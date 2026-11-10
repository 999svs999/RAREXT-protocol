/*
 * RAREXT's own GGUF inference engine.
 *
 * This file is a RAREXT engine ARTIFACT, not a wrapper around a third-party
 * runtime. It is self-contained on purpose: no imports, no native addons, no
 * Ollama, no llama.cpp, no container. The provider fetches its shards from
 * RAREXT, verifies the committed digest, and evaluates this file in a `node:vm`
 * context that has no `require` and no filesystem. The only inputs are the
 * verified model bytes and the request.
 *
 * Supported container: GGUF v2/v3 (little endian).
 * Supported tensor types: F32, F16, Q4_0, Q5_0, Q8_0, Q4_K, Q6_K.
 * Supported architecture: qwen2 (GQA + NeoX RoPE + SwiGLU + tied output).
 *
 * Exports `run(model, input)` where `model` is `{ kind: "gguf", bytes }` and
 * `input` is `{ prompt, steps, seed, temperature }`. Returns
 * `{ text, seed, steps, tokens }`; `tokens` are the generated token ids, so the
 * run carries a decode trace a replay can re-check token for token.
 */
(function () {
  "use strict";

  // ── fp16 ──────────────────────────────────────────────────────────────────
  var F16_TABLE = null;
  function f16(bits) {
    if (F16_TABLE === null) {
      F16_TABLE = new Float32Array(65536);
      for (var i = 0; i < 65536; i += 1) {
        var sign = (i >> 15) & 1;
        var exponent = (i >> 10) & 31;
        var mantissa = i & 1023;
        var value;
        if (exponent === 0) value = mantissa * Math.pow(2, -24);
        else if (exponent === 31) value = mantissa === 0 ? Infinity : NaN;
        else value = (1 + mantissa / 1024) * Math.pow(2, exponent - 15);
        F16_TABLE[i] = sign === 1 ? -value : value;
      }
    }
    return F16_TABLE[bits & 0xffff];
  }

  // ── GGUF reader ───────────────────────────────────────────────────────────
  var TYPE_F32 = 0;
  var TYPE_F16 = 1;
  var TYPE_Q4_0 = 2;
  var TYPE_Q5_0 = 6;
  var TYPE_Q8_0 = 8;
  var TYPE_Q4_K = 12;
  var TYPE_Q6_K = 14;

  // bytes per block, and weights per block
  var BLOCK = {};
  BLOCK[TYPE_F32] = { bytes: 4, weights: 1 };
  BLOCK[TYPE_F16] = { bytes: 2, weights: 1 };
  BLOCK[TYPE_Q4_0] = { bytes: 18, weights: 32 };
  BLOCK[TYPE_Q5_0] = { bytes: 22, weights: 32 };
  BLOCK[TYPE_Q8_0] = { bytes: 34, weights: 32 };
  BLOCK[TYPE_Q4_K] = { bytes: 144, weights: 256 };
  BLOCK[TYPE_Q6_K] = { bytes: 210, weights: 256 };

  function Reader(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }
  Reader.prototype.u8 = function () {
    var v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  };
  Reader.prototype.i8 = function () {
    var v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  };
  Reader.prototype.u16 = function () {
    var v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  };
  Reader.prototype.u32 = function () {
    var v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  };
  Reader.prototype.i32 = function () {
    var v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  };
  Reader.prototype.f32 = function () {
    var v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  };
  Reader.prototype.f64 = function () {
    var v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  };
  Reader.prototype.u64 = function () {
    var v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    // GGUF sizes and offsets fit comfortably in a double for real models.
    return Number(v);
  };
  Reader.prototype.i64 = function () {
    var v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return Number(v);
  };
  var UTF8 = null;
  function decodeUtf8(bytes) {
    if (UTF8 === null) UTF8 = new TextDecoder("utf-8");
    return UTF8.decode(bytes);
  }
  Reader.prototype.str = function () {
    var length = this.u64();
    var start = this.offset;
    if (start + length > this.bytes.length) throw new Error("GGUF string runs past the end of the file");
    var text = decodeUtf8(this.bytes.subarray(start, start + length));
    this.offset += length;
    return text;
  };

  var SCALAR = {
    0: "u8", 1: "i8", 2: "u16", 3: "i16", 4: "u32", 5: "i32",
    6: "f32", 7: "bool", 8: "str", 10: "u64", 11: "i64", 12: "f64",
  };

  function readScalar(reader, type) {
    switch (type) {
      case 0: return reader.u8();
      case 1: return reader.i8();
      case 2: return reader.u16();
      case 3: var s3 = reader.u16(); return s3 >= 0x8000 ? s3 - 0x10000 : s3;
      case 4: return reader.u32();
      case 5: return reader.i32();
      case 6: return reader.f32();
      case 7: return reader.u8() !== 0;
      case 8: return reader.str();
      case 10: return reader.u64();
      case 11: return reader.i64();
      case 12: return reader.f64();
      default: throw new Error("unsupported GGUF scalar type " + type);
    }
  }

  function parseGguf(bytes) {
    var reader = new Reader(bytes);
    var magic = String.fromCharCode(reader.u8(), reader.u8(), reader.u8(), reader.u8());
    if (magic !== "GGUF") throw new Error("not a GGUF file (magic " + JSON.stringify(magic) + ")");
    var version = reader.u32();
    if (version < 2 || version > 3) throw new Error("unsupported GGUF version " + version);
    var tensorCount = reader.u64();
    var kvCount = reader.u64();

    var kv = {};
    for (var i = 0; i < kvCount; i += 1) {
      var key = reader.str();
      var type = reader.u32();
      if (type === 9) {
        var elementType = reader.u32();
        var length = reader.u64();
        var array = new Array(length);
        for (var j = 0; j < length; j += 1) array[j] = readScalar(reader, elementType);
        kv[key] = array;
      } else {
        kv[key] = readScalar(reader, type);
      }
    }

    var tensors = {};
    for (var t = 0; t < tensorCount; t += 1) {
      var name = reader.str();
      var dims = [];
      var nDims = reader.u32();
      for (var d = 0; d < nDims; d += 1) dims.push(reader.u64());
      var tensorType = reader.u32();
      var offset = reader.u64();
      var block = BLOCK[tensorType];
      if (block === undefined) throw new Error("unsupported tensor type " + tensorType + " for " + name);
      var cols = dims[0];
      if (cols % block.weights !== 0) {
        throw new Error("tensor " + name + " has " + cols + " columns, not a multiple of " + block.weights);
      }
      var rowBytes = (cols / block.weights) * block.bytes;
      var rows = 1;
      for (var r = 1; r < dims.length; r += 1) rows *= dims[r];
      tensors[name] = {
        name: name,
        type: tensorType,
        dims: dims,
        cols: cols,
        rows: rows,
        rowBytes: rowBytes,
        offset: offset,
      };
    }
    // The data section begins after the tensor-info table, not after the KV
    // block. Aligning the wrong offset reads tensor metadata as weights.
    var alignment = 32;
    if (typeof kv["general.alignment"] === "number" && kv["general.alignment"] > 0) {
      alignment = kv["general.alignment"];
    }
    var dataStart = Math.ceil(reader.offset / alignment) * alignment;
    return { kv: kv, tensors: tensors, dataStart: dataStart, bytes: bytes, view: reader.view };
  }

  // ── quantized rows ────────────────────────────────────────────────────────

  function dequantRow(model, tensor, row, out) {
    var view = model.view;
    var base = model.dataStart + tensor.offset + row * tensor.rowBytes;
    var cols = tensor.cols;
    var i;
    var block;
    switch (tensor.type) {
      case TYPE_F32:
        for (i = 0; i < cols; i += 1) out[i] = view.getFloat32(base + i * 4, true);
        return out;
      case TYPE_F16:
        for (i = 0; i < cols; i += 1) out[i] = f16(view.getUint16(base + i * 2, true));
        return out;
      case TYPE_Q4_0:
        for (block = 0; block < cols; block += 32) {
          var q4base = base + (block / 32) * 18;
          var d4 = f16(view.getUint16(q4base, true));
          for (i = 0; i < 16; i += 1) {
            var q4 = view.getUint8(q4base + 2 + i);
            out[block + i] = ((q4 & 15) - 8) * d4;
            out[block + i + 16] = ((q4 >> 4) - 8) * d4;
          }
        }
        return out;
      case TYPE_Q5_0:
        for (block = 0; block < cols; block += 32) {
          var q5base = base + (block / 32) * 22;
          var d5 = f16(view.getUint16(q5base, true));
          var qh = view.getUint32(q5base + 2, true);
          for (i = 0; i < 16; i += 1) {
            var q5 = view.getUint8(q5base + 6 + i);
            out[block + i] = (((q5 & 15) | (((qh >> i) & 1) << 4)) - 16) * d5;
            out[block + i + 16] = (((q5 >> 4) | (((qh >> (i + 16)) & 1) << 4)) - 16) * d5;
          }
        }
        return out;
      case TYPE_Q8_0:
        for (block = 0; block < cols; block += 32) {
          var q8base = base + (block / 32) * 34;
          var d8 = f16(view.getUint16(q8base, true));
          for (i = 0; i < 32; i += 1) out[block + i] = view.getInt8(q8base + 2 + i) * d8;
        }
        return out;
      case TYPE_Q4_K:
        for (var sb = 0; sb < cols; sb += 256) {
          var kbase = base + (sb / 256) * 144;
          var kd = f16(view.getUint16(kbase, true));
          var kmin = f16(view.getUint16(kbase + 2, true));
          var scales = kbase + 4;
          var qs = kbase + 16;
          var is = 0;
          var qpos = 0;
          var vpos = sb;
          for (var group = 0; group < 256; group += 64) {
            var s0 = scaleMinK4(view, scales, is);
            var s1 = scaleMinK4(view, scales, is + 1);
            var d0 = kd * s0.d;
            var m0 = kmin * s0.m;
            var d1 = kd * s1.d;
            var m1 = kmin * s1.m;
            for (i = 0; i < 32; i += 1) {
              out[vpos + i] = d0 * (view.getUint8(qs + qpos + i) & 15) - m0;
            }
            for (i = 0; i < 32; i += 1) {
              out[vpos + 32 + i] = d1 * (view.getUint8(qs + qpos + i) >> 4) - m1;
            }
            qpos += 32;
            vpos += 64;
            is += 2;
          }
        }
        return out;
      case TYPE_Q6_K:
        for (var kb = 0; kb < cols; kb += 256) {
          var q6base = base + (kb / 256) * 210;
          var q6d = f16(view.getUint16(q6base + 208, true));
          var qlBase = q6base;
          var qhBase = q6base + 128;
          var scBase = q6base + 192;
          for (var half = 0; half < 2; half += 1) {
            for (i = 0; i < 32; i += 1) {
              var idx = half * 32 + i;
              var is6 = i < 16 ? 0 : 1;
              var ql0 = view.getUint8(qlBase + idx);
              var ql1 = view.getUint8(qlBase + idx + 32);
              var qh = view.getUint8(qhBase + idx);
              var q1 = ((ql0 & 15) | (((qh >> 0) & 3) << 4)) - 32;
              var q2 = ((ql1 & 15) | (((qh >> 2) & 3) << 4)) - 32;
              var q3 = ((ql0 >> 4) | (((qh >> 4) & 3) << 4)) - 32;
              var q4 = ((ql1 >> 4) | (((qh >> 6) & 3) << 4)) - 32;
              var o = kb + half * 128 + i;
              out[o] = q6d * view.getInt8(scBase + half * 8 + is6 + 0) * q1;
              out[o + 32] = q6d * view.getInt8(scBase + half * 8 + is6 + 2) * q2;
              out[o + 64] = q6d * view.getInt8(scBase + half * 8 + is6 + 4) * q3;
              out[o + 96] = q6d * view.getInt8(scBase + half * 8 + is6 + 6) * q4;
            }
          }
        }
        return out;
      default:
        throw new Error("cannot dequantize tensor type " + tensor.type);
    }
  }

  function scaleMinK4(view, base, j) {
    var qj = view.getUint8(base + j);
    if (j < 4) {
      return { d: qj & 63, m: view.getUint8(base + j + 4) & 63 };
    }
    var qj4 = view.getUint8(base + j + 4);
    return {
      d: (qj4 & 15) | (((view.getUint8(base + j - 4) >> 6) & 3) << 4),
      m: (qj4 >> 4) | (((qj >> 6) & 3) << 4),
    };
  }

  /** Dot one quantized row against a dense vector. Kept in the quant domain so a
   * 0.5B model is served without ever materializing its weights as floats. */
  function dotRow(model, tensor, row, vec) {
    var view = model.view;
    var base = model.dataStart + tensor.offset + row * tensor.rowBytes;
    var cols = tensor.cols;
    var total = 0;
    var block;
    var i;
    var sum;
    switch (tensor.type) {
      case TYPE_F32:
        for (i = 0; i < cols; i += 1) total += view.getFloat32(base + i * 4, true) * vec[i];
        return total;
      case TYPE_F16:
        for (i = 0; i < cols; i += 1) total += f16(view.getUint16(base + i * 2, true)) * vec[i];
        return total;
      case TYPE_Q4_0:
        for (block = 0; block < cols; block += 32) {
          var q4base = base + (block / 32) * 18;
          var d4 = f16(view.getUint16(q4base, true));
          sum = 0;
          for (i = 0; i < 16; i += 1) {
            var q4 = view.getUint8(q4base + 2 + i);
            sum += ((q4 & 15) - 8) * vec[block + i];
            sum += ((q4 >> 4) - 8) * vec[block + i + 16];
          }
          total += d4 * sum;
        }
        return total;
      case TYPE_Q5_0:
        for (block = 0; block < cols; block += 32) {
          var q5base = base + (block / 32) * 22;
          var d5 = f16(view.getUint16(q5base, true));
          var qh = view.getUint32(q5base + 2, true);
          sum = 0;
          for (i = 0; i < 16; i += 1) {
            var q5 = view.getUint8(q5base + 6 + i);
            sum += (((q5 & 15) | (((qh >> i) & 1) << 4)) - 16) * vec[block + i];
            sum += (((q5 >> 4) | (((qh >> (i + 16)) & 1) << 4)) - 16) * vec[block + i + 16];
          }
          total += d5 * sum;
        }
        return total;
      case TYPE_Q8_0:
        for (block = 0; block < cols; block += 32) {
          var q8base = base + (block / 32) * 34;
          var d8 = f16(view.getUint16(q8base, true));
          sum = 0;
          for (i = 0; i < 32; i += 1) sum += view.getInt8(q8base + 2 + i) * vec[block + i];
          total += d8 * sum;
        }
        return total;
      case TYPE_Q4_K:
        sum = 0;
        for (var sb = 0; sb < cols; sb += 256) {
          var kbase = base + (sb / 256) * 144;
          var kd = f16(view.getUint16(kbase, true));
          var kmin = f16(view.getUint16(kbase + 2, true));
          var scales = kbase + 4;
          var qs = kbase + 16;
          var is = 0;
          var qpos = 0;
          var vpos = sb;
          for (var group = 0; group < 256; group += 64) {
            var s0 = scaleMinK4(view, scales, is);
            var s1 = scaleMinK4(view, scales, is + 1);
            var d0 = kd * s0.d;
            var m0 = kmin * s0.m;
            var d1 = kd * s1.d;
            var m1 = kmin * s1.m;
            for (i = 0; i < 32; i += 1) {
              sum += (d0 * (view.getUint8(qs + qpos + i) & 15) - m0) * vec[vpos + i];
            }
            for (i = 0; i < 32; i += 1) {
              sum += (d1 * (view.getUint8(qs + qpos + i) >> 4) - m1) * vec[vpos + 32 + i];
            }
            qpos += 32;
            vpos += 64;
            is += 2;
          }
        }
        return total + sum;
      case TYPE_Q6_K:
        for (var kb = 0; kb < cols; kb += 256) {
          var q6base = base + (kb / 256) * 210;
          var q6d = f16(view.getUint16(q6base + 208, true));
          var qlBase = q6base;
          var qhBase = q6base + 128;
          var scBase = q6base + 192;
          for (var half = 0; half < 2; half += 1) {
            for (i = 0; i < 32; i += 1) {
              var idx = half * 32 + i;
              var is6 = i < 16 ? 0 : 1;
              var ql0 = view.getUint8(qlBase + idx);
              var ql1 = view.getUint8(qlBase + idx + 32);
              var qh = view.getUint8(qhBase + idx);
              var q1 = ((ql0 & 15) | (((qh >> 0) & 3) << 4)) - 32;
              var q2 = ((ql1 & 15) | (((qh >> 2) & 3) << 4)) - 32;
              var q3 = ((ql0 >> 4) | (((qh >> 4) & 3) << 4)) - 32;
              var q4 = ((ql1 >> 4) | (((qh >> 6) & 3) << 4)) - 32;
              var o = kb + half * 128 + i;
              total += q6d * view.getInt8(scBase + half * 8 + is6 + 0) * q1 * vec[o];
              total += q6d * view.getInt8(scBase + half * 8 + is6 + 2) * q2 * vec[o + 32];
              total += q6d * view.getInt8(scBase + half * 8 + is6 + 4) * q3 * vec[o + 64];
              total += q6d * view.getInt8(scBase + half * 8 + is6 + 6) * q4 * vec[o + 96];
            }
          }
        }
        return total;
      default:
        throw new Error("cannot dot tensor type " + tensor.type);
    }
  }

  // ── tokenizer ─────────────────────────────────────────────────────────────
  function bytesToUnicode() {
    var bs = [];
    var cs = [];
    var b;
    for (b = 33; b <= 126; b += 1) { bs.push(b); cs.push(b); }
    for (b = 161; b <= 172; b += 1) { bs.push(b); cs.push(b); }
    for (b = 174; b <= 255; b += 1) { bs.push(b); cs.push(b); }
    var n = 0;
    for (b = 0; b < 256; b += 1) {
      if (bs.indexOf(b) === -1) {
        bs.push(b);
        cs.push(256 + n);
        n += 1;
      }
    }
    var byteToChar = {};
    var charToByte = {};
    for (var i = 0; i < bs.length; i += 1) {
      var ch = String.fromCharCode(cs[i]);
      byteToChar[bs[i]] = ch;
      charToByte[ch] = bs[i];
    }
    return { byteToChar: byteToChar, charToByte: charToByte };
  }

  var PRETOKEN =
    "(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])" +
    "|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+" +
    "|\\p{N}" +
    "| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*" +
    "|\\s*[\\r\\n]+" +
    "|\\s+(?!\\S)" +
    "|\\s+";

  function Tokenizer(model) {
    var kv = model.kv;
    this.tokens = kv["tokenizer.ggml.tokens"];
    if (!Array.isArray(this.tokens)) throw new Error("GGUF has no tokenizer.ggml.tokens");
    var merges = kv["tokenizer.ggml.merges"];
    if (!Array.isArray(merges)) merges = [];
    this.ids = new Map();
    for (var i = 0; i < this.tokens.length; i += 1) {
      if (!this.ids.has(this.tokens[i])) this.ids.set(this.tokens[i], i);
    }
    this.ranks = new Map();
    for (var m = 0; m < merges.length; m += 1) {
      if (!this.ranks.has(merges[m])) this.ranks.set(merges[m], m);
    }
    var map = bytesToUnicode();
    this.byteToChar = map.byteToChar;
    this.charToByte = map.charToByte;
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    this.pattern = new RegExp(PRETOKEN, "gu");
  }

  Tokenizer.prototype.pieces = function (text) {
    var out = [];
    var match;
    this.pattern.lastIndex = 0;
    while ((match = this.pattern.exec(text)) !== null) {
      if (match[0].length > 0) out.push(match[0]);
    }
    return out;
  };

  Tokenizer.prototype.bpe = function (symbols) {
    if (symbols.length <= 1) return symbols;
    while (symbols.length > 1) {
      var bestRank = Infinity;
      var bestPair = null;
      for (var i = 0; i < symbols.length - 1; i += 1) {
        var rank = this.ranks.get(symbols[i] + " " + symbols[i + 1]);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestPair = symbols[i] + " " + symbols[i + 1];
        }
      }
      if (bestPair === null) break;
      var merged = [];
      for (var j = 0; j < symbols.length; ) {
        if (j < symbols.length - 1 && symbols[j] + " " + symbols[j + 1] === bestPair) {
          merged.push(symbols[j] + symbols[j + 1]);
          j += 2;
        } else {
          merged.push(symbols[j]);
          j += 1;
        }
      }
      symbols = merged;
    }
    return symbols;
  };

  Tokenizer.prototype.encode = function (text) {
    var ids = [];
    var pieces = this.pieces(text);
    if (pieces.length === 0) return ids;
    // Re-encode piece by piece rather than slicing the original bytes: the
    // pre-tokenizer guarantees the concatenation of the pieces is the input.
    for (var p = 0; p < pieces.length; p += 1) {
      var piece = pieces[p];
      var raw = this.encoder.encode(piece);
      var symbols = [];
      for (var r = 0; r < raw.length; r += 1) symbols.push(this.byteToChar[raw[r]]);
      var merged = this.bpe(symbols);
      for (var s = 0; s < merged.length; s += 1) {
        var id = this.ids.get(merged[s]);
        if (id === undefined) {
          // Byte fallback: emit the raw bytes the symbol stands for.
          for (var c = 0; c < merged[s].length; c += 1) {
            var byte = this.charToByte[merged[s][c]];
            var fallback = this.ids.get("<0x" + (byte < 16 ? "0" : "") + byte.toString(16).toUpperCase() + ">");
            if (fallback !== undefined) ids.push(fallback);
          }
        } else {
          ids.push(id);
        }
      }
    }
    return ids;
  };

  Tokenizer.prototype.decode = function (ids) {
    var text = "";
    for (var i = 0; i < ids.length; i += 1) text += this.tokens[ids[i]] || "";
    var bytes = [];
    for (var c = 0; c < text.length; c += 1) {
      var byte = this.charToByte[text[c]];
      if (byte === undefined) {
        // A special token (e.g. <|im_end|>) is literal text, not byte-encoded.
        return text;
      }
      bytes.push(byte);
    }
    return this.decoder.decode(new Uint8Array(bytes));
  };

  // ── math ──────────────────────────────────────────────────────────────────
  function rmsNorm(out, x, weight, eps) {
    var sum = 0;
    for (var i = 0; i < x.length; i += 1) sum += x[i] * x[i];
    var scale = 1 / Math.sqrt(sum / x.length + eps);
    for (var j = 0; j < x.length; j += 1) out[j] = x[j] * scale * weight[j];
    return out;
  }

  function silu(x) {
    return x / (1 + Math.exp(-x));
  }

  /** y = W x, one quantized row at a time. */
  function matmul(model, tensor, x, y) {
    for (var row = 0; row < tensor.rows; row += 1) y[row] = dotRow(model, tensor, row, x);
    return y;
  }

  function addBias(y, bias) {
    if (bias === undefined) return y;
    for (var i = 0; i < y.length; i += 1) y[i] += bias[i];
    return y;
  }

  function tensorOrNull(model, name) {
    return model.tensors[name];
  }

  // ── inference ─────────────────────────────────────────────────────────────
  function argmax(values) {
    var best = 0;
    var bestValue = values[0];
    for (var i = 1; i < values.length; i += 1) {
      if (values[i] > bestValue) {
        bestValue = values[i];
        best = i;
      }
    }
    return best;
  }

  function sample(values, temperature, rng) {
    var max = -Infinity;
    var i;
    for (i = 0; i < values.length; i += 1) if (values[i] > max) max = values[i];
    var sum = 0;
    var probs = new Float64Array(values.length);
    for (i = 0; i < values.length; i += 1) {
      var p = Math.exp((values[i] - max) / temperature);
      probs[i] = p;
      sum += p;
    }
    var target = rng() * sum;
    var running = 0;
    for (i = 0; i < values.length; i += 1) {
      running += probs[i];
      if (running >= target) return i;
    }
    return values.length - 1;
  }

  function xorshift(seed) {
    var state = (seed >>> 0) || 0x9e3779b9;
    return function () {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 4294967296;
    };
  }

  function run(model, input) {
    if (!model || model.kind !== "gguf" || !ArrayBuffer.isView(model.bytes)) {
      throw new Error('the rarext gguf engine needs a model { kind: "gguf", bytes: Uint8Array }');
    }
    var gguf = parseGguf(model.bytes);
    var kv = gguf.kv;
    var arch = kv["general.architecture"];
    if (arch !== "qwen2") throw new Error("this rarext engine supports qwen2 GGUF; got " + String(arch));

    var nLayer = kv["qwen2.block_count"];
    var nEmbd = kv["qwen2.embedding_length"];
    var nHead = kv["qwen2.attention.head_count"];
    var nHeadKv = kv["qwen2.attention.head_count_kv"];
    var nFfn = kv["qwen2.feed_forward_length"];
    var eps = kv["qwen2.attention.layer_norm_rms_epsilon"] || 1e-6;
    var ropeBase = kv["qwen2.rope.freq_base"] || 10000;
    var headDim = nEmbd / nHead;
    var group = nHead / nHeadKv;

    var tokenizer = new Tokenizer(gguf);
    var embd = tensorOrNull(gguf, "token_embd.weight");
    if (embd === undefined) throw new Error("GGUF has no token_embd.weight");
    var outputNorm = tensorOrNull(gguf, "output_norm.weight");

    var prompt = String(input.prompt == null ? "" : input.prompt);
    var promptIds = tokenizer.encode(prompt);
    var bos = kv["tokenizer.ggml.bos_token_id"];
    if (promptIds.length === 0 && typeof bos === "number") promptIds.push(bos);

    var steps = Math.max(1, Math.min(Number(input.steps) || 16, 256));
    var temperature = typeof input.temperature === "number" ? input.temperature : 0;
    var seed = Number.isSafeInteger(input.seed) ? input.seed : 0;
    var rng = xorshift(seed >>> 0);

    var x = new Float32Array(nEmbd);
    var norm = new Float32Array(nEmbd);
    var q = new Float32Array(nEmbd);
    var k = new Float32Array(nHeadKv * headDim);
    var v = new Float32Array(nHeadKv * headDim);
    var attn = new Float32Array(nEmbd);
    var gate = new Float32Array(nFfn);
    var up = new Float32Array(nFfn);
    var hidden = new Float32Array(nEmbd);
    var logits = new Float32Array(embd.rows);

    // Per-layer KV cache: one Float32Array per position, for every layer.
    var cacheK = [];
    var cacheV = [];
    for (var layer = 0; layer < nLayer; layer += 1) {
      cacheK.push([]);
      cacheV.push([]);
    }

    var position = 0;
    var generated = [];
    var allIds = promptIds.slice();

    function forward(tokenId) {
      dequantRow(gguf, embd, tokenId, x);
      for (var layerIndex = 0; layerIndex < nLayer; layerIndex += 1) {
        var prefix = "blk." + layerIndex + ".";
        var attnNorm = tensorOrNull(gguf, prefix + "attn_norm.weight");
        rmsNorm(norm, x, dequantNorm(gguf, attnNorm, nEmbd), eps);

        matmul(gguf, tensorOrNull(gguf, prefix + "attn_q.weight"), norm, q);
        addBias(q, biasOrNull(gguf, prefix + "attn_q.bias", nEmbd));
        matmul(gguf, tensorOrNull(gguf, prefix + "attn_k.weight"), norm, k);
        addBias(k, biasOrNull(gguf, prefix + "attn_k.bias", nHeadKv * headDim));
        matmul(gguf, tensorOrNull(gguf, prefix + "attn_v.weight"), norm, v);
        addBias(v, biasOrNull(gguf, prefix + "attn_v.bias", nHeadKv * headDim));

        rope(q, nHead, headDim, position, ropeBase);
        rope(k, nHeadKv, headDim, position, ropeBase);

        cacheK[layerIndex].push(new Float32Array(k));
        cacheV[layerIndex].push(new Float32Array(v));

        var scale = 1 / Math.sqrt(headDim);
        for (var h = 0; h < nHead; h += 1) {
          var kvh = (h / group) | 0;
          var qBase = h * headDim;
          var positions = cacheK[layerIndex].length;
          var scores = new Float32Array(positions);
          var maxScore = -Infinity;
          for (var p = 0; p < positions; p += 1) {
            var kp = cacheK[layerIndex][p];
            var score = 0;
            for (var d = 0; d < headDim; d += 1) score += q[qBase + d] * kp[kvh * headDim + d];
            score *= scale;
            scores[p] = score;
            if (score > maxScore) maxScore = score;
          }
          var denom = 0;
          for (var p2 = 0; p2 < positions; p2 += 1) {
            var e = Math.exp(scores[p2] - maxScore);
            scores[p2] = e;
            denom += e;
          }
          for (var d2 = 0; d2 < headDim; d2 += 1) {
            var weighted = 0;
            for (var p3 = 0; p3 < positions; p3 += 1) {
              weighted += (scores[p3] / denom) * cacheV[layerIndex][p3][kvh * headDim + d2];
            }
            attn[qBase + d2] = weighted;
          }
        }

        matmul(gguf, tensorOrNull(gguf, prefix + "attn_output.weight"), attn, hidden);
        for (var a = 0; a < nEmbd; a += 1) x[a] += hidden[a];

        var ffnNorm = tensorOrNull(gguf, prefix + "ffn_norm.weight");
        rmsNorm(norm, x, dequantNorm(gguf, ffnNorm, nEmbd), eps);
        matmul(gguf, tensorOrNull(gguf, prefix + "ffn_gate.weight"), norm, gate);
        matmul(gguf, tensorOrNull(gguf, prefix + "ffn_up.weight"), norm, up);
        for (var f = 0; f < nFfn; f += 1) gate[f] = silu(gate[f]) * up[f];
        matmul(gguf, tensorOrNull(gguf, prefix + "ffn_down.weight"), gate, hidden);
        for (var r = 0; r < nEmbd; r += 1) x[r] += hidden[r];
      }

      rmsNorm(norm, x, dequantNorm(gguf, outputNorm, nEmbd), eps);
      for (var row = 0; row < embd.rows; row += 1) logits[row] = dotRow(gguf, embd, row, norm);
      return logits;
    }

    var normCache = new Map();
    function dequantNorm(g, tensor, size) {
      if (tensor === undefined) throw new Error("GGUF is missing a norm tensor");
      var cached = normCache.get(tensor.name);
      if (cached !== undefined) return cached;
      var out = new Float32Array(size);
      dequantRow(g, tensor, 0, out);
      normCache.set(tensor.name, out);
      return out;
    }
    function biasOrNull(g, name, size) {
      var tensor = tensorOrNull(g, name);
      if (tensor === undefined) return undefined;
      return dequantNorm(g, tensor, size);
    }

    for (var i = 0; i < promptIds.length; i += 1) {
      // The last prompt token produces the first generated token; earlier ones
      // only fill the cache.
      var stepLogits = forward(promptIds[i]);
      position += 1;
      if (i === promptIds.length - 1) {
        var next = temperature > 0 ? sample(stepLogits, temperature, rng) : argmax(stepLogits);
        generated.push(next);
      }
    }
    if (promptIds.length === 0) throw new Error("the prompt produced no tokens");

    for (var step = 1; step < steps; step += 1) {
      var token = generated[generated.length - 1];
      var nextLogits = forward(token);
      position += 1;
      var nextToken = temperature > 0 ? sample(nextLogits, temperature, rng) : argmax(nextLogits);
      generated.push(nextToken);
    }

    return {
      text: tokenizer.decode(generated),
      seed: seed,
      steps: generated.length,
      tokens: generated,
    };
  }

  function rope(vector, heads, headDim, position, base) {
    var half = headDim / 2;
    for (var h = 0; h < heads; h += 1) {
      var off = h * headDim;
      for (var i = 0; i < half; i += 1) {
        var theta = position * Math.pow(base, (-2 * i) / headDim);
        var cos = Math.cos(theta);
        var sin = Math.sin(theta);
        var x0 = vector[off + i];
        var x1 = vector[off + i + half];
        vector[off + i] = x0 * cos - x1 * sin;
        vector[off + i + half] = x0 * sin + x1 * cos;
      }
    }
  }

  var api = { run: run, parseGguf: parseGguf, encode: function (model, text) {
    return new Tokenizer(parseGguf(model.bytes)).encode(text);
  } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof globalThis !== "undefined") globalThis.RAREXT_GGUF = api;
})();
