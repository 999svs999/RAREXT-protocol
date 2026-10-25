import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { canonicalize, score } from "../../../packages/core/src/index.ts";
import type {
  AppInfo,
  Artifact,
  Attestation,
  Challenge,
  Circuit,
  ClaimKind,
  ClaimScope,
  Task,
  VerificationOutput,
} from "../../../packages/core/src/index.ts";
import { attest } from "./attest.ts";
import { boundedVerifier } from "./bounded.ts";
import { generativeVerifier } from "./generative.ts";
import {
  bindClaim,
  hashValue,
  logicVerifierHash,
  semanticsForChallenge,
  type ClaimOptions,
  type SemanticsRegistry,
} from "./semantics.ts";

const LOGIC_APP = "logic";
const LOGIC_KIND = "logic.netlist";

export interface AppVerifier extends AppInfo {
  supports(artifact: Artifact, challenge: Challenge): boolean;
  verify(artifact: Artifact, challenge: Challenge): Promise<Attestation>;
}

export interface ExternalVerifierConfig {
  app: string;
  name?: string;
  version?: string;
  description?: string;
  url: string;
  artifactKinds?: string[];
  manifest?: unknown;
}

export interface VerifierRegistryOptions {
  /** Timeout for one external verifier request, including its response body. */
  timeoutMs?: number;
  /** Explicit verifier configuration, mainly for tests and embedded deployments. */
  configs?: ExternalVerifierConfig[];
}

export const DEFAULT_EXTERNAL_VERIFIER_TIMEOUT_MS = 10_000;
const MAX_EXTERNAL_VERIFIER_TIMEOUT_MS = 300_000;

function externalVerifierTimeout(value: number | string | undefined): number {
  if (value === undefined || value === "") return DEFAULT_EXTERNAL_VERIFIER_TIMEOUT_MS;

  const timeoutMs = Number(value);

  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_EXTERNAL_VERIFIER_TIMEOUT_MS
  ) {
    throw new Error(
      `verifier timeout must be an integer between 1 and ${MAX_EXTERNAL_VERIFIER_TIMEOUT_MS} ms`,
    );
  }

  return timeoutMs;
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Partial<Task>;
  return (
    typeof task.id === "string" &&
    typeof task.title === "string" &&
    Array.isArray(task.inputs) &&
    Array.isArray(task.outputs) &&
    Array.isArray(task.cases) &&
    typeof task.referenceGateCount === "number"
  );
}

function isCircuit(value: unknown): value is Circuit {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Circuit).components)
  );
}

function logicVerifier(semantics: SemanticsRegistry | null): AppVerifier {
  return {
    id: LOGIC_APP,
    name: "Logic",
    version: "1",
    description: "NAND and LATCH netlists verified by the built-in deterministic simulator.",
    artifactKinds: [LOGIC_KIND],
    challengeCount: 0,
    verifier: "builtin",
    configured: true,
    url: null,
    supports: (artifact) => artifact.app === LOGIC_APP && artifact.kind === LOGIC_KIND,
    verify: async (artifact, challenge) => {
      if (!isCircuit(artifact.body)) {
        throw new Error("logic artifact body must be a netlist");
      }

      if (!isTask(challenge.spec)) {
        throw new Error(`challenge ${challenge.id} is not a logic task`);
      }

      const result = score(artifact.body, challenge.spec);
      const bound = semantics
        ? semanticsForChallenge(semantics, challenge)
        : null;

      const attestation = attest(artifact.body, challenge.spec, {
        semanticsId: bound?.id ?? `logic/${challenge.id}`,
        semanticsVersion: bound?.version ?? 1,
        semanticsHash: bound ? hashValue(bound) : "",
        claimKind: bound?.claimKind ?? "satisfies",
        scope: null,
        proofKind: "recomputable",
        signatureAlgorithm: "ecdsa-p256",
        cryptoProfile: "classical",
        verifierHash: logicVerifierHash(),
      });

      return {
        ...attestation,
        app: LOGIC_APP,
        challengeId: challenge.id,
        correct: result.correct,
        score: result.score,
        gateCount: result.gateCount,
      };
    },
  };
}

