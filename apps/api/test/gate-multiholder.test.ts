import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { DurabilityLedger, httpHolder, type DurabilityHolder } from "../src/durability.ts";
import { encodeFileToShards } from "../src/erasure-stream.ts";
import { createHolderServer } from "../src/holder-server.ts";

interface RunningHolder {
  holder: DurabilityHolder;
  stop: () => Promise<void>;
}

function scratch(prefix: string): string {
  const base = join(process.cwd(), ".data");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

async function startHolder(id: string, root: string): Promise<RunningHolder> {
  const server = createHolderServer({ id, directory: join(root, id) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    holder: httpHolder(id, `http://127.0.0.1:${port}`),
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("multi-holder gate survives a live failure, repairs, and retrieves concurrently", { timeout: 30_000 }, async () => {
  const root = scratch("rarext-gate-");
  const h0 = await startHolder("holder-0", root);
  const h1 = await startHolder("holder-1", root);
  const h2 = await startHolder("holder-2", root);
  let h3: RunningHolder | null = null;

  try {
    const payload = randomBytes(320_000);
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
    const activeHolders = [h0.holder, h1.holder, h2.holder];
    const placement = await ledger.placeStreamed(streamed, activeHolders, "durable");
    const blobHash = placement.blobHash;

    assert.equal(placement.shards.length, 3);
    await ledger.challenge(blobHash, activeHolders);
    assert.equal(ledger.audit(blobHash).status, "ok");

    // Lose one of three shards (k=2, m=1): still retrievable, but the audit is
    // under-replicated until repair moves the lost shard to a fresh holder.
    await h1.stop();
    await ledger.challenge(blobHash, activeHolders);
    assert.equal(ledger.audit(blobHash).status, "under-replicated");

    h3 = await startHolder("holder-3", root);
    const repairHolders = [h0.holder, h2.holder, h3.holder];
    const repaired = await ledger.repair(blobHash, repairHolders);
    assert.equal(repaired.filled, 1);

    await ledger.challenge(blobHash, repairHolders);
    assert.equal(ledger.audit(blobHash).status, "ok");

    // The same placement read at once by several callers must produce byte-exact
    // output without one read starving or corrupting another.
    const retrievals = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        ledger.retrieveStreamed(
          repaired.placement,
          join(root, `retrieved-${index}.bin`),
          repairHolders,
          { concurrency: 3 },
        ),
      ),
    );

    for (const [index, result] of retrievals.entries()) {
      assert.equal(result.downloaded, 2);
      assert.equal(result.sha256, streamed.payloadDigest);
      assert.deepEqual(readFileSync(join(root, `retrieved-${index}.bin`)), payload);
    }
  } finally {
    await Promise.all([h0.stop(), h2.stop(), ...(h3 ? [h3.stop()] : [])]);
    rmSync(root, { recursive: true, force: true });
  }
});
