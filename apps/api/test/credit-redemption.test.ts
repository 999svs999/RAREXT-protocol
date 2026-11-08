import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

import {
  REDEMPTION_KIND,
  canonicalize,
  creditBalances,
  creditLeaf,
  creditLedgerProblems,
  creditSupply,
  verifyProof,
} from "../../../packages/core/src/index.ts";
import type { CreditRecordFields, RedemptionInstruction } from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const bytesSha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const nodeHash = (value: string | Uint8Array) =>
  createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");

function registerKey(store: Awaited<ReturnType<typeof start>>["store"], handle: string) {
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
    sign(instruction: RedemptionInstruction): string {
      return signBytes("sha256", Buffer.from(canonicalize(instruction)), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64");
    },
  };
}

function credit(keyId: string, bounty: number): CreditRecordFields {
  return {
    keyId,
    action: "infer",
    bounty,
    challengeId: "d".repeat(64),
    artifactHash: "a".repeat(64),
    at: "2026-11-09T00:00:00.000Z",
  };
}

function instruction(from: string, amount: number, reference = "chain:tx:0xabc", nonce = "n1"): RedemptionInstruction {
  return { kind: REDEMPTION_KIND, from, amount, reference, nonce, at: "2026-11-09T01:00:00.000Z" };
}

test("a signed redemption removes credits against an external reference, provably", async () => {
  const { server, store, base } = await start();
  try {
    const alice = registerKey(store, "alice");
    store.addCredit(credit(alice.keyId, 12) as never);

    const redeem = instruction(alice.keyId, 5);
    const response = await post(base, "/v1/work/redeem", { ...redeem, signature: alice.sign(redeem) });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    const body = JSON.parse(text) as {
      redemption: { id: string; reference: string; amount: number };
      balance: number;
      supply: number;
      receipts: Array<CreditRecordFields & { ledger: { root: string; index: number; proof: string[] } }>;
    };

    assert.equal(body.redemption.reference, "chain:tx:0xabc");
    assert.equal(body.balance, 7);
    assert.equal(body.supply, 7, "redeeming lowered the ledger total");
    assert.equal(body.receipts.length, 1, "a redemption is one debit, no credit");
    const receipt = body.receipts[0]!;
    assert.equal(receipt.action, "redeem");
    assert.equal(receipt.bounty, -5);
    assert.equal(receipt.challengeId, "chain:tx:0xabc");

    assert.equal(
      verifyProof(creditLeaf(receipt, nodeHash), receipt.ledger.proof, receipt.ledger.root, receipt.ledger.index, bytesSha256),
      true,
    );

    const all = store.listCredits() as unknown as CreditRecordFields[];
    assert.deepEqual(creditBalances(all), { [alice.keyId]: 7 });
    assert.equal(creditSupply(all), 7);
    assert.deepEqual(creditLedgerProblems(all), []);
  } finally {
    await stop(server);
  }
});

test("credits cannot be redeemed twice: the double-spend is refused", async () => {
  const { server, store, base } = await start();
  try {
    const alice = registerKey(store, "alice");
    store.addCredit(credit(alice.keyId, 12) as never);

    // Redeem everything once.
    const first = instruction(alice.keyId, 12, "chain:tx:0xabc", "spend-1");
    const spent = await post(base, "/v1/work/redeem", { ...first, signature: alice.sign(first) });
    assert.equal(spent.status, 201, await spent.text());

    // The same credits cannot be redeemed again, even with a fresh nonce.
    const second = instruction(alice.keyId, 12, "chain:tx:0xdef", "spend-2");
    const again = await post(base, "/v1/work/redeem", { ...second, signature: alice.sign(second) });
    assert.equal(again.status, 402);
    assert.match(((await again.json()) as { error: string }).error, /insufficient credits/);

    // The exact same signed instruction cannot be applied twice.
    const replay = await post(base, "/v1/work/redeem", { ...first, signature: alice.sign(first) });
    assert.equal(replay.status, 409);
    assert.match(((await replay.json()) as { error: string }).error, /already been applied/);

    const all = store.listCredits() as unknown as CreditRecordFields[];
    assert.deepEqual(creditBalances(all), { [alice.keyId]: 0 });
    assert.equal(creditSupply(all), 0);
    assert.deepEqual(creditLedgerProblems(all), []);
  } finally {
    await stop(server);
  }
});

test("a redemption is refused when the amount, signature, or reference is not right", async () => {
  const { server, store, base } = await start();
  try {
    const alice = registerKey(store, "alice");
    const bob = registerKey(store, "bob");
    store.addCredit(credit(alice.keyId, 12) as never);

    // Forged: Bob signs a redemption from Alice.
    const forged = instruction(alice.keyId, 5);
    const forgedPost = await post(base, "/v1/work/redeem", { ...forged, signature: bob.sign(forged) });
    assert.equal(forgedPost.status, 401);

    // An unregistered redeemer cannot hold the debit.
    const unknown = instruction("unknown-key", 5, "chain:tx:0xabc", "n2");
    const unknownPost = await post(base, "/v1/work/redeem", { ...unknown, signature: alice.sign(unknown) });
    assert.equal(unknownPost.status, 403);

    // A redemption with no external reference is refused structurally.
    const noRef = instruction(alice.keyId, 5, "", "n3");
    const noRefPost = await post(base, "/v1/work/redeem", { ...noRef, signature: alice.sign(noRef) });
    assert.equal(noRefPost.status, 400);

    assert.equal(store.listCredits().filter((c) => c.action === "redeem").length, 0);
  } finally {
    await stop(server);
  }
});
