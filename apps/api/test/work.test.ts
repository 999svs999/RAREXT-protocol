import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type { JsonWebKey } from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

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
    ).json()) as { credits: number; byAction: Record<string, { jobs: number }> };

    assert.equal(earnings.credits, result.bounty);
    assert.equal(earnings.byAction.verify?.jobs, 1);
  } finally {
    await stop(server);
  }
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
