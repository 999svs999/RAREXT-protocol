import test from "node:test";
import assert from "node:assert/strict";

import { findTask, score, simulate, validateCircuit } from "../src/index.ts";
import type { Circuit, Component } from "../src/index.ts";

const input = (id: string): Component => ({ id, type: "INPUT" });
const output = (id: string, source: string): Component => ({
  id,
  type: "OUTPUT",
  inputs: [source],
});
const nand = (id: string, a: string, b: string): Component => ({
  id,
  type: "NAND",
  inputs: [a, b],
});

const halfAdder: Circuit = {
  components: [
    input("a"),
    input("b"),
    nand("n1", "a", "b"),
    nand("n2", "a", "n1"),
    nand("n3", "b", "n1"),
    nand("xor", "n2", "n3"),
    nand("n5", "n1", "n1"),
    output("sum", "xor"),
    output("carry", "n5"),
  ],
};

test("NAND wired as an inverter", () => {
  const circuit: Circuit = {
    components: [
      input("a"),
      nand("n", "a", "a"),
      output("y", "n"),
    ],
  };

  for (const value of [0, 1] as const) {
    const result = simulate(circuit, { a: value });
    assert.equal(result.settled, true);
    assert.equal(result.outputs.y, value === 0 ? 1 : 0);
  }
});

test("half adder satisfies its truth table", () => {
  const expected = [
    { a: 0, b: 0, sum: 0, carry: 0 },
    { a: 0, b: 1, sum: 1, carry: 0 },
    { a: 1, b: 0, sum: 1, carry: 0 },
    { a: 1, b: 1, sum: 0, carry: 1 },
  ] as const;

  for (const row of expected) {
    const result = simulate(halfAdder, { a: row.a, b: row.b });
    assert.equal(result.settled, true);
    assert.equal(result.outputs.sum, row.sum);
    assert.equal(result.outputs.carry, row.carry);
  }
});

test("half adder scores perfectly against the reference", () => {
  const task = findTask("half-adder");
  assert.ok(task);

  const result = score(halfAdder, task);
  assert.equal(result.correct, true);
  assert.equal(result.gateCount, 5);
  assert.equal(result.score, 1000);
});

test("latch is transparent when enabled and holds when disabled", () => {
  const circuit: Circuit = {
    components: [
      input("d"),
      input("en"),
      { id: "latch", type: "LATCH", inputs: ["d", "en"] },
      output("y", "latch"),
    ],
  };

  const transparent = simulate(circuit, { d: 1, en: 1 });
  assert.equal(transparent.outputs.y, 1);

  const held = simulate(circuit, { d: 0, en: 0 }, { latch: 1 });
  assert.equal(held.outputs.y, 1);

  const reset = simulate(circuit, { d: 1, en: 0 }, { latch: 0 });
  assert.equal(reset.outputs.y, 0);
});

test("a self-inverting NAND loop is reported as unsettled", () => {
  const circuit: Circuit = {
    components: [
      nand("n", "n", "n"),
      output("y", "n"),
    ],
  };

  const result = simulate(circuit, {});
  assert.equal(result.settled, false);
});

test("validation rejects duplicate ids and dangling references", () => {
  assert.throws(
    () => validateCircuit({ components: [input("a"), input("a")] }),
    /duplicate component id/,
  );

  assert.throws(
    () => validateCircuit({ components: [nand("n", "a", "a")] }),
    /unknown input/,
  );
});

test("simulation rejects missing inputs", () => {
  const circuit: Circuit = {
    components: [input("a"), nand("n", "a", "a"), output("y", "n")],
  };

  assert.throws(() => simulate(circuit, {}), /missing or invalid input/);
});
