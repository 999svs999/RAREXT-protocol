"""Minimal GGUF writer — just the subset RAREXT's engine reads.

The engine parses GGUF itself (`apps/runtime/engines/rarext-gguf-engine.js`), so a
model can be authored anywhere and served by it. This writes GGUF v3 with float32
tensors: the smallest honest container for a model trained here.
"""

import os
import struct

import numpy as np

MAGIC = 0x46554747  # "GGUF" little-endian

# GGUF metadata value types
UINT32, INT32, FLOAT32, BOOL, STRING, ARRAY, UINT64 = 4, 5, 6, 7, 8, 9, 10

TENSOR_F32 = 0


def _s(text: str) -> bytes:
    raw = text.encode("utf-8")
    return struct.pack("<Q", len(raw)) + raw


class GGUFWriter:
    def __init__(self, alignment: int = 32):
        self.alignment = alignment
        self.kv = []  # (key, type, payload-builder)
        self.tensors = []  # (name, np.ndarray)

    # --- metadata -------------------------------------------------------
    def add_uint32(self, key, value):
        self.kv.append((key, UINT32, struct.pack("<I", int(value))))

    def add_float32(self, key, value):
        self.kv.append((key, FLOAT32, struct.pack("<f", float(value))))

    def add_bool(self, key, value):
        self.kv.append((key, BOOL, struct.pack("<B", 1 if value else 0)))

    def add_string(self, key, value):
        self.kv.append((key, STRING, _s(value)))

    def add_array_string(self, key, values):
        payload = struct.pack("<IQ", STRING, len(values))
        for v in values:
            payload += _s(v)
        self.kv.append((key, ARRAY, payload))

    def add_array_int32(self, key, values):
        payload = struct.pack("<IQ", INT32, len(values))
        for v in values:
            payload += struct.pack("<i", int(v))
        self.kv.append((key, ARRAY, payload))

    def add_tensor(self, name, array: np.ndarray):
        assert array.dtype == np.float32, f"{name} must be float32"
        self.tensors.append((name, np.ascontiguousarray(array, dtype=np.float32)))

    # --- writing --------------------------------------------------------
    def write(self, path):
        # Each tensor's offset is relative to the start of the DATA SECTION,
        # and readers (RAREXT's engine included) start that section at the
        # first 32-byte boundary after the tensor-info table. So the table has
        # to be padded to that boundary here: writing data straight after it
        # shifts every tensor by the pad and the last one runs off the file.
        blobs = []
        infos = []
        offset = 0
        for name, array in self.tensors:
            raw = array.tobytes(order="C")
            infos.append((name, array.shape, offset))
            blobs.append(raw)
            pad = (-len(raw)) % self.alignment
            if pad:
                blobs.append(b"\x00" * pad)
            offset += len(raw) + pad

        head = bytearray()
        head += struct.pack("<I", MAGIC)
        head += struct.pack("<I", 3)
        head += struct.pack("<Q", len(infos))
        head += struct.pack("<Q", len(self.kv))
        for key, vtype, payload in self.kv:
            head += _s(key)
            head += struct.pack("<I", vtype)
            head += payload
        for name, shape, off in infos:
            head += _s(name)
            # GGUF stores the fastest-varying dimension first: a torch row of
            # `cols` elements is dims[0], so a (rows, cols) matrix is written
            # as [cols, rows].
            dims = list(shape[::-1])
            head += struct.pack("<I", len(dims))
            for d in dims:
                head += struct.pack("<Q", int(d))
            head += struct.pack("<I", TENSOR_F32)
            head += struct.pack("<Q", off)
        head += b"\x00" * ((-len(head)) % self.alignment)

        with open(path, "wb") as fh:
            fh.write(head)
            for blob in blobs:
                fh.write(blob)

        expected = len(head) + offset
        size = os.path.getsize(path)
        if size != expected:
            raise AssertionError(f"wrote {size} bytes, expected {expected}")
        return path
