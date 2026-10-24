import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalize,
  type Artifact,
  type Attestation,
  type Challenge,
  type JsonWebKey,
  type OperatorAttestation,
  type SignatureSuite,
} from "../../../packages/core/src/index.ts";
import { profileFor, suiteFor, verifyPayload } from "./identity.ts";

export const OPERATOR_KIND = "rarext.verifier-operator";
export const OPERATOR_REVOCATION_KIND = "rarext.verifier-operator-revocation";

export interface VerifierOperator {
  kind: typeof OPERATOR_KIND;
  version: 1;
  name: string;
  keyId: string;
  publicKey: JsonWebKey;
  algorithm: SignatureSuite;
  /** Apps this operator may attest for, or `*` for every app. */
  apps: string[];
  url: string | null;
  createdAt: string;
}

export interface SignedOperator {
  operator: VerifierOperator;
  signature: string;
}

export interface OperatorRevocation {
  kind: typeof OPERATOR_REVOCATION_KIND;
  version: 1;
  keyId: string;
  publicKey: JsonWebKey;
  algorithm: SignatureSuite;
  revokedAt: string;
}

export interface SignedOperatorRevocation {
  revocation: OperatorRevocation;
  signature: string;
}

export interface OperatorSigner {
  publicKey: unknown;
  suite: SignatureSuite;
  sign(payload: unknown): string;
}

export interface OperatorAttestationCheck {
  ok: boolean;
  reason: string | null;
  operator: VerifierOperator | null;
}

const HASH = /^[0-9a-f]{64}$/;

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function digest(signed: SignedOperator): string {
  return sha256(signed.operator);
}

