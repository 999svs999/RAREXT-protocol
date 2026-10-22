import assert from "node:assert/strict";
import test from "node:test";

import type { Challenge, Publication } from "../../../packages/core/src/index.ts";
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

const artifact = {
  app: "logic",
  kind: "logic.netlist",
  version: 1,
  mediaType: "application/json",
  body: passingCircuit,
};

test("a published claim verifies against the recomputed meaning", async () => {
  const { server, base } = await start(undefined, {
    challenges: {
      list: () => [halfAdder],
      get: (id: string) => (id === halfAdder.id ? halfAdder : null),
    },
  });

  try {
    const published = await post(base, "/v1/artifacts", {
      author: "alice",
      title: "Adding machine",
      challengeId: halfAdder.id,
      artifact,
    });

    assert.equal(published.status, 201);

    const publication = (await published.json()) as Publication;
    const verified = await post(base, "/v1/verify", {
      publicationId: publication.id,
    });

    assert.equal(verified.status, 200);

    const result = (await verified.json()) as { valid: boolean };
    assert.equal(result.valid, true);
  } finally {
    await stop(server);
  }
});
