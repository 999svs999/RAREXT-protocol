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

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
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

server.closeAllConnections();
server.close();

const summary = {
  identity: { handle: keyfile.handle, keyId: keyfile.keyId },
  publications: published.length,
  root: bundle.manifest.root,
  leafVersion: bundle.manifest.leafVersion,
  bundle: join(OUT, "bundle.json"),
  verified: true,
};
if (asJson) {
  console.log(JSON.stringify(summary, null, 1));
} else {
  console.log(`\nBUNDLE VERIFIED: ${published.length} FUTURISTIC publications`);
  console.log("root:", bundle.manifest.root);
  console.log("written to:", OUT);
}
