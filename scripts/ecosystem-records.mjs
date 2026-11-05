#!/usr/bin/env node
// Build the ecosystem's RAREXT records: a structural site record and a name
// binding for each brand.
//
// One ecosystem, not one brand: FUTURISTIC, APESDAILY, BAPECLUB and the protocol
// itself each publish what they are and where they live, signed by their own
// identity. The builders here are PURE and take their page bytes as input — the
// network is a separate, injectable step — because a record's digests must be
// reproducible from the artifact, and anything that fetches cannot be tested.
//
// What a site record does NOT claim: liveness. It commits to what the origin
// served when it was published. Re-fetching later and finding different bytes is
// the normal state of the web, not a failed verification — which is why the
// verifier is structural and the copy in the record says "as published".

import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const root = dirname(dirname(fileURLToPath(import.meta.url))) + "/";

// Imported, never re-declared: a name rule written twice WILL diverge from the
// verifier's, and the failure mode is a record that cannot be anchored.
const { NAME_PATTERN } = await import(root + "apps/api/src/rarext-name.ts");

export const REGISTRY_URL = "https://999svs999.github.io/RAREXT-protocol/registry/bundle.json";
export const MIRROR_URL = "https://999svs999.github.io/RAREXT-protocol/mirror/";
export const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

/** The brands that live on the protocol, and what their records cover. */
export const ECOSYSTEM_BRANDS = [
  {
    handle: "apesdaily",
    app: "apesdaily-site",
    kind: "apesdaily.site.v1",
    name: "apesdaily",
    origin: "https://apesdaily.com/",
    title: "APESDAILY — AI crypto trading technology",
    generator: "apesdaily-site-record",
    identityDir: ".apesdaily-identity",
    // Stable, meaningful surfaces — not asset filenames, which change per deploy.
    // /.well-known/agent.json is written but not yet deployed; a record may only
    // list paths the origin SERVES, so it joins this list on the first deploy.
    pages: ["/", "/launchpad", "/developers", "/robots.txt", "/llms.txt"],
    note: "apesdaily — AI crypto trading technology: verifiable tooling for traders who would rather see the invariant than the promise.",
  },
  {
    handle: "bapeclub",
    app: "bapeclub-site",
    kind: "bapeclub.site.v1",
    name: "bapeclub",
    origin: "https://bapeclub.app/",
    title: "BAPECLUB — private members club",
    generator: "bapeclub-site-record",
    identityDir: ".bapeclub-identity",
    pages: ["/", "/robots.txt"],
    note: "bapeclub — the private members club. This record covers the club surface only; the Shopify storefront is a separate property and is not claimed.",
  },
  {
    handle: "saikougoods",
    app: "saikougoods-site",
    kind: "saikougoods.site.v1",
    name: "saikougoods",
    origin: "https://saikougoods.pages.dev/",
    title: "最高選物 — Saikou_Goods · curated consignment",
    generator: "saikougoods-site-record",
    identityDir: ".saikougoods-identity",
    pages: ["/"],
    note: "saikougoods — 最高選物, curated streetwear/luxury/jewelry consignment. The catalogue is the operator's own Grailed wardrobe; this record pins the storefront, not the marketplace.",
  },
  {
    handle: "rarext",
    app: "rarext-site",
    kind: "rarext.site.v1",
    name: "rarext",
    origin: "https://rarext-com.pages.dev/",
    title: "RAREXT — the protocol the ecosystem publishes on",
    generator: "rarext-site-record",
    identityDir: ".rarext-identity",
    pages: ["/"],
    note: "rarext — the protocol itself, alongside the registry bundle it publishes.",
  },
];

/** A structural site record body, exactly as the verifier requires it. */
export function siteRecordBody({ origin, title, generator, pages, media = [], revision = null, publishedAt = null }) {
  if (typeof origin !== "string" || !origin.startsWith("https://")) {
    throw new Error("origin must be an https URL");
  }
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error("a site record needs at least one page");
  }
  const body = {
    site: origin,
    title,
    published_at: publishedAt ?? new Date().toISOString(),
    generator,
    pages: pages.map((p) => ({ path: p.path, sha256: p.sha256, bytes: p.bytes })),
  };
  if (revision) body.revision = revision;
  if (media.length) body.media = media.map((m) => ({ url: m.url, sha256: m.sha256, bytes: m.bytes }));
  return body;
}

/**
 * Turn fetched bytes into page entries. `fetched` is [{path, sha256?, bytes?}]
 * where each entry may carry its raw body instead, so the caller owns the network
 * and this stays deterministic.
 */
