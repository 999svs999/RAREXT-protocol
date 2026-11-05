#!/usr/bin/env node
// Ensure every brand in the ecosystem has its OWN signing identity.
//
// "All projects live on RAREXT" means each brand's records are signed by that
// brand — not by one shared key asserting on four brands' behalf. Identities are
// per-brand (handle + keyId), stored 0600 in an ignored directory, and this
// script NEVER prints secret material: only the handle and a keyId prefix, so it
// is safe to run in a report.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url))) + "/";
const sdk = await import(root + "packages/agent-sdk/src/index.ts");
const { generateAgentKeypair, createAgentKeyfile, parseAgentKeyfile } = sdk;

// dir -> brand handle. Kept inside the protocol repo beside .futuristic-identity,
// which is where the publisher already keeps its own.
export const BRAND_IDENTITIES = [
  {    handle: "futuristic", dir: ".futuristic-identity" },
  { handle: "apesdaily", dir: ".apesdaily-identity" },
  { handle: "bapeclub", dir: ".bapeclub-identity" },
  { handle: "rarext", dir: ".rarext-identity" },
  { handle: "saikougoods", dir: ".saikougoods-identity" },
];

export function identityPath(dir) {
  return join(root, dir, "agent-key.json");
}

/** Load or create a brand's identity. Returns public fields only. */
export function ensureIdentity(handle, dir) {
  const path = identityPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  if (!existed) {
    writeFileSync(path, JSON.stringify(createAgentKeyfile(handle, generateAgentKeypair("ecdsa-p256")), null, 1), { mode: 0o600 });
  }
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`${path} has mode ${mode.toString(8)} — refusing to use an identity that is not 0600`);
  }
  const keyfile = parseAgentKeyfile(JSON.parse(readFileSync(path, "utf8")));
  if (keyfile.handle !== handle) {
    throw new Error(`identity at ${path} belongs to "${keyfile.handle}", not "${handle}"`);
  }
  return { handle, dir, keyId: keyfile.keyId, created: !existed, note: "secret never printed" };
}

/**
 * Load a brand's signing identity. Separate from ensureIdentity on purpose:
 * that one returns PUBLIC fields only, so it can be printed safely. This one
 * hands back a signer, and the same 0600 + handle guards apply — a wrong or
 * world-readable key must fail loudly rather than sign as the wrong brand.
 */
export function signerFor(handle, dir) {
  const path = identityPath(dir);
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${path} has mode ${mode.toString(8)} — refusing to sign with it`);
  const keyfile = parseAgentKeyfile(JSON.parse(readFileSync(path, "utf8")));
  if (keyfile.handle !== handle) throw new Error(`identity at ${path} is "${keyfile.handle}", not "${handle}"`);
  return new sdk.AgentSigner(keyfile.privateKey);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const b of BRAND_IDENTITIES) {
    const r = ensureIdentity(b.handle, b.dir);
    console.log(`  ${r.handle.padEnd(11)} keyId ${r.keyId.slice(0, 16)}…  ${r.created ? "CREATED" : "existing"}`);
  }
}
