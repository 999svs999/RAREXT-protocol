// Runs every method over one corpus and writes a Markdown table plus JSON.
//
// The table is the gate: a representation with no row has no claim. A row whose
// decoded bytes do not match the reference digest is labelled `bounded` or
// `generative`, never `exact`.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { allRunners } from "./methods.mjs";
import { corpusStats } from "./corpus.mjs";

function now() {
  return performance.now();
}

function version(command, args = ["--version"]) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")[0]
      .trim();
  } catch {
    return null;
  }
}

function environment() {
  return {
    node: process.version,
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    ffmpeg: version("ffmpeg", ["-hide_banner", "-version"]),
    zstd: version("zstd", ["--version"]),
  };
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function classify(runner, result) {
  if (result.exact) return "exact";
  if (runner.kind === "generative") return "generative";
  return "bounded";
}

function addRow(runner, result) {
  if (result.skipped) {
    return {
      method: runner.label,
      kind: runner.kind,
      slice: result.slice ?? "—",
      skipped: true,
      reason: result.reason,
      classification: "skipped",
    };
  }

  const declaredDecoder = result.decoderBytes ?? runner.decoderBytes ?? null;

  if (runner.kind === "learned" && !(declaredDecoder > 0)) {
    throw new Error(`${runner.label}: a learned codec must declare its decoder size`);
  }

  if (runner.kind !== "classical" && !(declaredDecoder > 0)) {
    throw new Error(`${runner.label}: a ${runner.kind} representation must declare its decoder size`);
  }

  const decoderBytes = declaredDecoder;
  const totalBytes = result.storedBytes + (decoderBytes ?? 0);
  const classification = classify(runner, result);
  const notes = [...(result.notes ? [result.notes] : [])];

  if (runner.declaresExact && !result.exact) {
    notes.push("declared lossless but the decoded digest differs");
  }

  if (!result.exact && result.psnr !== null && result.psnr !== undefined) {
    notes.push(`PSNR ${result.psnr.toFixed(2)} dB`);
  }

  if (!result.exact) {
    notes.push(`${(result.errorRatio * 100).toFixed(2)}% bytes differ`);
  }

  return {
    method: runner.label,
    kind: runner.kind,
    slice: result.slice,
    inputBytes: result.inputBytes,
    storedBytes: result.storedBytes,
    decoderBytes,
    totalBytes,
    ratio: result.inputBytes / totalBytes,
    classification,
    exact: result.exact,
    errorRatio: result.errorRatio,
    psnr: result.psnr,
    verifyMs: result.verifyMs,
    decodeMs: result.decodeMs,
    encodeMs: result.encodeMs,
    referenceDigest: result.referenceDigest,
    reconstructedDigest: result.reconstructedDigest,
    notes: notes.join("; "),
  };
}

function table(rows) {
  const lines = [
    "| Method | Corpus slice | Input | Stored | Decoder | Total | Ratio | Result | Verify | Decode |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |",
  ];

  for (const row of rows) {
    if (row.skipped) {
      lines.push(
        `| ${row.method} | ${row.slice} | — | — | — | — | — | skipped: ${row.reason} | — | — |`,
      );
      continue;
    }

    const result =
      row.classification === "exact"
        ? "yes — exact"
        : `no — ${row.classification}`;

    lines.push(
      `| ${row.method} | ${row.slice} | ${formatBytes(row.inputBytes)} | ${formatBytes(row.storedBytes)} | ${row.decoderBytes ? formatBytes(row.decoderBytes) : "—"} | ${formatBytes(row.totalBytes)} | ${row.ratio.toFixed(2)}x | ${result} | ${row.verifyMs.toFixed(1)} ms | ${row.decodeMs.toFixed(1)} ms |`,
    );
  }

  return lines.join("\n");
}

function corpusTable(manifest) {
  const lines = [
    "| Slice | Modality | Bytes | SHA-256 (first 16) |",
    "| --- | --- | ---: | --- |",
  ];

  for (const slice of manifest.slices) {
    lines.push(
      `| ${slice.path} | ${slice.modality} | ${formatBytes(slice.bytes)} | \`${slice.sha256.slice(0, 16)}\` |`,
    );
  }

  return lines.join("\n");
}

const THROUGHPUT_PATH = fileURLToPath(new URL("./THROUGHPUT.md", import.meta.url));
const NETWORK_PATH = fileURLToPath(new URL("./NETWORK.md", import.meta.url));

function throughputSection() {
  if (!existsSync(THROUGHPUT_PATH)) return "";

  const section = readFileSync(THROUGHPUT_PATH, "utf8").trim();
  return section ? `\n${section}\n` : "";
}

function networkSection() {
  if (!existsSync(NETWORK_PATH)) return "";

  const section = readFileSync(NETWORK_PATH, "utf8").trim();
  return section ? `\n${section}\n` : "";
}

function markdown({ rows, manifest, env, elapsedMs, budget, stats }) {
  const skipped = rows.filter((row) => row.skipped);
  const tableLines = table(rows);

  return `# Storage benchmark

Generated by \`npm run bench:storage\` on ${new Date().toISOString()}.

This is a measurement, not a claim. Numbers depend on the machine and on the
codec build shown below; regenerate before quoting. A method whose decoded bytes
do not match the reference digest is \`bounded\` or \`generative\`, never \`exact\`.

## Result

${tableLines}

- **Stored** is the encoded artifact (all shards for erasure coding).
- **Decoder** is the decoder artifact when it is part of the protocol's cost.
  Learned and parametric rows must declare it and count it in **total**; classical
  rows rely on the system ffmpeg/zstd decoder and show \`—\`.
- **Total** is stored + decoder; **ratio** is input / total, so higher is smaller.
- A \`no — bounded\` result reports byte error against the committed reference
  digest, plus PSNR where the slice has a raster interpretation.
- **Verify** reads the stored artifact and recomputes its SHA-256; it checks stored
  integrity, not decodability. **Decode** reconstructs the reference bytes.
- Skipped rows mean the local toolchain lacks that encoder; they are not passes.
${throughputSection()}${networkSection()}
## Corpus

${corpusTable(manifest)}

Corpus digest: \`${manifest.digest}\` · total ${formatBytes(stats.totalBytes)} across
${stats.slices} file(s). The default corpus is deterministic and hash-locked in
\`corpus.lock.json\`; pass \`--corpus <dir>\` to measure a downloaded public corpus.

## Budget

Elapsed ${(elapsedMs / 1000).toFixed(1)} s of a ${budget.maxMinutes}-minute budget:
**${budget.passed ? "within budget" : "over budget"}**.

## Environment

| | |
| --- | --- |
| Node | \`${env.node}\` |
| Platform | ${env.platform} |
| CPU | ${env.cpu} |
| ffmpeg | ${env.ffmpeg ? `\`${env.ffmpeg}\`` : "not installed"} |
| zstd | ${env.zstd ? `\`${env.zstd}\`` : "not installed"} |

${skipped.length > 0 ? `> ${skipped.length} method(s) skipped; see the table.\n` : ""}`;
}

export async function runBenchmark({
  root,
  manifest,
  runners = allRunners(),
  workRoot = null,
  keep = false,
  maxMinutes = 15,
} = {}) {
  const work = workRoot ?? mkdtempSync(join(tmpdir(), "rarext-storage-bench-"));
  const started = now();
  const rows = [];
  const env = environment();

  try {
    for (const runner of runners) {
      const runnerWork = join(work, runner.id);

      mkdirSync(runnerWork, { recursive: true });

      let result;

      try {
        result = await runner.run({ root, manifest, work: runnerWork });
      } catch (error) {
        result = {
          skipped: true,
          reason: error instanceof Error ? error.message : String(error),
          slice: "—",
        };
      }

      rows.push(addRow(runner, result));
    }
  } finally {
    if (!keep && !workRoot) rmSync(work, { recursive: true, force: true });
  }

  const elapsedMs = now() - started;
  const budget = { maxMinutes, elapsedMs, passed: elapsedMs <= maxMinutes * 60 * 1000 };
  const stats = corpusStats(manifest);
  const report = {
    generatedAt: new Date().toISOString(),
    environment: env,
    corpus: {
      digest: manifest.digest,
      totalBytes: stats.totalBytes,
      slices: manifest.slices.map(({ path, modality, bytes, sha256: digest }) => ({ path, modality, bytes, digest })),
    },
    budget,
    rows,
  };

  return {
    report,
    markdown: markdown({ rows, manifest, env, elapsedMs, budget, stats }),
  };
}

export function writeResults({ report, markdown }, basePath) {
  const markdownPath = basePath.endsWith(".md") ? basePath : `${basePath}.md`;
  const jsonPath = markdownPath.replace(/\.md$/, ".json");

  writeFileSync(markdownPath, markdown);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);

  return { markdownPath, jsonPath };
}

export { formatBytes };
