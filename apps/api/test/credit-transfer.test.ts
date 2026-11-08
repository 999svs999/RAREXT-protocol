import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

import {
  TRANSFER_KIND,
  canonicalize,
  creditLeaf,
  creditStatement,
  creditBalances,
  creditLedgerProblems,
  verifyProof,
} from "../../../packages/core/src/index.ts";
import type { CreditRecordFields, TransferInstruction } from "../../../packages/core/src/index.ts";
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
    sign(instruction: TransferInstruction): string {
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
    at: "2026-11-08T00:00:00.000Z",
  };
}

function instruction(from: string, to: string, amount: number, nonce = "n1"): TransferInstruction {
  return { kind: TRANSFER_KIND, from, to, amount, nonce, at: "2026-11-08T01:00:00.000Z" };
}

test("a signed transfer moves credits and proves against the whole-ledger root", async () => {
  const { server, store, base } = await start();
  try {
    const alice = registerKey(store, "alice");
    const bob = registerKey(store, "bob");
    store.addCredit(credit(alice.keyId, 12) as never);

    const move = instruction(alice.keyId, bob.keyId, 5);
    const moved = await post(base, "/v1/work/transfer", { ...move, signature: alice.sign(move) });
    const movedText = await moved.text();
    assert.equal(moved.status, 201, movedText);
    const body = JSON.parse(movedText) as {
      balances: { from: number; to: number };
      receipts: Array<CreditRecordFields & { ledger: { root: string; index: number; proof: string[] } }>;
    };

    assert.deepEqual(body.balances, { from: 7, to: 5 });
    assert.equal(body.receipts.length, 2);
    const debit = body.receipts.find((r) => r.keyId === alice.keyId)!;
    const received = body.receipts.find((r) => r.keyId === bob.keyId)!;
    assert.equal(debit.bounty, -5);
    assert.equal(received.bounty, 5);
    assert.equal(debit.artifactHash, received.artifactHash, "one movement, one identity");

    // The receiving receipt proves against the root the node published.
    assert.equal(
      verifyProof(
        creditLeaf(received, nodeHash),
        received.ledger.proof,
        received.ledger.root,
        received.ledger.index,
        bytesSha256,
      ),
      true,
    );

    // The node's whole ledger is exactly the credits the records imply, and it
    // is conserved: nothing was minted, the 5 moved.
    const all = store.listCredits() as unknown as CreditRecordFields[];
    assert.deepEqual(creditBalances(all), { [alice.keyId]: 7, [bob.keyId]: 5 });
    assert.deepEqual(creditLedgerProblems(all), []);

    // The earner's statement shows spend and net, not just a total.
    const statement = creditStatement(alice.keyId, all);
    assert.equal(statement.credits.earned, 12);
    assert.equal(statement.credits.spent, 5);
    assert.equal(statement.credits.net, 7);
  } finally {
    await stop(server);
  }
});

test("a key can only move credits it holds: the double-spend is refused", async () => {
  const { server, store, base } = await start();
  try {
    const alice = registerKey(store, "alice");
    const bob = registerKey(store, "bob");
    store.addCredit(credit(alice.keyId, 12) as never);

    // Spend everything once.
    const first = instruction(alice.keyId, bob.keyId, 12, "spend-1");
    const spent = await post(base, "/v1/work/transfer", { ...first, signature: alice.sign(first) });
    assert.equal(spent.status, 201, await spent.text());

    // The same credits cannot be spent again, even with a fresh nonce.
    const second = instruction(alice.keyId, bob.keyId, 12, "spend-2");
    const again = await post(base, "/v1/work/transfer", { ...second, signature: alice.sign(second) });
    assert.equal(again.status, 402);
    assert.match(((await again.json()) as { error: string }).error, /insufficient credits/);

    // And the exact same signed instruction cannot be applied twice.
    const replay = await post(base, "/v1/work/transfer", { ...first, signature: alice.sign(first) });
    assert.equal(replay.status, 409);
    assert.match(((await replay.json()) as { error: string }).error, /already been applied/);

    const all = store.listCredits() as unknown as CreditRecordFields[];
    assert.deepEqual(creditLedgerProblems(all), [], "the ledger never goes overdrawn");
    assert.deepEqual(creditBalances(all), { [alice.keyId]: 0, [bob.keyId]: 12 });
  } finally {
    await stop(server);
  }
});

test("a transfer is refused when the payer, payee, or signature is not right", async () => {
  const { server, store, base } = await start();
  try {
    const alice = registerKey(store, "alice");
    const bob = registerKey(store, "bob");
    store.addCredit(credit(alice.keyId, 12) as never);

    // A forged transfer: Bob signs a movement from Alice.
    const forged = instruction(alice.keyId, bob.keyId, 5);
    const forgedPost = await post(base, "/v1/work/transfer", { ...forged, signature: bob.sign(forged) });
    assert.equal(forgedPost.status, 401);

    // A payee the node does not know cannot hold a receipt.
    const stranger = instruction(alice.keyId, "unknown-key", 5, "n2");
    const unknown = await post(base, "/v1/work/transfer", { ...stranger, signature: alice.sign(stranger) });
    assert.equal(unknown.status, 403);

    // A self-move is refused structurally.
    const self = instruction(alice.keyId, alice.keyId, 5, "n3");
    const selfPost = await post(base, "/v1/work/transfer", { ...self, signature: alice.sign(self) });
    assert.equal(selfPost.status, 400);

    assert.equal(store.listCredits().filter((c) => c.action === "transfer").length, 0);
  } finally {
    await stop(server);
  }
});
