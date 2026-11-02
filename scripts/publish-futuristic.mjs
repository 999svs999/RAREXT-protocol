#!/usr/bin/env node
// publish-futuristic.mjs — FUTURISTIC's real content record, anchored on RAREXT.
//
//   node scripts/publish-futuristic.mjs
//   node scripts/publish-futuristic.mjs --json
//
// Reads /Users/r/FUTURISTIC/state/ledger.jsonl, takes every run that actually
// published (a publish record with platform ids), and republishes each as a
// signed futuristic-video artifact under the persisted `futuristic` agent
// identity. The registry's structural verifier recomputes every field check;
// the author signature carries integrity. Anchors, writes the bundle to
// .futuristic-proof/ — the input for the branded mirror + deploy.
//
// The identity keyfile persists at .futuristic-identity/agent-key.json
// (chmod 600) so every future publication keeps the same authorKey: the brand
// has ONE identity, not a new one per run.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const OUT = join(root, ".futuristic-proof");
const IDENTITY_DIR = join(root, ".futuristic-identity");
const IDENTITY_PATH = join(IDENTITY_DIR, "agent-key.json");
const LEDGER = "/Users/r/FUTURISTIC/state/ledger.jsonl";
const MEDIA_ROOT = "/Users/r/FUTURISTIC/state/media";

const asJson = process.argv.includes("--json");

const core = await import(root + "packages/core/src/index.ts");
const { canonicalize } = core;
const sdk = await import(root + "packages/agent-sdk/src/index.ts");
const { AgentSigner, RarextClient, generateAgentKeypair, createAgentKeyfile, parseAgentKeyfile } = sdk;
const { encodePngRaster } = await import(root + "scripts/png-raster.mjs");
const apiApp = await import(root + "apps/api/src/app.ts");
const { createApp } = apiApp;
const storeMod = await import(root + "apps/api/src/store.ts");
const { RarextStore } = storeMod;

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ---- identity (persisted) ------------------------------------------------
mkdirSync(IDENTITY_DIR, { recursive: true });
let keyfile;
if (existsSync(IDENTITY_PATH)) {
  keyfile = parseAgentKeyfile(JSON.parse(readFileSync(IDENTITY_PATH, "utf8")));
  if (!asJson) console.log("identity loaded:", keyfile.handle, keyfile.keyId.slice(0, 16) + "…");
} else {
  keyfile = createAgentKeyfile("futuristic", generateAgentKeypair("ecdsa-p256"));
  writeFileSync(IDENTITY_PATH, JSON.stringify(keyfile, null, 1), { mode: 0o600 });
  if (!asJson) console.log("identity created:", keyfile.handle, keyfile.keyId.slice(0, 16) + "…");
}
const signer = new AgentSigner(keyfile.privateKey);

