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
import { injectBundleScript, writeBundleFiles } from "./mirror-artifacts.mjs";
import { mirrorVerifyPage } from "./mirror-verify-page.mjs";
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

writeBundleFiles(out, bundle);

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
const index = injectBundleScript(readFileSync(indexPath, "utf8"), {
  appSrc: "/app.js",
  newAppSrc: "./app.js",
});

writeFileSync(indexPath, index);

const verifyPath = join(out, "verify.html");
writeFileSync(
  verifyPath,
  mirrorVerifyPage({
    title: "Mirror verification",
    heading: "This mirror is a copy. Here is whether it is a faithful one.",
  }),
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