export function signOperator(
  input: {
    name: string;
    apps: string[];
    url?: string | null;
    createdAt?: string;
  },
  signer: OperatorSigner,
): SignedOperator {
  const publicKey = signer.publicKey as JsonWebKey;
  const operator: VerifierOperator = {
    kind: OPERATOR_KIND,
    version: 1,
    name: input.name,
    keyId: sha256(publicKey),
    publicKey,
    algorithm: signer.suite,
    apps: [...input.apps],
    url: input.url ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  return { operator, signature: signer.sign(operator) };
}

export function signOperatorRevocation(
  signer: OperatorSigner,
  revokedAt: string = new Date().toISOString(),
): SignedOperatorRevocation {
  const publicKey = signer.publicKey as JsonWebKey;
  const revocation: OperatorRevocation = {
    kind: OPERATOR_REVOCATION_KIND,
    version: 1,
    keyId: sha256(publicKey),
    publicKey,
    algorithm: signer.suite,
    revokedAt,
  };

  return { revocation, signature: signer.sign(revocation) };
}

export function verifyOperatorRevocation(signed: SignedOperatorRevocation): {
  ok: boolean;
  reason: string | null;
} {
  const invalid = (reason: string) => ({ ok: false, reason });
  const revocation = signed?.revocation;

  if (!revocation || typeof revocation !== "object") {
    return invalid("revocation must be an object");
  }
  if (revocation.kind !== OPERATOR_REVOCATION_KIND) {
    return invalid("kind is not an operator revocation");
  }
  if (revocation.version !== 1) return invalid("version is not supported");
  if (typeof signed.signature !== "string") return invalid("signature must be a string");
  if (!revocation.publicKey || typeof revocation.publicKey !== "object") {
    return invalid("publicKey is missing");
  }

  const suite = suiteFor(revocation.publicKey);
  if (!suite || suite !== revocation.algorithm) return invalid("algorithm is not supported");
  if (sha256(revocation.publicKey) !== revocation.keyId) {
    return invalid("keyId does not match the public key");
  }
  if (typeof revocation.revokedAt !== "string" || Number.isNaN(Date.parse(revocation.revokedAt))) {
    return invalid("revokedAt must be an ISO timestamp");
  }
  if (!verifyPayload(revocation.publicKey, revocation, signed.signature, suite)) {
    return invalid("signature does not verify");
  }

  return { ok: true, reason: null };
}

export function verifyOperator(signed: SignedOperator): {
  ok: boolean;
  reason: string | null;
} {
  const invalid = (reason: string) => ({ ok: false, reason });
  const operator = signed?.operator;

  if (!operator || typeof operator !== "object") return invalid("operator must be an object");
  if (operator.kind !== OPERATOR_KIND) return invalid("kind is not a verifier operator");
  if (operator.version !== 1) return invalid("version is not supported");
  if (typeof signed.signature !== "string") return invalid("signature must be a string");
  if (typeof operator.name !== "string" || operator.name.trim().length === 0) {
    return invalid("name is required");
  }
  if (operator.name.length > 80) return invalid("name is too long");
  if (!operator.publicKey || typeof operator.publicKey !== "object") {
    return invalid("publicKey is missing");
  }

  const suite = suiteFor(operator.publicKey);
  if (!suite || suite !== operator.algorithm) return invalid("algorithm is not supported");
  if (sha256(operator.publicKey) !== operator.keyId) {
    return invalid("keyId does not match the public key");
  }

  if (!Array.isArray(operator.apps) || operator.apps.length === 0) {
    return invalid("apps must be a non-empty list");
  }
  if (operator.apps.some((app) => typeof app !== "string" || app.length === 0)) {
    return invalid("every app must be a non-empty string");
  }
  if (new Set(operator.apps).size !== operator.apps.length) {
    return invalid("apps must be unique");
  }

  if (operator.url !== null && !/^https?:\/\/\S+$/.test(operator.url ?? "")) {
    return invalid("url must be http(s) or null");
  }
  if (typeof operator.createdAt !== "string" || Number.isNaN(Date.parse(operator.createdAt))) {
    return invalid("createdAt must be an ISO timestamp");
  }
  if (!verifyPayload(operator.publicKey, operator, signed.signature, suite)) {
    return invalid("signature does not verify");
  }

  return { ok: true, reason: null };
}

export function asSignedOperator(value: unknown): SignedOperator | null {
  if (!value || typeof value !== "object") return null;

  const candidate = value as Partial<SignedOperator>;

  if (!candidate.operator || typeof candidate.operator !== "object") return null;
  if (typeof candidate.signature !== "string") return null;

  return candidate as SignedOperator;
}

export function asSignedOperatorRevocation(value: unknown): SignedOperatorRevocation | null {
  if (!value || typeof value !== "object") return null;

  const candidate = value as Partial<SignedOperatorRevocation>;

  if (!candidate.revocation || typeof candidate.revocation !== "object") return null;
  if (typeof candidate.signature !== "string") return null;

  return candidate as SignedOperatorRevocation;
}

export function asOperatorAttestation(value: unknown): OperatorAttestation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const candidate = value as Partial<OperatorAttestation>;

  if (typeof candidate.keyId !== "string" || !HASH.test(candidate.keyId)) return null;
  if (typeof candidate.signature !== "string") return null;
  if (!candidate.attestation || typeof candidate.attestation !== "object") return null;

  return candidate as OperatorAttestation;
}

/**
 * Checks a signed attestation from an authorised operator against the challenge
 * and the artifact. Nothing here trusts the operator's word about the artifact:
 * the circuit hash must match the bytes being published.
 */
export function verifyOperatorAttestation(
  submission: OperatorAttestation,
  operators: VerifierOperatorRegistry,
  challenge: Challenge,
  artifact: Artifact,
): OperatorAttestationCheck {
  const operator = operators.get(submission.keyId);

  if (!operator) {
    return { ok: false, reason: `unknown verifier operator: ${submission.keyId}`, operator: null };
  }

  if (operators.isRevoked(submission.keyId)) {
    return {
      ok: false,
      reason: `operator ${operator.name} key is revoked`,
      operator,
    };
  }

  if (!operators.authorize(submission.keyId, artifact.app)) {
    return {
      ok: false,
      reason: `operator ${operator.name} is not authorised for app ${artifact.app}`,
      operator,
    };
  }

  const attestation = submission.attestation;

  if (
    attestation.app !== artifact.app ||
    (attestation.challengeId ?? attestation.taskId) !== challenge.id
  ) {
    return { ok: false, reason: "attestation is for another app or challenge", operator };
  }

  if (attestation.circuitHash !== sha256(artifact)) {
    return { ok: false, reason: "attestation is for another artifact", operator };
  }

  if (
    attestation.semanticsId !== challenge.semanticsId ||
    attestation.semanticsVersion !== challenge.semanticsVersion
  ) {
    return { ok: false, reason: "attestation is bound to another semantics record", operator };
  }

  if (attestation.correct !== true) {
    return { ok: false, reason: "operator did not attest that the artifact is correct", operator };
  }

  if (
    !Number.isFinite(attestation.score) ||
    attestation.score < 0 ||
    !Number.isInteger(attestation.gateCount) ||
    attestation.gateCount < 0
  ) {
    return { ok: false, reason: "attestation score or gate count is invalid", operator };
  }

  if (
    attestation.signatureAlgorithm !== operator.algorithm ||
    attestation.cryptoProfile !== profileFor(operator.algorithm)
  ) {
    return { ok: false, reason: "attestation algorithm does not match the operator", operator };
  }

  if (!verifyPayload(operator.publicKey, attestation, submission.signature, operator.algorithm)) {
    return { ok: false, reason: "operator signature does not verify", operator };
  }

  return { ok: true, reason: null, operator };
}