// ---- ledger -> records ----------------------------------------------------
const runs = [];
for (const line of readFileSync(LEDGER, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let d;
  try { d = JSON.parse(line); } catch { continue; }
  const pub = d.publish;
  if (!pub || typeof pub !== "object") continue;

  const platforms = [];
  if (pub.youtube && typeof pub.youtube === "object" && pub.youtube.video_id) {
    platforms.push({ platform: "youtube", id: pub.youtube.video_id, url: `https://youtu.be/${pub.youtube.video_id}` });
  }
  if (pub.instagram && typeof pub.instagram === "object" && pub.instagram.instagram) {
    platforms.push({ platform: "instagram", id: String(pub.instagram.instagram) });
  }
  if (pub.facebook && typeof pub.facebook === "object" && pub.facebook.facebook) {
    platforms.push({ platform: "facebook", id: String(pub.facebook.facebook) });
  }
  if (pub.threads && typeof pub.threads === "object" && pub.threads.threads) {
    platforms.push({ platform: "threads", id: String(pub.threads.threads) });
  }
  if (platforms.length === 0) continue;

  const media = d.media ?? {};
  const video = {};
  if (typeof pub.r2_url === "string" && pub.r2_url.startsWith("https://")) {
    video.r2_url = pub.r2_url;
  }
  const localVideo = join(MEDIA_ROOT, d.run_id, "video.mp4");
  if (existsSync(localVideo)) {
    const st = statSync(localVideo);
    if (st.size > 10_000) {
      video.sha256 = sha256File(localVideo);
      video.bytes = st.size;
    }
  }

  const record = {
    run_id: d.run_id,
    theme: d.theme ?? "unknown",
    prompt: d.prompt ?? "",
    model: media.model ?? "agnes-video-v2.0",
    duration_s: typeof media.seconds === "number" ? media.seconds : 121 / 24,
    video,
    platforms,
  };
  if (d.drive && typeof d.drive === "object" && !Array.isArray(d.drive)) {
    const drive = {};
    for (const [name, id] of Object.entries(d.drive)) {
      if (typeof id === "string" && id.length >= 10) drive[name] = id;
    }
    if (Object.keys(drive).length > 0) record.drive = drive;
  }
  runs.push({
    record,
    title: (d.payloads?.youtube?.title ?? `FUTURISTIC ${d.run_id}`).slice(0, 120),
    created_at: d.created_at,
  });
}

if (runs.length === 0) {
  console.error("no published runs found in the ledger — nothing to anchor");
  process.exit(1);
}
if (!asJson) console.log(`ledger: ${runs.length} published run(s) to anchor`);

// ---- in-process registry ---------------------------------------------------
// One seeded challenge for ALL FUTURISTIC video records (the same way
// gen-starter is one challenge many publications attest against).
const challengesMod = await import(root + "apps/api/src/challenges.ts");
const { createChallengeRegistry } = challengesMod;
const baseRegistry = createChallengeRegistry();
const challengeMap = new Map(baseRegistry.list().map((c) => [c.id, c]));
challengeMap.set("futuristic-published", {
  id: "futuristic-published",
  app: "futuristic-video",
  title: "FUTURISTIC published-video record",
  description:
    "The brand's structural record of one published pipeline run: run id, one-line prompt, Agnes model, media commitment, per-platform publication ids. Verified by structural-record-check.",
  version: 1,
  spec: { kind: "futuristic.video.record" },
  semanticsId: "futuristic-video/futuristic-published",
  semanticsVersion: 1,
  createdAt: new Date().toISOString(),
  status: "open",
  sponsor: null,
});

const challengeRegistry = {
  list: () => [...challengeMap.values()],
  get: (id) => challengeMap.get(id) ?? null,
};
const store = new RarextStore();
const server = createApp({ store, challenges: challengeRegistry });
server.listen(8792, "127.0.0.1");
await once(server, "listening");
const base = "http://127.0.0.1:8792";
const client = new RarextClient({ baseUrl: base });
await client.registerAgent(signer, "futuristic");
if (!asJson) console.log("agent registered:", signer.keyId.slice(0, 16) + "…");

// ---- publish every run -----------------------------------------------------
const published = [];
for (const run of runs) {
  const publication = await client.publishArtifactAs(signer, {
    author: "futuristic",
    title: run.title,
    body: `Published ${run.record.platforms.map((p) => p.platform).join(", ")} — run ${run.record.run_id} from the one-line prompt "${run.record.prompt}".`,
    challengeId: "futuristic-published",
    artifact: {
      app: "futuristic-video",
      kind: "futuristic.video.v1",
      version: 1,
      mediaType: "application/json",
      body: run.record,
    },
  });
  if (!publication.attestation?.correct) {
    throw new Error(`publication ${run.record.run_id} did not attest correct`);
  }
  published.push({
    id: publication.id,
    run_id: run.record.run_id,
    attestation: publication.attestation.correct,
    platforms: run.record.platforms.map((p) => p.platform),
  });
  if (!asJson) console.log(`  ✓ ${run.record.run_id} -> ${publication.id.slice(0, 8)}… [${publication.attestation.representation ?? "exact"}]`);
}

// ---- AI seed representations -----------------------------------------------
// The brand's record AND the protocol's AI proof in one registry: the verify
// page replays AI claims, and the self-publish tests read the published bundle
// for them. Same identity, same anchor — the seeds are correct by construction.
const seedChallenges = await client.challenges();
const genChallenge = seedChallenges.find((c) => c.id === "gen-starter");
const boundedChallenge = seedChallenges.find((c) => c.id === "bounded-starter");
if (!genChallenge || !boundedChallenge) throw new Error("AI seeds missing");

const genBody = genChallenge.sampleArtifact.body;
const RASTER_SIZE = 64;
const raster = core.renderRaster(genBody.model, genBody.seed, RASTER_SIZE);
const rasterDigest = createHash("sha256").update(raster).digest("hex");
const png = encodePngRaster(raster, RASTER_SIZE);
const renditionResponse = await fetch(`${base}/v1/blobs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ content: png.toString("base64"), encoding: "base64", mediaType: "image/png" }),
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

const boundedBody = boundedChallenge.sampleArtifact.body;
const boundedPngWidth = boundedChallenge.spec.reference.length * core.BOUNDED_RASTER_SCALE;
const boundedPngHeight = core.BOUNDED_RASTER_HEIGHT;
const boundedRaster = core.renderBoundedRaster(boundedChallenge.spec.reference, boundedBody.values);
const boundedRasterDigest = createHash("sha256").update(boundedRaster).digest("hex");
const boundedPng = encodePngRaster(boundedRaster, boundedPngWidth, boundedPngHeight);
const boundedStoreResponse = await fetch(`${base}/v1/blobs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ content: boundedPng.toString("base64"), encoding: "base64", mediaType: "image/png" }),
});
if (!boundedStoreResponse.ok) throw new Error(`bounded rendition store failed: ${boundedStoreResponse.status}`);
const boundedBlob = await boundedStoreResponse.json();
boundedBody.media = core.boundedRenditionFor(boundedChallenge.spec.reference, boundedBody.values, {
  encodePng: (r, width, height) => new Uint8Array(encodePngRaster(r, width, height)),
  sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
});
if (boundedBody.media.blob !== boundedBlob.hash) {
  throw new Error(`bounded rendition blob digest mismatch: store ${boundedBlob.hash.slice(0, 16)}… vs computed ${boundedBody.media.blob.slice(0, 16)}…`);
}

