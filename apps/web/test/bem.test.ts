import test from "node:test";
import assert from "node:assert/strict";

import { bemReadout, formatTokenAmount, parseBemStatus } from "../src/bem.ts";

const CONTRACT = "0x5555555555555555555555555555555555555555";
const ADDRESS = "0x3333333333333333333333333333333333333333";

function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configured: true,
    chainId: "56",
    blockNumber: "256",
    bemContract: CONTRACT,
    bemDecimals: 18,
    address: ADDRESS,
    bemBalance: "1234500000000000000000",
    ...overrides,
  };
}

test("formats base units with the token decimals", () => {
  assert.equal(formatTokenAmount("0", 18), "0");
  assert.equal(formatTokenAmount("1", 18), "0.000000000000000001");
  assert.equal(formatTokenAmount("1000000000000000000", 18), "1");
  assert.equal(formatTokenAmount("1234500000000000000000", 18), "1,234.5");
  assert.equal(formatTokenAmount("123456789", 6), "123.456789");
  assert.equal(formatTokenAmount("5", 0), "5");
});

test("fixture: a configured status renders the $BEM amount", () => {
  assert.deepEqual(bemReadout(parseBemStatus(fixture())), {
    kind: "amount",
    amount: "1,234.5",
  });
});

test("fixture: a zero balance renders zero, not empty", () => {
  const status = parseBemStatus(fixture({ bemBalance: "0" }));
  assert.deepEqual(bemReadout(status), { kind: "amount", amount: "0" });
});

test("fixture: an unconfigured status has nothing to show", () => {
  assert.deepEqual(bemReadout(parseBemStatus({ configured: false })), { kind: "empty" });
});

test("fixture: an RPC error renders unavailable", () => {
  const status = parseBemStatus(
    fixture({ bemBalance: null, error: "RPC returned 500" }),
  );
  assert.deepEqual(bemReadout(status), { kind: "unavailable" });
});

test("fixture: a missing balance renders unavailable", () => {
  const status = parseBemStatus(fixture({ bemBalance: null }));
  assert.deepEqual(bemReadout(status), { kind: "unavailable" });
});

test("parseBemStatus falls back to 18 decimals for junk input", () => {
  assert.equal(parseBemStatus({ bemDecimals: "x" }).bemDecimals, 18);
  assert.equal(parseBemStatus({ bemDecimals: 99 }).bemDecimals, 18);
  assert.equal(parseBemStatus({ bemDecimals: -1 }).bemDecimals, 18);
  assert.equal(parseBemStatus({ bemDecimals: 6 }).bemDecimals, 6);
});
