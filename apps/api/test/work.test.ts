import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { CREDIT_ROOT_FIELDS, creditRoot } from "../../../packages/core/src/index.ts";
import { canonicalize } from "../../../packages/core/src/index.ts";
import type { JsonWebKey } from "../../../packages/core/src/index.ts";
import type { CreditRecord } from "../src/work.ts";
import { post, start, stop } from "./helpers.ts";

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const publicJwk = pair.publicKey.export({ format: "jwk" }) as JsonWebKey;

const CHESS_ARTIFACT = {
  app: "chess",
  kind: "chess.moves",
  version: 1,
  mediaType: "application/json",
  body: { moves: ["a1a8"] },
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(submission: {
  challengeId: string;
  artifact: unknown;
  attestation: Record<string, unknown>;
  worker: { keyId: string };
}): string {
  return sha256(
    canonicalize({
      challengeId: submission.challengeId,
      artifact: submission.artifact,
      attestation: submission.attestation,
      worker: { keyId: submission.worker.keyId },
    }),
  );
}

function worker(keyId: string, challengeId = "half-adder") {
  const submission = {
    challengeId,
    artifact: CHESS_ARTIFACT,
    attestation: {
      circuitHash: "",
      traceHash: "",
      correct: true,
      score: 1000,
      gateCount: 0,
      proof: {},
    },
    worker: { keyId },
  };

  const signature = sign(
    "sha256",
    Buffer.from(digest(submission), "utf8"),
    { key: pair.privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64");

  return { ...submission, worker: { keyId, publicKey: publicJwk, signature } };
}

test("the work board lists the actions and the open jobs", async () => {
  const { server, base } = await start();

  try {
    const response = await fetch(`${base}/v1/work?keyId=wk`);
    assert.equal(response.status, 200);

    const board = (await response.json()) as {
      actions: { id: string; base: number; unit: string }[];
      orders: { id: string; bounty: number; action: string }[];
    };

    const ids = board.actions.map((action) => action.id);
    for (const expected of [
      "verify",
      "store",
      "mirror",
      "relay",
      "publish",
      "remix",
      "report",
    ]) {
      assert.ok(ids.includes(expected), `expected the ${expected} action`);
    }

    // Different actions pay differently.
    const bases = board.actions.map((action) => action.base);
    assert.equal(new Set(bases).size, bases.length, "each action pays differently");

    for (const order of board.orders) {
      assert.equal(order.action, "verify");
      assert.ok(order.bounty > 0);
    }
  } finally {
    await stop(server);
  }
});

test("a worker is paid for work the registry agrees with", async () => {
  const { server, base } = await start();

  try {
    const board = (await (await fetch(`${base}/v1/work?keyId=wk`)).json()) as {
      orders: {
        id: string;
        challengeId: string;
        artifact: unknown;
        challenge: { id: string; app: string; spec: unknown };
      }[];
    };

    const order = board.orders.find((candidate) => candidate.challengeId === "half-adder");
    assert.ok(order, "expected the logic sample job");

    // The attestation the registry would produce for this artifact.
    const expected = (await (
      await post(base, "/v1/artifacts", {
        author: "probe",
        title: "Probe",
        challengeId: order.challengeId,
        artifact: order.artifact,
      })
    ).json()) as { attestation: { circuitHash: string; traceHash: string } };

    const submission = worker("wk", order.challengeId);
    submission.artifact = order.artifact as typeof CHESS_ARTIFACT;
    submission.attestation = {
      circuitHash: expected.attestation.circuitHash,
      traceHash: expected.attestation.traceHash,
      correct: true,
      score: 1000,
      gateCount: 0,
      proof: {},
    };
    submission.worker.signature = sign(
      "sha256",
      Buffer.from(digest(submission), "utf8"),
      { key: pair.privateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64");

    const response = await post(base, "/v1/verifications", submission);
    assert.equal(response.status, 201);

    const result = (await response.json()) as {
      accepted: boolean;
      bounty: number;
      earnings: { credits: number };
    };

    assert.equal(result.accepted, true);
    assert.ok(result.bounty > 0);
    assert.equal(result.earnings.credits, result.bounty);

    const earnings = (await (
      await fetch(`${base}/v1/work/earnings?keyId=wk`)
    ).json()) as {
      credits: number;
      byAction: Record<string, { jobs: number }>;
      records: Array<CreditRecord & { root: string }>;
    };

    assert.equal(earnings.credits, result.bounty);
    assert.equal(earnings.byAction.verify?.jobs, 1);

    // The RECEIPTS travel with the summary, and each one carries the identity a verifier can
    // recompute from the receipt itself — including from the response AS IT ARRIVED, with the root
    // the node attached, because presentation keys are not part of the record.
    assert.equal(earnings.records.length, 1);
    const receipt = earnings.records[0]!;
    assert.equal(receipt.keyId, "wk");
    assert.equal(receipt.root, creditRoot(receipt, hash));
    assert.equal(creditRoot(earnings.records[0] as unknown as CreditRecord, hash), receipt.root);
  } finally {
    await stop(server);
  }
});

test("every field of the API's credit record is a decision core holds: covered, with no labels", () => {
  // The board (which actions exist, what they pay) is this node's policy; the IDENTITY of what it
  // pays out is the protocol's. This is the seam: the API's type must have no field that core's
  // field map does not decide on, or a new field would silently sit outside the receipt's identity.
  const mutators: Record<keyof CreditRecord, (entry: CreditRecord) => void> = {
    keyId: (entry) => { entry.keyId = "other"; },
    action: (entry) => { entry.action = "mirror"; },
    bounty: (entry) => { entry.bounty = 999; },
    challengeId: (entry) => { entry.challengeId = "other"; },
    artifactHash: (entry) => { entry.artifactHash = "e".repeat(64); },
    at: (entry) => { entry.at = "2026-11-02T00:00:00.000Z"; },
  };

  const base: CreditRecord = {
    keyId: "wk",
    action: "verify",
    bounty: 12,
    challengeId: "gen-starter",
    artifactHash: "c".repeat(64),
    at: "2026-11-01T00:00:00.000Z",
  };
  const baseRoot = creditRoot(base, hash);
  const tried: string[] = [];

  for (const [field, mutate] of Object.entries(mutators)) {
    const entry: CreditRecord = { ...base };
    mutate(entry);
    assert.notEqual(creditRoot(entry, hash), baseRoot, `${field} is part of the payment`);
    tried.push(field);
    assert.equal(CREDIT_ROOT_FIELDS[field as keyof typeof CREDIT_ROOT_FIELDS], true);
  }

  assert.deepEqual(tried.sort(), Object.keys(base).sort(), "every field of the API's type was decided on");
  assert.deepEqual(Object.keys(CREDIT_ROOT_FIELDS).sort(), Object.keys(base).sort());
});

test("the same work is never paid twice", async () => {
  const { server, base } = await start();

  try {
    const board = (await (await fetch(`${base}/v1/work?keyId=wk`)).json()) as {
      orders: { challengeId: string; artifact: unknown }[];
    };

    const order = board.orders.find((candidate) => candidate.challengeId === "half-adder");
    assert.ok(order);

    const expected = (await (
      await post(base, "/v1/artifacts", {
        author: "probe",
        title: "Probe",
        challengeId: order.challengeId,
        artifact: order.artifact,
      })
    ).json()) as { attestation: { circuitHash: string; traceHash: string } };

    const submission = worker("wk", order.challengeId);
    submission.artifact = order.artifact as typeof CHESS_ARTIFACT;
    submission.attestation = {
      circuitHash: expected.attestation.circuitHash,
      traceHash: expected.attestation.traceHash,
      correct: true,
      score: 1000,
      gateCount: 0,
      proof: {},
    };
    submission.worker.signature = sign(
      "sha256",
      Buffer.from(digest(submission), "utf8"),
      { key: pair.privateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64");

    const first = await post(base, "/v1/verifications", submission);
    assert.equal(first.status, 201);

    const second = await post(base, "/v1/verifications", submission);
    assert.equal(second.status, 409);
  } finally {
    await stop(server);
  }
});

test("an attestation that does not match the verifier is refused", async () => {
  const { server, base } = await start();

  try {
    const submission = worker("wk", "half-adder");
    submission.attestation = {
      circuitHash: "0".repeat(64),
      traceHash: "0".repeat(64),
      correct: true,
      score: 1000,
      gateCount: 0,
      proof: {},
    };
    submission.worker.signature = sign(
      "sha256",
      Buffer.from(digest(submission), "utf8"),
      { key: pair.privateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64");

    const response = await post(base, "/v1/verifications", submission);
    assert.equal(response.status, 422);
  } finally {
    await stop(server);
  }
});
