// Check the published seed's federation promise against the live network: the
// seed must name at least TWO distinct locations, and every location it names
// must serve a copy that rebuilds the pinned root. Every PIN the seed records
// must also resolve to the bundle's content address.
//
// One location listed twice is not a mirror list, and a client that fails over
// between copies of the same bytes has failed over to nothing. This is the
// check that keeps the seed honest as copies are added and removed.
//
// Usage: node scripts/verify-seed-mirrors.mjs [seed-url]
// Exits non-zero if fewer than two distinct locations are named, or if none of
// them rebuilds the pinned root. A location that is merely unreachable is
// reported but does not fail the run while another location verifies — mirrors
// exist to be redundant, and so do pins: a pin that does not resolve, serves
// other bytes, or disagrees with the seed's `bundleCid` is reported as a
// failing pin, one line per pin, and is not fatal while a location verifies.

import { pathToFileURL } from "node:url";

import { verifyBundle } from "../apps/api/src/bundle.ts";
import { cidV1Raw } from "../apps/api/src/adapters/content.ts";

const SEED_URL = "https://999svs999.github.io/RAREXT-protocol/registry/seed.json";
const TIMEOUT_MS = Number(process.env.SEED_TIMEOUT_MS ?? 20_000);

const getJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

export const getBytes = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

/**
 * Where a recorded pin is fetched from. A reference that is already a URL is
 * fetched as it was recorded; anything else — the local `cid:<cid>` the pinning
 * call writes, or a service's own `pin:<cid>` — resolves through the service
 * the pin names, as `${service}/${cid}`. Null means the entry names nowhere to
 * read from, which is a failing pin rather than a skipped one.
 */
export function pinUrl(pin) {
  if (typeof pin?.reference === "string" && /^https?:\/\//.test(pin.reference)) {
    return pin.reference;
  }
  if (typeof pin?.service === "string" && pin.service.length > 0 && typeof pin?.cid === "string") {
    return `${pin.service.replace(/\/+$/, "")}/${pin.cid}`;
  }
  return null;
}

/**
 * One seed pin against the bundle the seed pins: fetch it, hash what came back
 * with the same CIDv1 the publisher computed, and require the result to agree
 * with BOTH the pin's own `cid` and the seed's `bundleCid`. A pin that fails
 * any of that returns `ok: false` with the reason — reported like a location
 * line, never silently dropped.
 */
export async function checkPin(pin, seed, fetchBytes = getBytes) {
  const cid = typeof pin?.cid === "string" && pin.cid.length > 0 ? pin.cid : null;
  if (!cid) return { ok: false, reason: "names no content address" };

  if (typeof pin.error === "string") {
    return { ok: false, reason: `the publish recorded an error: ${pin.error}` };
  }

  const url = pinUrl(pin);
  if (!url) return { ok: false, reason: "names no service or URL to fetch it from" };

  try {
    const bytes = await fetchBytes(url);
    const served = cidV1Raw(bytes);
    if (served !== cid) {
      return { ok: false, reason: `${url} — serves ${served}, the pin says ${cid}` };
    }
    const pinned = typeof seed?.bundleCid === "string" ? seed.bundleCid : "";
    if (pinned.length > 0 && cid !== pinned) {
      return { ok: false, reason: `${url} — resolves ${cid}, but the seed pins ${pinned}` };
    }
    return { ok: true, url, reason: `${url} — serves the bundle's content address` };
  } catch (error) {
    return { ok: false, reason: `${url} — did not resolve (${error.message})` };
  }
}

async function main() {
  const seedUrl = process.argv[2] ?? SEED_URL;
  const seed = await getJson(seedUrl);
  const pinned = seed.bundleRoot;
  if (typeof pinned !== "string" || !/^[0-9a-f]{64}$/.test(pinned)) {
    console.log(`FAIL the seed at ${seedUrl} pins no 64-hex root`);
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

  console.log(`seed ${seedUrl}`);
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

  // Every pin the publish recorded, resolved and hashed the same way a mirror
  // copy is: one line per pin, and a failing pin is reported rather than fatal,
  // because pins are redundant with the locations above, not a replacement.
  const pins = (Array.isArray(seed.pins) ? seed.pins : []).filter(
    (pin) => pin !== null && typeof pin === "object",
  );
  let pinVerified = 0;
  if (pins.length === 0) {
    console.log(`  · pins: the seed records none (the publish had no pinning service configured)`);
  }
  for (const [index, pin] of pins.entries()) {
    const result = await checkPin(pin, seed);
    if (result.ok) {
      pinVerified += 1;
      console.log(`  ✔ pins[${index}]: ${result.reason}`);
    } else {
      console.log(`  ✖ pins[${index}]: ${result.reason}`);
      failures.push(`pins[${index}]: ${result.reason}`);
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
  const pinSummary =
    pins.length === 0
      ? ""
      : ` · ${pinVerified} of ${pins.length} pin(s) match the bundle's content address` +
        (pinVerified === pins.length ? "" : ` (${pins.length - pinVerified} failing)`);
  console.log(`OK ${verified} of ${candidates.length} distinct location(s) rebuild the pinned root${pinSummary}`);
}

// The pin check is exported for the tests; the network run happens only when
// this file is the script being executed, not when it is imported.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
