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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { writeMirrorBlobs } from "./mirror-blobs.mjs";

const root = new URL("..", import.meta.url).pathname;
const publicDir = join(root, "apps/web/public");

if (!existsSync(join(publicDir, "verify.js"))) {
  console.log("building the web app for the mirror");
  execFileSync("npm", ["run", "build:web"], { cwd: root, stdio: "inherit" });
}
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

function mediaClaims(publications) {
  return (Array.isArray(publications) ? publications : []).flatMap((publication) => {
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
}

const blobs = await writeMirrorBlobs({
  base: api,
  mirrorDir: out,
  aiClaims: mediaClaims(bundle.publications),
});
console.log(`  embedded ${blobs.count} blob(s), ${blobs.total} bytes`);

// The mirror's page loads the bundle before the app, so the workbench answers
// its reads from the bundle instead of a server.
const indexPath = join(out, "index.html");
const index = readFileSync(indexPath, "utf8").replace(
  '<script type="module" src="/app.js"></script>',
  '<script src="./bundle.js"></script>\n    <script type="module" src="./app.js"></script>',
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
    <h1>This mirror is a copy. Here is whether it is a faithful one.</h1>
    <div id="out"></div>
    <button id="check">Re-verify</button>
    <script type="module">
      import { verifyBundle } from "./verify.js";
      const out = document.getElementById("out");

      async function run() {
        const [bundle, blobFile] = await Promise.all([
          (await fetch("./bundle.json")).json(),
          fetch("./blobs.json").then((response) => response.ok ? response.json() : { blobs: [] }),
        ]);
        const requested = new URLSearchParams(location.search).get("root");
        const pinned = requested && /^[0-9a-f]{64}$/.test(requested) ? requested : null;
        const challenges = Object.fromEntries(
          (bundle.challenges ?? []).map((challenge) => [challenge.id, challenge.spec ?? {}]),
        );
        const media = Object.fromEntries(
          (Array.isArray(blobFile.blobs) ? blobFile.blobs : [])
            .filter((blob) => typeof blob.hash === "string" && typeof blob.content === "string")
            .map((blob) => [blob.hash, blob.content]),
        );
        const result = await verifyBundle(bundle, challenges, pinned ?? undefined, media);

        const row = (label, value, cls) =>
          '<div class="row"><span class="dim">' + label + '</span><span class="' + (cls ?? "") + '">' + value + "</span></div>";
        const pinRow = pinned
          ? row("Pinned chain root", "<code>" + pinned + "</code>",
                result.valid ? "ok" : "bad")
          : row("Pinned chain root", "not supplied (open with ?root=...)", "dim");

        const sections = [
          row("Publications", String(result.publications)),
          row("Anchored root", "<code>" + result.root + "</code>"),
          row("Recomputed root", "<code>" + result.computedRoot + "</code>"),
          pinRow,
          row("This copy is faithful", result.valid ? "yes" : "no", result.valid ? "ok" : "bad"),
          result.reason ? row("Why not", result.reason, "bad") : "",
        ];

        const ai = (result.aiClaims ?? []).filter((claim) => claim.representation);
        if (ai.length) {
          sections.push("<h2>AI claims</h2>");
          for (const claim of ai) {
            const title = (bundle.publications.find((pub) => pub.id === claim.publicationId) ?? {}).title ?? claim.publicationId;
            sections.push(row(title.slice(0, 60), "representation: " + claim.representation, "dim"));
            if (claim.local) {
              sections.push(row(title.slice(0, 60), "local check: " + (claim.local.correct ? "PASSES" : "FAILS"),
                claim.local.correct ? "ok" : "bad"));
            }
            if (claim.media) {
              sections.push(row("rendition", claim.media.matches === true
                ? "raster re-derived"
                : claim.media.matches === false ? "raster MISMATCH" : "not checked",
                claim.media.matches === true ? "ok" : "bad"));
              if (claim.media.blobMatches !== null) {
                sections.push(row("rendition bytes", claim.media.blobMatches ? "blob digest matches" : "blob MISMATCH",
                  claim.media.blobMatches ? "ok" : "bad"));
              }
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
`,
);

// Keep the mirror portable under a subpath (GitHub Pages serves this repo at
// /RAREXT-protocol/). Assets and the bundle must resolve next to the page.
for (const name of readdirSync(out)) {
  if (!name.endsWith(".html")) continue;
  const path = join(out, name);
  const html = readFileSync(path, "utf8");
  const fixed = html
    .replace(/(src|href)="\/(bundle|app|verify)\.(js|json)"/g, '$1="./$2.$3"')
    .replace(/href="\/(styles\.css|favicon\.svg)"/g, 'href="./$1"');
  if (fixed !== html) writeFileSync(path, fixed);
}

console.log(`mirror written to ${out}`);
console.log(`  root ${bundle.manifest.root}`);
console.log(`  ${bundle.manifest.publications.length} publications`);
console.log(`  open ${out}/index.html for the workbench, ${out}/verify.html for the proof`);
