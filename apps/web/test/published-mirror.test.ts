import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { verifyBundle, type Bundle } from "../src/verify.ts";

const site = fileURLToPath(new URL("../../../site/registry", import.meta.url));

function read<T>(name: string): T {
  return JSON.parse(readFileSync(`${site}/${name}`, "utf8")) as T;
}

test("the published mirror verifies against its pinned root and media", async () => {
  const bundle = read<Bundle>("bundle.json");
  const mirror = read<Bundle>("mirror/bundle.json");
  const blobFile = read<{ blobs: { hash: string; content: string }[] }>(
    "mirror/blobs.json",
  );
  const seed = read<{
    bundleRoot: string;
    mirrors: { root: string }[];
  }>("seed.json");

  assert.equal(bundle.manifest.leafVersion, 4);
  assert.equal(mirror.manifest.root, bundle.manifest.root);
  assert.equal(seed.bundleRoot, bundle.manifest.root);
  assert.ok(seed.mirrors.every((entry) => entry.root === bundle.manifest.root));

  const challenges = Object.fromEntries(
    (bundle.challenges ?? []).map((challenge) => [challenge.id, challenge.spec ?? {}]),
  );
  const media = Object.fromEntries(
    blobFile.blobs
      .filter((blob) => typeof blob.hash === "string" && typeof blob.content === "string")
      .map((blob) => [blob.hash, blob.content]),
  );

  const result = await verifyBundle(
    bundle,
    challenges,
    bundle.manifest.root,
    media,
  );

  assert.equal(result.valid, true, result.reason ?? undefined);

  const ai = result.aiClaims.filter((claim) => claim.representation);
  assert.equal(ai.length, 2);

  const rendition = ai.find((claim) => claim.media !== null);
  assert.ok(rendition?.media);
  assert.equal(rendition.media.matches, true);
  assert.equal(rendition.media.blobMatches, true);
});
