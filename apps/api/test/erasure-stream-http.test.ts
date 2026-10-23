import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DurabilityLedger, httpHolder } from "../src/durability.ts";
import { encodeFileToShards } from "../src/erasure-stream.ts";
import { createHolderServer } from "../src/holder-server.ts";
import { placementProblem } from "../src/placements.ts";

async function startHolders(count: number, root: string) {
  const servers: ReturnType<typeof createHolderServer>[] = [];
  const holders: { directory: string; holder: ReturnType<typeof httpHolder> }[] = [];

  for (let index = 0; index < count; index += 1) {
    const directory = join(root, `h${index}`);
    const server = createHolderServer({ id: `holder-${index}`, directory });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    servers.push(server);
    holders.push({
      directory,
      holder: httpHolder(`holder-${index}`, `http://127.0.0.1:${port}`),
    });
  }

  return {
    holders: holders.map((entry) => entry.holder),
    directories: holders.map((entry) => entry.directory),
    async close() {
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}

test("streamed shards upload and download over HTTP, then place and retrieve", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-stream-http-"));
  const network = await startHolders(3, root);

  try {
    const payload = randomBytes(300_000);
    const inputPath = join(root, "payload.bin");
    writeFileSync(inputPath, payload);

    const streamed = encodeFileToShards({
      inputPath,
      outputDir: join(root, "shards"),
      dataShards: 2,
      parityShards: 1,
      chunkBytes: 2 * 4096 * 3,
    });

    const shard = streamed.shards[0]!;
    const uploaded = await network.holders[0]!.putFile!(shard.path, shard.sha256);
    assert.equal(uploaded, shard.sha256);

    const downloadedPath = join(root, "downloaded-shard");
    assert.equal(await network.holders[0]!.getFile!(shard.sha256, downloadedPath), true);
    assert.deepEqual(readFileSync(downloadedPath), readFileSync(shard.path));
    assert.equal(await network.holders[0]!.getFile!("a".repeat(64), join(root, "missing")), false);

    await assert.rejects(
      network.holders[0]!.putFile!(shard.path, "b".repeat(64)),
      /failed putFile: 400/,
    );

    const ledger = new DurabilityLedger();
    const placement = await ledger.placeStreamed(streamed, network.holders, "durable");

    assert.equal(placementProblem(placement), null);
    assert.equal(placement.streamed?.chunks, streamed.chunks);
    assert.equal(placement.shards.length, 3);

    const outputPath = join(root, "retrieved.bin");
    const result = await ledger.retrieveStreamed(placement, outputPath, network.holders);
    assert.equal(result.downloaded, 2);
    assert.equal(result.sha256, streamed.payloadDigest);
    assert.deepEqual(readFileSync(outputPath), payload);

    const outcomes = await ledger.challenge(placement.blobHash, network.holders);
    assert.equal(outcomes.filter((outcome) => outcome.ok).length, 3);
    assert.equal(ledger.audit(placement.blobHash).status, "ok");

    const bad = structuredClone(placement);
    bad.streamed!.chunkDigests[0] = "not-a-digest";
    assert.match(placementProblem(bad) ?? "", /chunkDigests/);
  } finally {
    await network.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt HTTP shard is skipped in favour of k good ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-stream-http-bad-"));
  const network = await startHolders(3, root);

  try {
    const payload = randomBytes(120_000);
    const inputPath = join(root, "payload.bin");
    writeFileSync(inputPath, payload);

    const streamed = encodeFileToShards({
      inputPath,
      outputDir: join(root, "shards"),
      dataShards: 2,
      parityShards: 1,
      chunkBytes: 2 * 4096 * 2,
    });

    const ledger = new DurabilityLedger();
    const placement = await ledger.placeStreamed(streamed, network.holders, "durable");
    const victim = placement.shards.find((shard) => shard.holder === "holder-0")!;
    writeFileSync(join(network.directories[0]!, victim.storedAs), randomBytes(1024));

    const outputPath = join(root, "retrieved.bin");
    const result = await ledger.retrieveStreamed(placement, outputPath, network.holders);
    assert.equal(result.downloaded, 2);
    assert.deepEqual(readFileSync(outputPath), payload);
  } finally {
    await network.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw shard upload bypasses the 32 MiB JSON body cap", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-stream-http-large-"));
  const server = createHolderServer({ id: "holder-0", directory: join(root, "h0") });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const holder = httpHolder("holder-0", `http://127.0.0.1:${port}`);
  const path = join(root, "large-shard.bin");
  const downloaded = join(root, "downloaded.bin");

  try {
    writeFileSync(path, randomBytes(40 * 1024 * 1024));
    const digest = (await import("node:crypto"))
      .createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");

    assert.equal(await holder.putFile!(path, digest), digest);
    assert.equal(await holder.getFile!(digest, downloaded), true);
    assert.equal(readFileSync(downloaded).length, 40 * 1024 * 1024);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw upload enforces quota and content-length", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-stream-http-quota-"));
  const server = createHolderServer({ id: "holder-0", directory: join(root, "h0"), maxBytes: 16 });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const holder = httpHolder("holder-0", `http://127.0.0.1:${port}`);
  const path = join(root, "too-big.bin");

  try {
    writeFileSync(path, Buffer.alloc(32, 1));
    const digest = (await import("node:crypto")).createHash("sha256").update(readFileSync(path)).digest("hex");

    await assert.rejects(holder.putFile!(path, digest), /failed putFile: 507/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("unauthenticated raw upload is refused when a token is configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-stream-http-token-"));
  const server = createHolderServer({ id: "holder-0", directory: join(root, "h0"), token: "secret" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const path = join(root, "shard.bin");
  const anonymous = httpHolder("holder-0", `http://127.0.0.1:${port}`);
  const authorized = httpHolder("holder-0", `http://127.0.0.1:${port}`, { token: "secret" });

  try {
    writeFileSync(path, Buffer.alloc(64, 2));
    const digest = (await import("node:crypto")).createHash("sha256").update(readFileSync(path)).digest("hex");

    await assert.rejects(anonymous.putFile!(path, digest), /failed putFile: 401/);
    assert.equal(await authorized.putFile!(path, digest), digest);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
