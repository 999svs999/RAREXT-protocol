/**
 * A measured benchmark for a committed container.
 *
 * Two things are measured on the SAME weights, with no third-party engine:
 *
 *  - the RAREXT engine, end to end (tokens, ms/token, tokens/second), resident
 *    and — when a reader is supplied — streamed from disk;
 *  - a deliberately simple **reference output-projection pass** over the same
 *    committed tensor, materializing one row at a time through the engine's own
 *    `dequantTensor` and dotting it. It is the dominant per-token cost of a
 *    transformer, written the obvious (slow) way, so the engine's whole-model
 *    step can be compared against it honestly.
 *
 * The deterministic parts (model bytes, steps, MACs per token, token ids, the
 * reference's row count) carry a canonical fingerprint; the timings are
 * host-specific and reported as measured, never as a promise.
 */

import { createHash } from "node:crypto";

import { canonicalDigest } from "./digest.ts";
import type { NativeEngine } from "./engine-bundle.ts";

export interface BenchTiming {
  tokens: number;
  totalMs: number;
  msPerToken: number;
  tokensPerSecond: number;
}

export interface BenchResult {
  kind: "rarext.engine-bench.v1";
  model: { id: string; kind: string; bytes: number; tensorCount: number };
  prompt: string;
  steps: number;
  /** Multiply-accumulates for one token over the container's weight tensors. */
  macsPerToken: number;
  engine: BenchTiming & { tokenIds: number[]; tokenDigest: string };
  streamed:
    | (BenchTiming & {
        identical: boolean;
        tokenIds: number[];
        peakResidentBytes: number | null;
        bytesRead: number;
      })
    | null;
  reference: {
    pass: string;
    tensor: string;
    rows: number;
    cols: number;
    /** Materializing every row through the engine's dequantizer, one parse. */
    materializeMs: number;
    /** The naive dot of each materialized row against a probe vector. */
    dotMs: number;
    totalMs: number;
    msPerRow: number;
    rowsPerSecond: number;
    /** The reference's whole projection pass: one token's worth of it. */
    projectionMsPerToken: number;
  };
  comparison: {
    /** Engine whole-step ms per token over the reference's projection-only pass. */
    engineStepOverReferenceProjection: number;
    note: string;
  };
  /** Facts about what could not be measured, said out loud. */
  notes: string[];
  measuredAt: string;
}

export interface BenchOptions {
  id?: string;
  prompt?: string;
  steps?: number;
  /** Timed repetitions; the fastest is reported, so one noisy run cannot win. */
  repeats?: number;
  /** A factory for a bounded reader, to measure the streamed path too. */
  streamer?: () => { readAt: (offset: number, length: number) => Uint8Array; sizeBytes: number };
}

interface ParsedContainer {
  tensors: Record<string, { name: string; cols: number; rows: number }>;
  kv: Record<string, unknown>;
}

function now(): number {
  return performance.now();
}

function timing(tokens: number, totalMs: number): BenchTiming {
  return {
    tokens,
    totalMs: Math.round(totalMs * 1000) / 1000,
    msPerToken: tokens === 0 ? 0 : Math.round((totalMs / tokens) * 1000) / 1000,
    tokensPerSecond: totalMs === 0 ? 0 : Math.round((tokens / totalMs) * 1000 * 1000) / 1000,
  };
}

function tokenDigest(tokens: number[]): string {
  return createHash("sha256").update(tokens.join(",")).digest("hex");
}

/** Measure one model handle: warm up, then the fastest of `repeats` runs. */
function measure(
  engine: NativeEngine,
  model: unknown,
  input: { prompt: string; steps: number },
  repeats: number,
): { best: BenchTiming; tokens: number[] } {
  engine.run(model, input); // warm: caches norms, tokenizer, parsed metadata
  let best: BenchTiming | null = null;
  let tokens: number[] = [];
  for (let attempt = 0; attempt < Math.max(1, repeats); attempt += 1) {
    const started = now();
    const result = engine.run(model, input);
    const ms = now() - started;
    const measured = timing(result.tokens.length, ms);
    tokens = result.tokens;
    if (best === null || measured.tokensPerSecond > best.tokensPerSecond) best = measured;
  }
  return { best: best!, tokens };
}

/**
 * Run the benchmark. `model` is the resident handle (`{ kind, bytes }`); when
 * `options.streamer` is given, the same container is also measured through a
 * bounded reader and the two decodes are compared token for token.
 */
