// Learned and parametric representations for the research gate.
//
// These are deliberately small and boring: an order-1 Huffman model trained on a
// different corpus slice, and a tensor-product Legendre fit of each photograph.
// Both count their decoder in the total cost, because the model is data the
// protocol would have to store and agree on. Neither is allowed to call a
// non-exact reconstruction exact.

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sliceByModality } from "./corpus.mjs";

const CONTEXTS = 256;
const SYMBOLS = 256;
const MAX_CODE_LENGTH = 32;

function now() {
  return performance.now();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function combinedDigest(digests) {
  return createHash("sha256").update(digests.join("\n")).digest("hex");
}

function bitsFor(count, total) {
  if (count <= 0) return MAX_CODE_LENGTH;
  return Math.min(MAX_CODE_LENGTH, Math.max(1, Math.ceil(Math.log2(total / count))));
}

// Shannon lengths satisfy Kraft, so canonical codes built from them are
// prefix-free even when the tree is not complete.
function lengthsFromCounts(counts) {
  const total = counts.reduce((sum, count) => sum + count, 0);
  return counts.map((count) => (count === 0 ? 0 : bitsFor(count, total)));
}

function globalCounts(bytes) {
  const counts = new Array(SYMBOLS).fill(1);
  for (const byte of bytes) counts[byte] += 1;
  return counts;
}

function contextCounts(training) {
  const table = Array.from({ length: CONTEXTS }, () => new Array(SYMBOLS).fill(0));
  let previous = 0;

  for (const byte of training) {
    table[previous][byte] += 1;
    previous = byte;
  }

  return table;
}

function canonicalCodes(lengths) {
  const codes = new Array(SYMBOLS).fill(null);
  const order = [];

  for (let symbol = 0; symbol < SYMBOLS; symbol += 1) {
    if (lengths[symbol] > 0) order.push(symbol);
  }

  order.sort((left, right) => lengths[left] - lengths[right] || left - right);

  let code = 0;
  let previousLength = 0;

  for (const symbol of order) {
    const length = lengths[symbol];
    code <<= length - previousLength;
    codes[symbol] = { code, length };
    code += 1;
    previousLength = length;
  }

  return codes;
}

function decodeTable(codes) {
  const table = new Map();

  for (let symbol = 0; symbol < SYMBOLS; symbol += 1) {
    const entry = codes[symbol];
    if (entry) table.set(entry.length * 0x1_0000_0000 + entry.code, symbol);
  }

  return table;
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.current = 0;
    this.used = 0;
  }

  write(code, length) {
    for (let bit = length - 1; bit >= 0; bit -= 1) {
      this.current = (this.current << 1) | ((code >>> bit) & 1);
      this.used += 1;

      if (this.used === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.used = 0;
      }
    }
  }

  finish() {
    if (this.used > 0) {
      this.bytes.push(this.current << (8 - this.used));
    }

    return Buffer.from(this.bytes);
  }
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
    this.current = 0;
    this.left = 0;
  }

  read() {
    if (this.left === 0) {
      if (this.offset >= this.bytes.length) throw new Error("learned codec: truncated bitstream");
      this.current = this.bytes[this.offset];
      this.offset += 1;
      this.left = 8;
    }

    this.left -= 1;
    return (this.current >>> this.left) & 1;
  }
}

/**
 * A static order-1 Huffman codec. The model is trained on one public corpus
 * slice and used to encode another, so the evaluation slice is held out. The
 * 64 KiB context table is written as the decoder and counted in full.
 */
