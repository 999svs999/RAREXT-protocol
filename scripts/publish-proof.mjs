#!/usr/bin/env node
// Publishes the locally verified AI proof as the static public copy.
//
//   npm run publish:proof
//
// Reads .ai-proof (written by scripts/publish-ai-proof.mjs), validates the
// bundle, copies the bundle and mirror into site/registry, and updates the seed
// list. It does not generate a new proof or contact a network.
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const proof = join(root, ".ai-proof");
const site = join(root, "site", "registry");
const mirrorSource = join(proof, "mirror");
const mirrorTarget = join(site, "mirror");

const bundlePath = join(proof, "bundle.json");
const blobsPath = join(mirrorSource, "blobs.json");

const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
const blobs = JSON.parse(readFileSync(blobsPath, "utf8"));

const { verifyBundle } = await import(join(root, "apps/api/src/bundle.ts"));
const verification = verifyBundle(bundle);

if (!verification.valid) {
  throw new Error(`the .ai-proof bundle does not verify: ${verification.reason}`);
}

if (bundle.manifest.leafVersion !== 4) {
  throw new Error(`expected leafVersion 4, got ${bundle.manifest.leafVersion}`);
}

const ai = (bundle.publications ?? []).filter(
  (publication) => publication.attestation?.representation,
);
if (ai.length !== 2) {
  throw new Error(`expected two AI representations, got ${ai.length}`);
}

const media = ai
  .map((publication) => publication.artifact?.body?.media)
  .filter((entry) => entry !== undefined && entry !== null);
if (media.length !== ai.length) {
  throw new Error(`expected one rendition per AI representation, got ${media.length} for ${ai.length}`);
}
const representations = new Set(ai.map((publication) => publication.attestation.representation));
for (const expected of ["generative", "bounded"]) {
  if (!representations.has(expected)) {
    throw new Error(`expected a ${expected} AI representation`);
  }
}

const encoded = new Map(
  (Array.isArray(blobs.blobs) ? blobs.blobs : [])
    .filter((blob) => typeof blob.hash === "string" && typeof blob.content === "string")
    .map((blob) => [blob.hash, blob.content]),
);

for (const rendition of media) {
  if (typeof rendition.blob !== "string" || !encoded.has(rendition.blob)) {
    throw new Error("the rendition blob is not embedded in the mirror");
  }

  const bytes = Buffer.from(encoded.get(rendition.blob), "base64");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== rendition.blob) {
    throw new Error("the embedded rendition bytes do not match their blob digest");
  }
}

const mirrorFiles = [
  "app.js",
  "blobs.json",
  "bundle.js",
  "bundle.json",
  "favicon.svg",
  "gallery.html",
  "index.html",
  "leaderboard.html",
  "styles.css",
  "verify.html",
  "verify.js",
];

rmSync(mirrorTarget, { recursive: true, force: true });
mkdirSync(mirrorTarget, { recursive: true });

for (const name of mirrorFiles) {
  cpSync(join(mirrorSource, name), join(mirrorTarget, name));
}

// The published bytes are serialized once and hashed once: the seed pins the
// bundle's CID (a CIDv1 over the raw sha2-256 multihash), so a mirror pointer
// is a hash rather than a URL and any copy can be checked against it without
// trusting whoever served it.
const { bundleJson } = await import(join(root, "scripts/mirror-artifacts.mjs"));
const bundleBytes = Buffer.from(bundleJson(bundle), "utf8");
const { cidV1Raw } = await import(join(root, "apps/api/src/adapters/content.ts"));
const bundleCid = cidV1Raw(bundleBytes);

writeFileSync(join(site, "bundle.json"), bundleBytes);

const seedPath = join(site, "seed.json");
const seed = JSON.parse(readFileSync(seedPath, "utf8"));
seed.updatedAt = new Date().toISOString();
seed.bundleRoot = bundle.manifest.root;
seed.bundleCid = bundleCid;

for (const mirror of seed.mirrors ?? []) {
  mirror.root = bundle.manifest.root;
}

writeFileSync(seedPath, `${JSON.stringify(seed, null, 2)}\n`);

const rootUrl = "https://999svs999.github.io/RAREXT-protocol";
const proofUrl = `${rootUrl}/mirror/verify.html?root=${bundle.manifest.root}`;
const publications = bundle.manifest.publications.length;
const challengeCount = bundle.challenges?.length ?? 0;
const semanticsCount = bundle.semantics?.length ?? 0;
const anchorCount = bundle.anchors?.length ?? 0;

writeFileSync(
  join(site, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>RAREXT registry bundle</title>
    <meta name="description" content="A static copy of the latest anchored RAREXT registry bundle, with its seed list, mirror, and Merkle root." />
    <link rel="icon" href="../favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="../styles.css" />
  </head>
  <body>
    <main>
      <section class="band">
        <p class="eyebrow">Public artifact</p>
        <h2>Registry bundle</h2>
        <p class="section-lede">
          This is a static copy of the latest anchored registry bundle. It is not a live
          API. A reader can fetch the JSON, recompute the publication leaves, and check
          that the Merkle root matches the root in the seed list.
        </p>
        <div class="facts">
          <div>
            <strong>Root</strong>
            <span><code>${bundle.manifest.root}</code></span>
          </div>
          <div>
            <strong>Contents</strong>
            <span>${publications} anchored publication${publications === 1 ? "" : "s"} · ${challengeCount} challenges · ${semanticsCount} semantics · ${anchorCount} anchor${anchorCount === 1 ? "" : "s"}</span>
          </div>
          <div>
            <strong>AI representations</strong>
            <span>${ai.map((publication) => publication.attestation.representation).join(", ")}</span>
          </div>
          <div>
            <strong>Bundle</strong>
            <span><a href="./bundle.json">bundle.json</a></span>
          </div>
          <div>
            <strong>Seed list</strong>
            <span><a href="./seed.json">seed.json</a></span>
          </div>
          <div>
            <strong>Mirror</strong>
            <span><a href="../mirror/">workbench</a> · <a href="../mirror/gallery.html">gallery</a></span>
          </div>
          <div>
            <strong>Verify</strong>
            <span><a href="../mirror/verify.html?root=${bundle.manifest.root}">run the pinned verifier</a></span>
          </div>
        </div>
        <p class="small">
          The verifier is the same one used by the registry and the mirror page. It
          re-derives AI renditions from the committed model and seed, checks the embedded
          blob bytes, and compares the recomputed root with the pinned root above:
          <code>node --test apps/api/test/published-bundle.test.ts apps/web/test/published-mirror.test.ts</code>.
        </p>
        <p class="small">
          <a href="../">Back to RAREXT</a>
        </p>
      </section>
    </main>
  </body>
</html>
`,
);

console.log(`published proof ${bundle.manifest.root}`);
console.log(`  ${publications} publications, ${ai.length} AI representations, ${media.length} rendition`);
console.log(`  ${rootUrl}/registry/bundle.json`);
console.log(`  ${proofUrl}`);
