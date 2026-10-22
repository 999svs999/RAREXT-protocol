import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { createHolderServer } from "../src/holder-server.ts";
import { DurabilityLedger, httpHolder } from "../src/durability.ts";
import { encodeBytes, decodeBytes } from "../src/erasure.ts";

test("end-to-end multi-holder gate with live holder failure, audit under-replication, repair, and byte-exact retrieval", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-gate-"));
  const h0Dir = join(root, "h0");
  const h1Dir = join(root, "h1");
  const h2Dir = join(root, "h2");

  const s0 = createHolderServer({ id: "holder-0", directory: h0Dir });
  const s1 = createHolderServer({ id: "holder-1", directory: h1Dir });
  const s2 = createHolderServer({ id: "holder-2", directory: h2Dir });

  s0.listen(0, "127.0.0.1");
  s1.listen(0, "127.0.0.1");
  s2.listen(0, "127.0.0.1");

  await Promise.all([once(s0, "listening"), once(s1, "listening"), once(s2, "listening")]);

  const p0 = (s0.address() as AddressInfo).port;
  const p1 = (s1.address() as AddressInfo).port;
  const p2 = (s2.address() as AddressInfo).port;

  const h0 = httpHolder("holder-0", `http://127.0.0.1:${p0}`);
  const h1 = httpHolder("holder-1", `http://127.0.0.1:${p1}`);
  const h2 = httpHolder("holder-2", `http://127.0.0.1:${p2}`);

  const activeHolders = [h0, h1, h2];

  try {
    const payload = randomBytes(32 * 1024);
    const ledger = new DurabilityLedger();

    // 1. Place blob across 3 holders (k=2, m=1)
    const encoded = encodeBytes(payload, 2, 1);
    const placement = await ledger.place(encoded, activeHolders, "durable");
    assert.equal(placement.shards.length, 3);
    const blobHash = placement.blobHash;

    // 2. Challenge active holders to establish liveness
    await ledger.challenge(blobHash, activeHolders);
    const auditInitial = ledger.audit(blobHash);
    assert.equal(auditInitial.status, "ok");

    // 3. Kill holder 1 mid-flight (close server)
    s1.closeAllConnections();
    await new Promise<void>((resolve) => s1.close(() => resolve()));

    // 4. Challenging dead holder 1 will cause misses/failure, leading to under-replication
    await ledger.challenge(blobHash, activeHolders);
    const auditDegraded = ledger.audit(blobHash);
    assert.equal(auditDegraded.status, "under-replicated");

    // 5. Bring in a spare replacement holder h3
    const h3Dir = join(root, "h3");
    const s3 = createHolderServer({ id: "holder-3", directory: h3Dir });
    s3.listen(0, "127.0.0.1");
    await once(s3, "listening");
    const p3 = (s3.address() as AddressInfo).port;
    const h3 = httpHolder("holder-3", `http://127.0.0.1:${p3}`);

    try {
      // 6. Repair blob using surviving holder h0, h2, and spare h3
      const repairHolders = [h0, h2, h3];
      const repairedOutcome = await ledger.repair(blobHash, repairHolders);
      assert.ok(repairedOutcome.filled > 0);

      // 7. Challenge and audit recovered state -> ok
      await ledger.challenge(blobHash, repairHolders);
      const auditRecovered = ledger.audit(blobHash);
      assert.equal(auditRecovered.status, "ok");

      // 8. Retrieve shards from surviving/repaired holders and verify byte-exact reconstruction
      const survivorShards = await Promise.all(
        repairedOutcome.placement.shards.map(async (shard) => {
          const holder = repairHolders.find((h) => h.id === shard.holder)!;
          const foundBytes = await holder.get(shard.storedAs);
          assert.ok(foundBytes);
          return {
            index: shard.index,
            dataShards: repairedOutcome.placement.dataShards,
            parityShards: repairedOutcome.placement.parityShards,
            length: repairedOutcome.placement.length,
            payloadDigest: repairedOutcome.placement.blobHash,
            digest: shard.digest,
            bytes: Uint8Array.from(foundBytes),
          };
        }),
      );

      const decodedPayload = decodeBytes(survivorShards);
      assert.deepEqual(Buffer.from(decodedPayload), payload);

    } finally {
      s3.closeAllConnections();
      await new Promise<void>((resolve) => s3.close(() => resolve()));
    }

  } finally {
    s0.closeAllConnections();
    s2.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => s0.close(() => resolve())),
      new Promise<void>((resolve) => s2.close(() => resolve())),
    ]);
    rmSync(root, { recursive: true, force: true });
  }
});
