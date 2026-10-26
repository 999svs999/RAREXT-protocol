// The files every mirror tree carries, written in ONE place.
//
// A sweep for duplicated generated artifacts found the bundle written as the
// same inline one-liner in three places — build-mirror.mjs once and
// publish-ai-proof.mjs twice — with publish-ai-proof's own comment saying it
// builds "the same way scripts/build-mirror.mjs does". That is duplication
// stated out loud, and the twins had already diverged: one injected
// "./bundle.js" into the workbench and the other "/bundle.js", relying on a
// later absolute-to-relative pass. The page had the same shape and a failover
// fix already went to the copy that was never published.
//
// So the bundle pair and the workbench script-tag injection live here, and the
// generators call them. claim:check asserts the inline forms appear nowhere else
// in scripts/.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** The inline bundle the workbench reads: window.__RAREXT_BUNDLE__ = {...}; */
export function bundleScript(bundle) {
  return `window.__RAREXT_BUNDLE__ = ${JSON.stringify(bundle)};\n`;
}

/**
 * Write the bundle pair into a mirror tree: `bundle.json` (for the verifiers,
 * which parse it) and `bundle.js` (for the workbench, which cannot fetch a
 * relative file when opened from disk).
 */
export function writeBundleFiles(dir, bundle) {
  writeFileSync(join(dir, "bundle.json"), JSON.stringify(bundle, null, 2));
  writeFileSync(join(dir, "bundle.js"), bundleScript(bundle));
}

/**
 * Put the bundle in front of the workbench: the app answers its reads from the
 * bundle instead of a server, so the bundle must load first.
 *
 * The workbench's built index.html carries the app tag with an absolute path
 * (`/app.js`), and the dev tree publishes document-relative paths, so the
 * caller says what it is looking for and what it wants to end up with:
 * `injectBundleScript(html, { appSrc: "/app.js", newAppSrc: "./app.js" })`.
 * The bundle src is derived from `newAppSrc`, so the two always agree — the
 * divergence this replaces had one tree at `./bundle.js` and the other at
 * `/bundle.js`, each relying on a later pass to reconcile them.
 *
 * A MISS IS LOUD. The previous inline versions used String.replace, which is a
 * silent no-op when the needle is absent: a workbench shipping without its
 * bundle would have looked fine in a build log and only failed in a browser,
 * where it would quietly answer from the network instead of the bundle.
 */
export function injectBundleScript(html, { appSrc, newAppSrc = appSrc }) {
  const needle = `<script type="module" src="${appSrc}"></script>`;
  if (!html.includes(needle)) {
    throw new Error(`injectBundleScript: no ${needle} to put the bundle in front of`);
  }
  const bundleSrc = newAppSrc.replace(/app\.js$/, "bundle.js");
  return html.replace(
    needle,
    `<script src="${bundleSrc}"></script>\n    <script type="module" src="${newAppSrc}"></script>`,
  );
}
