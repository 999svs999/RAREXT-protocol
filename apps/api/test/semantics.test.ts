import assert from "node:assert/strict";
import test from "node:test";

import type { Challenge, Publication, Semantics } from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

const halfAdder: Challenge = {
  id: "half-adder",
  app: "logic",
  title: "Add two bits",
  description: "Turn the answer on when exactly one start is on.",
  version: 1,
  spec: {
    id: "half-adder",
    title: "Add two bits",
    description: "Turn the answer on when exactly one start is on.",
    inputs: ["a", "b"],
    outputs: ["sum", "carry"],
    referenceGateCount: 5,
    cases: [
      { inputs: { a: 0, b: 0 }, outputs: { sum: 0, carry: 0 } },
      { inputs: { a: 0, b: 1 }, outputs: { sum: 1, carry: 0 } },
      { inputs: { a: 1, b: 0 }, outputs: { sum: 1, carry: 0 } },
      { inputs: { a: 1, b: 1 }, outputs: { sum: 0, carry: 1 } },
    ],
  },
  semanticsId: "logic/half-adder",
  semanticsVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const passingCircuit = {
  components: [
    { id: "a", type: "INPUT" as const },
    { id: "b", type: "INPUT" as const },
    { id: "n3", type: "NAND" as const, inputs: ["a", "b"] },
    { id: "n1", type: "NAND" as const, inputs: ["a", "n3"] },
    { id: "n2", type: "NAND" as const, inputs: ["b", "n3"] },
    { id: "n4", type: "NAND" as const, inputs: ["n1", "n2"] },
    { id: "n5", type: "NAND" as const, inputs: ["n3", "n3"] },
    { id: "sum", type: "OUTPUT" as const, inputs: ["n4"] },
    { id: "carry", type: "OUTPUT" as const, inputs: ["n5"] },
  ],
};

test("semantics are published with their hash and binding", async () => {
  const { server, base } = await start(undefined, {
    challenges: {
      list: () => [halfAdder],
      get: (id: string) => (id === halfAdder.id ? halfAdder : null),
    },
  });

  try {
    const response = await fetch(`${base}/v1/semantics`);
    assert.equal(response.status, 200);

    const records = (await response.json()) as (Semantics & { semanticsHash: string })[];
    const record = records.find((item) => item.id === "logic/half-adder");

    assert.ok(record, "expected the built-in logic semantics");
    assert.equal(record.version, 1);
    assert.equal(record.claimKind, "satisfies");
    assert.equal(record.origin, "declared");
    assert.equal(record.semanticsHash.length, 64);

    const single = await fetch(`${base}/v1/semantics/logic/half-adder`);
    assert.equal(single.status, 200);

    const missing = await fetch(`${base}/v1/semantics/nope/nope`);
    assert.equal(missing.status, 404);

    const challenges = (await (
      await fetch(`${base}/v1/challenges`)
    ).json()) as (Challenge & { semanticsBinding: string; semanticsHash: string })[];

    assert.equal(challenges.length, 1);
    assert.equal(challenges[0]?.semanticsId, "logic/half-adder");
    assert.ok(challenges[0]?.semanticsHash);
  } finally {
    await stop(server);
  }
});

test("a challenge whose spec drifts from its meaning is reported", async () => {
  const drifted: Challenge = {
    ...halfAdder,
    spec: { ...(halfAdder.spec as Record<string, unknown>), cases: [] },
  };

  const { server, base } = await start(undefined, {
    challenges: {
      list: () => [drifted],
      get: (id: string) => (id === drifted.id ? drifted : null),
    },
  });

  try {
    const challenges = (await (
      await fetch(`${base}/v1/challenges`)
    ).json()) as (Challenge & { semanticsBinding: string })[];

    assert.equal(challenges[0]?.semanticsBinding, "spec-mismatch");
  } finally {
    await stop(server);
  }
});

test("published artifacts carry a claim bound to the meaning", async () => {
  const { server, base } = await start(undefined, {
    challenges: {
      list: () => [halfAdder],
      get: (id: string) => (id === halfAdder.id ? halfAdder : null),
    },
  });

  try {
    const response = await post(base, "/v1/artifacts", {
      author: "alice",
      title: "Adding machine",
      challengeId: halfAdder.id,
      artifact: {
        app: "logic",
        kind: "logic.netlist",
        version: 1,
        mediaType: "application/json",
        body: passingCircuit,
      },
    });

    assert.equal(response.status, 201);

    const publication = (await response.json()) as Publication;
    assert.equal(publication.attestation.semanticsId, "logic/half-adder");
    assert.equal(publication.attestation.semanticsVersion, 1);
    assert.equal(publication.attestation.claimKind, "satisfies");
    assert.equal(publication.attestation.semanticsHash.length, 64);
    assert.equal(publication.attestation.verifierHash.length, 64);
  } finally {
    await stop(server);
  }
});

test("a claim kind the meaning does not license is rejected", async () => {
  const { server, base } = await start(undefined, {
    challenges: {
      list: () => [halfAdder],
      get: (id: string) => (id === halfAdder.id ? halfAdder : null),
    },
  });

  try {
    const response = await post(base, "/v1/artifacts", {
      author: "alice",
      title: "Claiming something else",
      challengeId: halfAdder.id,
      claim: { kind: "attests" },
      artifact: {
        app: "logic",
        kind: "logic.netlist",
        version: 1,
        mediaType: "application/json",
        body: passingCircuit,
      },
    });

    assert.equal(response.status, 422);

    const payload = (await response.json()) as { error: string };
    assert.match(payload.error, /licenses "satisfies" claims/);
  } finally {
    await stop(server);
  }
});

test("a claim scope outside the meaning is rejected", async () => {
  const { server, base } = await start(undefined, {
    challenges: {
      list: () => [halfAdder],
      get: (id: string) => (id === halfAdder.id ? halfAdder : null),
    },
  });

  try {
    const response = await post(base, "/v1/artifacts", {
      author: "alice",
      title: "Scoped claim",
      challengeId: halfAdder.id,
      claim: { scope: { payroll: "2024-Q3" } },
      artifact: {
        app: "logic",
        kind: "logic.netlist",
        version: 1,
        mediaType: "application/json",
        body: passingCircuit,
      },
    });

    assert.equal(response.status, 422);

    const payload = (await response.json()) as { error: string };
    assert.match(payload.error, /not part of logic\/half-adder@1/);
  } finally {
    await stop(server);
  }
});
