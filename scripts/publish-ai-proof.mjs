// Publishes real AI publications through the live API flow, anchors them,
// and saves the resulting bundle — the proof that AI lives on RAREXT.
import { createHash } from "node:crypto";
import { injectBundleScript, writeBundleFiles } from "./mirror-artifacts.mjs";
import { mirrorVerifyPage } from "./mirror-verify-page.mjs";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeMirrorBlobs } from "./mirror-blobs.mjs";
import { encodePngRaster } from "./png-raster.mjs";

const root = new URL("..", import.meta.url).pathname;
const OUT = join(root, ".ai-proof");



const core = await import(root + "packages/core/src/index.ts");
const { canonicalize, generate } = core;

const sdk = await import(root + "packages/agent-sdk/src/index.ts");
const { AgentSigner, RarextClient, generateAgentKeypair } = sdk;

const apiApp = await import(root + "apps/api/src/app.ts");
const { createApp } = apiApp;

const storeMod = await import(root + "apps/api/src/store.ts");
const { RarextStore } = storeMod;

mkdirSync(OUT, { recursive: true });

// 1. Boot the real API in-process on a fixed port.
const store = new RarextStore();
const server = createApp({ store });
server.listen(8791, "127.0.0.1");
await once(server, "listening");
const base = "http://127.0.0.1:8791";
console.log("api up at", base);

const client = new RarextClient({ baseUrl: base });

// 2. A real agent identity, registered under a handle.
const keypair = generateAgentKeypair("ecdsa-p256");
const signer = new AgentSigner(keypair.privateKey);
await client.registerAgent(signer, "ai-proof");
console.log("agent registered:", signer.keyId.slice(0, 16));

// 3. The seeded AI challenges and their sample bodies (correct by construction).
const challenges = await client.challenges();
const genChallenge = challenges.find((c) => c.id === "gen-starter");
const boundedChallenge = challenges.find((c) => c.id === "bounded-starter");
if (!genChallenge || !boundedChallenge) throw new Error("AI seeds missing");
const genBody = genChallenge.sampleArtifact.body;
const boundedBody = boundedChallenge.sampleArtifact.body;

// 3a. A media rendition of the SAME commitment. The picture is derived from
// the committed model and seed alone, so it is a function of the commitment:
// a stranger can re-derive these bytes and compare digests instead of
// trusting an uploaded file. The raster digest is the encoder-independent
// part; the PNG blob is one faithful encoding of that raster.
const RASTER_SIZE = 64;
const boundedPngWidth = boundedChallenge.spec.reference.length * core.BOUNDED_RASTER_SCALE;
const boundedPngHeight = core.BOUNDED_RASTER_HEIGHT;
const raster = core.renderRaster(genBody.model, genBody.seed, RASTER_SIZE);
const rasterDigest = createHash("sha256").update(raster).digest("hex");
const png = encodePngRaster(raster, RASTER_SIZE);

const renditionResponse = await fetch(`${base}/v1/blobs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    content: png.toString("base64"),
    encoding: "base64",
    mediaType: "image/png",
  }),
});
if (!renditionResponse.ok) throw new Error(`rendition store failed: ${renditionResponse.status}`);
const renditionBlob = await renditionResponse.json();

genBody.media = {
  mediaType: "image/png",
  rule: core.RASTER_RULE,
  blob: renditionBlob.hash,
  raster: rasterDigest,
  size: RASTER_SIZE,
  bytes: png.length,
};
console.log(
  `rendition stored: blob ${renditionBlob.hash.slice(0, 16)}… raster ${rasterDigest.slice(0, 16)}… (${png.length} bytes)`,
);

// 3b. The bounded class gets the same treatment, and here the picture is the
// measurement itself: reference lane, reconstruction lane, and the absolute
// error amplified by a fixed gain. A reconstruction inside the committed bound
// looks almost blank in the error lane — the promise becomes something the
// reader can see and re-derive, not just a number in a JSON field.
const boundedRaster = core.renderBoundedRaster(
  boundedChallenge.spec.reference,
  boundedBody.values,
);
const boundedRasterDigest = createHash("sha256").update(boundedRaster).digest("hex");
const boundedPng = encodePngRaster(boundedRaster, boundedPngWidth, boundedPngHeight);
const boundedStoreResponse = await fetch(`${base}/v1/blobs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    content: boundedPng.toString("base64"),
    encoding: "base64",
    mediaType: "image/png",
  }),
});
if (!boundedStoreResponse.ok) {
  throw new Error(`bounded rendition store failed: ${boundedStoreResponse.status}`);
}
const boundedBlob = await boundedStoreResponse.json();

boundedBody.media = {
  mediaType: "image/png",
  rule: core.BOUNDED_RASTER_RULE,
  blob: boundedBlob.hash,
  raster: boundedRasterDigest,
  width: boundedPngWidth,
  height: boundedPngHeight,
  bytes: boundedPng.length,
};
console.log(
  `bounded rendition stored: blob ${boundedBlob.hash.slice(0, 16)}… raster ${boundedRasterDigest.slice(0, 16)}… (${boundedPng.length} bytes)`,
);

// 4. Publish REAL generative + bounded publications, signed by the agent.
const genPublication = await client.publishArtifactAs(signer, {
  author: "ai-proof",
  title: "Replay of the committed starter model (32 steps)",
  body: "Generated on this node by the digest-bound xorshift32 starter model from seed 42; replay it yourself.",
  challengeId: "gen-starter",
  artifact: {
    app: "ai-generative",
    kind: "ai.generative",
    version: 1,
    mediaType: "application/json",
    body: genBody,
  },
});
console.log("generative publication:", genPublication.id, "attested:", genPublication.attestation.correct);

