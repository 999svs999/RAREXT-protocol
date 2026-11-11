// The mirror's blob embedding must not let a large unrelated blob decide which
// evidence travels. Two behaviors are load-bearing:
//   1. AI rendition blobs are embedded first, so a store that lists by hash
//      cannot starve the (tiny) picture a claim points at.
//   2. A blob that does not fit is skipped with `continue`, not treated as the
//      end of the list, so a later small blob still makes it in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EMBED_PER_BLOB,
  EMBED_TOTAL,
  writeMirrorBlobs,
} from "../../../scripts/mirror-blobs.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function blob(size, fill) {
  const bytes = Buffer.alloc(size, fill);
  return { hash: sha256(bytes), size, bytes };
}

// `blobs` is also the order the fake store lists them in, so a test can put the
// rendition last or a too-large blob in the middle exactly as it intends.
function fakeFetch(blobs) {
  const byHash = new Map(blobs.map((entry) => [entry.hash, entry]));
  return async (url) => {
    if (url.endsWith("/v1/blobs")) {
      return {
        ok: true,
        json: async () => blobs.map(({ hash, size }) => ({ hash, size })),
      };
    }
    const hash = url.slice(url.lastIndexOf("/") + 1);
    const found = byHash.get(hash);
    if (!found) return { ok: false, json: async () => ({}) };
    return {
      ok: true,
      json: async () => ({
        hash: found.hash,
        size: found.size,
        mediaType: "image/png",
        tier: "public",
        content: found.bytes.toString("base64"),
      }),
    };
  };
}

function embeddedHashes(mirrorDir) {
  const written = JSON.parse(readFileSync(join(mirrorDir, "blobs.json"), "utf8"));
  return written.blobs;
}

test("an AI rendition is embedded even when unrelated blobs would exhaust the budget", async () => {
  const mirrorDir = mkdtempSync(join(tmpdir(), "rarext-mirror-blobs-ai-"));
  // Eight full-size blobs fill the whole budget if they are visited first; the
  // store lists the rendition LAST, which is what the prioritization must beat.
  const filler = Array.from({ length: 8 }, (_, i) => blob(EMBED_PER_BLOB, 0x40 + i));
  const rendition = blob(401, 0x07);
  const result = await writeMirrorBlobs({
    base: "http://mirror.test",
    mirrorDir,
    fetchImpl: fakeFetch([...filler, rendition]),
    aiClaims: [
      {
        blob: rendition.hash,
        app: "ai-bounded",
        representation: "bounded",
        publicationId: "pub-1",
        challengeId: "bounded-starter",
        title: "a committed reconstruction",
        size: rendition.size,
      },
    ],
  });

  const embedded = embeddedHashes(mirrorDir);
  assert.equal(embedded[0].hash, rendition.hash, "the AI rendition must lead the list");
  assert.ok(
    embedded.some((entry) => entry.hash === rendition.hash),
    "the AI rendition must be embedded even though the budget is full by hash order",
  );
  assert.equal(embedded[0].ai?.representation, "bounded", "the claim must travel with the rendition");
  assert.ok(result.total <= EMBED_TOTAL);
});

test("a blob that does not fit is skipped, not a reason to stop embedding", async () => {
  const mirrorDir = mkdtempSync(join(tmpdir(), "rarext-mirror-blobs-cap-"));
  // Seven full blobs leave less than one blob of headroom. The 100-byte blob
  // lands the total just below the cap, the next full blob cannot fit, and the
  // 400-byte blob AFTER it still must.
  const fillers = Array.from({ length: 7 }, (_, i) => blob(EMBED_PER_BLOB, 0x10 + i));
  const almost = blob(100, 0x01);
  const tooBig = blob(EMBED_PER_BLOB, 0x77);
  const lastSmall = blob(400, 0x02);
  const result = await writeMirrorBlobs({
    base: "http://mirror.test",
    mirrorDir,
    fetchImpl: fakeFetch([...fillers, almost, tooBig, lastSmall]),
  });

  const embedded = new Set(embeddedHashes(mirrorDir).map((entry) => entry.hash));
  assert.equal(embedded.has(tooBig.hash), false, "the over-budget blob must not be embedded");
  assert.equal(
    embedded.has(lastSmall.hash),
    true,
    "a later small blob must still be embedded after an over-budget one is skipped",
  );
  assert.ok(result.total <= EMBED_TOTAL);
});
