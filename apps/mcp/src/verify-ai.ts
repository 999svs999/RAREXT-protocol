import { createHash } from "node:crypto";

import {
  canonicalize,
  verifyAiArtifact,
  type AiLocalVerification,
} from "../../../packages/core/src/index.ts";
import type { Artifact, Challenge } from "../../../packages/core/src/index.ts";

/**
 * Local, trust-minimized AI verification behind the `rarext_verify_ai` MCP
 * verb: the challenge (and with it the committed reference or replay target)
 * is fetched from the registry, but the verdict is computed here from the pure
 * verifier math in core — the server's word is never trusted for the outcome.
 *
 * This lives in its own module because server.ts opens its stdio loop at
 * import time; tests and SDK consumers import from here instead.
 */
export async function verifyAiLocally(
  challengeId: string,
  artifact: Artifact,
  registry: { challenge(id: string): Promise<Challenge> },
): Promise<AiLocalVerification & { modelDigest?: string }> {
  const challenge = await registry.challenge(challengeId);
  const result = verifyAiArtifact(artifact, challenge);

  if ("error" in result) throw new Error(result.error);

  if (result.representation === "generative") {
    const body = artifact.body as { model: unknown };
    return {
      ...result,
      modelDigest: createHash("sha256").update(canonicalize(body.model)).digest("hex"),
    };
  }

  return result;
}
