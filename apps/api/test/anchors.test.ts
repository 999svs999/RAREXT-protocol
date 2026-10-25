import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Anchor, Circuit, Publication } from "../../../packages/core/src/index.ts";
import { AdapterRegistry } from "../src/adapters/registry.ts";
import { anchorPending, anchorThreshold, publicationLeaf } from "../src/anchorer.ts";
import { merkleRoot } from "../src/merkle.ts";
import { RarextStore } from "../src/store.ts";
import { post, start, stop } from "./helpers.ts";

/** A rail with a real network-shaped await, which is where the race lives. */
function slowRail(delayMs = 60) {
  return {
    info: () => ({ id: "trac", kind: "anchor", label: "slow rail", enabled: true }),
    status: async () => ({
      id: "trac",
      kind: "anchor",
      label: "slow rail",
      enabled: true,
      details: {},
    }),
    anchor: async (root: string) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { adapter: "trac", status: "ok", reference: `sim://${root.slice(0, 8)}` };
    },
  } as never;
}

/** A rail that is up but failing, so the local fallback is what gets recorded. */
function brokenRail() {
  return {
    info: () => ({ id: "trac", kind: "anchor", label: "broken rail", enabled: true }),
    status: async () => ({
      id: "trac",
      kind: "anchor",
      label: "broken rail",
      enabled: true,
      details: {},
    }),
    anchor: async () => {
      throw new Error("rail is down");
    },
  } as never;
}

const halfAdder: Circuit = {
  components: [
    { id: "a", type: "INPUT" },
    { id: "b", type: "INPUT" },
    { id: "n1", type: "NAND", inputs: ["a", "b"] },
    { id: "n2", type: "NAND", inputs: ["a", "n1"] },
    { id: "n3", type: "NAND", inputs: ["b", "n1"] },
    { id: "xor", type: "NAND", inputs: ["n2", "n3"] },
    { id: "n5", type: "NAND", inputs: ["n1", "n1"] },
    { id: "sum", type: "OUTPUT", inputs: ["xor"] },
    { id: "carry", type: "OUTPUT", inputs: ["n5"] },
  ],
};

async function publish(base: string, author: string): Promise<Publication> {
  const response = await post(base, "/v1/publications", {
    author,
    title: `${author} half adder`,
    taskId: "half-adder",
    circuit: halfAdder,
  });

  assert.equal(response.status, 201);
  return (await response.json()) as Publication;
}

test("anchors publications and returns verifiable Merkle proofs", async () => {
  const { server, base } = await start();

  try {
    const first = await publish(base, "alice");
    const second = await publish(base, "bob");

    const anchorResponse = await post(base, "/v1/anchors", {});
    assert.equal(anchorResponse.status, 201);
    const anchor = (await anchorResponse.json()) as Anchor;
    assert.equal(anchor.leafCount, 2);
    assert.deepEqual(anchor.publicationIds, [first.id, second.id]);
    assert.equal(anchor.root.length, 64);

    const proofResponse = await post(base, `/v1/anchors/${anchor.id}/proof`, {
      publicationId: second.id,
    });
    assert.equal(proofResponse.status, 200);
    const proof = (await proofResponse.json()) as { valid: boolean; proof: string[] };
    assert.equal(proof.valid, true);
    assert.equal(proof.proof.length, 1);

    const list = (await (await fetch(`${base}/v1/anchors`)).json()) as Anchor[];
    assert.equal(list.length, 1);

    const again = await post(base, "/v1/anchors", {});
    assert.equal(again.status, 409);
  } finally {
    await stop(server);
  }
});

test("pagination returns stable windows", async () => {
  const { server, base } = await start();

  try {
    for (let index = 0; index < 5; index += 1) {
      await publish(base, `builder${index}`);
    }

    const first = (await (
      await fetch(`${base}/v1/feed?limit=2&offset=0`)
    ).json()) as Publication[];
    const second = (await (
      await fetch(`${base}/v1/feed?limit=2&offset=2`)
    ).json()) as Publication[];

    assert.equal(first.length, 2);
    assert.equal(second.length, 2);
    assert.notEqual(first[0].id, second[0].id);
    assert.equal(new Set([...first, ...second].map((item) => item.id)).size, 4);
  } finally {
    await stop(server);
  }
});