export function learnedHuffmanRunner({ trainPath, evalPath }) {
  return {
    id: `learned-huffman-${evalPath.replace(/[^a-z0-9]+/gi, "-")}`,
    label: `learned order-1 Huffman (${trainPath === evalPath ? "adaptive" : `train ${trainPath}`})`,
    kind: "learned",
    declaresExact: true,
    decoderBytes: null,
    async run({ root, work }) {
      const training = readFileSync(join(root, trainPath));
      const evaluation = readFileSync(join(root, evalPath));
      const trainStart = now();
      const counts = contextCounts(training);
      const global = globalCounts(training);
      const fallbackLengths = lengthsFromCounts(global);
      const lengths = new Uint8Array(CONTEXTS * SYMBOLS);

      for (let context = 0; context < CONTEXTS; context += 1) {
        const row = counts[context];
        const total = row.reduce((sum, count) => sum + count, 0);

        if (total < 64) {
          lengths.set(fallbackLengths, context * SYMBOLS);
          continue;
        }

        // Laplace smoothing keeps every symbol decodable, including bytes the
        // training slice never saw after this context.
        const smoothed = row.map((count) => count + 1);
        lengths.set(lengthsFromCounts(smoothed), context * SYMBOLS);
      }

      const codes = Array.from({ length: CONTEXTS }, (_, context) =>
        canonicalCodes([...lengths.subarray(context * SYMBOLS, (context + 1) * SYMBOLS)]),
      );
      const trainMs = now() - trainStart;
      const encoder = new BitWriter();
      const encodeStart = now();
      let previous = 0;

      for (const byte of evaluation) {
        const entry = codes[previous][byte];
        if (!entry) throw new Error("learned codec: symbol has no code");
        encoder.write(entry.code, entry.length);
        previous = byte;
      }

      const encoded = encoder.finish();
      const encodeMs = now() - encodeStart;
      const header = Buffer.alloc(12);
      header.write("RXLH", 0, "ascii");
      header.writeUInt32LE(evaluation.length, 4);
      header.writeUInt32LE(0, 8);
      const stored = Buffer.concat([header, encoded]);
      const decoder = Buffer.concat([Buffer.from([1]), Buffer.from(fallbackLengths), Buffer.from(lengths)]);
      const storedPath = join(work, "stream.rxlh");
      const decoderPath = join(work, "model.rxlh");
      writeFileSync(storedPath, stored);
      writeFileSync(decoderPath, decoder);

      const verifyStart = now();
      if (sha256(readFileSync(storedPath)) !== sha256(stored)) throw new Error("learned codec: stored stream changed");
      if (sha256(readFileSync(decoderPath)) !== sha256(decoder)) throw new Error("learned codec: decoder changed");
      const verifyMs = now() - verifyStart;

      // Decode from the files, not from the in-memory encoder state.
      const readStored = readFileSync(storedPath);
      const readDecoder = readFileSync(decoderPath);
      const decodeStart = now();
      const decodedLength = readStored.readUInt32LE(4);
      const decodedModel = Array.from({ length: CONTEXTS }, (_, context) =>
        decodeTable(
          canonicalCodes([
            ...readDecoder.subarray(1 + SYMBOLS + context * SYMBOLS, 1 + SYMBOLS + (context + 1) * SYMBOLS),
          ]),
        ),
      );
      const reader = new BitReader(readStored.subarray(12));
      const decoded = Buffer.alloc(decodedLength);
      previous = 0;

      for (let index = 0; index < decodedLength; index += 1) {
        const table = decodedModel[previous];
        let code = 0;

        for (let length = 1; length <= MAX_CODE_LENGTH; length += 1) {
          code = (code << 1) | reader.read();
          const symbol = table.get(length * 0x1_0000_0000 + code);

          if (symbol !== undefined) {
            decoded[index] = symbol;
            previous = symbol;
            break;
          }

          if (length === MAX_CODE_LENGTH) throw new Error("learned codec: no matching code");
        }
      }

      const decodeMs = now() - decodeStart;
      const referenceDigest = sha256(evaluation);
      const reconstructedDigest = sha256(decoded);
      const differences = countDifferences(evaluation, decoded);

      return {
        slice:
          trainPath === evalPath
            ? `${evalPath} (adaptive per-file model)`
            : `${evalPath} (held out; trained on ${trainPath})`,
        inputBytes: evaluation.length,
        storedBytes: readStored.length,
        decoderBytes: readDecoder.length,
        referenceDigest,
        reconstructedDigest,
        exact: reconstructedDigest === referenceDigest,
        errorRatio: differences / Math.max(1, evaluation.length),
        psnr: null,
        verifyMs,
        decodeMs,
        encodeMs: encodeMs + trainMs,
        notes:
          trainPath === evalPath
            ? `order-1 model trained on the evaluated file; model cost ${readDecoder.length} bytes is stored and counted, so this is an adaptive result, not a generalization claim; training ${trainMs.toFixed(0)} ms`
            : `order-1 model trained on ${trainPath}; eval slice held out; decoder table ${readDecoder.length} bytes counted; training ${trainMs.toFixed(0)} ms`,
      };
    },
  };
}

