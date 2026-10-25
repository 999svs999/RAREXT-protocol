// Publishes real AI publications through the live API flow, anchors them,
// and saves the resulting bundle — the proof that AI lives on RAREXT.
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
writeFileSync(join(OUT, "bundle.json"), JSON.stringify(bundle, null, 2));
writeFileSync(
  join(OUT, "bundle.js"),
  `window.__RAREXT_BUNDLE__ = ${JSON.stringify(bundle)};\n`,
);

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
writeFileSync(join(mirrorDir, "bundle.json"), JSON.stringify(bundle, null, 2));
writeFileSync(
  join(mirrorDir, "bundle.js"),
  `window.__RAREXT_BUNDLE__ = ${JSON.stringify(bundle)};\n`,
);
const publicDir = join(root, "apps/web/public");
if (!existsSync(join(publicDir, "verify.js"))) throw new Error("web app not built");
cpSync(publicDir, mirrorDir, { recursive: true });

// Bundle before app, as build-mirror.mjs does.
const indexPath = join(mirrorDir, "index.html");
writeFileSync(
  indexPath,
  readFileSync(indexPath, "utf8").replace(
    '<script type="module" src="/app.js"></script>',
    '<script src="/bundle.js"></script>\n    <script type="module" src="/app.js"></script>',
  ),
);

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
const verifyHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mirror verification — AI claims included</title>
    <style>
      body { margin: 0; padding: 40px; background: #080a0e; color: #e3eaf3;
             font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      h1 { font-size: 20px; margin: 0 0 18px; }
      h2 { font-size: 14px; margin: 26px 0 8px; color: #9fb0c3; }
      .row { display: flex; justify-content: space-between; gap: 20px;
             padding: 8px 0; border-bottom: 1px solid #1b222c; font-size: 13px; }
      .ok { color: #6ff0c4; } .bad { color: #ff7d90; } .dim { color: #6c7a8b; }
      button { margin-top: 18px; padding: 8px 14px; border-radius: 7px;
               border: 1px solid #2d3846; background: #141922; color: #e3eaf3;
               font: inherit; cursor: pointer; }
      code { word-break: break-all; }
    </style>
  </head>
  <body>
    <h1>This mirror is a copy. Here is whether it is a faithful one — and whether its AI claims replay.</h1>
    <div id="out"></div>
    <button id="check">Re-verify</button>
    <script type="module">
      import { verifyBundle } from "./verify.js";
      const out = document.getElementById("out");

      async function run() {
        const bundle = await (await fetch("./bundle.json")).json();
        // The bundle carries every challenge spec, so this page can replay the
        // generative claims and recompute the bounded metrics itself.
        const challenges = Object.fromEntries(
          (bundle.challenges ?? []).map((c) => [c.id, c.spec ?? {}]),
        );
        const result = await verifyBundle(bundle, challenges);

        const row = (label, value, cls) =>
          '<div class="row"><span class="dim">' + label + '</span><span class="' + (cls ?? "") + '">' + value + "</span></div>";

        const sections = [
          row("Publications", String(result.publications)),
          row("Anchored root", "<code>" + result.root + "</code>"),
          row("Recomputed root", "<code>" + result.computedRoot + "</code>"),
          row("This copy is faithful", result.valid ? "yes" : "no", result.valid ? "ok" : "bad"),
          result.reason ? row("Why not", result.reason, "bad") : "",
        ];

        const ai = (result.aiClaims ?? []).filter((c) => c.representation);
        if (ai.length) {
          sections.push("<h2>AI claims — verified in your browser</h2>");
          for (const claim of ai) {
            const title = (bundle.publications.find((p) => p.id === claim.publicationId) ?? {}).title ?? claim.publicationId;
            sections.push(row(title.slice(0, 60), "representation: " + claim.representation, "dim"));
            if (claim.representation === "bounded") {
              sections.push(row("committed metric", claim.metricName + " = " + claim.metricValue + " (bound " + claim.bound + ")",
                claim.withinBound === false ? "bad" : "ok"));
            }
            if (claim.local) {
              let detail = "local check: " + (claim.local.correct ? "PASSES" : "FAILS");
              if (claim.local.metricValue !== undefined) {
                const committed = claim.metricValue;
                const agrees = committed === null || committed === claim.local.metricValue;
                detail += " · recomputed metric " + claim.local.metricValue +
                  (agrees ? " (matches attestation)" : " (MISMATCHES attested " + committed + ")");
                sections.push(row(title.slice(0, 60), detail, agrees ? "ok" : "bad"));
              } else {
                sections.push(row(title.slice(0, 60), detail, claim.local.correct ? "ok" : "bad"));
              }
            } else {
              sections.push(row(title.slice(0, 60), "local check: not run (spec unavailable)", "dim"));
            }
          }
        }

        out.innerHTML = sections.join("");
      }

      document.getElementById("check").addEventListener("click", run);
      run();
    </script>
  </body>
</html>
`;
writeFileSync(join(mirrorDir, "verify.html"), verifyHtml);

// Embed small public blobs so the gallery works on the static mirror with no
// server. Caps keep the deploy lean: 512 KiB per blob, 4 MiB total.
const EMBED_PER_BLOB = 512 * 1024;
const EMBED_TOTAL = 4 * 1024 * 1024;
const blobListResponse = await fetch(`${base}/v1/blobs`);
const blobList = blobListResponse.ok ? (await blobListResponse.json()) : [];
const embedded = [];
let embeddedTotal = 0;
for (const record of blobList) {
  if ((record.size ?? 0) > EMBED_PER_BLOB) continue;
  if (embeddedTotal + (record.size ?? 0) > EMBED_TOTAL) break;
  const detail = await fetch(`${base}/v1/blobs/${record.hash}`);
  if (!detail.ok) continue;
  const full = await detail.json();
  embedded.push({
    hash: full.hash,
    mediaType: full.mediaType,
    size: full.size,
    tier: full.tier ?? "public",
    content: full.content,
  });
  embeddedTotal += full.size ?? 0;
}
writeFileSync(
  join(mirrorDir, "blobs.json"),
  JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), blobs: embedded }, null, 2),
);
console.log(`  embedded ${embedded.length} blob(s), ${embeddedTotal} bytes`);
console.log("MIRROR BUILT AT", mirrorDir);

console.log("PROOF BUNDLE WRITTEN TO", OUT);
server.closeAllConnections();
server.close();
process.exit(0);

function clientWithAnchor(c) {
  return c.anchor();
}