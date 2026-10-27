import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_BUNDLE_RESPONSE_BYTES,
  readBundleResponseBytes,
} from "../src/index.ts";
import type { BundleResponse } from "../src/index.ts";

/**
 * The cap every client fetch path shares, exercised directly: a response is
 * refused before its body is fully materialized when the declared
 * Content-Length is past the cap, and the cap holds while READING even when
 * the header is absent or lying — the body is consumed in chunks with a
 * running byte counter, so a server that streams forever is cut off at the
 * cap instead of being read to its end. Every refusal names the cap and the
 * size when it is known.
 */
function responseFrom(
  body: ReadableStream<Uint8Array> | null,
  headers: Record<string, string> = {},
): BundleResponse {
  return {
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    body,
  };
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]!);
        index += 1;
      } else {
        controller.close();
      }
    },
  });
}

function streamForever(chunk: Uint8Array, maxChunks: number): ReadableStream<Uint8Array> {
  let count = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      count += 1;
      if (count > maxChunks) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
    cancel() {
      count = maxChunks;
    },
  });
}

test("MAX_BUNDLE_RESPONSE_BYTES is generous headroom over an honest bundle, not an amplifier", () => {
  assert.equal(MAX_BUNDLE_RESPONSE_BYTES, 8 * 1024 * 1024);
});

test("a body at or under the cap is read whole", async () => {
  const bytes = new TextEncoder().encode("a small bundle");
  const read = await readBundleResponseBytes(responseFrom(streamOf([bytes])));
  assert.equal(Buffer.from(read).toString("utf8"), "a small bundle");

  // Exactly at the cap is honest headroom, not a violation.
  const atCap = new Uint8Array(MAX_BUNDLE_RESPONSE_BYTES);
  const exact = await readBundleResponseBytes(responseFrom(streamOf([atCap])));
  assert.equal(exact.length, MAX_BUNDLE_RESPONSE_BYTES);
});

test("a declared Content-Length above the cap is refused before the body is read", async () => {
  // The body is tiny; the LIE is in the header. The refusal must happen
  // without consuming it, and must name both the claimed size and the cap.
  // (A ReadableStream eagerly pulls once at construction; what must not
  // happen is sustained reading.)
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(16));
      controller.close();
    },
  });
  await assert.rejects(
    () =>
      readBundleResponseBytes(
        responseFrom(body, { "content-length": String(4 * 1024 * 1024 * 1024) }),
      ),
    (error: Error) => {
      assert.match(error.message, /declares 4294967296 bytes/);
      assert.match(error.message, new RegExp(`above the ${MAX_BUNDLE_RESPONSE_BYTES} byte cap`));
      return true;
    },
  );
  assert.ok(pulled <= 1, "an oversized declaration is refused unread");

  // A body is cancelled so the connection is released, not left hanging.
  const cancelled = { calls: 0 };
  const hanging: BundleResponse = {
    headers: { get: () => String(MAX_BUNDLE_RESPONSE_BYTES + 1) },
    body: {
      cancel: async () => {
        cancelled.calls += 1;
      },
    } as unknown as ReadableStream<Uint8Array>,
  };
  await assert.rejects(() => readBundleResponseBytes(hanging), /byte cap/);
  assert.equal(cancelled.calls, 1, "the unread body is cancelled");
});

test("a body that streams past the cap is cut off mid-read, whatever the header said", async () => {
  // No Content-Length at all: the counter is the only defence, and it holds.
  const chunk = new Uint8Array(1024 * 1024); // 1 MiB per chunk
  await assert.rejects(
    () => readBundleResponseBytes(responseFrom(streamForever(chunk, 64))),
    (error: Error) => {
      assert.match(error.message, new RegExp(`streamed past the ${MAX_BUNDLE_RESPONSE_BYTES} byte cap`));
      assert.match(error.message, /at least 9\d+ bytes/, "the actual size read is named");
      return true;
    },
  );

  // A LYING header: declares a small length, streams far past it anyway.
  const lying = streamForever(chunk, 64);
  await assert.rejects(
    () =>
      readBundleResponseBytes(
        responseFrom(lying, { "content-length": "1024" }),
      ),
    /streamed past the 8388608 byte cap/,
    "the cap holds when the header lies",
  );

  // A response just past the cap is refused with the actual size named.
  const justPast = new Uint8Array(MAX_BUNDLE_RESPONSE_BYTES + 1);
  await assert.rejects(
    () => readBundleResponseBytes(responseFrom(streamOf([justPast]))),
    new RegExp(`at least ${MAX_BUNDLE_RESPONSE_BYTES + 1} bytes`),
  );
});

test("a response with no body reads as empty, as it always did", async () => {
  const read = await readBundleResponseBytes(responseFrom(null));
  assert.equal(read.length, 0);
});
