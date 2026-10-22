#!/usr/bin/env node
// Builds a static mirror of the registry.
//
//   node scripts/build-mirror.mjs [output directory]
//
// A mirror is what survives the operator. It holds the registry as a bundle, the
// workbench, and a verifier that recomputes the Merkle root from the
// publications in the browser and compares it with the root the chain holds.
//
// The mirror has no server behind it. It is a directory.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = resolve(root, process.argv[2] ?? ".mirror");
const api = process.env.RAREXT_API ?? "http://127.0.0.1:8787";

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

console.log(`fetching the bundle from ${api}`);

const response = await fetch(`${api}/v1/bundles/latest`);
if (!response.ok) {
  console.error(`could not fetch a bundle: ${response.status}`);
  console.error("anchor something first, or run: curl -X POST /v1/anchors");
  process.exit(1);
}

const bundle = await response.json();

writeFileSync(join(out, "bundle.json"), JSON.stringify(bundle, null, 2));
writeFileSync(
  join(out, "bundle.js"),
  `window.__RAREXT_BUNDLE__ = ${JSON.stringify(bundle)};\n`,
);

cpSync(join(root, "apps/web/public"), out, { recursive: true });

// The mirror's page loads the bundle before the app, so the workbench answers
// its reads from the bundle instead of a server.
const indexPath = join(out, "index.html");
const index = readFileSync(indexPath, "utf8").replace(
  '<script type="module" src="/app.js"></script>',
  '<script src="/bundle.js"></script>\n    <script type="module" src="/app.js"></script>',
);

writeFileSync(indexPath, index);

const verifyPath = join(out, "verify.html");
writeFileSync(
  verifyPath,
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mirror verification</title>
    <style>
      body { margin: 0; padding: 40px; background: #080a0e; color: #e3eaf3;
             font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      h1 { font-size: 20px; margin: 0 0 18px; }
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
    <h1>This mirror is a copy. Here is whether it is a faithful one.</h1>
    <div id="out"></div>
    <button id="check">Re-verify</button>
    <script src="/bundle.js"></script>
    <script type="module">
      const out = document.getElementById("out");

      async function sha256Hex(bytes) {
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      }

      function canonicalize(value) {
        if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
        if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
        const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
        return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
      }

      function hashPair(left, right) {
        return sha256Hex(new TextEncoder().encode(left + right));
      }

      function merkleRoot(leaves) {
        if (leaves.length === 0) return "";
        let level = [...leaves];
        while (level.length > 1) {
          const next = [];
          for (let i = 0; i < level.length; i += 2) next.push(hashPair(level[i], level[i + 1] ?? level[i]));
          level = next;
        }
        return level[0];
      }

      function leaf(publication, version) {
        if (version < 2) {
          return sha256Hex(new TextEncoder().encode(canonicalize({
            id: publication.id, author: publication.author, authorKey: publication.authorKey,
            taskId: publication.taskId, circuitHash: publication.attestation.circuitHash,
            traceHash: publication.attestation.traceHash, score: publication.attestation.score,
            gateCount: publication.attestation.gateCount, createdAt: publication.createdAt })));
        }
        return sha256Hex(new TextEncoder().encode(canonicalize({
          leafVersion: 2, id: publication.id, author: publication.author,
          authorKey: publication.authorKey, title: publication.title, body: publication.body,
          app: publication.app, challengeId: publication.challengeId, taskId: publication.taskId,
          artifact: publication.artifact, circuit: publication.circuit ?? null,
          parentId: publication.parentId, source: publication.source, createdAt: publication.createdAt,
          nonce: publication.nonce, signature: publication.signature,
          attestation: {
            circuitHash: publication.attestation.circuitHash,
            traceHash: publication.attestation.traceHash,
            correct: publication.attestation.correct,
            score: publication.attestation.score,
            gateCount: publication.attestation.gateCount,
            semanticsId: publication.attestation.semanticsId,
            semanticsVersion: publication.attestation.semanticsVersion,
            semanticsHash: publication.attestation.semanticsHash,
            claimKind: publication.attestation.claimKind,
            scope: publication.attestation.scope,
            verifierHash: publication.attestation.verifierHash } })));
      }

      async function verify() {
        const bundle = window.__RAREXT_BUNDLE__;
        if (!bundle) {
          out.innerHTML = '<div class="row bad">no bundle found</div>';
          return;
        }

        const leaves = [];
        for (const publication of bundle.publications) {
          leaves.push(await leaf(publication, bundle.manifest.leafVersion));
        }

        const computed = merkleRoot(leaves);
        const matches = computed === bundle.manifest.root;
        const listed = bundle.manifest.publications.map((p) => p.leaf);
        const listMatches = JSON.stringify(listed) === JSON.stringify(leaves);

        out.innerHTML = [
          row("Publications", String(bundle.publications.length)),
          row("Anchored root", "<code>" + bundle.manifest.root + "</code>"),
          row("Recomputed root", "<code>" + computed + "</code>"),
          row("Leaf list matches", listMatches ? "yes" : "no", listMatches ? "ok" : "bad"),
          row("This copy is faithful", matches && listMatches ? "yes" : "no", matches && listMatches ? "ok" : "bad"),
          row("Anchored at", bundle.manifest.createdAt),
        ].join("");

        function row(label, value, cls) {
          return '<div class="row"><span class="dim">' + label + '</span><span class="' + (cls ?? "") + '">' + value + "</span></div>";
        }
      }

      document.getElementById("check").addEventListener("click", verify);
      verify();
    </script>
  </body>
</html>
`,
);

console.log(`mirror written to ${out}`);
console.log(`  root ${bundle.manifest.root}`);
console.log(`  ${bundle.manifest.publications.length} publications`);
console.log(`  open ${out}/index.html for the workbench, ${out}/verify.html for the proof`);