function externalVerifier(
  config: ExternalVerifierConfig,
  requestFetch: typeof fetch,
  timeoutMs: number,
): AppVerifier {
  let url: URL;

  try {
    url = new URL(config.url);
  } catch {
    throw new Error(`verifier ${config.app} has an invalid url`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`verifier ${config.app} url must use http or https`);
  }

  return {
    id: config.app,
    name: config.name ?? config.app,
    version: config.version ?? "1",
    description: config.description ?? "External HTTP verifier.",
    artifactKinds: config.artifactKinds ?? [`${config.app}.artifact`],
    challengeCount: 0,
    verifier: "http",
    configured: true,
    url: url.toString(),
    supports: (artifact) =>
      artifact.app === config.app &&
      (config.artifactKinds === undefined ||
        config.artifactKinds.length === 0 ||
        config.artifactKinds.includes(artifact.kind)),
    verify: async (artifact, challenge) => {
      let response: Response;
      let text: string;

      try {
        response = await requestFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ artifact, challenge }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
      } catch (error) {
        if (isTimeout(error)) {
          throw new Error(
            `verifier ${config.app} timed out after ${timeoutMs}ms`,
          );
        }
        throw error;
      }

      let payload: VerificationOutput & { error?: string; manifest?: unknown };
      try {
        payload = JSON.parse(text) as VerificationOutput & {
          error?: string;
          manifest?: unknown;
        };
      } catch {
        throw new Error(
          `verifier ${config.app} returned invalid JSON (status ${response.status})`,
        );
      }

      if (!response.ok) {
        throw new Error(
          `verifier ${config.app} failed: ${payload.error ?? response.status}`,
        );
      }

      if (typeof payload.correct !== "boolean") {
        throw new Error(`verifier ${config.app} did not return a boolean correct`);
      }

      if (typeof payload.score !== "number" || !Number.isFinite(payload.score)) {
        throw new Error(`verifier ${config.app} did not return a numeric score`);
      }

      const proof = payload.proof ?? {
        correct: payload.correct,
        score: payload.score,
        details: payload.details ?? null,
      };

      const manifest =
        payload.manifest ?? config.manifest ?? {
          app: config.app,
          url: config.url,
          version: config.version ?? "1",
        };

      return {
        id: randomUUID(),
        verifier: `http:${config.app}`,
        app: config.app,
        challengeId: challenge.id,
        taskId: challenge.id,
        circuitHash: sha256(canonicalize(artifact)),
        traceHash: sha256(canonicalize(proof)),
        correct: payload.correct,
        score: Math.round(payload.score),
        gateCount:
          typeof payload.gateCount === "number" && Number.isFinite(payload.gateCount)
            ? Math.max(0, Math.round(payload.gateCount))
            : 0,
        semanticsId: challenge.semanticsId,
        semanticsVersion: challenge.semanticsVersion,
        semanticsHash: "",
        claimKind: "satisfies",
        scope: null,
        proofKind: "recomputable",
        signatureAlgorithm: "ecdsa-p256",
        cryptoProfile: "classical",
        verifierHash: hashValue(manifest),
        createdAt: new Date().toISOString(),
      };
    },
  };
}

function configuredVerifiers(): ExternalVerifierConfig[] {
  const source = process.env.RAREXT_VERIFIERS?.trim();

  if (!source) return [];

  let text = source;

  if (!source.startsWith("[") && !source.startsWith("{")) {
    if (!existsSync(source)) {
      throw new Error(`RAREXT_VERIFIERS file not found: ${source}`);
    }
    text = readFileSync(source, "utf8");
  }

  const parsed = JSON.parse(text) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && "verifiers" in parsed
      ? (parsed as { verifiers: unknown }).verifiers
      : null;

  if (!Array.isArray(list)) {
    throw new Error("RAREXT_VERIFIERS must be an array or { verifiers: [] }");
  }

  return list as ExternalVerifierConfig[];
}

