import type {
  Delegation,
  DelegationScope,
  Identity,
  JsonWebKey,
  KeyRotation,
  SignatureSuite,
} from "../../../packages/core/src/index.ts";

import { asPublicKey, keyId, suiteFor, verifyPayload } from "./identity.ts";

const SCOPES = new Set<DelegationScope>(["publish"]);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }

  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value;
}

function timestamp(value: unknown, name: string): string {
  const parsed = text(value, name);

  if (Number.isNaN(Date.parse(parsed))) {
    throw new Error(`${name} must be an ISO timestamp`);
  }

  return parsed;
}

function optionalTimestamp(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;

  return timestamp(value, name);
}

function suite(value: unknown, name: string): SignatureSuite {
  if (value !== "ecdsa-p256" && value !== "ml-dsa-44" && value !== "ml-dsa-65") {
    throw new Error(`${name} must be a supported signature suite`);
  }

  return value;
}

function signature(value: unknown): string {
  return text(value, "signature");
}

function publicKeyFor(value: unknown, name: string): { publicKey: JsonWebKey; algorithm: SignatureSuite; keyId: string } {
  const publicKey = asPublicKey(value);
  const algorithm = suiteFor(publicKey);

  if (!algorithm) throw new Error(`${name} has no supported suite`);

  return { publicKey, algorithm, keyId: keyId(publicKey) };
}

export function asKeyRotation(value: unknown): KeyRotation {
  const input = record(value);
  const from = publicKeyFor(input.fromPublicKey, "fromPublicKey");
  const to = publicKeyFor(input.toPublicKey, "toPublicKey");

  if (text(input.kind, "kind") !== "rarext.key-rotation") {
    throw new Error("kind must be rarext.key-rotation");
  }

  if (input.version !== 1) throw new Error("version must be 1");

  const rotation: KeyRotation = {
    kind: "rarext.key-rotation",
    version: 1,
    handle: text(input.handle, "handle"),
    fromKeyId: text(input.fromKeyId, "fromKeyId"),
    fromPublicKey: from.publicKey,
    fromAlgorithm: suite(input.fromAlgorithm, "fromAlgorithm"),
    toKeyId: text(input.toKeyId, "toKeyId"),
    toPublicKey: to.publicKey,
    toAlgorithm: suite(input.toAlgorithm, "toAlgorithm"),
    createdAt: timestamp(input.createdAt, "createdAt"),
    nonce: text(input.nonce, "nonce"),
    signature: signature(input.signature),
  };

  if (rotation.fromKeyId !== from.keyId) throw new Error("fromKeyId does not match fromPublicKey");
  if (rotation.toKeyId !== to.keyId) throw new Error("toKeyId does not match toPublicKey");
  if (rotation.fromAlgorithm !== from.algorithm) throw new Error("fromAlgorithm does not match fromPublicKey");
  if (rotation.toAlgorithm !== to.algorithm) throw new Error("toAlgorithm does not match toPublicKey");
  if (rotation.fromKeyId === rotation.toKeyId) throw new Error("rotation must change the key");
  if (rotation.nonce.length < 8 || rotation.nonce.length > 128) {
    throw new Error("nonce must be between 8 and 128 characters");
  }

  return rotation;
}

export interface KeyCheck {
  ok: boolean;
  reason: string | null;
}

export function verifyKeyRotation(rotation: KeyRotation, identity: Identity): KeyCheck {
  if (rotation.handle !== identity.handle) {
    return { ok: false, reason: "rotation names a different handle" };
  }

  if (rotation.fromKeyId !== identity.keyId) {
    return { ok: false, reason: "rotation does not start from the current key" };
  }

  if (rotation.fromAlgorithm !== identity.algorithm) {
    return { ok: false, reason: "rotation from-suite does not match the current identity" };
  }

  const { signature: _, ...payload } = rotation;

  if (!verifyPayload(rotation.fromPublicKey, payload, rotation.signature)) {
    return { ok: false, reason: "rotation signature is not valid" };
  }

  return { ok: true, reason: null };
}

export function asDelegation(value: unknown): Delegation {
  const input = record(value);
  const delegate = publicKeyFor(input.delegatePublicKey, "delegatePublicKey");

  if (text(input.kind, "kind") !== "rarext.delegation") {
    throw new Error("kind must be rarext.delegation");
  }

  if (input.version !== 1) throw new Error("version must be 1");

  if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
    throw new Error("scopes must be a non-empty array");
  }

  for (const scope of input.scopes) {
    if (!SCOPES.has(scope as DelegationScope)) {
      throw new Error(`unknown delegation scope: ${String(scope)}`);
    }
  }

  const app = input.app === null || input.app === undefined ? null : text(input.app, "app");
  const expiresAt = optionalTimestamp(input.expiresAt, "expiresAt");

  if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) {
    throw new Error("expiresAt must be in the future");
  }

  const delegation: Delegation = {
    kind: "rarext.delegation",
    version: 1,
    handle: text(input.handle, "handle"),
    rootKeyId: text(input.rootKeyId, "rootKeyId"),
    delegateKeyId: text(input.delegateKeyId, "delegateKeyId"),
    delegatePublicKey: delegate.publicKey,
    algorithm: suite(input.algorithm, "algorithm"),
    scopes: [...new Set(input.scopes as DelegationScope[])],
    app,
    createdAt: timestamp(input.createdAt, "createdAt"),
    expiresAt,
    nonce: text(input.nonce, "nonce"),
    signature: signature(input.signature),
  };

  if (delegation.rootKeyId === delegation.delegateKeyId) {
    throw new Error("a delegation must name a different key");
  }

  if (delegation.delegateKeyId !== delegate.keyId) {
    throw new Error("delegateKeyId does not match delegatePublicKey");
  }

  if (delegation.algorithm !== delegate.algorithm) {
    throw new Error("algorithm does not match delegatePublicKey");
  }

  if (delegation.nonce.length < 8 || delegation.nonce.length > 128) {
    throw new Error("nonce must be between 8 and 128 characters");
  }

  return delegation;
}

export function verifyDelegation(
  delegation: Delegation,
  identity: Identity,
  now = Date.now(),
): KeyCheck {
  if (delegation.handle !== identity.handle) {
    return { ok: false, reason: "delegation names a different handle" };
  }

  if (delegation.rootKeyId !== identity.keyId) {
    return { ok: false, reason: "delegation root is not the current key" };
  }

  if (!delegation.scopes.includes("publish")) {
    return { ok: false, reason: "delegation does not allow publishing" };
  }

  if (delegation.expiresAt !== null && Date.parse(delegation.expiresAt) <= now) {
    return { ok: false, reason: "delegation has expired" };
  }

  const { signature: _, ...payload } = delegation;

  if (!verifyPayload(identity.publicKey, payload, delegation.signature)) {
    return { ok: false, reason: "delegation signature is not valid" };
  }

  return { ok: true, reason: null };
}
