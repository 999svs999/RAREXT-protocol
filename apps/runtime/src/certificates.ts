import type { JsonWebKey } from "node:crypto";

import { publicKeyId, verifyPayload } from "../../../packages/agent-sdk/src/index.ts";

export type { JsonWebKey };

/** The suite name a signature uses; the SDK accepts the three it knows. */
type Suite = "ecdsa-p256" | "ml-dsa-44" | "ml-dsa-65";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A certificate in a chain of trust: a statement, signed by `issuer`, that
 * `subject`'s key is vouched for by `issuer`. A chain ends at a trust anchor; a
 * deployment pins that anchor's key id, so an operator-supplied leaf key is not
 * enough on its own — the chain must terminate at the pinned root.
 *
 * This one shape is shared by the machine quote's chain and the image manifest's
 * chain, so "the chain must reach the pinned root" is verified by one function
 * for both. A second implementation would let one of them accept a chain the
 * other refuses.
 */
export interface ProviderCertificate {
  subject: unknown;
  issuer: unknown;
  /** What the subject IS: a boot stage ("firmware"/"os"/"app") when it has one. */
  stage?: string;
  /** The measured value of that stage (a digest), when it has one. */
  measurement?: string;
  signature: string;
  suite: string;
}

/** The exact fields a certificate covers. `stage`/`measurement` only when present. */
export function providerCertificatePayload(cert: ProviderCertificate): {
  subject: unknown;
  issuer: unknown;
  stage?: string;
  measurement?: string;
} {
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    ...(cert.stage === undefined ? {} : { stage: cert.stage }),
    ...(cert.measurement === undefined ? {} : { measurement: cert.measurement }),
  };
}

/** Issue a certificate: `issuerSigner` vouches for `subject`'s key. */
export function issueProviderCertificate(input: {
  subject: unknown;
  issuerSigner: { sign(payload: unknown): string; publicKey: unknown; suite: string };
  stage?: string;
  measurement?: string;
}): ProviderCertificate {
  const subject = input.subject;
  const issuer = input.issuerSigner.publicKey;
  const cert: ProviderCertificate = {
    subject,
    issuer,
    ...(input.stage === undefined ? {} : { stage: input.stage }),
    ...(input.measurement === undefined ? {} : { measurement: input.measurement }),
    signature: "",
    suite: input.issuerSigner.suite,
  };
  cert.signature = input.issuerSigner.sign(providerCertificatePayload(cert));
  return cert;
}

/**
 * The stable identity a response receipt binds: the provider's machine/code/image
 * claim, WITHOUT the volatile parts — the per-run `challenge` nonce, the `issuedAt`
 * timestamp, and the `quote` (which is re-signed for each nonce). The operator then
 * signs "this answer came from THIS enclave", and the digest is the same whether
 * the run recorded the static card or a freshly-challenged attestation, so the
 * verifier recomputes it from what the run holds.
 */
export function attestationForReceipt(independence: unknown): unknown {
  if (typeof independence !== "object" || independence === null || Array.isArray(independence)) {
    return {};
  }
  const source = independence as Record<string, unknown>;
  return {
    kind: source.kind ?? null,
    scheme: source.scheme ?? null,
    machine: source.machine ?? null,
    measurement: source.measurement ?? null,
    code: source.code ?? null,
    image: source.image ?? null,
  };
}

/**
 * Verify a leaf signature and its chain of trust, returning the ROOT key id the
 * chain terminates at. Verifying the leaf's signature is not enough: each
 * certificate must be signed by its issuer, each subject must be the key below
 * it, and the top of the chain is the trust anchor. A deployment pins that
 * anchor's id, so a chain that does not reach the pinned root is refused. A leaf
 * with no chain is its own root (the pre-chain behaviour).
 */
export function verifyCertificateChain(input: {
  leafPublicKey: unknown;
  payload: unknown;
  signature: string;
  suite?: string;
  chain?: unknown;
}): string | null {
  if (!isRecord(input.leafPublicKey)) return null;
  let current = input.leafPublicKey as unknown as JsonWebKey;
  try {
    if (
      !verifyPayload(
        current,
        input.payload,
        input.signature,
        typeof input.suite === "string" ? (input.suite as Suite) : undefined,
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }

  const chain = Array.isArray(input.chain) ? input.chain : [];
  for (const raw of chain) {
    if (
      !isRecord(raw) ||
      !isRecord(raw.subject) ||
      !isRecord(raw.issuer) ||
      typeof raw.signature !== "string"
    ) {
      return null;
    }
    const cert = raw as unknown as ProviderCertificate;
    try {
      // The certificate must be ABOUT the key below it...
      if (publicKeyId(cert.subject as unknown as JsonWebKey) !== publicKeyId(current)) return null;
      // ... and signed by the issuer above it.
      if (
        !verifyPayload(
          cert.issuer as unknown as JsonWebKey,
          providerCertificatePayload(cert),
          cert.signature,
          typeof cert.suite === "string" ? (cert.suite as Suite) : undefined,
        )
      ) {
        return null;
      }
    } catch {
      return null;
    }
    current = cert.issuer as unknown as JsonWebKey;
  }

  return publicKeyId(current);
}
