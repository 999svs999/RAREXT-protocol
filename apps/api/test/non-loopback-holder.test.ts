import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DurabilityLedger, httpHolder } from "../src/durability.ts";
import { encodeFileToShards } from "../src/erasure-stream.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const TOKEN = "non-loopback-test-token";

function scratch(prefix: string): string {
  const base = join(process.cwd(), ".data");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

function nonLoopbackIPv4(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }

  return null;
}

async function freePort(host: string): Promise<number> {
  const server = createServer();
  server.listen(0, host);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  server.close();
  await once(server, "close");
  return port;
}

async function startHolder(
  id: string,
  host: string,
  port: number,
  directory: string,
): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["apps/api/src/holder-server.ts"], {
    cwd: root,
    env: {
      ...process.env,
      RAREXT_HOLDER_ID: id,
      RAREXT_HOLDER_DIR: directory,
      RAREXT_HOLDER_HOST: host,
      RAREXT_HOLDER_PORT: String(port),
      RAREXT_HOLDER_TOKEN: TOKEN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
  });

  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`holder ${id} exited (${child.exitCode}): ${stderr}`);
    }

    try {
      const response = await fetch(`http://${host}:${port}/v1/holder`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      if (response.ok) return child;
    } catch {
      // Not accepting connections yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  child.kill();
  throw new Error(`holder ${id} did not start on ${host}:${port}: ${stderr}`);
}

async function stopHolder(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

test("streams across a non-loopback holder, enforces its token, and retrieves byte-exact", { timeout: 60_000 }, async (t) => {
  const lan = nonLoopbackIPv4();
  if (!lan) {
    t.skip("no non-loopback IPv4 interface is available");
    return;
  }

  const directory = scratch("rarext-non-loopback-");
  const children: ChildProcess[] = [];
  const urls: string[] = [];
  const holders = [];

  try {
    const hosts = [lan, "127.0.0.1", "127.0.0.1"];

    for (const [index, host] of hosts.entries()) {
      const id = `holder-${index}`;
      const port = await freePort(host);
      const child = await startHolder(id, host, port, join(directory, id));
      const url = `http://${host}:${port}`;
      children.push(child);
      urls.push(url);
      holders.push(httpHolder(id, url, { token: TOKEN }));
    }

    const payload = randomBytes(256 * 1024);
    const inputPath = join(directory, "payload.bin");
    writeFileSync(inputPath, payload);

    const streamed = encodeFileToShards({
      inputPath,
      outputDir: join(directory, "shards"),
      dataShards: 2,
      parityShards: 1,
      chunkBytes: 2 * 4096 * 2,
    });

    const ledger = new DurabilityLedger();
    const placement = await ledger.placeStreamed(streamed, holders, "durable");

    assert.ok(
      placement.shards.some((shard) => shard.holder === "holder-0"),
      "the non-loopback holder receives a shard",
    );

    const outcomes = await ledger.challenge(placement.blobHash, holders);
    assert.equal(outcomes.filter((outcome) => outcome.ok).length, 3);
    assert.equal(ledger.audit(placement.blobHash).status, "ok");

    const output = join(directory, "retrieved.bin");
    const result = await ledger.retrieveStreamed(placement, output, holders);
    assert.equal(result.sha256, streamed.payloadDigest);
    assert.deepEqual(readFileSync(output), payload);

    // A non-loopback bind requires a token, and the raw shard stream is behind
    // the same check. One rejected holder degrades to parity; three fail closed.
    const anonymous = holders.map((holder, index) => httpHolder(holder.id, urls[index]!));
    const withOneRejected = await ledger.retrieveStreamed(
      placement,
      join(directory, "one-rejected.bin"),
      [anonymous[0]!, holders[1]!, holders[2]!],
    );
    assert.equal(withOneRejected.downloaded, 2);
    assert.deepEqual(readFileSync(join(directory, "one-rejected.bin")), payload);

    const rejectedOutput = join(directory, "all-rejected.bin");
    await assert.rejects(
      () => ledger.retrieveStreamed(placement, rejectedOutput, anonymous),
      /rejected getFile: 401/,
    );
    assert.equal(existsSync(rejectedOutput), false);
  } finally {
    await Promise.all(children.map(stopHolder));
    rmSync(directory, { recursive: true, force: true });
  }
});
