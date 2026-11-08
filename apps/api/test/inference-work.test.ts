import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

import {
  canonicalize,
  creditLeaf,
  creditLedgerRoot,
  inferenceCreditLedgerRoot,
  inferenceCreditRecords,
  verifyProof,
} from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const bytesSha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

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
    sign(claim: Record<string, unknown>): string {
      const { signature: _ignored, ...rest } = claim as { signature?: string };
      return signBytes("sha256", Buffer.from(canonicalize(rest)), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64");
    },
  };
}

const AGREED = "a".repeat(64);

function runBody(operators: string[], bounty = 12) {
  const providers = operators.map((operator, index) => ({
    endpoint: `https://provider-${index}.example`,
    responseDigest: AGREED,
    operator,
  }));
  const base = {
    providers,
    responseDigest: AGREED,
    deploymentDigest: "d".repeat(64),
    completedAt: "2026-11-08T00:00:00.000Z",
    bounty,
  };
  return {
    kind: "rarext.model-run.v1",
    deployment: { id: "model-run-demo", digest: "d".repeat(64) },
    model: { id: "rarext-native-proof", weightsDigest: `sha256:${"e".repeat(64)}` },
    engine: { name: "openai-compatible", version: "web4" },
    quorum: { required: operators.length, responded: operators.length, agreed: operators.length, providers },
    credits: {
      action: "infer",
      bounty,
      paid: operators.length,
      ledgerRoot: inferenceCreditLedgerRoot(base, (value) =>
        createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex"),
      ),
    },
    response: { body: { text: "hi" }, digest: AGREED, bytes: 12 },
    completedAt: "2026-11-08T00:00:00.000Z",
  };
}

/** Put an attested, anchored run into the store the way the node would have. */
function anchorRun(
  store: Awaited<ReturnType<typeof start>>["store"],
  body: Record<string, unknown>,
): string {
  const runDigest = sha256(canonicalize(body));
  const id = "run-publication";
  store.addPublication({
    id,
    author: "model-run",
    authorKey: null,
    signatureAlgorithm: "ecdsa-p256",
    title: "a model run",
    body: "",
    app: "ai-model-run",
    challengeId: "model-run-demo",
    artifact: { app: "ai-model-run", kind: "ai.model-run", version: 1, mediaType: "application/json", body },
    taskId: "model-run-demo",
    visibility: "public",
    artifactCommitment: null,
    parentId: null,
    source: null,
    createdAt: "2026-11-08T00:00:00.000Z",
    attestedAt: "2026-11-08T00:00:00.000Z",
    verified: true,
    signature: null,
    nonce: null,
    attestation: {
      id: "att-run",
      verifier: "rarext-runtime",
      taskId: "model-run-demo",
      circuitHash: "1".repeat(64),
      traceHash: "2".repeat(64),
      correct: true,
      score: 1,
      gateCount: 1,
      semanticsId: "ai-model-run",
      semanticsVersion: 1,
      semanticsHash: "3".repeat(64),
      claimKind: "satisfies",
      scope: null,
      verifierHash: "4".repeat(64),
      proofKind: "exact",
      signatureAlgorithm: "ecdsa-p256",
      cryptoProfile: "classical",
      createdAt: "2026-11-08T00:00:00.000Z",
    },
  } as never);
  store.addAnchor({
    id: "anchor-run",
    root: "f".repeat(64),
    publicationIds: [id],
    leafCount: 1,
    createdAt: "2026-11-08T00:00:00.000Z",
    adapter: "local",
    reference: null,
    receipts: [],
  } as never);
  return runDigest;
}

function claimFor(operator: string, runDigest: string) {
  return {
    kind: "rarext.inference-work.v1",
    operator,
    runDigest,
    at: new Date().toISOString(),
  };
}

