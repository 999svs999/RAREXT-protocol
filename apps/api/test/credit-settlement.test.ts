import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

import {
  REDEMPTION_KIND,
  canonicalize,
} from "../../../packages/core/src/index.ts";
import type { CreditRecordFields, RedemptionInstruction } from "../../../packages/core/src/index.ts";
import { AgentSigner, generateAgentKeypair } from "../../../packages/agent-sdk/src/index.ts";
import { RarextStore } from "../src/store.ts";
import type { SettlementAdapter, SettlementReceipt, SettlementRequest } from "../src/settlement.ts";
import { settlementPayload, verifySettlementReceipt } from "../src/settlement.ts";
import { post, start, stop } from "./helpers.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function registerKey(store: RarextStore, handle: string) {
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
    at: "2026-11-10T00:00:00.000Z",
  };
}

function instruction(from: string, amount: number, reference = "chain:tx:0xabc", nonce = "n1"): RedemptionInstruction {
  return { kind: REDEMPTION_KIND, from, amount, reference, nonce, at: "2026-11-10T01:00:00.000Z" };
}

test("a redemption settles through the adapter and records the receipt", async () => {
  const calls: SettlementRequest[] = [];
  const adapter: SettlementAdapter = {
    name: "stub-chain",
    async settle(request) {
      calls.push(request);
      return { settlementId: `tx-${request.reference}`, detail: "confirmed" };
    },
  };
  const store = new RarextStore();
  const { server, base } = await start(store, { settlement: adapter });
  try {
    const alice = registerKey(store, "alice");
    store.addCredit(credit(alice.keyId, 12) as never);

    const redeem = instruction(alice.keyId, 5, "chain:tx:0xabc");
    const response = await post(base, "/v1/work/redeem", { ...redeem, signature: alice.sign(redeem) });
    const body = (await response.json()) as {
      settlement: { settlementId: string; reference: string; adapter: string; amount: number };
      balance: number;
      supply: number;
    };
    assert.equal(response.status, 201);
    assert.equal(body.settlement.adapter, "stub-chain");
    assert.equal(body.settlement.settlementId, "tx-chain:tx:0xabc");
    assert.equal(body.settlement.reference, "chain:tx:0xabc");
    assert.equal(body.balance, 7);
    assert.equal(body.supply, 7);
    assert.equal(calls.length, 1, "the adapter was called exactly once");
    assert.equal(calls[0]!.amount, 5);
    assert.equal(calls[0]!.reference, "chain:tx:0xabc");

    // The settlement is recorded and readable.
    const listed = (await (await fetch(`${base}/v1/work/settlement?keyId=${alice.keyId}`)).json()) as {
      adapter: string;
      settlements: Array<{ settlementId: string; redemptionId: string }>;
    };
    assert.equal(listed.adapter, "stub-chain");
    assert.equal(listed.settlements.length, 1);
    assert.equal(listed.settlements[0]!.settlementId, "tx-chain:tx:0xabc");

    // The same redemption cannot be settled twice.
    const again = await post(base, "/v1/work/redeem", { ...redeem, signature: alice.sign(redeem) });
    assert.equal(again.status, 409);
    assert.equal(calls.length, 1, "the adapter is not called for a replayed redemption");
  } finally {
    await stop(server);
  }
});

test("a failing adapter refuses the redemption atomically", async () => {
  const adapter: SettlementAdapter = {
    name: "broken-chain",
    async settle() {
      throw new Error("the chain is offline");
    },
  };
  const store = new RarextStore();
  const { server, base } = await start(store, { settlement: adapter });
  try {
    const alice = registerKey(store, "alice");
    store.addCredit(credit(alice.keyId, 12) as never);

    const redeem = instruction(alice.keyId, 5);
    const response = await post(base, "/v1/work/redeem", { ...redeem, signature: alice.sign(redeem) });
    assert.equal(response.status, 502);
    assert.match(((await response.json()) as { error: string }).error, /settlement failed/);

    // No credits were removed and no settlement was recorded: the ledger did not
    // lose value the outside world never received.
    assert.equal(store.listCredits().filter((entry) => entry.action === "redeem").length, 0);
    assert.equal(store.listSettlements().length, 0);
    const listed = (await (await fetch(`${base}/v1/work/settlement?keyId=${alice.keyId}`)).json()) as {
      settlements: unknown[];
    };
    assert.equal(listed.settlements.length, 0);
  } finally {
    await stop(server);
  }
});

