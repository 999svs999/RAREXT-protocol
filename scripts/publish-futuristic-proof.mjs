#!/usr/bin/env node
// Publishes the FUTURISTIC proof as the static public copy — the brand's face
// on RAREXT.
//
//   npm run publish:futuristic
//
// Reads .futuristic-proof (written by scripts/publish-futuristic.mjs), validates
// the bundle, copies the mirror into site/registry, regenerates the generated
// pages from their single sources, and updates the seed list. It does not
// generate a new proof or contact a network.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const proof = join(root, ".futuristic-proof");
const site = join(root, "site", "registry");
const mirrorSource = join(proof, "mirror");
const mirrorTarget = join(site, "mirror");

const bundlePath = join(proof, "bundle.json");

// `let`: the semantics commitment returns a NEW bundle (core functions are pure).
let bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
const { verifyBundle } = await import(join(root, "apps/api/src/bundle.ts"));
const verification = verifyBundle(bundle);

if (!verification.valid) {
  throw new Error(`the .futuristic-proof bundle does not verify: ${verification.reason}`);
}

if (bundle.manifest.leafVersion !== 4) {
  throw new Error(`expected leafVersion 4, got ${bundle.manifest.leafVersion}`);
}

// The FUTURISTIC shape: every publication is the brand's video record, attested
// exact, under the futuristic app. This is the check that replaces the ai-proof
// "two AI representations" gate — this bundle is the brand's published record,
// and a stock demo leaf inside it would be a lie about what FUTURISTIC published.
const pubs = bundle.publications ?? [];
if (pubs.length === 0) {
  throw new Error("the FUTURISTIC bundle carries no publications");
}
const brandRecords = pubs.filter((publication) => publication.artifact?.app === "futuristic-video");
const aiRecords = pubs.filter((publication) => publication.artifact?.app === "ai-generative" || publication.artifact?.app === "ai-bounded");
if (brandRecords.length === 0) {
  throw new Error("the FUTURISTIC bundle carries no futuristic-video records");
}
for (const publication of brandRecords) {
  if (publication.attestation?.claimKind !== "satisfies" || publication.attestation?.representation !== "exact") {
    throw new Error(`publication ${publication.id} is not an attested-exact FUTURISTIC record`);
  }
}
if (aiRecords.length !== 2) {
  throw new Error(`expected the two AI seed representations beside the brand record, got ${aiRecords.length}`);
}

// RFC 0020: the published bundle COMMITS to the federation seed list — an
// ordinary publication, a Merkle leaf, not a bundle field.
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

const listUrl = "https://999svs999.github.io/RAREXT-protocol/registry/seed.json";
const seedForList = JSON.parse(readFileSync(join(site, "seed.json"), "utf8"));
const listEntries = parseRegistrySeedList(seedForList);
if (listEntries.length === 0) {
  throw new Error("the seed list names no registries, so there is nothing to commit to");
}
const listDigest = registryListDigest(listEntries, nodeSha256);

// REPLACE, never carry — same rule as publish-proof.mjs.
{
  const isCommitment = (publication) =>
    publication.artifact?.kind === REGISTRY_LIST_COMMITMENT_KIND ||
    publication.artifact?.kind === SEMANTICS_COMMITMENT_KIND ||
    publication.artifact?.app === FEDERATION_APP;
  const carried = (bundle.publications ?? []).filter(isCommitment);
  const kept = (bundle.publications ?? []).filter((publication) => !isCommitment(publication));
  const template = kept[0] ?? carried[0];
  if (!template) {
    throw new Error("the bundle carries no publication to template the federation commitment from");
  }
  const attestation = { ...template.attestation };
  delete attestation.representation;
  bundle.publications = [
    ...kept,
    {
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
    },
  ];
}

// RFC 0003: the SEMANTICS commitment — assembled in CORE, string hash.
const stringSha256 = (value) => createHash("sha256").update(value).digest("hex");
const semanticsCommitment = withSemanticsCommitment(bundle, stringSha256);
bundle = semanticsCommitment.bundle;
if (semanticsCommitment.added) {
  console.log(`semantics commitment published: ${semanticsCommitment.added} over ${(bundle.semantics ?? []).length} record(s)`);
}

// The manifest describes what is actually in the bundle; the ROOT is recomputed.
const { publicationLeaf } = await import(join(root, "apps/api/src/anchorer.ts"));
const { merkleRoot: apiMerkleRoot } = await import(join(root, "apps/api/src/merkle.ts"));

bundle.manifest.publications = bundle.publications.map((publication) => ({
  id: publication.id,
  leaf: publicationLeaf(publication),
}));
bundle.manifest.counts.publications = bundle.publications.length;
bundle.manifest.root = apiMerkleRoot(bundle.manifest.publications.map((entry) => entry.leaf));

// Re-verify AFTER the change.
const afterCommitment = verifyBundle(bundle);
if (!afterCommitment.valid) {
  throw new Error(`the bundle with the commitment does not verify: ${afterCommitment.reason}`);
}

// The anchor must cover the NEW root.
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

const { bundleJson, writeBundleFiles } = await import(join(root, "scripts/mirror-artifacts.mjs"));
const { cidV1Raw } = await import(join(root, "apps/api/src/adapters/content.ts"));

const anchoredBytes = Buffer.from(bundleJson(bundle), "utf8");
const anchoredCid = cidV1Raw(anchoredBytes);
writeFileSync(join(site, "bundle.json"), anchoredBytes);

// Generated pages REGENERATED from their single sources at publish time —
// never copied from the staging tree (the stale-landmine rule).
const { mirrorVerifyPage } = await import(join(root, "scripts/mirror-verify-page.mjs"));
const { futuristicGalleryPage } = await import(join(root, "scripts/futuristic-page.mjs"));

