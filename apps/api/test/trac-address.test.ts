import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalTracAddress,
  hexToTrac,
  tracToHex,
} from "../src/adapters/trac-address.ts";

const HEX = "fe947e14ea4d8a1ebc6084a9d9f7d59a39d69391def69e539d2c10c808d4c1ef";
const TRAC = "trac1l628u982fk9pa0rqsj5ana74nguadyu3mmmfu5ua9sgvszx5c8hsg9exft";

test("trac1 addresses decode to the 64-hex key", () => {
  assert.equal(tracToHex(TRAC), HEX);
  assert.equal(tracToHex(TRAC.toUpperCase()), HEX);
  assert.equal(tracToHex(TRAC.slice(0, -1) + "q"), null);
  assert.equal(tracToHex("tnk1" + TRAC.slice(5)), null);
  assert.equal(tracToHex(TRAC.slice(0, 10) + TRAC.slice(10).toUpperCase()), null);
  assert.equal(tracToHex("trac1qqqqqqqqqqqqqq"), null);
  assert.equal(tracToHex(HEX), null);
  assert.equal(tracToHex(""), null);
  assert.equal(tracToHex(42), null);
});

test("hex keys round-trip back to canonical trac1 addresses", () => {
  assert.equal(hexToTrac(HEX), TRAC);
  assert.equal(hexToTrac(HEX.toUpperCase()), null);
  assert.equal(hexToTrac("ab"), null);
  assert.equal(hexToTrac("zz"), null);
});

test("canonicalTracAddress accepts hex or trac1 and rejects the rest", () => {
  assert.equal(canonicalTracAddress(HEX), HEX);
  assert.equal(canonicalTracAddress(TRAC), HEX);
  assert.equal(canonicalTracAddress("nope"), null);
  assert.equal(canonicalTracAddress("trac1qqqqqqqqqqqqqq"), null);
});
