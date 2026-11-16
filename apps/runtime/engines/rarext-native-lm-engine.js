/*
 * RAREXT's own language-model engine — the native-lm runtime.
 *
 * This file is a RAREXT engine ARTIFACT, not a wrapper. It has no imports, no
 * native addons, no network, no filesystem. The provider fetches its shards from
 * RAREXT, verifies the committed digest, and evaluates this file in a `node:vm`
 * context that has no `require`. Its only inputs are the verified container and
 * the request.
 *
 * Container: `rarext.native-lm.v1` (magic "RNLM"), produced by
 * `scripts/train-native-lm.mjs` from RAREXT's own corpus.
 *
 *   magic   "RNLM" | u32 version | u32 headerLen | header JSON (utf8) | float32 LE tensors
 *
 * The model is a byte-level context MLP: the previous K bytes each contribute a
 * learned embedding, concatenated, through tanh into a softmax over the bytes the
 * corpus uses. Token ids ARE byte values (0-255), so `encode` is UTF-8 encoding
 * and `decode` is UTF-8 decoding — there is no borrowed tokenizer.
 *
 * Exports `run(model, input)` with the same decoding surface as RAREXT's GGUF
 * engine: temperature, topK, topP, minP, repetition/presence/frequency
 * penalties, logitBias, stop, logprobs/topLogprobs, pinnedTokens, seed. Greedy
 * is temperature 0; a sampled run is replayable from its seed. Also exports
 * `encode`, `decode`, `tokenBytes`, `embed`, and `describe`.
 */