export function pagesFrom(fetched) {
  return fetched.map((f) => {
    if (f.body !== undefined) {
      const buf = Buffer.isBuffer(f.body) ? f.body : Buffer.from(f.body);
      return { path: f.path, sha256: sha256Hex(buf), bytes: buf.length };
    }
    if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) {
      throw new Error(`page ${f.path} needs a sha256 digest`);
    }
    return { path: f.path, sha256: f.sha256, bytes: f.bytes };
  });
}

/** A name binding body, exactly as the name verifier requires it. */
export function nameRecordBody({ name, identityKey, targets, note }) {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new Error(`name "${name}" must be lowercase alphanumerics/dashes, 2..64 chars`);
  }
  if (!/^[0-9a-f]{64}$/.test(identityKey)) {
    throw new Error("identityKey must be 64 lowercase hex chars");
  }
  if (!Array.isArray(targets) || targets.length < 1) {
    throw new Error("a name binding needs at least one target");
  }
  const body = { name, identityKey, targets };
  if (note !== undefined) {
    if (typeof note !== "string" || note.length > 280) throw new Error("note must be ≤280 chars");
    body.note = note;
  }
  return body;
}

/** The targets a brand's name resolves to: where it lives and what it publishes. */
export function targetsFor(brand) {
  const targets = [
    { kind: "site", url: brand.origin },
    { kind: "registry", url: REGISTRY_URL },
  ];
  if (brand.handle === "bapeclub") {
    targets.push({ kind: "gallery", url: "https://bapeclub.app/" });
  } else if (brand.handle === "rarext") {
    targets.push({ kind: "mirror", url: MIRROR_URL });
  } else {
    targets.push({ kind: "gallery", url: brand.origin.replace(/\/$/, "") + "/launchpad" });
  }
  return targets;
}

/** Fetch a brand's pages. The only network-touching function here. */
export async function fetchBrandPages(brand, fetchImpl = fetch) {
  const fetched = [];
  for (const path of brand.pages) {
    const url = new URL(path.replace(/^\//, ""), brand.origin).toString();
    const res = await fetchImpl(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    fetched.push({ path, body: Buffer.from(await res.arrayBuffer()) });
  }
  return fetched;
}

/**
 * Classify an ecosystem publish failure: skippable means THAT BRAND's records are
 * left out this pass — a structural rejection, or its live site being unreadable —
 * while the rest of the ecosystem and FUTURISTIC still anchor. Everything else
 * (signing, attestation integrity, the API refusing a valid record) aborts, the
 * same rule the FUTURISTIC loop follows. One brand's blip must never jam the
 * whole pass: that failure mode already cost the registry a night of failed ships.
 */
export function isSkippableEcosystemError(err) {
  const msg = String(err?.message ?? err);
  return (
    msg.includes("failed structural checks") ||
    msg.includes("live site unreadable") ||
    /HTTP \d+/.test(msg) ||
    msg.includes("fetch failed")
  );
}

/** Build ONE brand's records: its site record and its name binding. */
export async function buildBrandRecords(brand, keyId, { fetchImpl = fetch, publishedAt = null } = {}) {
  if (!keyId) throw new Error(`no identity for ${brand.handle}`);
  const site = siteRecordBody({
    origin: brand.origin,
    title: brand.title,
    generator: brand.generator,
    pages: pagesFrom(await fetchBrandPages(brand, fetchImpl)),
    publishedAt,
  });
  const name = nameRecordBody({
    name: brand.name,
    identityKey: keyId,
    targets: targetsFor(brand),
    note: brand.note,
  });
  return { brand: brand.handle, app: brand.app, kind: brand.kind, site, name };
}

/** Build every ecosystem record. Returns bodies only — signing happens later. */
export async function buildEcosystemRecords({ identities, fetchImpl = fetch, publishedAt = null, only = null } = {}) {
  const out = [];
  for (const brand of ECOSYSTEM_BRANDS) {
    if (only && brand.handle !== only) continue;
    out.push(await buildBrandRecords(brand, identities?.[brand.handle], { fetchImpl, publishedAt }));
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const which = process.argv[2];
  const { ensureIdentity, BRAND_IDENTITIES } = await import(root + "scripts/ecosystem-identities.mjs");
  const identities = {};
  for (const b of BRAND_IDENTITIES) identities[b.handle] = ensureIdentity(b.handle, b.dir).keyId;
  const records = await buildEcosystemRecords({ identities, only: which ?? null });
  for (const r of records) {
    if (which && r.brand !== which) continue;
    console.log(`${r.brand}: ${r.site.pages.length} page(s), name "${r.name.name}"`);
    for (const p of r.site.pages) console.log(`    ${p.path.padEnd(28)} ${p.bytes} bytes  ${p.sha256.slice(0, 12)}…`);
  }
}
