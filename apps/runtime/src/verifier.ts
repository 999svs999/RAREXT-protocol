import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { verifyDeploymentBody, verifyProviderCardBody, verifyRunBody } from "./transcript.ts";
import type { ModelRunSpec } from "./types.ts";
import {
  MODEL_DEPLOYMENT_ARTIFACT_KIND,
  MODEL_PROVIDER_ARTIFACT_KIND,
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

  const optionalHash = (field: string): string | undefined => {
    const raw = value[field];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || !/^[0-9a-f]{64}$/.test(raw)) {
      throw new Error(`challenge.spec.${field} must be a 64-character sha256 hex digest when present`);
    }
    return raw;
  };

  return {
    deploymentDigest: value.deploymentDigest,
    modelId: value.modelId,
    weightsDigest: (value.weightsDigest as string | null) ?? null,
    engine: value.engine,
    ...(value.bundleDigest === undefined ? {} : { bundleDigest: optionalHash("bundleDigest") }),
    ...(value.shardsRoot === undefined ? {} : { shardsRoot: optionalHash("shardsRoot") }),
    ...(value.manifestHash === undefined ? {} : { manifestHash: optionalHash("manifestHash") }),
    ...(value.quorum === undefined ? {} : { quorum: quorumFromSpec(value.quorum) }),
    ...(value.operators === undefined ? {} : { operators: operatorsFromSpec(value.operators) }),
    ...(value.inferenceBounty === undefined
      ? {}
      : { inferenceBounty: inferenceBountyFromSpec(value.inferenceBounty, value.quorum, value.operators) }),
    ...(value.independence === undefined
      ? {}
      : independenceFromSpec(value.independence, value.quorum, value.operators, value.machines)),
    ...(value.measurements === undefined
      ? {}
      : { measurements: measurementsFromSpec(value.measurements, value.quorum, value.operators) }),
    ...(value.engineFingerprint === undefined
      ? {}
      : { engineFingerprint: optionalHash("engineFingerprint") }),
    ...(value.teeVendor === undefined ? {} : { teeVendor: optionalHash("teeVendor") }),
    ...(value.teeChainDepth === undefined
      ? {}
      : { teeChainDepth: teeChainDepthFromSpec(value.teeChainDepth, value.teeVendor) }),
    ...(value.teeBootStages === undefined
      ? {}
      : { teeBootStages: teeBootStagesFromSpec(value.teeBootStages, value.teeVendor) }),
    ...(value.teeStageMeasurements === undefined
      ? {}
      : { teeStageMeasurements: teeStageMeasurementsFromSpec(value.teeStageMeasurements, value.teeBootStages) }),
    ...(value.teeFreshness === undefined
      ? {}
      : { teeFreshness: teeFreshnessFromSpec(value.teeFreshness, value.teeVendor) }),
    ...(value.teeCodeMeasurement === undefined
      ? {}
      : { teeCodeMeasurement: teeCodeMeasurementFromSpec(value.teeCodeMeasurement, value.teeVendor) }),
    ...(value.teeSignedImage === undefined
      ? {}
      : { teeSignedImage: teeCodeMeasurementFromSpec(value.teeSignedImage, value.teeVendor) }),
    ...(value.teeSignedImageDepth === undefined
      ? {}
      : { teeSignedImageDepth: teeSignedImageDepthFromSpec(value.teeSignedImageDepth, value.teeSignedImage) }),
    ...(value.requireTrace === undefined
      ? {}
      : { requireTrace: requireTraceFromSpec(value.requireTrace) }),
    ...(value.requireReplay === undefined
      ? {}
      : { requireReplay: requireReplayFromSpec(value.requireReplay) }),
  };
}

/** A required replay envelope is a boolean the challenge either commits or not. */
function requireReplayFromSpec(requireReplay: unknown): true {
  if (requireReplay !== true) {
    throw new Error("challenge.spec.requireReplay must be true when present");
  }
  return true;
}

/** A required decode trace is a boolean the challenge either commits or does not. */
function requireTraceFromSpec(requireTrace: unknown): true {
  if (requireTrace !== true) {
    throw new Error("challenge.spec.requireTrace must be true when present");
  }
  return true;
}