(function () {
  "use strict";

  var MAGIC = "RNLM";
  var cache = typeof WeakMap === "function" ? new WeakMap() : null;

  // ── UTF-8, implemented here so the artifact needs no platform global ───────
  function utf8Encode(str) {
    var out = [];
    for (var i = 0; i < str.length; i += 1) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
          i += 1;
        } else out.push(0xef, 0xbf, 0xbd);
      } else if (c >= 0xdc00 && c <= 0xdfff) out.push(0xef, 0xbf, 0xbd);
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function utf8Decode(bytes) {
    var s = "";
    var i = 0;
    while (i < bytes.length) {
      var b = bytes[i];
      i += 1;
      if (b < 0x80) {
        s += String.fromCharCode(b);
        continue;
      }
      var n;
      var cp;
      if ((b & 0xe0) === 0xc0) { n = 1; cp = b & 0x1f; }
      else if ((b & 0xf0) === 0xe0) { n = 2; cp = b & 0x0f; }
      else if ((b & 0xf8) === 0xf0) { n = 3; cp = b & 0x07; }
      else { s += "\ufffd"; continue; }
      if (i + n > bytes.length) { s += "\ufffd"; break; }
      var ok = true;
      for (var j = 0; j < n; j += 1) {
        var cc = bytes[i + j];
        if ((cc & 0xc0) !== 0x80) { ok = false; break; }
        cp = (cp << 6) | (cc & 0x3f);
      }
      i += n;
      if (!ok) { s += "\ufffd"; continue; }
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) { s += "\ufffd"; continue; }
      if (cp <= 0xffff) s += String.fromCharCode(cp);
      else {
        cp -= 0x10000;
        s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return s;
  }

  // ── container parse ────────────────────────────────────────────────────────
  function parse(model) {
    if (cache !== null && model !== null && typeof model === "object") {
      var hit = cache.get(model);
      if (hit !== undefined) return hit;
    }
    var bytes = model && model.bytes;
    if (bytes === undefined || bytes === null || typeof bytes.length !== "number") {
      throw new Error("the rarext native-lm engine needs a model { bytes: Uint8Array }");
    }
    if (bytes.length < 12) throw new Error("native-lm container is shorter than its 12-byte header");
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== MAGIC) {
      throw new Error('not a RAREXT native-lm container (expected magic "RNLM")');
    }
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var version = view.getUint32(4, true);
    if (version !== 1) throw new Error("unsupported native-lm container version " + version);
    var headerLen = view.getUint32(8, true);
    var headerStart = 12;
    var headerEnd = headerStart + headerLen;
    if (headerEnd > bytes.length) throw new Error("native-lm header overruns the container");
    var header = JSON.parse(utf8Decode(Array.prototype.slice.call(bytes, headerStart, headerEnd)));
    if (header.kind !== "rarext.native-lm.v1") {
      throw new Error("native-lm header kind is " + String(header.kind));
    }
    var dataStart = headerEnd;
    var tensors = {};
    for (var i = 0; i < header.tensors.length; i += 1) {
      var t = header.tensors[i];
      var count = 1;
      for (var d = 0; d < t.shape.length; d += 1) count *= t.shape[d];
      var values = new Float32Array(count);
      var at = dataStart + t.offset;
      for (var k = 0; k < count; k += 1) values[k] = view.getFloat32(at + k * 4, true);
      tensors[t.name] = values;
    }
    var byteToVocab = new Int16Array(256).fill(-1);
    for (var v = 0; v < header.bytes.length; v += 1) byteToVocab[header.bytes[v]] = v;
    var parsed = {
      header: header,
      embed: tensors.embedding,
      w1: tensors.w1,
      b1: tensors.b1,
      w2: tensors.w2,
      b2: tensors.b2,
      byteToVocab: byteToVocab,
      context: header.context,
      dim: header.dim,
      hidden: header.hidden,
      vocab: header.vocab,
      bos: header.bos,
    };
    if (cache !== null && model !== null && typeof model === "object") cache.set(model, parsed);
    return parsed;
  }

  // ── forward ────────────────────────────────────────────────────────────────
  function logitsFor(p, contextIds) {
    var K = p.context;
    var D = p.dim;
    var IN = K * D;
    var H = p.hidden;
    var V = p.vocab;
    var x = p._x || (p._x = new Float32Array(IN));
    var h = p._h || (p._h = new Float32Array(H));
    var logits = p._logits || (p._logits = new Float32Array(V));
    for (var j = 0; j < K; j += 1) {
      var src = contextIds.length - K + j;
      var id = src < 0 ? p.bos : contextIds[src];
      var base = id * D;
      for (var d = 0; d < D; d += 1) x[j * D + d] = p.embed[base + d];
    }
    for (var hh = 0; hh < H; hh += 1) {
      var sum = p.b1[hh];
      var row = hh * IN;
      for (var i = 0; i < IN; i += 1) sum += p.w1[row + i] * x[i];
      h[hh] = Math.tanh(sum);
    }
    for (var v = 0; v < V; v += 1) {
      var s = p.b2[v];
      var r = v * H;
      for (var k2 = 0; k2 < H; k2 += 1) s += p.w2[r + k2] * h[k2];
      logits[v] = s;
    }
    return logits;
  }

  function entropyFree(logits, vocab, bos) {
    var max = -Infinity;
    for (var i = 0; i < vocab; i += 1) {
      if (i === bos) continue;
      if (logits[i] > max) max = logits[i];
    }
    var sum = 0;
    for (var j = 0; j < vocab; j += 1) {
      if (j === bos) continue;
      sum += Math.exp(logits[j] - max);
    }
    return { max: max, logSum: max + Math.log(sum) };
  }

  // ── sampler ────────────────────────────────────────────────────────────────
  function makeRng(seed) {
    var state = (seed | 0) >>> 0;
    return function () {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 0x100000000;
    };
  }

  function argmaxOf(logits, banned) {
    var best = -1;
    var bestV = -Infinity;
    for (var i = 0; i < logits.length; i += 1) {
      if (banned !== null && banned[i] === 1) continue;
      if (logits[i] > bestV) { bestV = logits[i]; best = i; }
    }
    return best;
  }

  function pick(logits, p, input, rng, seen) {
    var V = p.vocab;
    var banned = null;
    if (p.bos >= 0) {
      banned = new Uint8Array(V);
      banned[p.bos] = 1;
    }
    var work = new Float32Array(V);
    for (var v = 0; v < V; v += 1) work[v] = logits[v];
    var penalty = typeof input.repetitionPenalty === "number" ? input.repetitionPenalty : 1;
    var presence = typeof input.presencePenalty === "number" ? input.presencePenalty : 0;
    var frequency = typeof input.frequencyPenalty === "number" ? input.frequencyPenalty : 0;
    if (penalty !== 1 || presence !== 0 || frequency !== 0) {
      for (var s = 0; s < seen.length; s += 1) {
        var id = seen[s];
        if (penalty !== 1) work[id] = work[id] > 0 ? work[id] / penalty : work[id] * penalty;
        if (presence !== 0) work[id] -= presence;
        if (frequency !== 0) work[id] -= frequency;
      }
    }
    if (Array.isArray(input.logitBias)) {
      for (var b = 0; b < input.logitBias.length; b += 1) {
        var pair = input.logitBias[b];
        var token = p.byteToVocab[pair[0] & 255];
        if (token >= 0) work[token] += pair[1];
      }
    }
    var temperature = typeof input.temperature === "number" ? input.temperature : 0;
    if (!(temperature > 0)) return argmaxOf(work, banned);

    var topK = typeof input.topK === "number" ? input.topK : 40;
    var topP = typeof input.topP === "number" ? input.topP : 1;
    var minP = typeof input.minP === "number" ? input.minP : 0;

    var order = [];
    for (var o = 0; o < V; o += 1) if (banned === null || banned[o] !== 1) order.push(o);
    order.sort(function (a, b2) { return work[b2] - work[a]; });
    if (topK > 0 && topK < order.length) order.length = topK;

    var maxLogit = work[order[0]];
    var scaled = [];
    var total = 0;
    var bestP = 0;
    for (var oi = 0; oi < order.length; oi += 1) {
      var e = Math.exp((work[order[oi]] - maxLogit) / temperature);
      scaled.push(e);
      total += e;
      if (e > bestP) bestP = e;
    }
    var kept = [];
    var mass = 0;
    for (var ki = 0; ki < order.length; ki += 1) {
      var prob = scaled[ki] / total;
      if (minP > 0 && scaled[ki] / bestP < minP) continue;
      kept.push({ token: order[ki], prob: prob });
      mass += prob;
      if (topP < 1 && mass >= topP) break;
    }
    if (kept.length === 0) return order[0];
    var r = rng() * mass;
    var acc = 0;
    for (var kk = 0; kk < kept.length; kk += 1) {
      acc += kept[kk].prob;
      if (r <= acc) return kept[kk].token;
    }
    return kept[kept.length - 1].token;
  }

  function logprobOf(logits, token, p, topCount) {
    var ln = entropyFree(logits, p.vocab, p.bos);
    var top = [];
    if (topCount > 0) {
      var idx = [];
      for (var i = 0; i < p.vocab; i += 1) if (i !== p.bos) idx.push(i);
      idx.sort(function (a, b) { return logits[b] - logits[a]; });
      for (var t = 0; t < Math.min(topCount, idx.length); t += 1) {
        top.push({ token: p.header.bytes[idx[t]], logprob: logits[idx[t]] - ln.logSum });
      }
    }
    return { token: p.header.bytes[token], logprob: logits[token] - ln.logSum, top: top };
  }

  // ── public API ─────────────────────────────────────────────────────────────
  function encode(model, text) {
    var p = parse(model);
    var bytes = utf8Encode(String(text === undefined ? "" : text));
    var out = [];
    for (var i = 0; i < bytes.length; i += 1) {
      if (p.byteToVocab[bytes[i]] < 0) continue; // a byte the corpus never used
      out.push(bytes[i]);
    }
    return out;
  }

  function decode(model, ids) {
    var p = parse(model);
    var bytes = [];
    for (var i = 0; i < (ids || []).length; i += 1) {
      var id = ids[i];
      if (id >= 0 && id <= 255 && p.byteToVocab[id] >= 0) bytes.push(id);
    }
    return utf8Decode(bytes);
  }

  function tokenBytes(model, id) {
    var p = parse(model);
    if (id >= 0 && id <= 255 && p.byteToVocab[id] >= 0) return [id];
    return [];
  }

  /** The decoded text after each single token, with one parse (for streaming). */
  function decodeTokens(model, ids) {
    var p = parse(model);
    var out = [];
    for (var i = 0; i < (ids || []).length; i += 1) {
      var id = ids[i];
      out.push(id >= 0 && id <= 255 && p.byteToVocab[id] >= 0 ? utf8Decode([id]) : "");
    }
    return out;
  }

  /** The decoded prefix after each id, byte-correct across split UTF-8 runs. */
  function decodePrefixes(model, ids) {
    var p = parse(model);
    var seen = [];
    var out = [];
    for (var i = 0; i < (ids || []).length; i += 1) {
      var id = ids[i];
      if (id >= 0 && id <= 255 && p.byteToVocab[id] >= 0) seen.push(id);
      out.push(utf8Decode(seen));
    }
    return out;
  }

  function run(model, input) {
    var p = parse(model);
    var promptText = String(input && input.prompt !== undefined ? input.prompt : "");
    var promptBytes = encode(model, promptText);
    var contextLength = p.context;
    var truncated = promptBytes.length > contextLength;
    var promptIds = truncated ? promptBytes.slice(promptBytes.length - contextLength) : promptBytes.slice();
    var ctx = [];
    for (var c = 0; c < promptIds.length; c += 1) {
      var vid = p.byteToVocab[promptIds[c]];
      if (vid >= 0) ctx.push(vid);
    }
    var steps = Math.max(0, Math.floor(typeof input.steps === "number" ? input.steps : 1));
    var seed = typeof input.seed === "number" && Number.isFinite(input.seed) ? input.seed : 0;
    var rng = makeRng(seed);
    var tokens = [];
    var emitted = [];
    var logprobs = [];
    var seen = ctx.slice();
    var finish = "length";
    var pinned = Array.isArray(input.pinnedTokens) ? input.pinnedTokens : null;
    var stops = Array.isArray(input.stop) ? input.stop.filter(function (s) { return typeof s === "string" && s.length > 0; }) : [];
    var wantLogprobs = input.logprobs === true;
    var topCount = typeof input.topLogprobs === "number" ? Math.max(0, Math.min(20, input.topLogprobs)) : 0;

    for (var step = 0; step < steps; step += 1) {
      var logits = logitsFor(p, ctx);
      var tokenV;
      if (pinned !== null && step < pinned.length) {
        var pinByte = pinned[step];
        tokenV = p.byteToVocab[pinByte & 255];
        if (tokenV < 0) tokenV = argmaxOf(logits, null);
      } else {
        var scoredInput = input;
        tokenV = pick(logits, p, scoredInput, rng, seen);
      }
      if (wantLogprobs) logprobs.push(logprobOf(logits, tokenV, p, topCount));
      var byte = p.header.bytes[tokenV];
      tokens.push(byte);
      emitted.push(byte);
      seen.push(tokenV);
      ctx.push(tokenV);
      if (ctx.length > contextLength) ctx.shift();

      if (stops.length > 0) {
        var textSoFar = utf8Decode(emitted);
        var cut = -1;
        var cutStop = null;
        for (var s2 = 0; s2 < stops.length; s2 += 1) {
          var at = textSoFar.indexOf(stops[s2]);
          if (at >= 0 && (cut < 0 || at < cut)) { cut = at; cutStop = stops[s2]; }
        }
        if (cut >= 0) {
          var prefixText = textSoFar.slice(0, cut);
          var keep = [];
          var acc = "";
          for (var t2 = 0; t2 < emitted.length; t2 += 1) {
            acc = utf8Decode(emitted.slice(0, t2 + 1));
            if (acc.length <= prefixText.length) keep.push(emitted[t2]);
            else break;
          }
          tokens = keep.slice();
          emitted = keep.slice();
          finish = "stop";
          if (logprobs.length > tokens.length) logprobs.length = tokens.length;
          void cutStop;
          break;
        }
      }
    }

    var text = utf8Decode(emitted);
    var result = {
      text: text,
      seed: seed,
      steps: steps,
      tokens: tokens,
      finishReason: finish,
      contextLength: contextLength,
      promptTokens: promptIds.length,
      promptTruncated: truncated,
      promptIds: promptIds,
    };
    if (wantLogprobs) result.logprobs = logprobs;
    return result;
  }

  function embed(model, input) {
    var p = parse(model);
    var bytes = input && input.ids !== undefined ? input.ids : encode(model, input ? input.text : "");
    var sum = new Float32Array(p.dim);
    var n = 0;
    for (var i = 0; i < bytes.length; i += 1) {
      var vid = p.byteToVocab[bytes[i]];
      if (vid < 0) continue;
      var base = vid * p.dim;
      for (var d = 0; d < p.dim; d += 1) sum[d] += p.embed[base + d];
      n += 1;
    }
    var norm = 0;
    for (var d2 = 0; d2 < p.dim; d2 += 1) {
      sum[d2] = n === 0 ? 0 : sum[d2] / n;
      norm += sum[d2] * sum[d2];
    }
    norm = Math.sqrt(norm) || 1;
    for (var d3 = 0; d3 < p.dim; d3 += 1) sum[d3] /= norm;
    return { embedding: Array.prototype.slice.call(sum), dimensions: p.dim, tokens: bytes.length };
  }

  function describe(model) {
    var p = parse(model);
    var params = p.embed.length + p.w1.length + p.b1.length + p.w2.length + p.b2.length;
    return {
      kind: "rarext.native-lm.v1",
      label: p.header.label,
      architecture: p.header.architecture,
      family: "rarext-native",
      parameters: params,
      contextLength: p.context,
      dim: p.dim,
      hidden: p.hidden,
      vocab: p.vocab,
      quantization: null,
      format: "rnlm",
      lineage: p.header.lineage,
      training: p.header.training,
    };
  }

  var api = {
    run: run,
    encode: encode,
    decode: decode,
    tokenBytes: tokenBytes,
    decodeTokens: decodeTokens,
    decodePrefixes: decodePrefixes,
    embed: embed,
    describe: describe,
    chatTemplate: function () { return null; },
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof globalThis !== "undefined") globalThis.RAREXT_NATIVE_LM = api;
})();
