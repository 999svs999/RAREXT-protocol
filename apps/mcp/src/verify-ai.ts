import type { Artifact, Challenge } from "../../../packages/core/src/index.ts";
import {
  isBoundedBody,
  isBoundedSpec,
  verifyBoundedReconstruction,
} from "../../api/src/bounded.ts";
import {
  isGenerativeBody,
  isGenerativeSpec,
  modelDigest,
  verifyGenerativeReplay,
} from "../../api/src/generative.ts";

/**
 * Local, trust-minimized AI verification behind the `rarext_verify_ai` MCP
 * verb: the challenge (and with it the committed reference or replay target)
 * is fetched from the registry, but the verdict is computed here from the pure
 * verifier math — the server's word is never trusted for the outcome.
 *
 * This lives in its own module because server.ts opens its stdio loop at
 * import time; tests and SDK consumers import from here instead.
 */
export async function verifyAiLocally(
  challengeId: string,
  artifact: Artifact,
  registry: { challenge(id: string): Promise<Challenge> },
): Promise<Record<string, unknown>> {
  const challenge = await registry.challenge(challengeId);

  if (artifact.app === "ai-generative" && artifact.kind === "ai.generative") {
    if (!isGenerativeBody(artifact.body)) {
      throw new Error("ai.generative artifact body must be { model, seed, output }");
    }
    if (!isGenerativeSpec(challenge.spec)) {
      throw new Error(`challenge ${challengeId} is not a generative task`);
    }

    const replay = verifyGenerativeReplay(artifact.body, challenge.spec);
    return {
      representation: "generative",
      correct: replay.correct,
      modelDigest: modelDigest(artifact.body.model),
      seed: artifact.body.seed,
      steps: challenge.spec.steps,
    };
  }

  if (artifact.app === "ai-bounded" && artifact.kind === "ai.bounded") {
    if (!isBoundedBody(artifact.body)) {
      throw new Error("ai.bounded artifact body must be { values: number[] }");
    }
    if (!isBoundedSpec(challenge.spec)) {
      throw new Error(`challenge ${challengeId} is not a bounded task`);
    }

    const check = verifyBoundedReconstruction(artifact.body, challenge.spec);
    if ("error" in check) throw new Error(check.error);

    const spec = challenge.spec as { metric: string; bound: number };
    return {
      representation: "bounded",
      correct: check.correct,
      metricName: spec.metric,
      metricValue: check.metricValue,
      bound: spec.bound,
    };
  }

  throw new Error(`rarext_verify_ai does not support artifact kind: ${artifact.kind}`);
}
