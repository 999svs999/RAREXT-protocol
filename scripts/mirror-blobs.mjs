// Writes the static mirror's blobs.json. The gallery has no server behind it,
// so small public blobs travel inline; the gallery re-hashes them in the
// browser before rendering. Only bytes whose digest and length match are
// embedded, so a broken node response cannot poison the mirror.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const EMBED_PER_BLOB = 512 * 1024;
export const EMBED_TOTAL = 4 * 1024 * 1024;

const HASH = /^[0-9a-f]{64}$/;
const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+(;[\w-]+=[\w.-]+)*$/;

function safeType(type) {
  return typeof type === "string" && MEDIA_TYPE.test(type)
    ? type
    : "application/octet-stream";
}

function decodeContent(content, size) {
  if (
    typeof content !== "string" ||
    content.length === 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(content) ||
    content.length % 4 !== 0
  ) {
    return null;
  }

  const bytes = Buffer.from(content, "base64");
  if (bytes.length !== size || bytes.toString("base64") !== content) return null;
  return bytes;
}

/**
 * `aiClaims` optionally marks blobs that are renditions of an AI claim, so the
 * gallery can say what a picture IS (which claim, which representation) and
 * link back to the page that re-verifies it. Each entry: { blob, raster, app,
 * representation, publicationId, challengeId, title }.
 */
function aiIndex(aiClaims) {
  const index = new Map();
  for (const claim of Array.isArray(aiClaims) ? aiClaims : []) {
    if (!claim || typeof claim !== "object") continue;
    if (typeof claim.blob !== "string" || !HASH.test(claim.blob)) continue;
    index.set(claim.blob, {
      app: typeof claim.app === "string" ? claim.app : null,
      representation: typeof claim.representation === "string" ? claim.representation : null,
      publicationId: typeof claim.publicationId === "string" ? claim.publicationId : null,
      challengeId: typeof claim.challengeId === "string" ? claim.challengeId : null,
      title: typeof claim.title === "string" ? claim.title : null,
      raster: typeof claim.raster === "string" && HASH.test(claim.raster) ? claim.raster : null,
      size: Number.isSafeInteger(claim.size) ? claim.size : null,
    });
  }
  return index;
}

export async function writeMirrorBlobs({
  base,
  mirrorDir,
  fetchImpl = fetch,
  aiClaims = [],
}) {
  const embedded = [];
  const ai = aiIndex(aiClaims);
  let embeddedTotal = 0;

  try {
    const listResponse = await fetchImpl(`${base}/v1/blobs`);
    const list = listResponse.ok ? await listResponse.json() : [];
    const records = Array.isArray(list) ? list : [];

    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const hash = record.hash;
      const size = record.size;
      if (typeof hash !== "string" || !HASH.test(hash)) continue;
      if (!Number.isSafeInteger(size) || size < 0) continue;
      if (size > EMBED_PER_BLOB) continue;
      if (embeddedTotal + size > EMBED_TOTAL) break;

      const detail = await fetchImpl(`${base}/v1/blobs/${hash}`);
      if (!detail.ok) continue;

      const full = await detail.json();
      if (full.hash !== hash || full.size !== size) continue;

      const bytes = decodeContent(full.content, size);
      if (!bytes) continue;
      if (createHash("sha256").update(bytes).digest("hex") !== hash) continue;

      const entry = {
        hash,
        mediaType: safeType(full.mediaType),
        size,
        tier: full.tier === "sealed" ? "sealed" : "public",
        content: full.content,
      };
      const claim = ai.get(hash);
      if (claim) entry.ai = claim;
      embedded.push(entry);
      embeddedTotal += size;
    }
  } catch (error) {
    console.warn(
      `  could not embed blobs: ${error instanceof Error ? error.message : error}`,
    );
  }

  writeFileSync(
    join(mirrorDir, "blobs.json"),
    JSON.stringify(
      { version: 1, generatedAt: new Date().toISOString(), blobs: embedded },
      null,
      2,
    ),
  );

  return { count: embedded.length, total: embeddedTotal };
}