const genPublication = await client.publishArtifactAs(signer, {
  author: "futuristic",
  title: "Replay of the committed starter model (32 steps)",
  body: "Generated on this node by the digest-bound xorshift32 starter model from seed 42; replay it yourself.",
  challengeId: "gen-starter",
  artifact: { app: "ai-generative", kind: "ai.generative", version: 1, mediaType: "application/json", body: genBody },
});
if (genPublication.attestation.representation !== "generative") throw new Error("generative representation missing");
const boundedPublication = await client.publishArtifactAs(signer, {
  author: "futuristic",
  title: "Bounded reconstruction of the committed reference (maxAbsError 2)",
  body: "An int8-quantized reconstruction within the committed bound; recompute the metric yourself.",
  challengeId: "bounded-starter",
  artifact: { app: "ai-bounded", kind: "ai.bounded", version: 1, mediaType: "application/json", body: boundedBody },
});
if (boundedPublication.attestation.representation !== "bounded") throw new Error("bounded representation missing");
if (!asJson) console.log(`  ✓ ai seeds -> gen ${genPublication.id.slice(0, 8)}… bounded ${boundedPublication.id.slice(0, 8)}…`);

// ---- anchor + bundle -------------------------------------------------------
await client.anchor();
const bundleResponse = await fetch(`${base}/v1/bundles/latest`);
if (!bundleResponse.ok) throw new Error(`no bundle: ${bundleResponse.status}`);
const bundle = await bundleResponse.json();

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "bundle.json"), JSON.stringify(bundle, null, 1));