function countDifferences(left, right) {
  const length = Math.min(left.length, right.length);
  let differing = Math.abs(left.length - right.length);

  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) differing += 1;
  }

  return differing;
}

function parsePpm(bytes) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x36) throw new Error("parametric: expected a binary P6 PPM");

  let offset = 2;
  const tokens = [];

  while (tokens.length < 3) {
    while (offset < bytes.length && /\s/.test(String.fromCharCode(bytes[offset]))) offset += 1;
    if (bytes[offset] === 0x23) {
      while (offset < bytes.length && bytes[offset] !== 0x0a) offset += 1;
      continue;
    }

    let value = "";
    while (offset < bytes.length && !/\s/.test(String.fromCharCode(bytes[offset]))) {
      value += String.fromCharCode(bytes[offset]);
      offset += 1;
    }
    tokens.push(Number(value));
  }

  // Exactly one separator byte after maxval. Eating all whitespace corrupts
  // images whose first pixel byte happens to be a space or newline.
  if (bytes[offset] === 0x0d && bytes[offset + 1] === 0x0a) offset += 2;
  else offset += 1;

  const [width, height, max] = tokens;
  if (max !== 255) throw new Error("parametric: only 8-bit PPM is supported");

  return { width, height, pixels: bytes.subarray(offset, offset + width * height * 3) };
}

// Legendre polynomials on [-1, 1], evaluated by recurrence.
function legendreTable(values, degree) {
  const table = values.map(() => new Float64Array(degree + 1));

  for (let index = 0; index < values.length; index += 1) {
    const x = values[index];
    table[index][0] = 1;
    if (degree >= 1) table[index][1] = x;

    for (let order = 2; order <= degree; order += 1) {
      table[index][order] =
        ((2 * order - 1) * x * table[index][order - 1] - (order - 1) * table[index][order - 2]) / order;
    }
  }

  return table;
}

function solve(matrix, vector) {
  const size = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;

    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }

    if (Math.abs(a[pivot][column]) < 1e-12) continue;
    [a[column], a[pivot]] = [a[pivot], a[column]];

    const scale = a[column][column];

    for (let position = column; position <= size; position += 1) a[column][position] /= scale;

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = a[row][column];
      if (factor === 0) continue;

      for (let position = column; position <= size; position += 1) {
        a[row][position] -= factor * a[column][position];
      }
    }
  }

  return a.map((row) => row[size] ?? 0);
}

/**
 * A parametric representation: each photo is a tensor-product Legendre fit over
 * normalized coordinates. The coefficients are the entire stored artifact and
 * the decoder, so they are counted once as decoder bytes and stored bytes are
 * zero. There is no residual, so the claim is bounded, not exact.
 */
export function learnedRunners() {
  return [
    learnedHuffmanRunner({ trainPath: "text.txt", evalPath: "text.txt" }),
    learnedHuffmanRunner({ trainPath: "source.js", evalPath: "source.js" }),
    learnedHuffmanRunner({ trainPath: "source.js", evalPath: "text.txt" }),
  ];
}

