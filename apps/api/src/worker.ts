import { createPublicKey, verify } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type { JsonWebKey } from "../../../packages/core/src/index.ts";

import { submissionDigest, type VerificationSubmission } from "./work.ts";

/**
 * A worker's signature over its submission.
 *
 * The worker signs the digest of what it did, so the registry can attribute
 * the work to a key and nobody can hand someone else's work in.
 */
export function verifyWorkerSignature(
  submission: VerificationSubmission,
): boolean {
  try {
    const key = createPublicKey({
      key: submission.worker.publicKey as JsonWebKey,
      format: "jwk",
    });

    return verify(
      "sha256",
      Buffer.from(submissionDigest(submission), "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(submission.worker.signature, "base64"),
    );
  } catch {
    return false;
  }
}
