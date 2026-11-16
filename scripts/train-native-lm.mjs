#!/usr/bin/env node
/**
 * train-native-lm.mjs — grow a language model inside RAREXT, from nothing borrowed.
 *
 * This is not a fine-tune and not a converter. There is no pretrained
 * initialization, no downloaded checkpoint, no framework, and no network call.
 * The weights start as a seeded xorshift32 draw and move only by the gradient of
 * RAREXT's own text, computed by the loops below. Same corpus + same seed =>
 * byte-identical container.
 *
 * Model: a byte-level context MLP language model.
 *
 *   ids      one id per byte of text (the vocabulary is the bytes the corpus uses)
 *   context  the previous K bytes, each through a learned embedding, concatenated
 *   hidden   tanh(concat(E[b_{t-K}..b_{t-1}]) @ W1 + b1)
 *   output   softmax(hidden @ W2 + b2) over the next byte
 *
 * It is small on purpose: it has to train on four cores. That is a throughput
 * fact, not an architectural ceiling — see docs/NATIVE-MODEL.md for the scaling
 * runs that turn width and steps into a dial.
 *
 *   node scripts/train-native-lm.mjs
 *   node scripts/train-native-lm.mjs --steps 1500 --hidden 256 --label width-256
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── arguments ───────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
const CONFIG = {
  corpus: arg("corpus", join(root, "bench/native/corpus.txt")),
  outDir: arg("out", join(root, "bench/native")),
  label: arg("label", "rarext-native-1"),
  context: Number(arg("context", 24)),
  dim: Number(arg("dim", 16)),
  hidden: Number(arg("hidden", 192)),
  steps: Number(arg("steps", 4000)),
  batch: Number(arg("batch", 32)),
  lr: Number(arg("lr", 3e-3)),
  seed: Number(arg("seed", 0x52415245)), // "RARE"
  evalEvery: Number(arg("eval-every", 250)),
  holdout: 0.08,
};

// ── deterministic PRNG (the same xorshift32 RAREXT uses elsewhere) ──────────
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

// ── corpus → byte-vocabulary ids ────────────────────────────────────────────
const corpus = readFileSync(CONFIG.corpus);
const corpusDigest = createHash("sha256").update(corpus).digest("hex");
const distinct = [...new Set(corpus)].sort((a, b) => a - b);
const byteToVocab = new Int16Array(256).fill(-1);
distinct.forEach((b, i) => (byteToVocab[b] = i));
const VOCAB = distinct.length + 1; // + BOS, used to pad the first context
const BOS = VOCAB - 1;
const ids = new Int16Array(corpus.length);
for (let i = 0; i < corpus.length; i += 1) ids[i] = byteToVocab[corpus[i]];

const split = Math.floor(ids.length * (1 - CONFIG.holdout));
const train = ids.subarray(0, split);
const held = ids.subarray(split);

// ── parameters ──────────────────────────────────────────────────────────────
const K = CONFIG.context;
const D = CONFIG.dim;
const IN = K * D;
const H = CONFIG.hidden;
const PARAM_COUNT = VOCAB * D + IN * H + H + H * VOCAB + VOCAB;

const rng = makeRng(CONFIG.seed);
const uniform = (scale) => (rng() * 2 - 1) * scale;
const E = new Float32Array(VOCAB * D);
const W1 = new Float32Array(IN * H);
const b1 = new Float32Array(H);
const W2 = new Float32Array(H * VOCAB);
const b2 = new Float32Array(VOCAB);
for (let i = 0; i < E.length; i += 1) E[i] = uniform(0.1);
for (let i = 0; i < W1.length; i += 1) W1[i] = uniform(Math.sqrt(6 / IN));
for (let i = 0; i < W2.length; i += 1) W2[i] = uniform(Math.sqrt(6 / H));

// ── gradients, Adam state ───────────────────────────────────────────────────
const gE = new Float32Array(E.length);
const gW1 = new Float32Array(W1.length);
const gb1 = new Float32Array(H);
const gW2 = new Float32Array(W2.length);
const gb2 = new Float32Array(VOCAB);
const mE = new Float32Array(E.length), vE = new Float32Array(E.length);
const mW1 = new Float32Array(W1.length), vW1 = new Float32Array(W1.length);
const mb1 = new Float32Array(H), vb1 = new Float32Array(H);
const mW2 = new Float32Array(W2.length), vW2 = new Float32Array(W2.length);
const mb2 = new Float32Array(VOCAB), vb2 = new Float32Array(VOCAB);

const x = new Float32Array(IN);
const hidden = new Float32Array(H);
const dh = new Float32Array(H);
const dx = new Float32Array(IN);
const logits = new Float32Array(VOCAB);
const probs = new Float32Array(VOCAB);
const dlogits = new Float32Array(VOCAB);

/** Fill `x` with the K context bytes before position t (BOS-padded at the front). */
function contextAt(seq, t) {
  for (let j = 0; j < K; j += 1) {
    const src = t - K + j;
    const id = src < 0 ? BOS : seq[src];
    const base = id * D;
    x.set(E.subarray(base, base + D), j * D);
  }
}