test("a pinned settlement key verifies a signed adapter receipt", async () => {
  const signer = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const adapter: SettlementAdapter = {
    name: "signed-chain",
    async settle(request) {
      const settlementId = `tx-${request.reference}`;
      const detail = "confirmed";
      return {
        settlementId,
        detail,
        signature: signer.sign(settlementPayload(request, settlementId, detail)),
        publicKey: signer.publicKey,
        suite: signer.suite,
      };
    },
  };
  const store = new RarextStore();
  const { server, base } = await start(store, { settlement: adapter, settlementKey: signer.keyId });
  try {
    const alice = registerKey(store, "alice");
    store.addCredit(credit(alice.keyId, 12) as never);

    const redeem = instruction(alice.keyId, 5, "chain:tx:0xsigned");
    const response = await post(base, "/v1/work/redeem", { ...redeem, signature: alice.sign(redeem) });
    const body = (await response.json()) as { settlement: SettlementReceipt; balance: number };
    assert.equal(response.status, 201);
    assert.equal(body.settlement.signer, signer.keyId);
    assert.equal(body.settlement.adapter, "signed-chain");
    assert.equal(verifySettlementReceipt(body.settlement, signer.keyId), true);

    // Editing any settlement fact breaks the binding, so the signature no longer
    // covers what the receipt now claims.
    assert.equal(verifySettlementReceipt({ ...body.settlement, amount: 999 }, signer.keyId), false);
    assert.equal(
      verifySettlementReceipt({ ...body.settlement, reference: "chain:tx:other" }, signer.keyId),
      false,
    );
    // A receipt signed by another key is not the pinned adapter's.
    const other = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    assert.equal(verifySettlementReceipt(body.settlement, other.keyId), false);
    // An unsigned receipt proves nothing.
    assert.equal(
      verifySettlementReceipt(
        { ...body.settlement, signature: null, publicKey: null, signer: null },
        signer.keyId,
      ),
      false,
    );
  } finally {
    await stop(server);
  }
});

test("a pinned settlement key refuses an unsigned adapter and removes no credits", async () => {
  const signer = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const adapter: SettlementAdapter = {
    name: "unsigned-chain",
    async settle(request) {
      return { settlementId: `tx-${request.reference}` };
    },
  };
  const store = new RarextStore();
  const { server, base } = await start(store, { settlement: adapter, settlementKey: signer.keyId });
  try {
    const alice = registerKey(store, "alice");
    store.addCredit(credit(alice.keyId, 12) as never);

    const redeem = instruction(alice.keyId, 5, "chain:tx:0xunsigned");
    const response = await post(base, "/v1/work/redeem", { ...redeem, signature: alice.sign(redeem) });
    assert.equal(response.status, 502);
    assert.match(
      ((await response.json()) as { error: string }).error,
      /unsigned or signed by a key other than the pinned adapter key/,
    );

    // The ledger did not lose value the outside world cannot attribute.
    assert.equal(store.listCredits().filter((entry) => entry.action === "redeem").length, 0);
    assert.equal(store.listSettlements().length, 0);
  } finally {
    await stop(server);
  }
});

test("without an adapter a redemption is ledger-only, recorded with no settlement", async () => {
  const store = new RarextStore();
  const { server, base } = await start(store);
  try {
    const alice = registerKey(store, "alice");
    store.addCredit(credit(alice.keyId, 12) as never);
    const redeem = instruction(alice.keyId, 5);
    const response = await post(base, "/v1/work/redeem", { ...redeem, signature: alice.sign(redeem) });
    const body = (await response.json()) as { settlement: unknown; balance: number };
    assert.equal(response.status, 201);
    assert.equal(body.settlement, null);
    assert.equal(body.balance, 7);
  } finally {
    await stop(server);
  }
});
