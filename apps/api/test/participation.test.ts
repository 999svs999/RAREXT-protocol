import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

import { canonicalize, creditLedgerRoot } from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A registered participant, the way the budget route registers its pledger. */
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
    signAssertion(assertion: Record<string, unknown>): string {
      const { signature: _ignored, ...rest } = assertion as { signature?: string };
      return signBytes("sha256", Buffer.from(canonicalize(rest)), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64");
    },
  };
}

function assertionFor(participant: string, root: string, act = "mirror-verify") {
  return {
    kind: "rarext.participation.v1",
    participant,
    act,
    root,
    at: new Date().toISOString(),
  };
}

test("a participation receipt: corroborated, zero-bounty, in the ledger, served with its proof", async () => {
  const { server, store, base } = await start();
  try {
    // A publication and its anchor: the root the receipt will name.
    const publish = await post(base, "/v1/publications", {
      author: "operator-alice",
      title: "the root a reader verified",
      taskId: "half-adder",
      circuit: {
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
      },
    });
    {
      const publishText = await publish.text();
      assert.equal(publish.status, 201, publishText);
    }
    const anchor = await post(base, "/v1/anchors", {});
    const anchorText = await anchor.text();
    assert.equal(anchor.status, 201, anchorText);
    const { root } = JSON.parse(anchorText) as { root: string };

    const participant = registerIdentity(store, "reader-carol");
    const assertion = assertionFor(participant.keyId, root);
    const receipt = await post(base, "/v1/work/participation", { ...assertion, signature: participant.signAssertion(assertion) });
    const receiptBody = await receipt.text();
    assert.equal(receipt.status, 201, receiptBody);
    const parsed = JSON.parse(receiptBody) as {
      receipt: { action: string; bounty: number; artifactHash: string; root: string; ledger: { root: string; index: number; proof: string[] } | null };
    };
    assert.equal(parsed.receipt.action, "participate");
    assert.equal(parsed.receipt.bounty, 0, "nothing is minted for participation");
    assert.equal(parsed.receipt.artifactHash, root, "the receipt is FOR the verified root");
    assert.ok(parsed.receipt.ledger && Array.isArray(parsed.receipt.ledger.proof), "the receipt carries its inclusion proof");
    const ledgerProof = parsed.receipt.ledger;
    assert.ok(ledgerProof && Array.isArray(ledgerProof.proof), "the receipt carries its inclusion proof");
    assert.ok(Number.isInteger(ledgerProof.index), "the proof names the leaf's position");
    assert.equal(parsed.receipt.ledger.root, creditLedgerRoot(store.listCredits(), (value) => sha256(typeof value === "string" ? value : Buffer.from(value as Uint8Array).toString("hex"))), "the served ledger root is the one the records rebuild");

    // Replay: the same participation is receipted once.
    const replay = await post(base, "/v1/work/participation", { ...assertion, signature: participant.signAssertion(assertion) });
    assert.equal(replay.status, 409);
    assert.match(((await replay.json()) as { error: string }).error, /already been receipted/);

    // Earnings serves it like any other receipt — the participant holds a verifiable record.
    const earnings = (await (await fetch(`${base}/v1/work/earnings?keyId=${participant.keyId}`)).json()) as {
      records: Array<{ action: string; bounty: number; ledger: { index: number; proof: string[] } | null }>;
    };
    assert.equal(earnings.records.length, 1);
    assert.equal(earnings.records[0]?.action, "participate");
    const earning = earnings.records[0];
    assert.ok(earning && earning.ledger && Array.isArray(earning.ledger.proof), "earnings serves the inclusion proof too");
  } finally {
    await stop(server);
  }
});

test("a root the node never anchored cannot be corroborated", async () => {
  const { server, store, base } = await start();
  try {
    const participant = registerIdentity(store, "reader-dave");
    const unanchored = "1".repeat(64);
    const assertion = assertionFor(participant.keyId, unanchored);
    const refused = await post(base, "/v1/work/participation", { ...assertion, signature: participant.signAssertion(assertion) });
    assert.equal(refused.status, 404);
    assert.match(
      ((await refused.json()) as { error: string }).error,
      /never anchored/,
      "the refusal names the corroboration the node cannot make",
    );
    assert.equal(store.listCredits().length, 0, "a refusal leaves nothing behind");
  } finally {
    await stop(server);
  }
});

test("a forged assertion is refused: the receipt is the participant's or it is nobody's", async () => {
  const { server, store, base } = await start();
  try {
    const publish = await post(base, "/v1/publications", {
      author: "operator-alice",
      title: "a real record",
      taskId: "half-adder",
      circuit: {
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
      },
    });
    {
      const publishText = await publish.text();
      assert.equal(publish.status, 201, publishText);
    }
    const anchor = await post(base, "/v1/anchors", {});
    const anchorText = await anchor.text();
    assert.equal(anchor.status, 201, anchorText);
    const { root } = JSON.parse(anchorText) as { root: string };

    const real = registerIdentity(store, "reader-eve");
    const stranger = registerIdentity(store, "impostor");
    const assertion = assertionFor(real.keyId, root);
    const forged = await post(base, "/v1/work/participation", { ...assertion, signature: stranger.signAssertion(assertion) });
    assert.equal(forged.status, 401);
    assert.match(((await forged.json()) as { error: string }).error, /does not match the participating key/);
    assert.equal(store.listCredits().length, 0);
  } finally {
    await stop(server);
  }
});
