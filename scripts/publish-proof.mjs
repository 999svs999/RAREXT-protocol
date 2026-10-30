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

// `let`: the semantics commitment returns a NEW bundle (core functions are pure).
let bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
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

// RFC 0020: the published bundle COMMITS to the federation seed list. The
// commitment is an ordinary publication — a Merkle leaf, not a bundle field —
// because the root covers publication leaves and nothing else, so anything else
// would be editable while the root still verified.
const {
  parseRegistrySeedList,
  registryListDigest,
  federationCommitmentArtifact,
  withSemanticsCommitment,
  FEDERATION_APP,
  REGISTRY_LIST_COMMITMENT_KIND,
  SEMANTICS_COMMITMENT_KIND,
} = await import(join(root, "packages/core/src/index.ts"));
const { nodeSha256 } = await import(join(root, "apps/api/src/digest.ts"));

const listUrl = `${rootUrlForSeed()}/registry/seed.json`;
const seedForList = JSON.parse(readFileSync(join(site, "seed.json"), "utf8"));
const listEntries = parseRegistrySeedList(seedForList);
if (listEntries.length === 0) {
  throw new Error("the seed list names no registries, so there is nothing to commit to");
}
const listDigest = registryListDigest(listEntries, nodeSha256);

if (!(bundle.publications ?? []).some((publication) => publication.artifact?.kind === REGISTRY_LIST_COMMITMENT_KIND)) {
  const template = bundle.publications[0];
  // The leaf REQUIRES an attestation, and the AI verification surface selects its
  // claims by `representation` — so keeping the template's would have published
  // the commitment as a THIRD AI claim, a fake model result inside the very
  // surface that exists to prove AI results. Strip it: this publication is a
  // commitment, not a rendition, and the leaf's other fields can stay.
  const attestation = { ...template.attestation };
  delete attestation.representation;
  bundle.publications.push({
    ...template,
    id: "pub-federation-commitment",
    title: "The federation seed list this bundle commits to",
    attestation,
    artifact: {
      ...template.artifact,
      ...federationCommitmentArtifact({
        listUrl,
        digest: listDigest,
        generatedAt: new Date().toISOString(),
      }),
    },
  });
}

// RFC 0003's question 1: the SEMANTICS records are a bundle FIELD, and the root covers
// publication leaves — so a meaning a claim was made against was editable while the root
// still verified. Same fix as the seed list above: commit to it inside the proof.
//
// The assembly lives in CORE (withSemanticsCommitment), not here: it strips the
// template's `representation` so the commitment is not published as a fake AI claim,
// and a rule that easy to get wrong belongs where a test can reach it. A script block
// is the one place no test ever runs.
// A STRING hash, deliberately: `semanticsDigests` hashes each record's canonical TEXT,
// and nodeSha256 (bytes in, bytes out) silently produced byte maps instead of hex —
// which the bundle then committed to. The parser refused them, which is the only reason
// this was caught before it was published as an anchor that proved nothing.
const stringSha256 = (value) => createHash("sha256").update(value).digest("hex");
const semanticsCommitment = withSemanticsCommitment(bundle, stringSha256);
bundle = semanticsCommitment.bundle;
if (semanticsCommitment.added) {
  console.log(`semantics commitment published: ${semanticsCommitment.added} over ${(bundle.semantics ?? []).length} record(s)`);
}

// The manifest describes what is actually in the bundle, and the ROOT is
// recomputed over the new leaves: a bundle whose manifest still lists the old
// publications under the old root does not verify, which is the check below.
const { publicationLeaf } = await import(join(root, "apps/api/src/anchorer.ts"));
const { merkleRoot: apiMerkleRoot } = await import(join(root, "apps/api/src/merkle.ts"));

bundle.manifest.publications = bundle.publications.map((publication) => ({
  id: publication.id,
  leaf: publicationLeaf(publication),
}));
bundle.manifest.counts.publications = bundle.publications.length;
bundle.manifest.root = apiMerkleRoot(bundle.manifest.publications.map((entry) => entry.leaf));

// Re-verify AFTER the change: the bundle that gets published is the one whose
// root covers the commitment, and that is checked here rather than assumed.
const afterCommitment = verifyBundle(bundle);
if (!afterCommitment.valid) {
  throw new Error(`the bundle with the commitment does not verify: ${afterCommitment.reason}`);
}