// Files COPIED from the proof (static assets owned by the web tree or the mirror).
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

const owners = {
  "ai.html": join(root, "apps/web/public", "ai.html"),
  "ai.js": join(root, "apps/web/public", "ai.js"),
  "gallery.html": join(root, "apps/web/public", "gallery.html"),
  "index.html": join(root, "apps/web/public", "index.html"),
  "renditions.js": join(root, "apps/web/public", "renditions.js"),
  "leaderboard.html": join(root, "apps/web/public", "leaderboard.html"),
};
for (const name of mirrorFiles) {
  const owner = owners[name];
  if (owner && !existsSync(owner)) {
    throw new Error(`${name} is owned by ${owner}, which does not exist — build it before publishing`);
  }
  cpSync(owner ?? join(mirrorSource, name), join(mirrorTarget, name));
}

// The workbench's index needs the bundle in front of the app, and the mirror's
// bundle pair is written HERE — after the rmSync above, from the ANCHORED
// bundle (the registry copy and the mirror copy are the SAME bytes).
writeBundleFiles(mirrorTarget, bundle);
const { injectBundleScript } = await import(join(root, "scripts/mirror-artifacts.mjs"));
const mirrorIndex = join(mirrorTarget, "index.html");
writeFileSync(
  mirrorIndex,
  injectBundleScript(readFileSync(mirrorIndex, "utf8"), { appSrc: "/app.js", newAppSrc: "./app.js" }),
);

writeFileSync(
  join(mirrorTarget, "verify.html"),
  mirrorVerifyPage({
    title: "Mirror verification — FUTURISTIC included",
    heading:
      "This mirror is a copy. Here is whether it is a faithful one — and whether FUTURISTIC's published record holds.",
  }),
);
writeFileSync(join(mirrorTarget, "futuristic.html"), futuristicGalleryPage(bundle));

// Portability under a subpath (GitHub Pages serves /RAREXT-protocol/).
const { readdirSync } = await import("node:fs");
for (const name of readdirSync(mirrorTarget)) {
  if (!name.endsWith(".html")) continue;
  const path = join(mirrorTarget, name);
  const html = readFileSync(path, "utf8");
  const fixed = html
    .replace(/(src|href)="\/(bundle|app|verify)\.(js|json)"/g, '$1="./$2.$3"')
    .replace(/href="\/(styles\.css|favicon\.svg)"/g, 'href="./$1"');
  if (fixed !== html) writeFileSync(path, fixed);
}

// Seed: pinned to the ANCHORED bundle.
const seedPath = join(site, "seed.json");
const seed = JSON.parse(readFileSync(seedPath, "utf8"));
seed.updatedAt = new Date().toISOString();
seed.bundleRoot = bundle.manifest.root;
seed.bundleCid = anchoredCid;
seed.pins = [];
for (const mirror of seed.mirrors ?? []) {
  mirror.root = bundle.manifest.root;
}
writeFileSync(seedPath, `${JSON.stringify(seed, null, 2)}\n`);

// The origin's own binding (/.well-known/rarext.json) — derived from the
// committed seed, never hand-written: a republish that moves the root without
// regenerating the binding is exactly the stale self-binding the transition
// doc warns about. Same derivation the peer mirror deploy uses. The path is
// SITE-ROOT-relative: the binding answers for the whole origin.
const siteRoot = join(root, "site");
mkdirSync(join(siteRoot, ".well-known"), { recursive: true });
writeFileSync(
  join(siteRoot, ".well-known", "rarext.json"),
  `${JSON.stringify(
    {
      registry: "rarext",
      root: bundle.manifest.root,
      bundle: "https://999svs999.github.io/RAREXT-protocol/registry/bundle.json",
      cid: anchoredCid,
      issuedAt: new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z"),
    },
    null,
    2,
  )}\n`,
);

const rootUrl = "https://999svs999.github.io/RAREXT-protocol";
const publications = bundle.manifest.publications.length;

writeFileSync(
  join(site, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>RAREXT registry bundle — FUTURISTIC</title>
    <meta name="description" content="A static copy of the latest anchored RAREXT registry bundle carrying FUTURISTIC's published record, with its seed list, mirror, and Merkle root." />
    <link rel="icon" href="../favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="../styles.css" />
  </head>
  <body>
    <main>
      <section class="band">
        <p class="eyebrow">Public artifact</p>
        <h2>Registry bundle — FUTURISTIC</h2>
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
            <span>${publications} anchored publication${publications === 1 ? "" : "s"} · FUTURISTIC published record</span>
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
            <span><a href="../mirror/">workbench</a> · <a href="../mirror/futuristic.html">FUTURISTIC gallery</a></span>
          </div>
          <div>
            <strong>Verify</strong>
            <span><a href="../mirror/verify.html?root=${bundle.manifest.root}">run the pinned verifier</a></span>
          </div>
        </div>
        <p class="small">
          <a href="../">Back to RAREXT</a>
        </p>
      </section>
    </main>
  </body>
</html>
`,
);

console.log(`published FUTURISTIC proof ${bundle.manifest.root}`);
console.log(`  ${publications} publications, anchor ${anchor.id}`);
console.log(`  ${rootUrl}/registry/bundle.json`);
console.log(`  ${rootUrl}/mirror/futuristic.html`);
console.log(`  ${rootUrl}/mirror/verify.html?root=${bundle.manifest.root}`);
console.log(`  seed.pins is [] — no pinning service configured, bundleCid names the bytes`);