test("a provider is paid for the model run it answered, and can prove it", async () => {
  const { server, store, base } = await start();
  try {
    const alice = registerKey(store, "provider-alice");
    const bob = registerKey(store, "provider-bob");
    const runDigest = anchorRun(store, runBody([alice.keyId, bob.keyId]));

    const claim = claimFor(alice.keyId, runDigest);
    const claimed = await post(base, "/v1/work/inference", { ...claim, signature: alice.sign(claim) });
    const claimedText = await claimed.text();
    assert.equal(claimed.status, 201, claimedText);
    const receipt = (JSON.parse(claimedText) as {
      receipt: {
        keyId: string;
        action: string;
        bounty: number;
        challengeId: string;
        artifactHash: string;
        root: string;
        ledger: { root: string; index: number; proof: string[] };
      };
    }).receipt;

    assert.equal(receipt.action, "infer", "the receipt names the inference act");
    assert.equal(receipt.bounty, 12, "the operator earned the committed bounty");
    assert.equal(receipt.keyId, alice.keyId);
    assert.equal(receipt.artifactHash, AGREED, "the receipt is for the answer the run carries");
    assert.equal(receipt.challengeId, "d".repeat(64), "and under the deployment that paid it");
    // The claim named the run; the record names the agreed answer plus the run's
    // own completion time, which is what makes it unique to this run.
    assert.equal((JSON.parse(claimedText) as { receipt: { at: string } }).receipt.at, "2026-11-08T00:00:00.000Z");

    // The receipt proves against the ledger the node committed to.
    const fields = {
      keyId: receipt.keyId,
      action: receipt.action,
      bounty: receipt.bounty,
      challengeId: receipt.challengeId,
      artifactHash: receipt.artifactHash,
      at: (JSON.parse(claimedText) as { receipt: { at: string } }).receipt.at,
    };
    const nodeHash = (value: string | Uint8Array) =>
      createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");
    assert.equal(
      verifyProof(
        creditLeaf(fields, nodeHash),
        receipt.ledger.proof,
        receipt.ledger.root,
        receipt.ledger.index,
        bytesSha256,
      ),
      true,
    );

    // The ledger root is the commitment over the payments the run implied. At
    // this point only Alice has claimed, so the ledger holds just her receipt.
    const implied = inferenceCreditRecords({
      providers: [
        { responseDigest: AGREED, operator: alice.keyId },
        { responseDigest: AGREED, operator: bob.keyId },
      ],
      responseDigest: AGREED,
      deploymentDigest: "d".repeat(64),
      completedAt: "2026-11-08T00:00:00.000Z",
      bounty: 12,
    });
    assert.equal(implied.length, 2, "the run implied two payments");
    assert.equal(receipt.ledger.root, creditLedgerRoot([fields], nodeHash));

    // The second operator claims the same run and joins the same ledger, which
    // is then exactly the two payments the run implied.
    const bobClaim = claimFor(bob.keyId, runDigest);
    const bobPaid = await post(base, "/v1/work/inference", {
      ...bobClaim,
      signature: bob.sign(bobClaim),
    });
    const bobText = await bobPaid.text();
    assert.equal(bobPaid.status, 201, bobText);
    const bobReceipt = (JSON.parse(bobText) as { receipt: { ledger: { root: string } } }).receipt;
    assert.equal(bobReceipt.ledger.root, creditLedgerRoot(implied, nodeHash));

    // The same run is never paid twice to the same operator.
    const again = await post(base, "/v1/work/inference", { ...claim, signature: alice.sign(claim) });
    assert.equal(again.status, 409);
    assert.match(((await again.json()) as { error: string }).error, /already been paid/);

    // The earnings view counts the inference as its own action.
    const earnings = (await (await fetch(`${base}/v1/work/earnings?keyId=${alice.keyId}`)).json()) as {
      credits: number;
      byAction: Record<string, { credits: number; jobs: number }>;
    };
    assert.equal(earnings.credits, 12);
    assert.equal(earnings.byAction.infer?.jobs, 1);
  } finally {
    await stop(server);
  }
});

test("an inference claim is refused when the node cannot corroborate the run or the payer", async () => {
  const { server, store, base } = await start();
  try {
    const alice = registerKey(store, "provider-alice");
    const carol = registerKey(store, "provider-carol");
    const runDigest = anchorRun(store, runBody([alice.keyId]));

    // An operator the run did not pay is refused, even with a valid signature.
    const unpaid = claimFor(carol.keyId, runDigest);
    const refused = await post(base, "/v1/work/inference", { ...unpaid, signature: carol.sign(unpaid) });
    assert.equal(refused.status, 403);
    assert.match(((await refused.json()) as { error: string }).error, /did not pay this operator/);

    // A run the node never anchored is refused by name.
    const unknown = claimFor(alice.keyId, "9".repeat(64));
    const missing = await post(base, "/v1/work/inference", { ...unknown, signature: alice.sign(unknown) });
    assert.equal(missing.status, 404);
    assert.match(((await missing.json()) as { error: string }).error, /cannot pay for it/);

    // A forged signature does not pay.
    const forged = await post(base, "/v1/work/inference", {
      ...claimFor(alice.keyId, runDigest),
      signature: "AAAA",
    });
    assert.equal(forged.status, 401);
  } finally {
    await stop(server);
  }
});
