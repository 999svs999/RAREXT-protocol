#!/usr/bin/env python3
"""Independently dequantize the GGUF and compare against the engine's dump.

This is the last shared component between the JS engine and the NumPy reference:
if the engine's dequantization is wrong, both agree on wrong weights. So this
parses the GGUF from the raw bytes and implements Q5_0, Q8_0, Q4_K, Q6_K and F32
from the ggml definitions, then compares row by row.
"""
import json
import struct
import sys
import numpy as np

GGUF = sys.argv[1]
DUMP = "/tmp/npw"
TYPES = {0: "F32", 1: "F16", 2: "Q4_0", 6: "Q5_0", 8: "Q8_0", 12: "Q4_K", 14: "Q6_K"}
BLOCK = {"Q4_0": (18, 32), "Q5_0": (22, 32), "Q8_0": (34, 32), "Q4_K": (144, 256), "Q6_K": (210, 256)}


def f16(bits):
    return np.frombuffer(np.uint16(bits).tobytes(), dtype=np.float16).astype(np.float32)[0]


def parse_gguf(path):
    with open(path, "rb") as fh:
        data = fh.read()
    off = 0
    magic, version = data[0:4], struct.unpack_from("<I", data, 4)[0]
    assert magic == b"GGUF", magic
    off = 8
    n_tensors, n_kv = struct.unpack_from("<QQ", data, off)
    off += 16

    def read_string(o):
        n = struct.unpack_from("<Q", data, o)[0]
        return data[o + 8:o + 8 + n].decode("utf-8", "replace"), o + 8 + n

    def skip_value(o, t):
        sizes = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
        if t == 8:
            return read_string(o)[1]
        if t == 9:
            at, cnt = struct.unpack_from("<IQ", data, o)
            o += 12
            if at == 8:
                for _ in range(cnt):
                    o = read_string(o)[1]
                return o
            return o + sizes[at] * cnt
        return o + sizes[t]

    kv = {}
    for _ in range(n_kv):
        key, off = read_string(off)
        t = struct.unpack_from("<I", data, off)[0]
        off += 4
        if key in ("tokenizer.ggml.tokens", "tokenizer.ggml.merges", "tokenizer.ggml.scores",
                   "tokenizer.ggml.token_type"):
            kv[key] = "skipped"
            off = skip_value(off, t)
            continue
        start = off
        off = skip_value(off, t)
        if t == 8:
            kv[key], _ = read_string(start)
        elif t == 6:
            kv[key] = struct.unpack_from("<f", data, start)[0]
        elif t in (4, 5):
            kv[key] = struct.unpack_from("<i", data, start)[0]
        elif t == 10:
            kv[key] = struct.unpack_from("<Q", data, start)[0]
        elif t == 7:
            kv[key] = bool(data[start])
        else:
            kv[key] = "?"

    tensors = {}
    for _ in range(n_tensors):
        name, off = read_string(off)
        nd = struct.unpack_from("<I", data, off)[0]
        off += 4
        dims = struct.unpack_from("<" + "Q" * nd, data, off)
        off += 8 * nd
        t = struct.unpack_from("<I", data, off)[0]
        off += 4
        toff = struct.unpack_from("<Q", data, off)[0]
        off += 8
        tensors[name] = {"dims": dims, "type": t, "offset": toff}
    align = int(kv.get("general.alignment", 32))
    data_start = (off + align - 1) // align * align
    return kv, tensors, data, data_start


