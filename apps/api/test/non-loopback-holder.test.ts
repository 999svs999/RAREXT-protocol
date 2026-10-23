import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DurabilityLedger, httpHolder } from "../src/durability.ts";
import { decodeBytes, encodeBytes } from "../src/erasure.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const TOKEN = "non-loopback-test-token";

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

test("places a shard on a holder bound to a non-loopback address in a separate process", { timeout: 60_000 }, async (t) => {
  const lan = nonLoopbackIPv4();
  if (!lan) {
    t.skip("no non-loopback IPv4 interface is available");
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), "rarext-non-loopback-"));
  const children: ChildProcess[] = [];
  const holders = [];

  try {
    const hosts = [lan, "127.0.0.1", "127.0.0.1"];

    for (const [index, host] of hosts.entries()) {
      const id = `holder-${index}`;
      const port = await freePort(host);
      const child = await startHolder(id, host, port, join(directory, id));
      children.push(child);
      holders.push(httpHolder(id, `http://${host}:${port}`, { token: TOKEN }));
    }

    const payload = randomBytes(256 * 1024);
    const shards = encodeBytes(payload, 2, 1);
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(shards, holders, "durable");

    assert.ok(
      placement.shards.some((shard) => shard.holder === "holder-0"),
      "the non-loopback holder receives a shard",
    );

    const outcomes = await ledger.challenge(placement.blobHash, holders);
    assert.equal(outcomes.filter((outcome) => outcome.ok).length, 3);
    assert.equal(ledger.audit(placement.blobHash).status, "ok");

    const recovered = [];

    for (const shard of placement.shards.slice(0, placement.dataShards)) {
      const holder = holders.find((candidate) => candidate.id === shard.holder)!;
      const bytes = await holder.get(shard.storedAs);
      assert.ok(bytes);
      recovered.push({
        index: shard.index,
        dataShards: placement.dataShards,
        parityShards: placement.parityShards,
        length: placement.length,
        payloadDigest: placement.blobHash,
        digest: shard.digest,
        bytes,
      });
    }

    assert.deepEqual(Buffer.from(decodeBytes(recovered)), payload);
  } finally {
    await Promise.all(children.map(stopHolder));
    rmSync(directory, { recursive: true, force: true });
  }
});