export function polynomialRunner({ degree = 10, sampleStride = 16, ridge = 1e-8 } = {}) {
  return {
    id: `parametric-legendre-${degree}`,
    label: `parametric 2D Legendre degree ${degree}`,
    kind: "parametric",
    declaresExact: false,
    decoderBytes: null,
    async run({ root, manifest, work }) {
      const photos = manifest.slices.filter((slice) => slice.modality === "photo");
      if (photos.length === 0) throw new Error("parametric: corpus has no photo slice");

      const terms = [];
      for (let x = 0; x <= degree; x += 1) {
        for (let y = 0; y <= degree - x; y += 1) terms.push([x, y]);
      }

      const encodeStart = now();
      const models = [];
      let referenceBytes = 0;

      for (const photo of photos) {
        const source = readFileSync(join(root, photo.path));
        const image = parsePpm(source);
        referenceBytes += image.pixels.length;
        const samples = [];
        const xs = [];
        const ys = [];

        for (let y = 0; y < image.height; y += sampleStride) {
          for (let x = 0; x < image.width; x += sampleStride) {
            xs.push((x / (image.width - 1)) * 2 - 1);
            ys.push((y / (image.height - 1)) * 2 - 1);
            const index = (y * image.width + x) * 3;
            samples.push([image.pixels[index], image.pixels[index + 1], image.pixels[index + 2]]);
          }
        }

        const lx = legendreTable(xs, degree);
        const ly = legendreTable(ys, degree);
        const size = terms.length;
        const matrix = Array.from({ length: size }, () => new Float64Array(size));
        const vectors = [new Float64Array(size), new Float64Array(size), new Float64Array(size)];

        for (let sample = 0; sample < samples.length; sample += 1) {
          const basis = terms.map(([x, y]) => lx[sample][x] * ly[sample][y]);

          for (let row = 0; row < size; row += 1) {
            for (let column = 0; column < size; column += 1) {
              matrix[row][column] += basis[row] * basis[column];
            }

            for (let channel = 0; channel < 3; channel += 1) {
              vectors[channel][row] += basis[row] * samples[sample][channel];
            }
          }
        }

        const trace = matrix.reduce((sum, row, index) => sum + row[index], 0) / size;

        for (let index = 0; index < size; index += 1) matrix[index][index] += ridge * Math.max(1, trace);

        const coefficients = vectors.map((vector) => solve(matrix, vector));
        models.push({
          width: image.width,
          height: image.height,
          degree,
          terms,
          coefficients,
        });
      }

      const payload = Buffer.from(JSON.stringify(models), "utf8");
      const modelPath = join(work, "models.json");
      writeFileSync(modelPath, payload);
      const encodeMs = now() - encodeStart;

      const verifyStart = now();
      if (sha256(readFileSync(modelPath)) !== sha256(payload)) throw new Error("parametric: model changed after encode");
      const verifyMs = now() - verifyStart;

      // Decode from the stored model only. Reconstruction is the reader's cost,
      // so it must be inside Decode, not hidden in Encode.
      const decodeStart = now();
      const decodedModels = JSON.parse(readFileSync(modelPath, "utf8"));
      if (decodedModels.length !== models.length) throw new Error("parametric: model count changed");

      let channelError = 0;
      let channelCount = 0;
      let squared = 0;
      const digests = [];

      for (const [index, model] of decodedModels.entries()) {
        const source = parsePpm(readFileSync(join(root, photos[index].path)));
        const pixels = Buffer.alloc(model.width * model.height * 3);
        const lx = legendreTable(
          Array.from({ length: model.width }, (_, x) => (x / (model.width - 1)) * 2 - 1),
          model.degree,
        );
        const ly = legendreTable(
          Array.from({ length: model.height }, (_, y) => (y / (model.height - 1)) * 2 - 1),
          model.degree,
        );

        for (let y = 0; y < model.height; y += 1) {
          for (let x = 0; x < model.width; x += 1) {
            const target = (y * model.width + x) * 3;

            for (let channel = 0; channel < 3; channel += 1) {
              let value = 0;

              for (let term = 0; term < model.terms.length; term += 1) {
                value +=
                  model.coefficients[channel][term] *
                  lx[x][model.terms[term][0]] *
                  ly[y][model.terms[term][1]];
              }

              const rounded = Math.max(0, Math.min(255, Math.round(value)));
              pixels[target + channel] = rounded;
              const delta = source.pixels[target + channel] - rounded;
              if (delta !== 0) channelError += 1;
              squared += delta * delta;
              channelCount += 1;
            }
          }
        }

        digests.push(sha256(pixels));
      }

      const decodeMs = now() - decodeStart;
      const referenceDigest = combinedDigest(photos.map((photo) => photo.sha256));
      const reconstructedDigest = combinedDigest(digests);
      const mse = squared / Math.max(1, channelCount);

      return {
        slice: `photos (${photos.length} files, raw RGB)`,
        inputBytes: referenceBytes,
        storedBytes: 0,
        decoderBytes: payload.length,
        referenceDigest,
        reconstructedDigest,
        exact: false,
        errorRatio: channelError / Math.max(1, channelCount),
        psnr: mse === 0 ? null : 10 * Math.log10((255 * 255) / mse),
        verifyMs,
        decodeMs,
        encodeMs,
        notes: `degree ${degree} Legendre tensor basis, ${terms.length} coefficients/channel; coefficients are the decoder and the stored artifact (counted once); no residual; ${payload.length} byte model`,
      };
    },
  };
}
