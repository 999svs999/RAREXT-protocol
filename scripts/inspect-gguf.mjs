#!/usr/bin/env node
/**
 * Inspect a GGUF with RAREXT's own engine: report the architecture, a histogram
 * of tensor quant types, and decode the first row of every distinct type so the
 * block layout is exercised on real data.
 *
 *   node --experimental-strip-types scripts/inspect-gguf.mjs <model.gguf>
 */
import { readFileSync } from "node:fs";
import { loadEngine } from "../apps/runtime/src/engine-bundle.ts";

const path = process.argv[2];
if (path === undefined) {
  console.error("usage: inspect-gguf.mjs <model.gguf>");
  process.exit(1);
}

const NAMES = {
  0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 6: "Q5_0", 7: "Q5_1", 8: "Q8_0",
  10: "Q2_K", 11: "Q3_K", 12: "Q4_K", 13: "Q5_K", 14: "Q6_K", 15: "Q8_K",
  16: "IQ2_XXS", 17: "IQ2_XS", 18: "IQ3_XXS", 19: "IQ1_S", 20: "IQ4_NL",
  21: "IQ3_S", 22: "IQ2_S", 23: "IQ4_XS", 26: "I32", 28: "F64", 29: "IQ1_M", 30: "BF16",
};

const bytes = readFileSync(path);
const engine = loadEngine(readFileSync(new URL("../apps/runtime/engines/rarext-gguf-engine.js", import.meta.url)));
const magic = bytes.length >= 4 ? bytes.toString("latin1", 0, 4) : "";
const isContainer = magic === "RXHF";
const parsed = isContainer
  ? engine.parseContainer(new Uint8Array(bytes))
  : engine.parseGguf(new Uint8Array(bytes));
console.log("container:", isContainer ? "RXHF" : "GGUF");
console.log("architecture:", parsed.kv["general.architecture"]);
console.log("file_type:", parsed.kv["general.file_type"]);

const tensors = Object.values(parsed.tensors);
const histogram = new Map();
for (const tensor of tensors) histogram.set(tensor.type, (histogram.get(tensor.type) ?? 0) + 1);
console.log("tensors:", tensors.length);
for (const [type, count] of [...histogram].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${(NAMES[type] ?? `type ${type}`).padEnd(9)} ${count}`);
}

const model = { kind: isContainer ? "hf" : "gguf", bytes: new Uint8Array(bytes) };
for (const type of [...histogram.keys()].sort((a, b) => a - b)) {
  const tensor = tensors.find((t) => t.type === type);
  const row = Array.from(engine.dequantTensor(model, tensor.name, 0));
  const finite = row.every((v) => Number.isFinite(v));
  const sample = row.slice(0, 6).map((v) => v.toFixed(4)).join(", ");
  console.log(`${(NAMES[type] ?? `type ${type}`).padEnd(9)} ${tensor.name.padEnd(28)} [${sample} …] finite=${finite}`);
}
