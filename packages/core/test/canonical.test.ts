import test from "node:test";
import assert from "node:assert/strict";

import { canonicalize, simulate } from "../src/index.ts";
import type { Circuit } from "../src/index.ts";

test("canonical JSON is independent of key order", () => {
  const a = { b: 1, a: { d: [3, 2], c: "x" } };
  const b = { a: { c: "x", d: [3, 2] }, b: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
});

test("canonical JSON drops undefined object fields", () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}');
});

test("simulation traces are deterministic", () => {
  const circuit: Circuit = {
    components: [
      { id: "a", type: "INPUT" },
      { id: "n", type: "NAND", inputs: ["a", "a"] },
      { id: "y", type: "OUTPUT", inputs: ["n"] },
    ],
  };

  const first = simulate(circuit, { a: 0 });
  const second = simulate(circuit, { a: 0 });

  assert.equal(first.trace.length > 0, true);
  assert.equal(canonicalize(first.trace), canonicalize(second.trace));
});
