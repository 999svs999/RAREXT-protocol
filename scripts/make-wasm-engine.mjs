#!/usr/bin/env node
/**
 * Emit a minimal third-party engine as a WebAssembly binary, to prove the
 * provider runs a foreign engine with NO container runtime. The module exports
 * `memory` and `run(promptPtr, len, steps, seed) -> i32` (a NUL-terminated UTF-8
 * pointer), which is the ABI `loadWasmEngine` drives.
 *
 *   node scripts/make-wasm-engine.mjs <out.wasm> ["some text"]
 */
import { writeFileSync } from "node:fs";

const out = process.argv[2];
if (out === undefined) {
  console.error("usage: make-wasm-engine.mjs <out.wasm> [text]");
  process.exit(1);
}
const text = process.argv[3] ?? "third-party wasm engine online";

const uleb = (value) => {
  const bytes = [];
  let v = value;
  for (;;) {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
    if (v === 0) return bytes;
  }
};
const utf8 = (value) => Array.from(Buffer.from(value, "utf8"));
const section = (id, body) => [id, ...uleb(body.length), ...body];
const dataOffset = 16;
const dataBytes = [...utf8(text), 0];

const module = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ...section(1, [1, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f]), // (i32,i32,i32,i32)->i32
  ...section(3, [1, 0]), // one function of type 0
  ...section(5, [1, 0x00, 0x01]), // one memory page
  ...section(7, [
    2,
    ...uleb(6), ...utf8("memory"), 0x02, 0x00,
    ...uleb(3), ...utf8("run"), 0x00, 0x00,
  ]),
  ...section(10, [1, ...uleb(4), 0x00, 0x41, ...uleb(dataOffset), 0x0b]), // return i32.const dataOffset
  ...section(11, [1, 0x00, 0x41, ...uleb(dataOffset), 0x0b, ...uleb(dataBytes.length), ...dataBytes]),
]);

writeFileSync(out, module);
console.error(`wrote ${out} (${module.length} bytes): "${text}"`);