function rootUrlForSeed() {
  return "https://999svs999.github.io/RAREXT-protocol";
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

// Files COPIED from the proof. The generated ones are not here on purpose:
// `bundle.json`, `bundle.js` and `verify.html` come from the bundle and from
// their single source module below. Copying a generated file reproduces whatever
// the proof directory happened to hold — a `verify.html` from before the response
// cap lost the cap on the published page, which is exactly the kind of stale win
// this list must not allow.
const mirrorFiles = [
  "ai.html",
  "ai.js",
  "app.js",
  "blobs.json",
  "favicon.svg",
  "gallery.html",
  "index.html",
  "leaderboard.html",
  "renditions.js",
  "styles.css",
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
const { bundleJson, writeBundleFiles } = await import(join(root, "scripts/mirror-artifacts.mjs"));
const { cidV1Raw, pinBundle, pinServiceUrl } = await import(join(root, "apps/api/src/adapters/content.ts"));

// The anchor must cover the NEW root — the previous anchor (verified:
// adapter "local") points at the root without the commitment, so re-pinning
// without re-anchoring would leave the published copy unanchored.
const { RarextStore } = await import(join(root, "apps/api/src/store.ts"));
const { anchorPending } = await import(join(root, "apps/api/src/anchorer.ts"));

const anchorStore = new RarextStore();
for (const publication of bundle.publications) anchorStore.addPublication(publication, false);
const anchor = await anchorPending(anchorStore);
if (!anchor) {
  throw new Error("the publications did not anchor, so the published copy would be unanchored");
}
if (anchor.root !== bundle.manifest.root) {
  throw new Error(
    `the anchor covers root ${anchor.root}, but the bundle's publications rebuild ${bundle.manifest.root}`,
  );
}
bundle.anchors = [anchor];
bundle.manifest.anchorId = anchor.id;
bundle.manifest.anchorRoot = anchor.root;
bundle.manifest.counts.anchors = 1;

const anchoredBytes = Buffer.from(bundleJson(bundle), "utf8");
const anchoredCid = cidV1Raw(anchoredBytes);
writeFileSync(join(site, "bundle.json"), anchoredBytes);
// The mirror's own copy is regenerated from the SAME bundle: a mirror holding the
// pre-commitment bytes would no longer rebuild the pinned root, which is exactly
// what the live seed check looks for.
writeBundleFiles(mirrorTarget, bundle);
const { mirrorVerifyPage } = await import(join(root, "scripts/mirror-verify-page.mjs"));
writeFileSync(
  join(mirrorTarget, "verify.html"),
  mirrorVerifyPage({
    title: "Mirror verification — AI claims included",
    heading:
      "This mirror is a copy. Here is whether it is a faithful one — and whether its AI claims replay.",
  }),
);

const seedPath = join(site, "seed.json");
const seed = JSON.parse(readFileSync(seedPath, "utf8"));
seed.updatedAt = new Date().toISOString();
// Pinned to the ANCHORED bundle: its root covers the federation commitment, and
// its CID is over the exact bytes written above.
seed.bundleRoot = bundle.manifest.root;
seed.bundleCid = anchoredCid;

// The pinning call, attempted only when a service is configured. Publish runs
// without network by design: with no service the seed records NO pins (bundleCid
// carries the content address either way), and a configured service that fails
// is recorded as `{ cid, service, error }` rather than thrown — the publish must
// not crash on a pin it could not make, and must never record a pin it did not
// make. The entries below are exactly what pinBundle returned.
const serviceUrl = pinServiceUrl();
const pins = [];
if (serviceUrl) {
  try {
    const pinned = await pinBundle(anchoredBytes);
    pins.push({
      cid: pinned.cid,
      service: pinned.service ?? serviceUrl,
      reference: pinned.reference,
    });
  } catch (error) {
    pins.push({
      cid: anchoredCid,
      service: serviceUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
seed.pins = pins;

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
if (pins.length === 0) {
  console.log(`  seed.pins is [] — no pinning service configured, bundleCid names the bytes`);
} else {
  for (const pin of pins) {
    console.log(
      "error" in pin
        ? `  seed.pins records a failure at ${pin.service}: ${pin.error}`
        : `  seed.pins records ${pin.cid} pinned at ${pin.service} (${pin.reference})`,
    );
  }
}