/**
 * Self-registered verifier operators. Registration is permissionless and
 * self-signed; a publication chooses an operator by embedding its key id, and a
 * reader can re-check the attestation without this registry.
 */
export class VerifierOperatorRegistry {
  private readonly directory: string | null;
  private readonly operators = new Map<string, SignedOperator>();
  private readonly revocations = new Set<string>();

  constructor(directory: string | null = null) {
    this.directory = directory;

    if (directory) {
      mkdirSync(directory, { recursive: true });
      this.load();
    }
  }

  private index(): string {
    return join(this.directory!, "operators.json");
  }

  private load(): void {
    if (!existsSync(this.index())) return;

    const parsed = JSON.parse(readFileSync(this.index(), "utf8")) as {
      version?: number;
      operators?: SignedOperator[];
      revoked?: unknown;
    };

    if (parsed.version !== 1 || !Array.isArray(parsed.operators)) return;

    if (Array.isArray(parsed.revoked)) {
      for (const keyId of parsed.revoked) {
        if (typeof keyId === "string" && HASH.test(keyId)) this.revocations.add(keyId);
      }
    }

    for (const signed of parsed.operators) {
      const verified = verifyOperator(signed);

      if (!verified.ok) continue;

      this.operators.set(signed.operator.keyId, signed);
    }
  }

  private save(): void {
    if (!this.directory) return;

    const temporary = `${this.index()}.tmp`;

    writeFileSync(
      temporary,
      JSON.stringify(
        {
          version: 1,
          operators: [...this.operators.values()],
          revoked: [...this.revocations].sort(),
        },
        null,
        2,
      ),
    );
    renameSync(temporary, this.index());
  }

  register(signed: SignedOperator): { status: number; error?: string } {
    const verified = verifyOperator(signed);

    if (!verified.ok) return { status: 401, error: verified.reason ?? "invalid operator" };
    if (this.revocations.has(signed.operator.keyId)) {
      return { status: 409, error: "operator key is revoked" };
    }

    const existing = this.operators.get(signed.operator.keyId);

    if (existing) {
      return digest(existing) === digest(signed)
        ? { status: 200 }
        : { status: 409, error: "operator keyId is already registered" };
    }

    this.operators.set(signed.operator.keyId, signed);
    this.save();

    return { status: 201 };
  }

  revoke(signed: SignedOperatorRevocation): { status: number; error?: string } {
    const verified = verifyOperatorRevocation(signed);

    if (!verified.ok) return { status: 401, error: verified.reason ?? "invalid revocation" };

    const keyId = signed.revocation.keyId;

    if (!this.operators.has(keyId)) {
      return { status: 404, error: `unknown verifier operator: ${keyId}` };
    }
    if (this.revocations.has(keyId)) return { status: 200 };

    this.revocations.add(keyId);
    this.save();

    return { status: 200 };
  }

  isRevoked(keyId: string): boolean {
    return this.revocations.has(keyId);
  }

  get(keyId: string): VerifierOperator | null {
    return this.operators.get(keyId)?.operator ?? null;
  }

  list(): VerifierOperator[] {
    return [...this.operators.values()]
      .map((signed) => signed.operator)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  authorize(keyId: string, app: string): VerifierOperator | null {
    if (this.isRevoked(keyId)) return null;

    const operator = this.get(keyId);

    if (!operator) return null;

    return operator.apps.includes("*") || operator.apps.includes(app)
      ? operator
      : null;
  }
}
