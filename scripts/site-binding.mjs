#!/usr/bin/env node
// Read a site's RAREXT binding, and — when the caller names the registry's pinned root —
// say whether the site has actually joined.
//
//   node scripts/site-binding.mjs https://example.com
//   node scripts/site-binding.mjs https://example.com --registry rarext --root <64-hex>
//   node scripts/site-binding.mjs http://127.0.0.1:8080 --allow-private
//
// Two carriers are read, because a site controls different things at different layers:
// /.well-known/rarext.json over HTTPS, and _rarext.<host> TXT over DNS. Either one is
// enough. With no --root there is no verdict and this says so rather than guessing: a
// binding is the site's statement about itself, and a statement about itself is not
// evidence about itself. With --root, the verdict comes from core's verifySiteBinding
// against the root the REGISTRY pins, which is the only thing that can say yes.
//
// Plain `node`, no install: the reader and the rule both resolve inside the tree.

import { readSiteBinding } from "../packages/agent-sdk/src/index.ts";
import { RAREXT_SITE_BINDING_PATH, verifySiteBinding } from "../packages/core/src/index.ts";

const argv = process.argv.slice(2);
const positional = [];
let registry;
let root;
let allowPrivate = false;
let asJson = false;

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--registry") registry = argv[++index];
  else if (arg === "--root") root = argv[++index];
  else if (arg === "--allow-private") allowPrivate = true;
  else if (arg === "--json") asJson = true;
  else if (arg.startsWith("--")) {
    console.error(`unknown option ${arg}`);
    process.exit(2);
  } else positional.push(arg);
}

if (positional.length !== 1) {
  console.error("usage: node scripts/site-binding.mjs <origin> [--registry <id>] [--root <64-hex>] [--allow-private] [--json]");
  process.exit(2);
}

const origin = positional[0].includes("://") ? positional[0] : `https://${positional[0]}`;

const read = await readSiteBinding(origin, { allowPrivate });
const outcome = {
  origin,
  host: read.host,
  file: read.file,
  txt: read.txt,
  notes: read.notes,
  statement: read.parse.ok ? read.parse.binding : null,
  parseError: read.parse.ok ? null : read.parse.reason,
  verdict: null,
  verdictError: null,
};

if (read.parse.ok && typeof root === "string") {
  const verdict = verifySiteBinding(read.parse.binding, {
    pinnedRoot: root,
    ...(typeof registry === "string" ? { expectedRegistry: registry } : {}),
  });
  if (verdict.ok) outcome.verdict = { ok: true, registry: verdict.registry, root: verdict.root };
  else outcome.verdictError = verdict.reason;
}

if (asJson) {
  console.log(JSON.stringify(outcome, null, 2));
  process.exit(outcome.verdictError !== null || !read.parse.ok ? 1 : 0);
}

const carrier = (name, state) => `  ${name.padEnd(34)} ${state}`;
console.log(`site ${origin}`);
console.log(carrier(`${RAREXT_SITE_BINDING_PATH} (file)`, read.file));
console.log(carrier(`_rarext.<host> TXT (record)`, read.txt));
for (const note of read.notes) console.log(`    ${note}`);

if (!read.parse.ok) {
  console.error(`\nNOT A RAREXT BINDING: ${read.parse.reason}`);
  process.exit(1);
}

const binding = read.parse.binding;
console.log(`\nstatement: registry ${binding.registry}, root ${binding.root}`);
if (binding.bundle) console.log(`           bundle ${binding.bundle}`);
if (binding.cid) console.log(`           cid ${binding.cid}`);
if (binding.issuedAt) console.log(`           issuedAt ${binding.issuedAt}`);

if (typeof root !== "string") {
  console.log(
    "\nno --root given, so there is no verdict: this is the site's statement about itself.\n" +
      "Check it against the root its registry pins:\n" +
      `  node scripts/site-binding.mjs ${origin} --registry ${binding.registry} --root <the registry's pinned root>`,
  );
  process.exit(0);
}

if (outcome.verdictError !== null) {
  console.error(`\nNOT JOINED: ${outcome.verdictError}`);
  process.exit(1);
}

console.log(
  `\nJOINED: this site serves ${binding.registry} at the pinned root ${binding.root.slice(0, 16)}… — ` +
    "it keeps its hostname, its certificate and its deployment, and the network can verify its bytes.",
);
process.exit(0);