function forward(target) {
  for (let h = 0; h < H; h += 1) {
    let sum = b1[h];
    const row = h * IN;
    for (let i = 0; i < IN; i += 1) sum += W1[row + i] * x[i];
    hidden[h] = Math.tanh(sum);
  }
  let max = -Infinity;
  for (let v = 0; v < VOCAB; v += 1) {
    let sum = b2[v];
    const row = v * H;
    for (let h = 0; h < H; h += 1) sum += W2[row + h] * hidden[h];
    logits[v] = sum;
    if (sum > max) max = sum;
  }
  let denom = 0;
  for (let v = 0; v < VOCAB; v += 1) {
    const e = Math.exp(logits[v] - max);
    probs[v] = e;
    denom += e;
  }
  for (let v = 0; v < VOCAB; v += 1) probs[v] /= denom;
  return -Math.log(Math.max(probs[target], 1e-12));
}

function backward(target) {
  for (let v = 0; v < VOCAB; v += 1) dlogits[v] = probs[v] - (v === target ? 1 : 0);
  for (let v = 0; v < VOCAB; v += 1) {
    const g = dlogits[v];
    if (g === 0) continue;
    const row = v * H;
    for (let h = 0; h < H; h += 1) gW2[row + h] += g * hidden[h];
    gb2[v] += g;
  }
  for (let h = 0; h < H; h += 1) {
    let sum = 0;
    for (let v = 0; v < VOCAB; v += 1) sum += W2[v * H + h] * dlogits[v];
    dh[h] = sum * (1 - hidden[h] * hidden[h]);
  }
  for (let h = 0; h < H; h += 1) {
    const g = dh[h];
    if (g === 0) continue;
    const row = h * IN;
    for (let i = 0; i < IN; i += 1) gW1[row + i] += g * x[i];
    gb1[h] += g;
  }
  for (let i = 0; i < IN; i += 1) {
    let sum = 0;
    for (let h = 0; h < H; h += 1) sum += W1[h * IN + i] * dh[h];
    dx[i] = sum;
  }
  for (let j = 0; j < K; j += 1) {
    const src = currentT - K + j;
    const id = src < 0 ? BOS : currentSeq[src];
    const base = id * D;
    for (let d = 0; d < D; d += 1) gE[base + d] += dx[j * D + d];
  }
}

let currentSeq = train;
let currentT = 0;

/** One Adam step over the accumulated gradients, divided by the batch size. */
function adamStep(step, invBatch) {
  const b1t = 1 - Math.pow(0.9, step);
  const b2t = 1 - Math.pow(0.999, step);
  const rate = CONFIG.lr * Math.sqrt(b2t) / b1t;
  const update = (p, g, m, v, n) => {
    for (let i = 0; i < p.length; i += 1) {
      const grad = g[i] * invBatch;
      m[i] = 0.9 * m[i] + 0.1 * grad;
      v[i] = 0.999 * v[i] + 0.001 * grad * grad;
      p[i] -= rate * m[i] / (Math.sqrt(v[i]) + 1e-8);
      g[i] = 0;
      void n;
    }
  };
  update(E, gE, mE, vE);
  update(W1, gW1, mW1, vW1);
  update(b1, gb1, mb1, vb1);
  update(W2, gW2, mW2, vW2);
  update(b2, gb2, mb2, vb2);
}

function meanLoss(seq) {
  let total = 0;
  for (let t = Math.max(K, 1); t < seq.length; t += 1) {
    contextAt(seq, t);
    total += forward(seq[t]);
  }
  return total / Math.max(1, seq.length - Math.max(K, 1));
}

/** Greedy sample `n` bytes from a prompt, for progress reporting. */
function sample(seqPrompt, n) {
  const out = [];
  const seq = [...seqPrompt];
  for (let i = 0; i < n; i += 1) {
    contextAt(seq, seq.length);
    forward(0);
    let best = 0;
    for (let v = 1; v < VOCAB; v += 1) if (logits[v] > logits[best]) best = v;
    out.push(best);
    seq.push(best);
  }
  return out;
}

const encodeText = (text) => [...Buffer.from(text, "utf8")].map((b) => (byteToVocab[b] < 0 ? BOS : byteToVocab[b]));

// ── train ───────────────────────────────────────────────────────────────────
const started = Date.now();
const history = [];
console.log(`corpus    ${CONFIG.corpus} · ${corpus.length} bytes · sha256 ${corpusDigest.slice(0, 16)}…`);
console.log(`config    K=${K} D=${D} H=${H} vocab=${VOCAB} params=${PARAM_COUNT.toLocaleString()} steps=${CONFIG.steps} batch=${CONFIG.batch}`);
console.log(`init      xorshift32 seed ${CONFIG.seed} · no pretrained weights\n`);