const boundedPublication = await client.publishArtifactAs(signer, {
  author: "ai-proof",
  title: "Bounded reconstruction of the committed reference (maxAbsError 2)",
  body: "An int8-quantized reconstruction within the committed bound; recompute the metric yourself.",
  challengeId: "bounded-starter",
  artifact: {
    app: "ai-bounded",
    kind: "ai.bounded",
    version: 1,
    mediaType: "application/json",
    body: boundedBody,
  },
});
console.log("bounded publication:", boundedPublication.id, "attested:", boundedPublication.attestation.correct);

if (genPublication.attestation.representation !== "generative") throw new Error("generative representation missing on the attestation");
if (boundedPublication.attestation.representation !== "bounded") throw new Error("bounded representation missing on the attestation");
if (boundedPublication.attestation.metricValue !== 2) throw new Error("metricValue not recorded");

// Sanity: a tampered generative output must be rejected by the API itself.
const tampered = JSON.parse(JSON.stringify(genBody));
tampered.output = tampered.output.slice(0, -1) + (tampered.output.endsWith("a") ? "b" : "a");
let tamperRejected = false;
try {
  await client.publishArtifactAs(signer, {
    author: "ai-proof",
    title: "Tampered output (must fail)",
    challengeId: "gen-starter",
    artifact: {
      app: "ai-generative",
      kind: "ai.generative",
      version: 1,
      mediaType: "application/json",
      body: tampered,
    },
  });
} catch {
  tamperRejected = true;
}
if (!tamperRejected) throw new Error("the API accepted a tampered AI output — proof invalid");
console.log("tampered output rejected by the API: true");

// 5. Anchor everything.
const anchors = clientWithAnchor(client);
const anchor = await anchors;
console.log("anchor:", anchor.id ?? JSON.stringify(anchor).slice(0, 80));

// 6. Fetch the latest bundle and save it.
const bundleResponse = await fetch(`${base}/v1/bundles/latest`);
if (!bundleResponse.ok) throw new Error(`no bundle: ${bundleResponse.status}`);
const bundle = await bundleResponse.json();
writeBundleFiles(OUT, bundle);

const pubs = bundle.publications ?? [];
const aiPubs = pubs.filter((p) => p.attestation?.representation);
console.log(`bundle: leafVersion ${bundle.manifest.leafVersion}, ${pubs.length} publications, ${aiPubs.length} AI`);
for (const p of aiPubs) {
  console.log(`  - ${p.id} app=${p.app} representation=${p.attestation.representation} correct=${p.attestation.correct}`);
}
if (bundle.manifest.leafVersion !== 4) throw new Error("bundle is not leafVersion 4");
if (aiPubs.length !== 2) throw new Error("bundle does not carry both AI publications");

// 7. Build the static mirror the same way scripts/build-mirror.mjs does:
//    bundle + the built web app (workbench + verifier), no server behind it.
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const mirrorDir = join(OUT, "mirror");
rmSync(mirrorDir, { recursive: true, force: true });
mkdirSync(mirrorDir, { recursive: true });
writeBundleFiles(mirrorDir, bundle);
const publicDir = join(root, "apps/web/public");
if (!existsSync(join(publicDir, "verify.js"))) throw new Error("web app not built");
cpSync(publicDir, mirrorDir, { recursive: true });

// Bundle before the app, through the one implementation of that edit.
const indexPath = join(mirrorDir, "index.html");
writeFileSync(indexPath, injectBundleScript(readFileSync(indexPath, "utf8"), { appSrc: "/app.js" }));

// GitHub Pages serves this repo under /RAREXT-protocol/, so root-relative
// asset paths must become document-relative for the mirror to work there.
for (const name of readdirSync(mirrorDir)) {
  if (!name.endsWith(".html")) continue;
  const path = join(mirrorDir, name);
  const html = readFileSync(path, "utf8");
  const fixed = html
    .replace(/(src|href)="\/(bundle|app|verify)\.(js|json)"/g, '$1="./$2.$3"')
    .replace(/href="\/(styles\.css)"/g, 'href="./$1"');
  if (fixed !== html) writeFileSync(path, fixed);
}

// verify.html: the mirror's proof page — Merkle root + per-publication AI
// verification, all computed locally from the bundle (it carries the specs).
writeFileSync(
  join(mirrorDir, "verify.html"),
  mirrorVerifyPage({
    title: "Mirror verification — AI claims included",
    heading: "This mirror is a copy. Here is whether it is a faithful one — and whether its AI claims replay.",
  }),
);

const blobs = await writeMirrorBlobs({
  base,
  mirrorDir,
  aiClaims: [
    {
      blob: genBody.media.blob,
      raster: genBody.media.raster,
      size: genBody.media.size,
      app: "ai-generative",
      representation: "generative",
      publicationId: genPublication.id,
      challengeId: "gen-starter",
      title: genPublication.title,
    },
    {
      blob: boundedBody.media.blob,
      raster: boundedBody.media.raster,
      app: "ai-bounded",
      representation: "bounded",
      publicationId: boundedPublication.id,
      challengeId: "bounded-starter",
      title: boundedPublication.title,
    },
  ],
});
console.log(`  embedded ${blobs.count} blob(s), ${blobs.total} bytes`);
console.log("MIRROR BUILT AT", mirrorDir);

console.log("PROOF BUNDLE WRITTEN TO", OUT);
server.closeAllConnections();
server.close();
process.exit(0);

function clientWithAnchor(c) {
  return c.anchor();
}