export interface VerifierRegistry {
  list(): AppVerifier[];
  get(app: string): AppVerifier | null;
  verify(
    artifact: Artifact,
    challenge: Challenge,
    options?: ClaimOptions,
  ): Promise<Attestation>;
  verifyAttestation(
    artifact: Artifact,
    challenge: Challenge,
    attestation: Attestation,
  ): Promise<{
    valid: boolean;
    reason: string | null;
    attestation: Attestation;
    recomputed: Attestation;
  }>;
}

export function createVerifierRegistry(
  requestFetch: typeof fetch = fetch,
  semantics: SemanticsRegistry | null = null,
  options: VerifierRegistryOptions = {},
): VerifierRegistry {
  const verifiers = new Map<string, AppVerifier>();
  const timeoutMs = externalVerifierTimeout(
    options.timeoutMs ?? process.env.RAREXT_VERIFIER_TIMEOUT_MS,
  );
  const logic = logicVerifier(semantics);
  verifiers.set(logic.id, logic);

  const generative = generativeVerifier(semantics);
  verifiers.set(generative.id, generative);

  const bounded = boundedVerifier(semantics);
  verifiers.set(bounded.id, bounded);

  for (const config of options.configs ?? configuredVerifiers()) {
    const verifier = externalVerifier(config, requestFetch, timeoutMs);
    verifiers.set(verifier.id, verifier);
  }

  return {
    list: () => [...verifiers.values()],
    get: (app) => verifiers.get(app) ?? null,
    verify: async (artifact, challenge, options) => {
      const verifier = verifiers.get(artifact.app);

      if (!verifier) {
        throw new Error(`no verifier registered for app: ${artifact.app}`);
      }

      if (!verifier.supports(artifact, challenge)) {
        throw new Error(
          `verifier ${verifier.id} does not support artifact kind: ${artifact.kind}`,
        );
      }

      const attestation = await verifier.verify(artifact, challenge);

      if (!semantics) return attestation;

      const bound = bindClaim(attestation, challenge, semantics, options);

      if ("error" in bound) throw new Error(bound.error);

      return bound.attestation;
    },
    verifyAttestation: async (artifact, challenge, attestation) => {
      const verifier = verifiers.get(artifact.app);

      if (!verifier) {
        throw new Error(`no verifier registered for app: ${artifact.app}`);
      }

      if (!verifier.supports(artifact, challenge)) {
        throw new Error(
          `verifier ${verifier.id} does not support artifact kind: ${artifact.kind}`,
        );
      }

      const recomputed = await verifier.verify(artifact, challenge);
      const storedApp = attestation.app ?? LOGIC_APP;
      const storedChallengeId = attestation.challengeId ?? attestation.taskId;

      // Attestations published before the semantic layer carry no binding. They
      // still verify on their hashes; the binding is compared only once it exists.
      const semanticsMatch =
        attestation.semanticsId === undefined ||
        attestation.semanticsId === null ||
        (recomputed.semanticsId === attestation.semanticsId &&
          recomputed.semanticsVersion === attestation.semanticsVersion &&
          recomputed.semanticsHash === attestation.semanticsHash &&
          recomputed.claimKind === attestation.claimKind &&
          recomputed.verifierHash === attestation.verifierHash);

      const checks: [string, boolean][] = [
        ["app", recomputed.app === storedApp],
        ["challenge", recomputed.challengeId === storedChallengeId],
        ["artifact", recomputed.circuitHash === attestation.circuitHash],
        ["trace", recomputed.traceHash === attestation.traceHash],
        ["score", recomputed.score === attestation.score],
        ["gate count", recomputed.gateCount === attestation.gateCount],
        ["verdict", recomputed.correct === attestation.correct],
        ["representation", recomputed.representation === attestation.representation],
        ["metric name", recomputed.metricName === attestation.metricName],
        ["metric value", recomputed.metricValue === attestation.metricValue],
        ["proof kind", recomputed.proofKind === attestation.proofKind],
        ["verifier name", recomputed.verifier === attestation.verifier],
        ["semantics", semanticsMatch],
      ];
      const mismatch = checks.find(([, ok]) => !ok)?.[0] ?? null;

      return {
        valid: mismatch === null,
        reason: mismatch === null ? null : `attestation does not match ${mismatch}`,
        attestation,
        recomputed,
      };
    },
  };
}