/** A minimum image-chain depth only means something with a pinned root to chain to. */
function teeSignedImageDepthFromSpec(depth: unknown, teeSignedImage: unknown): number {
  if (!Number.isSafeInteger(depth) || (depth as number) < 1) {
    throw new Error("challenge.spec.teeSignedImageDepth must be a positive integer when present");
  }
  if (typeof teeSignedImage !== "string" || !/^[0-9a-f]{64}$/.test(teeSignedImage)) {
    throw new Error("challenge.spec.teeSignedImageDepth requires challenge.spec.teeSignedImage");
  }
  return depth as number;
}

/** An approved code measurement needs a pinned root to bind it to. */
function teeCodeMeasurementFromSpec(code: unknown, teeVendor: unknown): string {
  if (typeof code !== "string" || !/^[0-9a-f]{64}$/.test(code)) {
    throw new Error("challenge.spec.teeCodeMeasurement must be a sha256 hex digest when present");
  }
  if (typeof teeVendor !== "string" || !/^[0-9a-f]{64}$/.test(teeVendor)) {
    throw new Error("challenge.spec.teeCodeMeasurement requires challenge.spec.teeVendor");
  }
  return code;
}

/** Freshness only means something with a pinned root to bind the quote to. */
function teeFreshnessFromSpec(freshness: unknown, teeVendor: unknown): "challenge" {
  if (freshness !== "challenge") {
    throw new Error('challenge.spec.teeFreshness must be "challenge" when present');
  }

  if (typeof teeVendor !== "string" || !/^[0-9a-f]{64}$/.test(teeVendor)) {
    throw new Error("challenge.spec.teeFreshness requires challenge.spec.teeVendor");
  }
  return "challenge";
}

/** Approved stage measurements only mean something with named stages to pin. */
function teeStageMeasurementsFromSpec(
  measurements: unknown,
  teeBootStages: unknown,
): Record<string, string> {
  if (typeof measurements !== "object" || measurements === null || Array.isArray(measurements)) {
    throw new Error("challenge.spec.teeStageMeasurements must be an object when present");
  }
  if (!Array.isArray(teeBootStages) || teeBootStages.length === 0) {
    throw new Error("challenge.spec.teeStageMeasurements requires challenge.spec.teeBootStages");
  }
  const record: Record<string, string> = {};
  for (const [stage, measurement] of Object.entries(measurements as Record<string, unknown>)) {
    if (typeof measurement !== "string" || !/^[0-9a-f]{64}$/.test(measurement)) {
      throw new Error("challenge.spec.teeStageMeasurements values must be sha256 hex digests");
    }
    record[stage] = measurement;
  }
  return record;
}

/** Required boot stages only mean something with a pinned root to chain to. */
function teeBootStagesFromSpec(stages: unknown, teeVendor: unknown): string[] {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error("challenge.spec.teeBootStages must be a non-empty array when present");
  }
  if (typeof teeVendor !== "string" || !/^[0-9a-f]{64}$/.test(teeVendor)) {
    throw new Error("challenge.spec.teeBootStages requires challenge.spec.teeVendor");
  }
  return stages.map((stage) => {
    if (typeof stage !== "string" || stage.length === 0) {
      throw new Error("challenge.spec.teeBootStages entries must be non-empty strings");
    }
    return stage;
  });
}

/** A minimum chain depth only means something with a pinned root to chain to. */
function teeChainDepthFromSpec(depth: unknown, teeVendor: unknown): number {
  if (!Number.isSafeInteger(depth) || (depth as number) < 1) {
    throw new Error("challenge.spec.teeChainDepth must be a positive integer when present");
  }
  if (typeof teeVendor !== "string" || !/^[0-9a-f]{64}$/.test(teeVendor)) {
    throw new Error("challenge.spec.teeChainDepth requires challenge.spec.teeVendor");
  }
  return depth as number;
}

/**
 * A measurement allowlist gates which software may count toward the quorum, so
 * it needs a quorum of operators to gate. Each entry is a 64-hex measurement;
 * the verifier then refuses any agreeing provider whose measurement is not on
 * the list.
 */
