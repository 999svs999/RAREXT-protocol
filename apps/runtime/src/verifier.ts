import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { verifyDeploymentBody, verifyRunBody } from "./transcript.ts";
import type { ModelRunSpec } from "./types.ts";
import {
  MODEL_DEPLOYMENT_ARTIFACT_KIND,
  MODEL_RUN_APP,
  MODEL_RUN_ARTIFACT_KIND,
  RUNTIME_VERSION,
} from "./types.ts";

export const RUNTIME_VERIFIER_NAME = "rarext-model-run-exact";
export const RUNTIME_VERIFIER_VERSION = "1";

export interface VerifierManifest {
  app: string;
  name: string;
  version: string;
  algorithm: string;
  representation: "exact";
  runtime: string;
}

export const RUNTIME_VERIFIER_MANIFEST: VerifierManifest = {
  app: MODEL_RUN_APP,
  name: RUNTIME_VERIFIER_NAME,
  version: RUNTIME_VERIFIER_VERSION,
  algorithm: "canonical-transcript-sha256",
  representation: "exact",
  runtime: RUNTIME_VERSION,
};

export function runSpecFromChallenge(challenge: unknown): ModelRunSpec {
  if (typeof challenge !== "object" || challenge === null) {
    throw new Error("challenge must be an object");
  }
  const spec = (challenge as { spec?: unknown }).spec;
  if (typeof spec !== "object" || spec === null) {
    throw new Error("challenge.spec must be an object");
  }
  const value = spec as Record<string, unknown>;

  if (typeof value.deploymentDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.deploymentDigest)) {
    throw new Error("challenge.spec.deploymentDigest must be a 64-character sha256 hex digest");
  }
  if (typeof value.modelId !== "string" || value.modelId.length === 0) {
    throw new Error("challenge.spec.modelId must be a non-empty string");
  }
  if (value.weightsDigest !== null && typeof value.weightsDigest !== "string") {
    throw new Error("challenge.spec.weightsDigest must be a string or null");
  }
  if (
    value.engine !== "ollama" &&
    value.engine !== "strata" &&
    value.engine !== "freetoken" &&
    value.engine !== "openai-compatible" &&
    value.engine !== "anthropic"
  ) {
    throw new Error("challenge.spec.engine must name a supported engine");
  }

  return {
    deploymentDigest: value.deploymentDigest,
    modelId: value.modelId,
    weightsDigest: (value.weightsDigest as string | null) ?? null,
    engine: value.engine,
  };
}

export interface VerificationReply {
  correct: boolean;
  score: number;
  gateCount: number;
  proof: unknown;
  details: unknown;
  representation: "exact";
  manifest: VerifierManifest;
  error?: string;
}

/**
 * The verifier RAREXT calls, or that anyone can call. It recomputes the
 * transcript's digests itself; it never trusts a digest carried by the body.
 */
export function verifyModelRunArtifact(artifact: unknown, challenge: unknown): VerificationReply {
  const gateCount = 0;

  if (typeof artifact !== "object" || artifact === null) {
    return {
      correct: false,
      score: 0,
      gateCount,
      proof: null,
      details: { error: "artifact must be an object" },
      representation: "exact",
      manifest: RUNTIME_VERIFIER_MANIFEST,
      error: "artifact must be an object",
    };
  }

  const record = artifact as Record<string, unknown>;
  if (
    record.app !== MODEL_RUN_APP ||
    (record.kind !== MODEL_RUN_ARTIFACT_KIND && record.kind !== MODEL_DEPLOYMENT_ARTIFACT_KIND)
  ) {
    const message =
      `expected app ${MODEL_RUN_APP} and kind ${MODEL_RUN_ARTIFACT_KIND} or ${MODEL_DEPLOYMENT_ARTIFACT_KIND}`;
    return {
      correct: false,
      score: 0,
      gateCount,
      proof: null,
      details: { error: message },
      representation: "exact",
      manifest: RUNTIME_VERIFIER_MANIFEST,
      error: message,
    };
  }

  let spec: ModelRunSpec;
  try {
    spec = runSpecFromChallenge(challenge);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      correct: false,
      score: 0,
      gateCount,
      proof: null,
      details: { error: message },
      representation: "exact",
      manifest: RUNTIME_VERIFIER_MANIFEST,
      error: message,
    };
  }

  const verification =
    record.kind === MODEL_DEPLOYMENT_ARTIFACT_KIND
      ? verifyDeploymentBody(record.body, spec)
      : verifyRunBody(record.body, spec);

  return {
    correct: verification.correct,
    score: verification.score,
    gateCount: verification.details.checks.length,
    proof: verification.proof,
    details: verification.details,
    representation: "exact",
    manifest: RUNTIME_VERIFIER_MANIFEST,
    ...(verification.error === undefined ? {} : { error: verification.error }),
  };
}

function readBody(request: IncomingMessage, limit = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`request body above ${limit} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

/** A tiny HTTP verifier speaking the RAREXT external-verifier ABI. */
export function createVerifierServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, ...RUNTIME_VERIFIER_MANIFEST });
        return;
      }

      if (request.method === "GET" && url.pathname === "/manifest") {
        sendJson(response, 200, RUNTIME_VERIFIER_MANIFEST);
        return;
      }

      if (request.method === "POST" && url.pathname === "/verify") {
        const payload = JSON.parse(await readBody(request)) as {
          artifact?: unknown;
          challenge?: unknown;
        };
        const result = verifyModelRunArtifact(payload.artifact, payload.challenge);
        sendJson(response, 200, result);
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** The verifier config an operator drops into RAREXT_VERIFIERS. */
export function verifierConfig(url: string) {
  return {
    verifiers: [
      {
        app: MODEL_RUN_APP,
        name: "RAREXT model-run transcript",
        version: RUNTIME_VERIFIER_VERSION,
        description:
          "Recomputes a deployment manifest's digest or every digest in a model-run transcript, and checks it against the deployment the challenge committed.",
        url,
        artifactKinds: [MODEL_RUN_ARTIFACT_KIND, MODEL_DEPLOYMENT_ARTIFACT_KIND],
        manifest: RUNTIME_VERIFIER_MANIFEST,
      },
    ],
  };
}
