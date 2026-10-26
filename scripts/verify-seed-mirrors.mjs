// Check the published seed's federation promise against the live network: the
// seed must name at least TWO distinct locations, and every location it names
// must serve a copy that rebuilds the pinned root.
//
// One location listed twice is not a mirror list, and a client that fails over
// between copies of the same bytes has failed over to nothing. This is the
// check that keeps the seed honest as copies are added and removed.
//
// Usage: node scripts/verify-seed-mirrors.mjs [seed-url]
// Exits non-zero if fewer than two distinct locations are named, or if none of
// them rebuilds the pinned root. A location that is merely unreachable is
// reported but does not fail the run while another location verifies — mirrors
// exist to be redundant.

import { verifyBundle } from "../apps/api/src/bundle.ts";
import { cidV1Raw } from "../apps/api/src/adapters/content.ts";

const SEED_URL = process.argv[2] ?? "https://999svs999.github.io/RAREXT-protocol/registry/seed.json";
const TIMEOUT_MS = Number(process.env.SEED_TIMEOUT_MS ?? 20_000);

const getJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const getBytes = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

const seed = await getJson(SEED_URL);
const pinned = seed.bundleRoot;
if (typeof pinned !== "string" || !/^[0-9a-f]{64}$/.test(pinned)) {
  console.log(`FAIL the seed at ${SEED_URL} pins no 64-hex root`);
  process.exit(1);
}

const candidates = [];
const seen = new Set();
const add = (bundle, label) => {
  if (typeof bundle !== "string" || bundle.length === 0 || seen.has(bundle)) return;
  seen.add(bundle);
  candidates.push({ bundle, label });
};
add(seed.bundle, "seed.bundle");
for (const [index, mirror] of (seed.mirrors ?? []).entries()) {
  add(mirror?.bundle, `mirrors[${index}]${mirror?.id ? ` (${mirror.id})` : ""}`);
}

console.log(`seed ${SEED_URL}`);
console.log(`  pinned root ${pinned.slice(0, 16)}… · ${candidates.length} distinct location(s)`);

let verified = 0;
const failures = [];
for (const candidate of candidates) {
  try {
    const bytes = await getBytes(candidate.bundle);
    if (typeof seed.bundleCid === "string" && seed.bundleCid.length > 0) {
      const served = cidV1Raw(bytes);
      if (served !== seed.bundleCid) {
        console.log(
          `  ✖ ${candidate.label}: ${candidate.bundle} — serves ${served}, the seed pins ${seed.bundleCid}`,
        );
        failures.push(`${candidate.label}: content address does not match the seed's pin`);
        continue;
      }
    }
    const bundle = JSON.parse(new TextDecoder().decode(bytes));
    const verification = verifyBundle(bundle);
    if (!verification.valid) {
      console.log(`  ✖ ${candidate.label}: ${candidate.bundle} — ${verification.reason}`);
      failures.push(`${candidate.label}: ${verification.reason}`);
      continue;
    }
    if (verification.computedRoot !== pinned) {
      console.log(
        `  ✖ ${candidate.label}: ${candidate.bundle} — rebuilds ${verification.computedRoot?.slice(0, 16)}…, not the pinned root`,
      );
      failures.push(`${candidate.label}: rebuilds a different root`);
      continue;
    }
    verified += 1;
    console.log(
      `  ✔ ${candidate.label}: ${candidate.bundle} — ${verification.publications} publications rebuild the pinned root`,
    );
  } catch (error) {
    console.log(`  · ${candidate.label}: ${candidate.bundle} — unreachable (${error.message})`);
    failures.push(`${candidate.label}: unreachable`);
  }
}

let bad = false;
if (candidates.length < 2) {
  console.log(`FAIL the seed names ${candidates.length} distinct location(s) — a mirror list needs at least two`);
  bad = true;
}
if (verified === 0) {
  console.log(`FAIL no candidate rebuilt the pinned root\n  ${failures.join("\n  ")}`);
  bad = true;
}

if (bad) process.exit(1);
console.log(`OK ${verified} of ${candidates.length} distinct location(s) rebuild the pinned root`);