// Verify the bundle through the API's own verifier before declaring victory.
const { verifyBundle } = await import(join(root, "apps/api/src/bundle.ts"));
const verification = verifyBundle(bundle);
if (!verification.valid) throw new Error(`bundle does not verify: ${verification.reason}`);

const summary = {
  identity: { handle: keyfile.handle, keyId: keyfile.keyId },
  publications: published.length,
  root: bundle.manifest.root,
  leafVersion: bundle.manifest.leafVersion,
  bundle: join(OUT, "bundle.json"),
  verified: true,
};

// ---- mirror -----------------------------------------------------------------
// The brand's static face: bundle pair + workbench assets + the pinned verify
// page + the FUTURISTIC gallery. FUTURISTIC publications carry no media blobs
// (the videos live on the platforms and R2), so the mirror is light. Runs
// BEFORE the API shuts down — writeMirrorBlobs fetches from it.
const { writeBundleFiles, injectBundleScript } = await import(join(root, "scripts/mirror-artifacts.mjs"));
const { mirrorVerifyPage } = await import(join(root, "scripts/mirror-verify-page.mjs"));
const { writeMirrorBlobs } = await import(join(root, "scripts/mirror-blobs.mjs"));
const { futuristicGalleryPage } = await import(join(root, "scripts/futuristic-page.mjs"));

const mirrorDir = join(OUT, "mirror");
mkdirSync(mirrorDir, { recursive: true });
writeBundleFiles(mirrorDir, bundle);
// Blobs: the AI seed publications carry PNG renditions the verify page replays,
// so they are embedded (the same mediaClaims extraction build-mirror.mjs uses).
const mediaClaims = (publications) =>
  (Array.isArray(publications) ? publications : []).flatMap((publication) => {
    const media = publication?.artifact?.body?.media;
    if (!media || typeof media !== "object") return [];
    return [
      {
        blob: media.blob,
        raster: media.raster,
        size: media.size,
        app: publication.app,
        representation: publication.attestation?.representation ?? null,
        publicationId: publication.id,
        challengeId: publication.challengeId,
        title: publication.title,
      },
    ];
  });
const blobsWritten = await writeMirrorBlobs({ base, mirrorDir, aiClaims: mediaClaims(bundle.publications) });
cpSync(join(root, "apps/web/public"), mirrorDir, { recursive: true });
// cpSync above re-copied generated bundle files; rewrite to be sure they are
// the anchored bundle's bytes (single source, same rule as publish-proof.mjs).
writeBundleFiles(mirrorDir, bundle);

const mirrorIndex = join(mirrorDir, "index.html");
writeFileSync(mirrorIndex, injectBundleScript(readFileSync(mirrorIndex, "utf8"), { appSrc: "/app.js", newAppSrc: "./app.js" }));

writeFileSync(join(mirrorDir, "verify.html"), mirrorVerifyPage({
  title: "Mirror verification — FUTURISTIC included",
  heading: "This mirror is a copy. Here is whether it is a faithful one — and whether FUTURISTIC's published record holds.",
}));
writeFileSync(join(mirrorDir, "futuristic.html"), futuristicGalleryPage(bundle));

// Portability under a subpath (GitHub Pages serves /RAREXT-protocol/).
for (const name of readdirSync(mirrorDir)) {
  if (!name.endsWith(".html")) continue;
  const path = join(mirrorDir, name);
  const html = readFileSync(path, "utf8");
  const fixed = html
    .replace(/(src|href)="\/(bundle|app|verify)\.(js|json)"/g, '$1="./$2.$3"')
    .replace(/href="\/(styles\.css|favicon\.svg)"/g, 'href="./$1"');
  if (fixed !== html) writeFileSync(path, fixed);
}
summary.mirror = mirrorDir;
summary.blobs = blobsWritten.count;

server.closeAllConnections();
server.close();

if (asJson) {
  console.log(JSON.stringify(summary, null, 1));
} else {
  console.log(`\nBUNDLE VERIFIED: ${published.length} FUTURISTIC publications`);
  console.log("root:", bundle.manifest.root);
  console.log("written to:", OUT);
}
