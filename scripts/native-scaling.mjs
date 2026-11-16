#!/usr/bin/env node
/**
 * native-scaling.mjs — collect the native-model training runs into one artifact.
 *
 * Reads every `bench/native/*.json` training report, orders the runs by the
 * compute they spent, and writes `bench/native/scaling.json`. The point is to
 * show, with numbers RAREXT produced on this host, that capability moves when
 * RAREXT is given more compute — so the honest question is "how much compute",
 * never "whose checkpoint do we borrow".
 *
 *   npm run bench:native
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "bench/native");
if (!existsSync(dir)) {
  console.error("no bench/native — run `npm run train:native` first");
  process.exit(1);
}

const reports = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && f !== "scaling.json")
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
  .filter((r) => r.kind === "rarext.native-lm-training.v1");

// "Compute" is parameter-updates: params x steps. It is the quantity a bigger
// box buys, and the only one this host can actually increase.
for (const r of reports) {
  r.compute = r.params * r.config.steps;
}
reports.sort((a, b) => a.compute - b.compute);

const corpus = readFileSync(join(dir, "corpus.txt"));
const artifact = {
  kind: "rarext.native-scaling.v1",
  host: "Intel i5-8257U · 8 GiB · macOS · Node " + process.version,
  corpus: {
    path: "bench/native/corpus.txt",
    bytes: corpus.length,
    sha256: createHash("sha256").update(corpus).digest("hex"),
  },
  claim:
    "A RAREXT-native language model trained from a seeded initialization on RAREXT's own corpus. No pretrained weights, no downloaded checkpoint, no framework, no network.",
  runs: reports.map((r) => ({
    label: r.label,
    container: r.container,
    containerSha256: r.containerSha256,
    architecture: { context: r.config.context, dim: r.config.dim, hidden: r.config.hidden },
    params: r.params,
    steps: r.config.steps,
    compute: r.compute,
    seconds: r.final.seconds,
    heldLossNatsPerByte: r.final.heldLoss,
    heldBitsPerByte: r.final.bitsPerByte,
    pretrained: r.lineage.pretrained,
    externalModelBytes: r.lineage.externalModelBytes,
  })),
};

writeFileSync(join(dir, "scaling.json"), `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`native scaling · ${reports.length} run(s) · corpus sha256 ${artifact.corpus.sha256.slice(0, 16)}…\n`);
console.log("  label               params    steps       compute   held nats/byte  bits/byte");
for (const r of artifact.runs) {
  console.log(
    `  ${r.label.padEnd(18)} ${String(r.params).padStart(7)} ${String(r.steps).padStart(8)} ${String(r.compute).padStart(13)} ${r.heldLossNatsPerByte.toFixed(4).padStart(14)} ${r.heldBitsPerByte.toFixed(3).padStart(10)}`,
  );
}
const pretrained = artifact.runs.some((r) => r.pretrained === true || r.externalModelBytes !== 0);
console.log(`\n  pretrained weights on any run: ${pretrained ? "YES" : "none"}`);
console.log("  wrote bench/native/scaling.json");