function measurementsFromSpec(measurements: unknown, quorum: unknown, operators: unknown): string[] {
  if (!Array.isArray(measurements) || measurements.length === 0) {
    throw new Error("challenge.spec.measurements must be a non-empty array when present");
  }
  if (!Number.isSafeInteger(quorum) || (quorum as number) < 1) {
    throw new Error("challenge.spec.measurements requires a committed quorum");
  }
  if (!Array.isArray(operators) || operators.length === 0) {
    throw new Error("challenge.spec.measurements requires committed operators");
  }
  return measurements.map((entry) => {
    if (typeof entry !== "string" || !/^[0-9a-f]{64}$/.test(entry)) {
      throw new Error("challenge.spec.measurements entries must be sha256 hex digests");
    }
    return entry;
  });
}

/**
 * A machine-independence commitment only means something with the operators and
 * the operator-aligned machines to check it against: the run must show that its
 * agreeing providers sat on that many DISTINCT machines. A half-committed spec
 * is refused rather than enforced vacuously.
 */
function independenceFromSpec(
  independence: unknown,
  quorum: unknown,
  operators: unknown,
  machines: unknown,
): { independence: "machine"; machines: string[] } {
  if (independence !== "machine") {
    throw new Error('challenge.spec.independence must be "machine" when present');
  }
  if (!Number.isSafeInteger(quorum) || (quorum as number) < 1) {
    throw new Error("challenge.spec.independence requires a committed quorum");
  }
  if (!Array.isArray(operators) || operators.length === 0) {
    throw new Error("challenge.spec.independence requires committed operators");
  }
  if (!Array.isArray(machines) || machines.length === 0) {
    throw new Error("challenge.spec.independence requires committed machines");
  }
  const list = machines.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error("challenge.spec.machines entries must be non-empty strings");
    }
    return entry;
  });
  if (list.length !== operators.length) {
    throw new Error("challenge.spec.machines must be aligned index-for-index with operators");
  }
  if (new Set(list).size < (quorum as number)) {
    throw new Error("challenge.spec.machines cannot meet the quorum with fewer distinct machines");
  }
  return { independence: "machine", machines: list };
}

/**
 * A payment commitment is only meaningful with the two things it pays over: a
 * quorum to agree on, and operator identities to pay. A challenge that names a
 * bounty without both would let a run claim payments nobody can be held to, so
 * the pair is required together.
 */
function inferenceBountyFromSpec(bounty: unknown, quorum: unknown, operators: unknown): number {
  if (!Number.isSafeInteger(bounty) || (bounty as number) <= 0) {
    throw new Error("challenge.spec.inferenceBounty must be a positive integer when present");
  }
  if (!Number.isSafeInteger(quorum) || (quorum as number) < 1) {
    throw new Error("challenge.spec.inferenceBounty requires a committed quorum");
  }
  if (!Array.isArray(operators) || operators.length === 0) {
    throw new Error("challenge.spec.inferenceBounty requires committed operators");
  }
  return bounty as number;
}

function operatorsFromSpec(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("challenge.spec.operators must be a non-empty array when present");
  }
  const operators = value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error("challenge.spec.operators entries must be non-empty strings");
    }
    return entry;
  });
  if (new Set(operators).size !== operators.length) {
    throw new Error("challenge.spec.operators must not repeat an operator");
  }
  return operators;
}

function quorumFromSpec(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("challenge.spec.quorum must be a positive integer when present");
  }
  return value as number;
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
    (record.kind !== MODEL_RUN_ARTIFACT_KIND &&
      record.kind !== MODEL_DEPLOYMENT_ARTIFACT_KIND &&
      record.kind !== MODEL_PROVIDER_ARTIFACT_KIND)
  ) {
    const message =
      `expected app ${MODEL_RUN_APP} and kind ${MODEL_RUN_ARTIFACT_KIND}, ` +
      `${MODEL_DEPLOYMENT_ARTIFACT_KIND}, or ${MODEL_PROVIDER_ARTIFACT_KIND}`;
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
      : record.kind === MODEL_PROVIDER_ARTIFACT_KIND
        ? verifyProviderCardBody(record.body, spec)
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
        artifactKinds: [
          MODEL_RUN_ARTIFACT_KIND,
          MODEL_DEPLOYMENT_ARTIFACT_KIND,
          MODEL_PROVIDER_ARTIFACT_KIND,
        ],
        manifest: RUNTIME_VERIFIER_MANIFEST,
      },
    ],
  };
}