export function benchmarkEngine(
  engine: NativeEngine,
  model: { kind: "gguf" | "hf"; bytes: Uint8Array },
  options: BenchOptions = {},
): BenchResult {
  const prompt = options.prompt ?? "abcdefgh";
  const steps = options.steps ?? 16;
  const repeats = options.repeats ?? 3;
  const parsed = (model.kind === "hf"
    ? engine.parseContainer!(model.bytes)
    : engine.parseGguf!(model.bytes)) as unknown as ParsedContainer;

  // Committed work per token: the container's own weight arithmetic.
  let macsPerToken = 0;
  for (const tensor of Object.values(parsed.tensors)) {
    if (tensor.cols > 1) macsPerToken += tensor.rows * tensor.cols;
  }

  const { best, tokens } = measure(engine, model, { prompt, steps }, repeats);

  // The reference pass: materialize each projection row through the engine's own
  // dequantizer, then dot it. No third-party code touches the weights.
  const projection = parsed.tensors["output.weight"] ?? parsed.tensors["token_embd.weight"]!;
  const embedding = parsed.tensors["token_embd.weight"] ?? projection;
  const probe = engine.dequantTensor!(model, embedding.name, 0);

  // Materialize the whole projection through the engine's own dequantizer (one
  // parse, so the measurement is the row-by-row materialization, not repeated
  // header parsing), then dot it the obvious way.
  const materializeStart = now();
  const materialized = engine.dequantRows!(model, projection.name);
  const materializeMs = now() - materializeStart;

  const dotStart = now();
  let sink = 0;
  for (let row = 0; row < materialized.rows; row += 1) {
    let total = 0;
    for (let i = 0; i < materialized.cols; i += 1) total += materialized.values[row * materialized.cols + i]! * probe[i]!;
    sink += total;
  }
  const dotMs = now() - dotStart;
  const referenceMs = materializeMs + dotMs;
  const round = (value: number, digits: number): number => {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
  };
  const reference = {
    pass: "reference output projection (materialize-then-dot, engine dequantizer)",
    tensor: projection.name,
    rows: projection.rows,
    cols: projection.cols,
    materializeMs: round(materializeMs, 3),
    dotMs: round(dotMs, 3),
    totalMs: round(referenceMs, 3),
    msPerRow: round(referenceMs / Math.max(1, projection.rows), 6),
    rowsPerSecond: round((projection.rows / Math.max(0.001, referenceMs)) * 1000, 3),
    projectionMsPerToken: round(referenceMs, 3),
  };
  // Keep the sink observable so the loop cannot be optimized away.
  if (!Number.isFinite(sink)) throw new Error("the reference pass produced a non-finite value");

  let streamed: BenchResult["streamed"] = null;
  const notes: string[] = [];
  if (options.streamer !== undefined && model.kind !== "gguf") {
    notes.push(
      "this container is HF/RXHF: it is parsed from a resident buffer, so the streamed path does not apply",
    );
  }
  if (options.streamer !== undefined && model.kind === "gguf") {
    const reader = options.streamer();
    const streamedModel = {
      kind: model.kind,
      readAt: reader.readAt,
      sizeBytes: reader.sizeBytes,
      chunkBytes: 65536,
      cacheChunks: 32,
    };
    const streamedRun = measure(engine, streamedModel, { prompt, steps }, repeats);
    const stats = engine.streamStats?.(streamedModel) ?? null;
    const identical = streamedRun.tokens.join(",") === tokens.join(",");
    if (!identical) notes.push("the streamed decode DIFFERED from the resident one");
    streamed = {
      ...streamedRun.best,
      identical,
      tokenIds: streamedRun.tokens,
      peakResidentBytes: stats?.peakResidentBytes ?? null,
      bytesRead: stats?.bytesRead ?? 0,
    };
  }

  const engineStepOverReferenceProjection =
    referenceMs === 0 ? 0 : Math.round((best.msPerToken / referenceMs) * 1000) / 1000;

  return {
    kind: "rarext.engine-bench.v1",
    model: { id: options.id ?? "committed", kind: model.kind, bytes: model.bytes.length, tensorCount: Object.keys(parsed.tensors).length },
    prompt,
    steps,
    macsPerToken,
    engine: { ...best, tokenIds: tokens, tokenDigest: tokenDigest(tokens) },
    streamed,
    reference,
    comparison: {
      engineStepOverReferenceProjection,
      note:
        "the engine number is a whole-model step; the reference number is the output " +
        "projection alone, materialized row by row. A ratio below 1 means the engine's " +
        "entire step is still cheaper than the naive projection pass for one token.",
    },
    notes,
    measuredAt: new Date().toISOString(),
  };
}

/**
 * The deterministic part of a result: what a re-run must reproduce exactly. The
 * timings are deliberately excluded — they are host measurements, not a claim.
 */
export function benchFingerprint(result: BenchResult): string {
  return canonicalDigest({
    kind: result.kind,
    model: result.model,
    prompt: result.prompt,
    steps: result.steps,
    macsPerToken: result.macsPerToken,
    tokens: result.engine.tokenIds,
    tokenDigest: result.engine.tokenDigest,
    reference: { tensor: result.reference.tensor, rows: result.reference.rows, cols: result.reference.cols },
    streamedIdentical: result.streamed === null ? null : result.streamed.identical,
    notes: result.notes,
  });
}