// ---------------------------------------------------------------------------
// Hardening round: the anchoring path. Anchoring is the commitment everything
// else verifies against, and it had two cases guarding it.
// ---------------------------------------------------------------------------

async function publishMany(base: string, count: number): Promise<Publication[]> {
  const published: Publication[] = [];
  for (let index = 0; index < count; index += 1) {
    published.push(await publish(base, `builder-${index}`));
  }
  return published;
}

test("mechanism: concurrency — two overlapping anchors produce ONE anchor, shared", async () => {
  // Reproduced before the fix: two anchors, same root, the same publications in
  // both, because the pending set was read before the adapter await and
  // committed after it. The slow rail widens the window deliberately.
  const dir = mkdtempSync(join(tmpdir(), "rarext-anchor-race-"));
  const store = new RarextStore(join(dir, "store.json"));
  const { server, base } = await start(store, {
    registry: new AdapterRegistry([slowRail()]),
  });

  try {
    const published = await publishMany(base, 3);

    const first = anchorPending(store, new AdapterRegistry([slowRail()]));
    const second = anchorPending(store, new AdapterRegistry([slowRail()]));
    const [a, b] = await Promise.all([first, second]);

    assert.ok(a && b, "both callers must get an anchor, not a silent null");
    assert.equal(a.id, b.id, "one anchor, shared by both callers");
    assert.equal(a.root, b.root);
    assert.equal(store.listAnchors().length, 1, "exactly one anchor may be recorded");
    assert.deepEqual(a.publicationIds, published.map((entry) => entry.id));
    assert.equal(a.leafCount, 3);
  } finally {
    await stop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mechanism: concurrency — sequential anchoring with nothing pending is still a refusal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rarext-anchor-none-"));
  const store = new RarextStore(join(dir, "store.json"));
  const { server, base } = await start(store);

  try {
    assert.equal(await anchorPending(store), null, "nothing pending means no anchor");
    await publishMany(base, 1);
    const anchored = await anchorPending(store);
    assert.ok(anchored);
    assert.equal(await anchorPending(store), null, "the batch is spent");
    assert.equal(store.listAnchors().length, 1);
  } finally {
    await stop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mechanism: proofs — a publication outside the anchor is refused, not quietly invalid", async () => {
  const { server, base } = await start();

  try {
    const [inside] = await publishMany(base, 1);
    const anchorResponse = await post(base, "/v1/anchors", {});
    const anchor = (await anchorResponse.json()) as Anchor;
    const outsider = await publish(base, "outsider");

    const proof = await post(base, `/v1/anchors/${anchor.id}/proof`, {
      publicationId: outsider.id,
    });
    assert.equal(proof.status, 409);
    const body = (await proof.json()) as { error: string };
    assert.match(body.error, /not part of this anchor/);
  } finally {
    await stop(server);
  }
});

test("mechanism: proofs — an unknown anchor is a 404, not an inconclusive proof", async () => {
  const { server, base } = await start();

  try {
    const [published] = await publishMany(base, 1);
    const ghost = await post(base, "/v1/anchors/no-such-anchor/proof", {
      publicationId: published.id,
    });
    assert.equal(ghost.status, 404);
  } finally {
    await stop(server);
  }
});

test("mechanism: tamper — rewriting a publication after anchoring breaks its proof", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rarext-anchor-tamper-"));
  const store = new RarextStore(join(dir, "store.json"));
  const { server, base } = await start(store);

  try {
    const [victim] = await publishMany(base, 1);
    const anchor = (await (await post(base, "/v1/anchors", {})).json()) as Anchor;

    const before = await post(base, `/v1/anchors/${anchor.id}/proof`, {
      publicationId: victim.id,
    });
    assert.equal(((await before.json()) as { valid: boolean }).valid, true);

    const stored = store.getPublication(victim.id) as { title: string };
    stored.title = "rewritten after anchoring";

    const after = await post(base, `/v1/anchors/${anchor.id}/proof`, {
      publicationId: victim.id,
    });
    assert.equal(
      ((await after.json()) as { valid: boolean }).valid,
      false,
      "a leaf recomputed from tampered bytes must not match the anchored root",
    );
    assert.equal(publicationLeaf(stored as never) === publicationLeaf(victim), false);
  } finally {
    await stop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mechanism: durability — an anchor and its proof survive a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rarext-anchor-restart-"));
  const storePath = join(dir, "store.json");
  const first = new RarextStore(storePath);
  const { server, base } = await start(first);

  let anchor: Anchor;
  let published: Publication;
  try {
    [published] = await publishMany(base, 2);
    anchor = (await (await post(base, "/v1/anchors", {})).json()) as Anchor;
  } finally {
    await stop(server);
  }

  const reopened = new RarextStore(storePath);
  const second = await start(reopened);
  try {
    assert.equal(reopened.pendingPublications().length, 0, "anchored work is not pending again");
    const proof = await post(second.base, `/v1/anchors/${anchor.id}/proof`, {
      publicationId: published.id,
    });
    assert.equal(proof.status, 200);
    assert.equal(((await proof.json()) as { valid: boolean }).valid, true);
  } finally {
    await stop(second.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mechanism: determinism — the committed root IS the Merkle root of the leaves", async () => {
  // Stronger than "stable across nodes": the root must equal an independent
  // recomputation over the same publications, in the order the anchor lists.
  const dir = mkdtempSync(join(tmpdir(), "rarext-anchor-root-"));
  const store = new RarextStore(join(dir, "store.json"));
  const { server, base } = await start(store);

  try {
    const published = await publishMany(base, 3);
    const anchor = (await (await post(base, "/v1/anchors", {})).json()) as Anchor;

    const listed = anchor.publicationIds.map((id) => store.getPublication(id)!);
    assert.equal(listed.length, 3);
    assert.deepEqual(
      anchor.publicationIds,
      published.map((entry) => entry.id),
      "the anchor lists the batch in publication order",
    );

    const leaves = listed.map((publication) => publicationLeaf(publication));
    assert.equal(merkleRoot(leaves), anchor.root, "the root must be the Merkle root of the leaves");
    assert.equal(merkleRoot(leaves), merkleRoot(leaves.map((leaf) => leaf)), "recomputation is stable");
    assert.equal(anchor.root.length, 64);
    assert.match(anchor.root, /^[0-9a-f]{64}$/);

    // Order is part of the commitment: the same leaves in another order are a
    // different root, which is what stops a reordering rewrite.
    if (leaves.length > 1) {
      const reordered = [leaves[1]!, leaves[0]!, ...leaves.slice(2)];
      assert.notEqual(merkleRoot(reordered), anchor.root);
    }
  } finally {
    await stop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mechanism: failure — a broken rail does not lose the anchor, and the failure is recorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rarext-anchor-broken-"));
  const store = new RarextStore(join(dir, "store.json"));
  const { server, base } = await start(store, {
    registry: new AdapterRegistry([brokenRail()]),
  });

  try {
    await publishMany(base, 1);
    const response = await post(base, "/v1/anchors", {});
    assert.equal(response.status, 201, "the local commitment must survive a dead rail");

    const anchor = (await response.json()) as Anchor & { receipts: { status: string }[] };
    assert.equal(anchor.root.length, 64);
    assert.equal(anchor.adapter, "local");
    assert.equal(anchor.reference, null);
    assert.ok(
      anchor.receipts.some((receipt) => receipt.status !== "ok"),
      "the failed rail must appear in the receipts",
    );
  } finally {
    await stop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mechanism: policy — the anchor threshold parses the environment honestly", () => {
  const restore = process.env.RAREXT_ANCHOR_EVERY;
  try {
    for (const [value, expected] of [
      [undefined, 0],
      ["", 0],
      ["0", 0],
      ["-3", 0],
      ["junk", 0],
      ["7", 7],
      ["7.9", 7],
    ] as Array<[string | undefined, number]>) {
      if (value === undefined) delete process.env.RAREXT_ANCHOR_EVERY;
      else process.env.RAREXT_ANCHOR_EVERY = value;
      assert.equal(anchorThreshold(), expected, `RAREXT_ANCHOR_EVERY=${value}`);
    }
  } finally {
    if (restore === undefined) delete process.env.RAREXT_ANCHOR_EVERY;
    else process.env.RAREXT_ANCHOR_EVERY = restore;
  }
});
