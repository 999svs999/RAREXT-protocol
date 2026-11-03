#!/usr/bin/env node
// Resolve a RAREXT human name — `rar.futuristic`, `futuristic.rar`, `rr.futuristic`,
// `@futuristic` or bare `futuristic` — and say what was verified or refused.
//
//   node scripts/resolve-name.mjs rar.futuristic
//   node scripts/resolve-name.mjs futuristic.rar --json
//   node scripts/resolve-name.mjs futuristic --bundle https://example.com/registry/bundle.json
//
// A name binds to an IDENTITY KEY, never to a root: anchoring `name -> root`
// would change the root it names, so no fixed point exists. Resolution therefore
// reads the name record out of a VERIFIED bundle (an unverified bundle is never
// resolved from), checks that the claiming key is the key that signed the record,
// and hands back the targets. If two records claim one name under different keys
// that is a collision and it is refused — never silently picked from.
//
// Plain `node`, no install. Exit 0 resolved, 1 not resolved, 2 usage error.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const DEFAULT_BUNDLE = "https://999svs999.github.io/RAREXT-protocol/registry/bundle.json";
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const argv = process.argv.slice(2);
let bundleUrl = DEFAULT_BUNDLE;
let asJson = false;
let raw = null;

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--bundle") bundleUrl = argv[++index] ?? "";
  else if (arg === "--json") asJson = true;
  else if (arg.startsWith("--")) {
    console.error(`unknown option ${arg}`);
    process.exit(2);
  } else if (raw === null) raw = arg;
  else {
    console.error("exactly one name is resolved per run");
    process.exit(2);
  }
}

if (raw === null || !bundleUrl) {
  console.error("usage: resolve-name.mjs <rar.<name> | <name>.rar | rr.<name> | @<name> | <name>> [--bundle <url>] [--json]");
  process.exit(2);
}

// Accept every form the operator asked for, and reduce each to the bare name.
const stripped = raw
  .replace(/^@/, "")
  .replace(/\.rar$/i, "")
  .replace(/^(?:rar|rarext|rr)\./i, "")
  .toLowerCase();
const name = stripped.trim();
if (!NAME_PATTERN.test(name)) {
  console.error(`not a resolvable name: ${raw} -> ${name || "(empty)"}`);
  process.exit(2);
}

const { verifyBundle } = await import(join(root, "apps/api/src/bundle.ts"));

function fail(outcome) {
  if (asJson) console.log(JSON.stringify(outcome, null, 2));
  else console.error(`✗ ${outcome.error}`);
  process.exit(1);
}

let bundle;
try {
  const res = await fetch(bundleUrl, { cache: "no-store" });
  if (!res.ok) fail({ resolved: null, error: `bundle fetch ${res.status} from ${bundleUrl}`, name });
  bundle = await res.json();
} catch (error) {
  fail({ resolved: null, error: `bundle unreachable: ${error?.message ?? error}`, name });
}

const verdict = await verifyBundle(bundle);
if (!verdict.valid) {
  fail({ resolved: null, error: `bundle does not verify: ${verdict.reason ?? "no reason given"}`, name, root: bundle?.manifest?.root ?? null });
}

const records = (bundle.publications ?? []).filter(
  (p) => p.artifact?.app === "rarext-name" && p.artifact?.body?.name === name,
);
if (records.length === 0) {
  fail({ resolved: null, error: `no record claims the name "${name}"`, root: bundle.manifest.root, name });
}

const keys = [...new Set(records.map((r) => r.authorKey))];
if (keys.length > 1) {
  fail({
    resolved: null,
    error: `name collision: ${records.length} records claim "${name}" under ${keys.length} different keys`,
    name,
    keys,
    root: bundle.manifest.root,
  });
}

const record = records[records.length - 1];
const body = record.artifact.body;
if (body.identityKey !== record.authorKey) {
  fail({
    resolved: null,
    error: "the record's identityKey does not match the key that signed it",
    name,
    identityKey: body.identityKey,
    authorKey: record.authorKey,
    root: bundle.manifest.root,
  });
}

const outcome = {
  resolved: {
    name,
    forms: [`rar.${name}`, `${name}.rar`, `rr.${name}`, `@${name}`, name],
    identityKey: record.authorKey,
    targets: body.targets,
    note: body.note ?? null,
    publicationId: record.id,
    root: bundle.manifest.root,
    bundle: bundleUrl,
    verified: true,
  },
  error: null,
};

if (asJson) console.log(JSON.stringify(outcome, null, 2));
else {
  const o = outcome.resolved;
  console.log(`✓ ${name} resolved (bundle verified, root ${o.root.slice(0, 16)}…)`);
  console.log(`  identity : ${o.identityKey}`);
  for (const t of o.targets) console.log(`  ${t.kind.padEnd(8)} : ${t.url}`);
  console.log(`  forms    : ${o.forms.join("  ")}`);
}
process.exit(0);
