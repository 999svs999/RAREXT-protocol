import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { DurabilityLedger, httpHolder, type DurabilityHolder } from "../src/durability.ts";
import { sha256Bytes } from "../src/storage.ts";
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

class FaultyHolder implements DurabilityHolder {
  readonly id: string;
  private readonly statusToReturn: number | "ok";
  private putCallCount = 0;

  constructor(id: string, status: number | "ok" = "ok") {
    this.id = id;
    this.statusToReturn = status;
  }

  async put(bytes: Uint8Array): Promise<string> {
    this.putCallCount++;
    if (this.statusToReturn === "ok") {
      return `mock-stored-as-${this.id}-${this.putCallCount}`;
    }
    throw new Error(`simulated holder error: ${this.statusToReturn}`);
  }

  async putFile(path: string, storedAs: string): Promise<string> {
    this.putCallCount++;
    if (this.statusToReturn === "ok") {
      return `mock-stored-as-file-${this.id}-${this.putCallCount}`;
    }
    throw new Error(`simulated holder error: ${this.statusToReturn}`);
  }

  async get(storedAs: string): Promise<Uint8Array | null> { return null; }
  async remove(storedAs: string): Promise<boolean> { return false; }
  async has(storedAs: string): Promise<boolean> { return false; }
  async respond(challenge: import("../src/durability.ts").HolderChallenge): Promise<import("../src/durability.ts").ChallengeResponse | null> { return null; }
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

test("multi-holder gate survives a live failure, repairs, and retrieves concurrently", { timeout: 30_000 }, async (t) => {
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

    await t.test("placement fails loudly when a holder returns 5xx (e.g. 507 quota)", async () => {
      const faultyH = new FaultyHolder("faulty-holder", 507);
      // Exactly dataShards + parityShards holders, the faulty one among them:
      // with a spare healthy holder the ledger could legitimately place all
      // shards elsewhere and never exercise the failure, making the assertion
      // depend on selection order instead of on the behaviour under test.
      const testHolders = [h0.holder, h2.holder, faultyH];

      // Make sure the number of holders is sufficient initially, even with the faulty one
      const placementShards = encodeFileToShards({
        inputPath,
        outputDir: join(root, "shards-faulty"),
        dataShards: 2,
        parityShards: 1,
        chunkBytes: 2 * 4096 * 2,
      });

      await assert.rejects(
        () => ledger.placeStreamed(placementShards, testHolders, "durable"),
        /simulated holder error: 507/,
        "placement should fail due to faulty holder",
      );
    });

    // A holder that answers a put with something that is not a valid shard
    // name is refused at placement, loudly — the returned name is the locator
    // every later read and challenge uses, so a malformed one cannot be
    // adopted. (Equality with the digest is deliberately NOT asserted here:
    // a holder names the file by its own digest of the bytes it received, and
    // integrity is enforced when those bytes are read back against the name.)
    await t.test("placement refuses a storedAs that is not a valid shard name", async () => {
      const root = scratch("rarext-gate-inconsistent-storedas");
      const hA = await startHolder("holder-A", root);
      const hB = await startHolder("holder-B", root);
      try {
        const payload = randomBytes(1024); // Small payload
        const inputPath = join(root, "payload.bin");
        writeFileSync(inputPath, payload);

        // Mock holders where one returns a lying 'storedAs'
        const mockHolders = [
          {
            ...hA.holder,
            putFile: async (path: string, storedAs: string): Promise<string> => {
              return "mock-stored-as-A-incorrect-hash";
            },
            put: async (bytes: Uint8Array): Promise<string> => {
              return "mock-stored-as-A-incorrect-hash";
            },
          },
          hB.holder,
        ];

        const streamed = encodeFileToShards({
          inputPath,
          outputDir: join(root, "shards"),
          dataShards: 1,
          parityShards: 1,
          chunkBytes: 4096,
        });

        const ledger = new DurabilityLedger();
        await assert.rejects(
          () => ledger.placeStreamed(streamed, mockHolders as any, "durable"),
          /invalid storedAs/,
          "placement should be refused if a holder answers with a name that is not a valid shard name",
        );
      } finally {
        await hA.stop();
        await hB.stop();
        rmSync(root, { recursive: true, force: true });
      }
    });

  } finally {
    await Promise.all([h0.stop(), h2.stop(), ...(h3 ? [h3.stop()] : [])]);
    rmSync(root, { recursive: true, force: true });
  }
});