for (let step = 1; step <= CONFIG.steps; step += 1) {
  let loss = 0;
  for (let b = 0; b < CONFIG.batch; b += 1) {
    const t = K + Math.floor(rng() * (train.length - K - 1));
    contextAt(train, t);
    loss += forward(train[t]);
    currentT = t;
    currentSeq = train;
    backward(train[t]);
  }
  adamStep(step, 1 / CONFIG.batch);
  if (step % CONFIG.evalEvery === 0 || step === 1 || step === CONFIG.steps) {
    const heldLoss = meanLoss(held);
    const trainLoss = loss / CONFIG.batch;
    history.push({ step, batchLoss: Number(trainLoss.toFixed(4)), heldLoss: Number(heldLoss.toFixed(4)) });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`step ${String(step).padStart(5)}  batch ${trainLoss.toFixed(4)}  held ${heldLoss.toFixed(4)}  bits/byte ${(heldLoss / Math.LN2).toFixed(3)}  ${secs}s`);
    if (step % (CONFIG.evalEvery * 4) === 0 || step === CONFIG.steps) {
      const prompt = encodeText("RAREXT is ");
      const out = sample(prompt, 160);
      const text = Buffer.from(out.map((v) => (v === BOS ? 32 : distinct[v]))).toString("utf8");
      console.log(`   sample: ${JSON.stringify(text.slice(0, 140))}`);
      history[history.length - 1].sample = text.slice(0, 240);
    }
  }
}

const finalHeld = meanLoss(held);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

// ── serialize the container: header JSON + float32 tensors ──────────────────
const tensors = [
  ["embedding", E, [VOCAB, D]],
  ["w1", W1, [IN, H]],
  ["b1", b1, [H]],
  ["w2", W2, [H, VOCAB]],
  ["b2", b2, [VOCAB]],
];
let offset = 0;
const table = [];
for (const [name, data, shape] of tensors) {
  table.push({ name, shape, offset, bytes: data.length * 4 });
  offset += data.length * 4;
}
const header = {
  kind: "rarext.native-lm.v1",
  architecture: "byte-context-mlp",
  label: CONFIG.label,
  context: K,
  dim: D,
  hidden: H,
  vocab: VOCAB,
  bos: BOS,
  bytes: distinct,
  tensors: table,
  dataBytes: offset,
  training: {
    corpus: "bench/native/corpus.txt",
    corpusSha256: corpusDigest,
    corpusBytes: corpus.length,
    seed: CONFIG.seed,
    steps: CONFIG.steps,
    batch: CONFIG.batch,
    learningRate: CONFIG.lr,
    finalHeldLoss: Number(finalHeld.toFixed(4)),
    finalHeldBitsPerByte: Number((finalHeld / Math.LN2).toFixed(4)),
  },
  lineage: {
    pretrained: false,
    externalModelBytes: 0,
    initialization: "xorshift32 seeded in scripts/train-native-lm.mjs",
    corpus: "RAREXT's own documents, snapshotted in-repo",
    trainedBy: "scripts/train-native-lm.mjs (pure JS, no framework)",
  },
};
const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
const container = Buffer.alloc(12 + headerBytes.length + offset);
container.write("RNLM", 0, "ascii");
container.writeUInt32LE(1, 4);
container.writeUInt32LE(headerBytes.length, 8);
headerBytes.copy(container, 12);
let cursor = 12 + headerBytes.length;
for (const [, data] of tensors) {
  for (let i = 0; i < data.length; i += 1) {
    container.writeFloatLE(data[i], cursor);
    cursor += 4;
  }
}

mkdirSync(CONFIG.outDir, { recursive: true });
const containerPath = join(CONFIG.outDir, `${CONFIG.label}.rnlm`);
writeFileSync(containerPath, container);
const containerDigest = createHash("sha256").update(container).digest("hex");

const report = {
  kind: "rarext.native-lm-training.v1",
  label: CONFIG.label,
  container: containerPath.replace(root, "").replace(/^\//, ""),
  containerSha256: containerDigest,
  containerBytes: container.length,
  params: PARAM_COUNT,
  config: { context: K, dim: D, hidden: H, steps: CONFIG.steps, batch: CONFIG.batch, lr: CONFIG.lr, seed: CONFIG.seed, vocab: VOCAB },
  corpus: { path: "bench/native/corpus.txt", bytes: corpus.length, sha256: corpusDigest },
  lineage: header.lineage,
  final: { heldLoss: Number(finalHeld.toFixed(4)), bitsPerByte: Number((finalHeld / Math.LN2).toFixed(4)), seconds: Number(elapsed) },
  history,
};
writeFileSync(join(CONFIG.outDir, `${CONFIG.label}.json`), `${JSON.stringify(report, null, 2)}\n`);

console.log(`\nfinal held loss ${finalHeld.toFixed(4)} nats/byte · ${(finalHeld / Math.LN2).toFixed(3)} bits/byte · ${elapsed}s`);
console.log(`container ${containerPath}`);
console.log(`sha256    ${containerDigest}`);
console.log(`report    ${join(CONFIG.outDir, `${CONFIG.label}.json`)}`);