def dequant(raw, t, n):
    """Return n float32 weights for tensor type t starting at raw[0]."""
    if t == 0:
        return np.frombuffer(raw[: n * 4], dtype=np.float32).copy()
    if t == 1:
        return np.frombuffer(raw[: n * 2], dtype=np.float16).astype(np.float32)
    name = TYPES[t]
    size, width = BLOCK[name]
    blocks = n // width
    out = np.zeros(n, dtype=np.float32)
    for b in range(blocks):
        blk = np.frombuffer(raw[b * size:(b + 1) * size], dtype=np.uint8)
        if name == "Q4_0":
            d = f16(blk[0:2].view(np.uint16)[0])
            q = blk[2:18].astype(np.int32)
            out[b * 32:b * 32 + 16] = d * ((q & 15) - 8)
            out[b * 32 + 16:b * 32 + 32] = d * ((q >> 4) - 8)
        elif name == "Q5_0":
            d = f16(blk[0:2].view(np.uint16)[0])
            qh = int.from_bytes(blk[2:6].tobytes(), "little")
            q = blk[6:22].astype(np.int32)
            i = np.arange(16)
            lo = (q & 15) | (((qh >> i) & 1) << 4)
            hi = (q >> 4) | (((qh >> (i + 16)) & 1) << 4)
            out[b * 32:b * 32 + 16] = d * (lo - 16)
            out[b * 32 + 16:b * 32 + 32] = d * (hi - 16)
        elif name == "Q8_0":
            d = f16(blk[0:2].view(np.uint16)[0])
            out[b * 32:(b + 1) * 32] = d * blk[2:34].view(np.int8).astype(np.float32)
        elif name == "Q4_K":
            d = f16(blk[0:2].view(np.uint16)[0])
            dmin = f16(blk[2:4].view(np.uint16)[0])
            sc = blk[4:16].astype(np.int32)
            q = blk[16:144].astype(np.int32)
            for g in range(4):
                for sub in range(2):
                    j = 2 * g + sub
                    if j < 4:
                        s = sc[j] & 63
                        m = sc[j + 4] & 63
                    else:
                        s = (sc[j + 4] & 15) | (((sc[j - 4] >> 6) & 3) << 4)
                        m = (sc[j + 4] >> 4) | (((sc[j] >> 6) & 3) << 4)
                    dj = d * s
                    mj = dmin * m
                    if sub == 0:
                        vals = (q[g * 32:(g + 1) * 32] & 15)
                        out[b * 256 + g * 64: b * 256 + g * 64 + 32] = dj * vals - mj
                    else:
                        vals = (q[g * 32:(g + 1) * 32] >> 4)
                        out[b * 256 + g * 64 + 32: b * 256 + g * 64 + 64] = dj * vals - mj
        elif name == "Q6_K":
            qd = f16(blk[208:210].view(np.uint16)[0])
            ql = blk[0:128].astype(np.int32)
            qh = blk[128:192].astype(np.int32)
            sc = blk[192:208].view(np.int8).astype(np.float32)
            for half in range(2):
                for i in range(32):
                    idx = half * 32 + i
                    is6 = 0 if i < 16 else 1
                    # Each half consumes 64 ql bytes and 32 qh bytes.
                    ql0, ql1, qhv = ql[half * 64 + i], ql[half * 64 + i + 32], qh[idx]
                    q1 = ((ql0 & 15) | (((qhv >> 0) & 3) << 4)) - 32
                    q2 = ((ql1 & 15) | (((qhv >> 2) & 3) << 4)) - 32
                    q3 = ((ql0 >> 4) | (((qhv >> 4) & 3) << 4)) - 32
                    q4 = ((ql1 >> 4) | (((qhv >> 6) & 3) << 4)) - 32
                    o = b * 256 + half * 128 + i
                    out[o] = qd * sc[half * 8 + is6 + 0] * q1
                    out[o + 32] = qd * sc[half * 8 + is6 + 2] * q2
                    out[o + 64] = qd * sc[half * 8 + is6 + 4] * q3
                    out[o + 96] = qd * sc[half * 8 + is6 + 6] * q4
    return out


kv, tensors, data, data_start = parse_gguf(GGUF)
rowspec = [("blk.0.attn_q.weight", 0, 3), ("blk.0.ffn_gate.weight", 0, 3),
           ("token_embd.weight", 100000, 2), ("blk.0.ffn_down.weight", 0, 2),
           # This model keeps 12 of its ffn_down tensors in Q4_K, and the first
           # version of this check sampled only Q5_0/Q8_0/Q6_K/F32 — so the one
           # type with a hand-rolled 6-bit scale/min unpacker was never verified
           # against an independent implementation. Sample every Q4_K tensor.
           *[(name, 0, 2) for name, info in tensors.items() if TYPES.get(info["type"]) == "Q4_K"],
           ("blk.0.attn_norm.weight", 0, 1)]
print(f'{"tensor":<24} {"type":<6} rows  max|engine-numpy|  exact')
for name, first_row, count in rowspec:
    info = tensors[name]
    t = info["type"]
    cols = int(info["dims"][0])
    if t not in TYPES:
        print(f"  {name:<24} type {t} not implemented")
        continue
    block_size, width = BLOCK.get(TYPES[t], (4, 1))
    row_bytes = (cols // width) * block_size
    worst = 0.0
    for r in range(first_row, first_row + count):
        start = data_start + info["offset"] + r * row_bytes
        raw = data[start: start + row_bytes]
        mine = dequant(raw, t, cols)
        meta = json.load(open(f"{DUMP}/index.json"))["tensors"][name]
        dump = np.memmap(f"{DUMP}/{name}.f32", dtype=np.float32, mode="r", shape=(meta["rows"], meta["cols"]))[r]
        worst = max(worst, float(np.abs(mine - dump).max()))
    print(f"  {name:<24} {TYPES[t]:<6} {count:<5} {worst: .6e}        {worst == 0.0}")
