#!/usr/bin/env node
/**
 * build-native-corpus.mjs — freeze the text RAREXT grows its own model on.
 *
 * The point of a RAREXT-native model is that nothing about it is borrowed: not
 * the weights, and not the corpus. This script reads ONLY files in this
 * repository, strips formatting that is not prose, and writes one deterministic
 * snapshot. Same checkout => same snapshot => same digest => same model.
 *
 *   node scripts/build-native-corpus.mjs [maxBytes]
 *
 * Output: bench/native/corpus.txt (committed), and a digest line on stdout.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "bench/native");
const OUT = join(OUT_DIR, "corpus.txt");
const MAX = Number(process.argv[2] ?? 320_000);

// A fixed list, in a fixed order: the snapshot must not depend on directory
// enumeration order. These are RAREXT's own documents.
const FILES = [
  "README.md",
  "CHANGELOG.md",
  "ROADMAP.md",
  "docs/SOTA-COMPARISON.md",
  "docs/AI-CAPABILITY-AUDIT.md",
  "docs/WEB4-MODEL.md",
  "docs/AI-VERIFICATION.md",
  "docs/MODEL-RUNTIME.md",
  "docs/CLOUD-RUNTIME.md",
  "docs/OPERATIONS.md",
  "docs/LAUNCH.md",
  "docs/GLOSSARY.md",
  "docs/AUDIT.md",
  "docs/UI-UX-BENCHMARK.md",
  "docs/STORAGE-SECURITY.md",
];

/** Prose from one document: no fences, no inline code, no markup, no URLs. */
function prose(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, "")
    .replace(/^\s*\|/gm, "")
    .replace(/\|\s*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const chunks = [];
let bytes = 0;
for (const file of FILES) {
  let raw;
  try {
    raw = readFileSync(join(root, file), "utf8");
  } catch {
    continue;
  }
  const text = prose(raw);
  if (text.length === 0) continue;
  const block = `${text}\n\n`;
  if (bytes + block.length > MAX) {
    chunks.push(block.slice(0, MAX - bytes));
    bytes = MAX;
    break;
  }
  chunks.push(block);
  bytes += block.length;
}

const corpus = chunks.join("").replace(/[ \t]+$/gm, "").trimEnd() + "\n";
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, corpus);

const digest = createHash("sha256").update(corpus).digest("hex");
const distinct = new Set([...Buffer.from(corpus, "utf8")]);
console.log(`corpus   ${OUT}`);
console.log(`bytes    ${Buffer.byteLength(corpus, "utf8")}`);
console.log(`chars    ${corpus.length}`);
console.log(`distinct ${distinct.size} byte values`);
console.log(`sha256   ${digest}`);
console.log(`sources  ${FILES.length} RAREXT documents`);
