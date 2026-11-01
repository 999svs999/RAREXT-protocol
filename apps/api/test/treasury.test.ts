import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

import { canonicalize, creditLedgerRoot } from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function registerIdentity(store: Awaited<ReturnType<typeof start>>["store"], handle: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  const keyId = sha256(canonicalize(jwk));
  store.addIdentity({
    handle,
    displayName: handle,
    keyId,
    publicKey: jwk,
    algorithm: "ecdsa-p256",
    createdAt: new Date().toISOString(),
    links: [],
    verified: true,
  } as never);
  return {
    keyId,
    sign(payload: Record<string, unknown>): string {
      const { signature: _ignored, ...rest } = payload as { signature?: string };
      return signBytes("sha256", Buffer.from(canonicalize(rest)), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
    },
  };
}

const halfAdder = {
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

async function anchorSomething(base: string): Promise<string> {
  const publish = await post(base, "/v1/publications", {
    author: "operator-alice",
    title: "the root the treasury view counts",
    taskId: "half-adder",
    circuit: halfAdder,
  });
  assert.equal(publish.status, 201, await publish.text());
  const anchor = await post(base, "/v1/anchors", {});
  const text = await anchor.text();
  assert.equal(anchor.status, 201, text);
  return (JSON.parse(text) as { root: string }).root;
}

test("the treasury view: the classes a decision can name, sized from this node's own ledger", async () => {
  const { server, store, base } = await start();
  try {
    const root = await anchorSomething(base);

    // An operator's anchoring receipt and a reader's participation receipt, on the same root.
    const operator = registerIdentity(store, "operator-node");
    const anchorClaim = { kind: "rarext.anchor-work.v1", operator: operator.keyId, root, at: new Date().toISOString() };
    const claimed = await post(base, "/v1/work/anchor", { ...anchorClaim, signature: operator.sign(anchorClaim) });
    assert.equal(claimed.status, 201, await claimed.text());

    const reader = registerIdentity(store, "reader-1");
    const assertion = { kind: "rarext.participation.v1", participant: reader.keyId, act: "mirror-verify", root, at: new Date().toISOString() };
    const participated = await post(base, "/v1/work/participation", { ...assertion, signature: reader.sign(assertion) });
    assert.equal(participated.status, 201, await participated.text());

    const treasury = (await (await fetch(`${base}/v1/work/treasury`)).json()) as {
      ledgerRoot: string;
      classes: Array<{ act: string; receipts: number; holders: number; byRoot: Array<{ root: string; receipts: number; holders: number }> }>;
      pending: Array<{ proposalRoot: string; to: { kind: string; act: string } }>;
    };

    // The commitment is the recomputed one, not a stored number.
    const byteHash = (value: string | Uint8Array) =>
      createHash("sha256").update(typeof value === "string" ? value : Buffer.from(value)).digest("hex");
    assert.equal(treasury.ledgerRoot, creditLedgerRoot(store.listCredits(), byteHash), "the ledger root is recomputed at read time");

    const anchorClass = treasury.classes.find((entry) => entry.act === "anchor");
    const participateClass = treasury.classes.find((entry) => entry.act === "participate");
    assert.ok(anchorClass && participateClass, "both receipt classes are reported");
    assert.equal(anchorClass?.receipts, 1, "one anchoring receipt exists");
    assert.equal(anchorClass?.holders, 1, "held by one operator");
    assert.equal(participateClass?.receipts, 1, "one participation receipt exists");
    assert.equal(participateClass?.holders, 1);
    assert.deepEqual(anchorClass?.byRoot, [{ root, receipts: 1, holders: 1 }], "a root-scoped decision can size against the root");

    // A second reader joins the SAME class: the class grows, the holder count does not double-count.
    const reader2 = registerIdentity(store, "reader-2");
    const assertion2 = { kind: "rarext.participation.v1", participant: reader2.keyId, act: "mirror-verify", root, at: new Date().toISOString() };
    await post(base, "/v1/work/participation", { ...assertion2, signature: reader2.sign(assertion2) });
    const grown = (await (await fetch(`${base}/v1/work/treasury`)).json()) as { classes: Array<{ act: string; receipts: number; holders: number }> };
    const grownClass = grown.classes.find((entry) => entry.act === "participate");
    assert.equal(grownClass?.receipts, 2, "two receipts");
    assert.equal(grownClass?.holders, 2, "two distinct holders");
  } finally {
    await stop(server);
  }
});

test("the treasury view is empty on a node with no receipts, and never invents a class", async () => {
  const { server, base } = await start();
  try {
    const treasury = (await (await fetch(`${base}/v1/work/treasury`)).json()) as {
      classes: Array<{ act: string; receipts: number; holders: number }>;
      pending: unknown[];
    };
    assert.ok(treasury.classes.length >= 1);
    for (const entry of treasury.classes) {
      assert.equal(entry.receipts, 0, `${entry.act} must be zero on a fresh node`);
      assert.equal(entry.holders, 0);
    }
    assert.deepEqual(treasury.pending, [], "nothing is in flight");
  } finally {
    await stop(server);
  }
});
