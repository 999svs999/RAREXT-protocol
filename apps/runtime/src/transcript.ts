import { canonicalBytes, canonicalDigest, sha256Hex } from "./digest.ts";
import { extractAnthropicText, extractOpenAiText, extractSseText } from "./engines.ts";
import { deploymentDigest, isLoopbackEndpoint, validateDeployment } from "./manifest.ts";
import { verifyProviderCard } from "./model-bundle.ts";
import type {
  ApiShape,
  DeploymentCommitment,
  DeploymentManifest,
  DeploymentVerification,
  EngineName,
  HardwareBackend,
  ModelRunBody,
  ModelRunSpec,
  ModelRunVerification,
  ProviderCardVerification,
  ReplayEnvelope,
  RunBundleRef,
  RunQuorum,
  RunRecord,
  SamplingParams,
  TokenUsage,
} from "./types.ts";
import {
  MAX_TRANSCRIPT_BYTES,
  MODEL_DEPLOYMENT_ARTIFACT_KIND,
  MODEL_PROVIDER_ARTIFACT_KIND,
  MODEL_RUN_APP,
  MODEL_RUN_ARTIFACT_KIND,
  RUN_KIND,
  RUN_RECORD_KIND,
} from "./types.ts";
import type { LedgerAudit, LedgerVerification } from "./types.ts";

const HEX64 = /^[0-9a-f]{64}$/;

export class TranscriptTooLargeError extends Error {
  readonly bytes: number;

  constructor(bytes: number) {
    super(
      `transcript is ${bytes} canonical bytes, above the ${MAX_TRANSCRIPT_BYTES}-byte publish limit`,
    );
    this.name = "TranscriptTooLargeError";
    this.bytes = bytes;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSseBody(value: unknown): value is { kind: "sse"; data: string } {
  return isRecord(value) && value.kind === "sse" && typeof value.data === "string";
}

export function extractResponseText(body: unknown, api: ApiShape): string {
  if (isSseBody(body)) return extractSseText(body.data);
  return api === "anthropic" ? extractAnthropicText(body) : extractOpenAiText(body);
}

function checkedCanonical(value: unknown, label: string): { digest: string; bytes: number } {
  const bytes = canonicalBytes(value);
  if (bytes > MAX_TRANSCRIPT_BYTES) throw new TranscriptTooLargeError(bytes);
  if (bytes === 0) throw new Error(`${label} is empty`);
  return { digest: canonicalDigest(value), bytes };
}

/**
 * The bundle reference a deployment commits in its labels, in the exact shape
 * a run records. A deployment without `execution: "web4"` has no bundle.
 */
export function bundleRefFromDeployment(
  deployment: DeploymentManifest,
): RunBundleRef | null {
  const labels = deployment.labels;
  if (labels?.execution !== "web4") return null;
  const { bundle, shardsRoot, manifestHash } = labels;
  if (
    typeof bundle !== "string" ||
    typeof shardsRoot !== "string" ||
    typeof manifestHash !== "string" ||
    typeof deployment.model.weightsDigest !== "string"
  ) {
    return null;
  }
  return {
    digest: bundle,
    shardsRoot,
    manifestHash,
    weightsDigest: deployment.model.weightsDigest,
  };
}

export interface CreateRunInput {
  deployment: DeploymentCommitment;
  api: ApiShape;
  /** The exact body forwarded upstream (after any Anthropic -> OpenAI translation). */
  request: unknown;
  /** The exact upstream response object, or `{ kind: "sse", data }` for a stream. */
  response: unknown;
  usage: TokenUsage | null;
  sampling: Omit<SamplingParams, "stream">;
  startedAt: string;
  completedAt: string;
  previous: string | null;
  /** Present when the engine is deterministic enough for an independent replay. */
  replay?: boolean;
  /** Present when the deployment required agreement across providers. */
  quorum?: RunQuorum;
}

/**
 * Build a model-run transcript. Every digest is computed from the bytes we
 * actually sent and received; nothing is copied from the engine's claims.
 */
export function createRunBody(input: CreateRunInput): ModelRunBody {
  const request = checkedCanonical(input.request, "request");
  const response = checkedCanonical(input.response, "response");
  const text = extractResponseText(input.response, input.api);
  const bundle = bundleRefFromDeployment(input.deployment);

  return {
    kind: RUN_KIND,
    deployment: { id: input.deployment.id, digest: input.deployment.digest },
    model: {
      id: input.deployment.model.id,
      weightsDigest: input.deployment.model.weightsDigest,
    },
    engine: {
      name: input.deployment.engine.name,
      version: input.deployment.engine.version,
    },
    ...(bundle === null ? {} : { bundle }),
    ...(input.quorum === undefined ? {} : { quorum: input.quorum }),
    api: input.api,
    request: { body: input.request, digest: request.digest, bytes: request.bytes },
    response: {
      body: input.response,
      digest: response.digest,
      bytes: response.bytes,
      text,
      textDigest: sha256Hex(text),
    },
    sampling: { ...input.sampling, stream: false },
    usage: input.usage,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    previous: input.previous,
    replay:
      input.replay === false
        ? null
        : ({
            api: input.api,
            endpoint: input.deployment.engine.endpoint,
            request: input.request,
            params: { ...input.sampling, stream: false },
          } satisfies ReplayEnvelope),
  };
}

export function runRecordFor(body: ModelRunBody): RunRecord {
  return { kind: RUN_RECORD_KIND, body, digest: canonicalDigest(body) };
}

export function transcriptDigest(body: ModelRunBody): string {
  return canonicalDigest(body);
}

function check(
  checks: string[],
  failures: string[],
  name: string,
  ok: boolean,
): void {
  if (ok) {
    checks.push(name);
  } else {
    failures.push(name);
  }
}

/**
 * Verify a run transcript against the challenge it was published under.
 *
 * What this proves: the bytes in the transcript are the bytes that were hashed,
 * the deployment digest is the one the challenge committed, the response text
 * is the text those bytes contain, and the record names everything a holder of
 * the same deployment needs to replay it. It does NOT prove the model is good,
 * and it does not replay a 290B model on the registry — replay is the local
 * check `rarext-runtime replay` performs when the weights are present.
 */
export function verifyRunBody(body: unknown, spec: ModelRunSpec): ModelRunVerification {
  const checks: string[] = [];
  const failures: string[] = [];

  if (!isRecord(body)) {
    return {
      correct: false,
      score: 0,
      proof: null,
      details: {
        representation: "exact",
        transcriptDigest: "",
        deploymentDigest: "",
        requestDigest: "",
        responseDigest: "",
        textDigest: "",
        replayable: false,
        durationMs: null,
        tokensPerSecond: null,
        checks: [],
      },
      error: "artifact body must be an object",
    };
  }

  check(checks, failures, "kind", body.kind === RUN_KIND);

  const deployment = isRecord(body.deployment) ? body.deployment : {};
  const model = isRecord(body.model) ? body.model : {};
  const engine = isRecord(body.engine) ? body.engine : {};
  const request = isRecord(body.request) ? body.request : {};
  const response = isRecord(body.response) ? body.response : {};
  const sampling = isRecord(body.sampling) ? body.sampling : {};
  const replay = isRecord(body.replay) ? body.replay : null;

  check(checks, failures, "deployment.digest", deployment.digest === spec.deploymentDigest);
  check(checks, failures, "deployment.id", typeof deployment.id === "string" && deployment.id.length > 0);
  check(checks, failures, "model.id", model.id === spec.modelId);
  check(checks, failures, "model.weightsDigest", (model.weightsDigest ?? null) === spec.weightsDigest);
  check(checks, failures, "engine.name", engine.name === spec.engine);

  if (spec.bundleDigest === undefined) {
    // Local and remote runs name no bundle; a web4 bundle cannot be attached to
    // a challenge that never committed it.
    check(checks, failures, "bundle.absent", body.bundle === undefined);
  } else {
    const bundle = isRecord(body.bundle) ? body.bundle : {};
    check(checks, failures, "bundle.digest", bundle.digest === spec.bundleDigest);
    if (spec.shardsRoot !== undefined) {
      check(checks, failures, "bundle.shardsRoot", bundle.shardsRoot === spec.shardsRoot);
    }
    if (spec.manifestHash !== undefined) {
      check(checks, failures, "bundle.manifestHash", bundle.manifestHash === spec.manifestHash);
    }
    check(
      checks,
      failures,
      "bundle.weightsDigest",
      bundle.weightsDigest === spec.weightsDigest && bundle.weightsDigest === model.weightsDigest,
    );
  }

  const requestDigest = canonicalDigest(request.body);
  const requestBytes = canonicalBytes(request.body);
  check(checks, failures, "request.digest", request.digest === requestDigest);
  check(checks, failures, "request.bytes", request.bytes === requestBytes);

  const responseDigest = canonicalDigest(response.body);
  const responseBytes = canonicalBytes(response.body);
  check(checks, failures, "response.digest", response.digest === responseDigest);
  check(checks, failures, "response.bytes", response.bytes === responseBytes);

  // A quorum run names every provider and the exact response each returned.
  // The chosen response must be one of those digests, and the deployment's
  // required count must be met. The evidence is inside the transcript, so
  // editing any of it moves the run digest.
  if (spec.quorum === undefined) {
    check(checks, failures, "quorum.absent", body.quorum === undefined);
  } else {
    const quorum = isRecord(body.quorum) ? body.quorum : null;
    const providers = quorum !== null && Array.isArray(quorum.providers) ? quorum.providers : [];
    const validProviders =
      providers.length > 0 &&
      providers.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.endpoint === "string" &&
          /^https?:\/\//.test(entry.endpoint) &&
          typeof entry.responseDigest === "string" &&
          HEX64.test(entry.responseDigest),
      );
    const required = quorum !== null ? quorum.required : null;
    const responded = quorum !== null ? quorum.responded : null;
    const agreed = quorum !== null ? quorum.agreed : null;

    // Agreement is not whatever the recorder wrote: it is how many recorded
    // providers returned the digest of the response the run actually carries.
    // A dissent is allowed to be present (it is evidence), but it cannot be
    // counted, and one endpoint cannot answer twice to inflate the count.
    const endpoints = providers
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => entry.endpoint)
      .filter((endpoint): endpoint is string => typeof endpoint === "string");
    const uniqueEndpoints = new Set(endpoints).size === endpoints.length;
    const agreeing = providers.filter(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && entry.responseDigest === responseDigest,
    );
    const recomputedAgreed = agreeing.length;

    // When the challenge committed operator identities, agreement must be
    // spread across distinct operators, not just endpoints. Each agreeing
    // provider must name a committed operator, and there must be at least
    // `quorum` of them. A run cannot satisfy the threshold with several
    // endpoints run by one operator.
    const committedOperators = spec.operators;
    const operatorsMet =
      committedOperators === undefined
        ? true
        : committedOperators.length >= spec.quorum &&
          agreeing.every(
            (entry) =>
              typeof entry.operator === "string" && committedOperators.includes(entry.operator),
          ) &&
          new Set(
            agreeing
              .map((entry) => entry.operator)
              .filter((operator): operator is string => typeof operator === "string"),
          ).size >= spec.quorum;

    check(
      checks,
      failures,
      "quorum",
      quorum !== null &&
        required === spec.quorum &&
        typeof required === "number" &&
        required >= 1 &&
        typeof responded === "number" &&
        typeof agreed === "number" &&
        responded >= required &&
        agreed >= required &&
        agreed <= responded &&
        validProviders &&
        uniqueEndpoints &&
        providers.length === responded &&
        agreed === recomputedAgreed &&
        operatorsMet,
    );
    check(
      checks,
      failures,
      "quorum.response",
      validProviders &&
        providers.some(
          (entry) => isRecord(entry) && entry.responseDigest === responseDigest,
        ),
    );
  }

  const api: ApiShape =
    body.api === "anthropic" || body.api === "openai"
      ? body.api
      : replay?.api === "anthropic" || replay?.api === "openai"
        ? replay.api
        : isRecord(response.body) &&
            (response.body.type === "message" || Array.isArray(response.body.content))
          ? "anthropic"
          : "openai";
  const text = extractResponseText(response.body, api);
  check(checks, failures, "response.text", response.text === text);
  check(checks, failures, "response.textDigest", response.textDigest === sha256Hex(text));

  check(
    checks,
    failures,
    "sampling",
    typeof sampling.temperature === "number" &&
      Number.isFinite(sampling.temperature) &&
      sampling.temperature >= 0 &&
      sampling.temperature <= 2 &&
      (sampling.topP === null ||
        (typeof sampling.topP === "number" && sampling.topP > 0 && sampling.topP <= 1)) &&
      (sampling.seed === null || Number.isSafeInteger(sampling.seed)) &&
      (sampling.maxTokens === null ||
        (Number.isSafeInteger(sampling.maxTokens) && (sampling.maxTokens as number) > 0)),
  );

  const started = typeof body.startedAt === "string" ? Date.parse(body.startedAt) : Number.NaN;
  const completed = typeof body.completedAt === "string" ? Date.parse(body.completedAt) : Number.NaN;
  check(checks, failures, "timestamps", Number.isFinite(started) && Number.isFinite(completed) && completed >= started);
  check(checks, failures, "previous", body.previous === null || (typeof body.previous === "string" && HEX64.test(body.previous)));

  const usage = isRecord(body.usage) ? body.usage : null;
  const usageField = (value: unknown): boolean =>
    value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
  check(
    checks,
    failures,
    "usage",
    body.usage === null ||
      (usage !== null &&
        usageField(usage.promptTokens) &&
        usageField(usage.completionTokens) &&
        usageField(usage.totalTokens)),
  );

  // Throughput is derived, not asserted: the transcript commits the timestamps
  // and token counts, and this arithmetic is what a reader can recompute. It
  // does not prove the engine was fast, only that the recorded interval and
  // completion count imply this rate.
  const durationMs =
    Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : null;
  const completionTokens =
    usage !== null && typeof usage.completionTokens === "number" && Number.isFinite(usage.completionTokens)
      ? usage.completionTokens
      : null;
  const tokensPerSecond =
    durationMs !== null && durationMs > 0 && completionTokens !== null
      ? (completionTokens / durationMs) * 1000
      : null;

  let replayable = false;
  if (replay) {
    replayable =
      (replay.api === "openai" || replay.api === "anthropic") &&
      typeof replay.endpoint === "string" &&
      /^https?:\/\//.test(replay.endpoint) &&
      replay.request !== undefined &&
      isRecord(replay.params);
  } else {
    // A transcript without replay metadata is still an exact record; it is
    // simply not independently reproducible.
    replayable = false;
  }

  const correct = failures.length === 0;
  const transcript = canonicalDigest(body);

  return {
    correct,
    score: correct ? 100 : 0,
    proof: {
      representation: "exact",
      transcriptDigest: transcript,
      deploymentDigest: String(deployment.digest ?? ""),
      requestDigest,
      responseDigest,
      textDigest: sha256Hex(text),
      replayable,
      durationMs,
      tokensPerSecond,
      checks,
      failures,
    },
    details: {
      representation: "exact",
      transcriptDigest: transcript,
      deploymentDigest: String(deployment.digest ?? ""),
      requestDigest,
      responseDigest,
      textDigest: sha256Hex(text),
      replayable,
      durationMs,
      tokensPerSecond,
      checks,
    },
    ...(correct ? {} : { error: `transcript failed: ${failures.join(", ")}` }),
  };
}

/** The artifact envelope the registry verifies for a run. */
export function runArtifact(body: ModelRunBody) {
  return {
    app: MODEL_RUN_APP,
    kind: MODEL_RUN_ARTIFACT_KIND,
    version: 1,
    mediaType: "application/json",
    body,
  } as const;
}

/** The artifact envelope the registry verifies for a deployment commitment. */
export function deploymentArtifact(body: DeploymentCommitment) {
  return {
    app: MODEL_RUN_APP,
    kind: MODEL_DEPLOYMENT_ARTIFACT_KIND,
    version: 1,
    mediaType: "application/json",
    body,
  } as const;
}

/**
 * The artifact envelope the registry verifies for a provider card. A provider
 * publishes its own card under the model challenge, so the card is signed and
 * carried by the same bundle as the deployment and its runs.
 */
export function providerCardArtifact(body: unknown) {
  return {
    app: MODEL_RUN_APP,
    kind: MODEL_PROVIDER_ARTIFACT_KIND,
    version: 1,
    mediaType: "application/json",
    body,
  } as const;
}

const ENGINES = new Set<EngineName>(["ollama", "strata", "freetoken", "openai-compatible", "anthropic"]);
const BACKENDS = new Set<HardwareBackend>([
  "cpu",
  "metal",
  "cuda",
  "rocm",
  "vulkan",
  "cloud",
  "network",
  "unknown",
]);

/**
 * Verify a published deployment commitment.
 *
 * The manifest is the thing that names the model, weights, engine, and
 * hardware; its digest is the identity every run cites. This recomputes that
 * digest from the manifest itself and checks the identity against the same
 * challenge the runs use — a deployment cannot be published under a challenge
 * that commits a different model or different weights.
 */
export function verifyDeploymentBody(body: unknown, spec: ModelRunSpec): DeploymentVerification {
  const checks: string[] = [];
  const failures: string[] = [];

  if (!isRecord(body)) {
    return {
      correct: false,
      score: 0,
      proof: null,
      details: {
        representation: "exact",
        deploymentDigest: "",
        modelId: "",
        weightsDigest: null,
        engine: spec.engine,
        backend: "unknown",
        checks: [],
      },
      error: "deployment body must be an object",
    };
  }

  const manifestErrors = validateDeployment(body);
  check(checks, failures, "manifest", manifestErrors.length === 0);

  const claimed = typeof body.digest === "string" && HEX64.test(body.digest) ? body.digest : "";
  check(checks, failures, "digest.present", claimed !== "");

  const { digest: _digest, ...manifest } = body;
  const recomputed = deploymentDigest(manifest as unknown as DeploymentManifest);
  check(checks, failures, "digest.recomputed", claimed === recomputed);
  check(checks, failures, "deployment.digest", recomputed === spec.deploymentDigest);

  const model = isRecord(body.model) ? body.model : {};
  const engine = isRecord(body.engine) ? body.engine : {};
  const hardware = isRecord(body.hardware) ? body.hardware : {};

  check(checks, failures, "model.id", model.id === spec.modelId);
  check(checks, failures, "model.weightsDigest", (model.weightsDigest ?? null) === spec.weightsDigest);
  check(checks, failures, "engine.name", engine.name === spec.engine);
  check(
    checks,
    failures,
    "hardware",
    typeof hardware.backend === "string" &&
      BACKENDS.has(hardware.backend as HardwareBackend) &&
      (hardware.memoryBytes === null ||
        (typeof hardware.memoryBytes === "number" && Number.isFinite(hardware.memoryBytes))),
  );
  check(
    checks,
    failures,
    "placement",
    body.placement === undefined ||
      body.placement === "local" ||
      body.placement === "remote" ||
      body.placement === "web4",
  );
  if (body.placement === "web4") {
    const labels = isRecord(body.labels) ? body.labels : {};
    // The weights are blobs, not a promise: the card names the bundle the
    // provider fetched, and the model's weight digest must be the bundle's.
    check(
      checks,
      failures,
      "placement.web4",
      hardware.backend === "network" &&
        hardware.memoryBytes === null &&
        labels.execution === "web4",
    );
    check(
      checks,
      failures,
      "bundle.commitment",
      typeof labels.bundle === "string" &&
        HEX64.test(labels.bundle) &&
        typeof labels.shardsRoot === "string" &&
        HEX64.test(labels.shardsRoot) &&
        typeof labels.manifestHash === "string" &&
        HEX64.test(labels.manifestHash),
    );
    check(
      checks,
      failures,
      "challenge.bundle",
      typeof spec.bundleDigest === "string" &&
        typeof spec.weightsDigest === "string" &&
        labels.bundle === spec.bundleDigest &&
        (spec.shardsRoot === undefined || labels.shardsRoot === spec.shardsRoot) &&
        (spec.manifestHash === undefined || labels.manifestHash === spec.manifestHash),
    );

    // A loopback provider is a test fixture, exactly as a loopback remote
    // endpoint is; a real card cannot quietly run on the publisher's machine.
    const web4Endpoint = typeof engine.endpoint === "string" ? engine.endpoint : "";
    if (web4Endpoint !== "" && isLoopbackEndpoint(web4Endpoint)) {
      check(checks, failures, "placement.fixture", labels.fixture === "loopback");
    }
  }
  if (body.placement === "remote") {
    // A remote commitment claims that this process has no weights and no local
    // inference. Keeping the hardware record consistent makes that claim
    // checkable: a manifest cannot be called remote while claiming local memory.
    check(
      checks,
      failures,
      "placement.remote",
      hardware.backend === "cloud" && hardware.memoryBytes === null,
    );

    // A loopback endpoint is local compute. It is allowed only when the
    // manifest is explicitly marked as a test fixture, so a real cloud card
    // cannot quietly point at the publisher's own machine.
    const remoteEndpoint = typeof engine.endpoint === "string" ? engine.endpoint : "";
    if (remoteEndpoint !== "" && isLoopbackEndpoint(remoteEndpoint)) {
      const labels = isRecord(body.labels) ? body.labels : {};
      check(checks, failures, "placement.fixture", labels.fixture === "loopback");
    }
  }

  const actualEngine =
    typeof engine.name === "string" && ENGINES.has(engine.name as EngineName)
      ? (engine.name as EngineName)
      : spec.engine;
  const actualBackend =
    typeof hardware.backend === "string" && BACKENDS.has(hardware.backend as HardwareBackend)
      ? (hardware.backend as HardwareBackend)
      : "unknown";
  const actualWeights = typeof model.weightsDigest === "string" ? model.weightsDigest : null;
  const actualModel = typeof model.id === "string" ? model.id : "";

  const correct = failures.length === 0;

  return {
    correct,
    score: correct ? 100 : 0,
    proof: {
      representation: "exact",
      deploymentDigest: recomputed,
      modelId: actualModel,
      weightsDigest: actualWeights,
      engine: actualEngine,
      backend: actualBackend,
      checks,
      failures,
    },
    details: {
      representation: "exact",
      deploymentDigest: recomputed,
      modelId: actualModel,
      weightsDigest: actualWeights,
      engine: actualEngine,
      backend: actualBackend,
      checks,
    },
    ...(correct ? {} : { error: `deployment failed: ${failures.join(", ")}` }),
  };
}

/**
 * Verify a published provider card against the challenge that commits the
 * model. The card's own digest proves it was not edited after the provider
 * signed it; the challenge proves it names the bundle, weights, and model the
 * deployment committed to. Neither is a trust anchor on its own, which is why
 * deploy also fetches the bundle manifest independently and cross-checks it.
 */
export function verifyProviderCardBody(
  body: unknown,
  spec: ModelRunSpec,
): ProviderCardVerification {
  const checks: string[] = [];
  const failures: string[] = [];

  if (!isRecord(body)) {
    return {
      correct: false,
      score: 0,
      proof: null,
      details: {
        representation: "exact",
        providerCardDigest: "",
        endpoint: "",
        bundleDigest: "",
        modelId: "",
        checks: [],
      },
      error: "provider card body must be an object",
    };
  }

  const errors = verifyProviderCard(body);
  check(checks, failures, "card", errors.length === 0);

  const bundle = isRecord(body.bundle) ? body.bundle : {};
  const model = isRecord(body.model) ? body.model : {};
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  const cardDigest = typeof body.digest === "string" ? body.digest : "";

  check(
    checks,
    failures,
    "bundle",
    typeof spec.bundleDigest === "string" &&
      bundle.digest === spec.bundleDigest &&
      (spec.shardsRoot === undefined || bundle.shardsRoot === spec.shardsRoot) &&
      (spec.manifestHash === undefined || bundle.manifestHash === spec.manifestHash) &&
      (spec.weightsDigest === null || bundle.weightsDigest === spec.weightsDigest),
  );
  check(checks, failures, "model", model.id === spec.modelId);
  check(
    checks,
    failures,
    "model.weightsDigest",
    (model.weightsDigest ?? null) === spec.weightsDigest &&
      bundle.weightsDigest === spec.weightsDigest,
  );

  const correct = failures.length === 0;

  return {
    correct,
    score: correct ? 100 : 0,
    proof: {
      representation: "exact",
      providerCardDigest: cardDigest,
      endpoint,
      bundleDigest: typeof bundle.digest === "string" ? bundle.digest : "",
      modelId: typeof model.id === "string" ? model.id : "",
      checks,
      failures,
    },
    details: {
      representation: "exact",
      providerCardDigest: cardDigest,
      endpoint,
      bundleDigest: typeof bundle.digest === "string" ? bundle.digest : "",
      modelId: typeof model.id === "string" ? model.id : "",
      checks,
    },
    ...(correct ? {} : { error: `provider card failed: ${failures.join(", ")}` }),
  };
}

export function verifyRunRecord(record: unknown): boolean {
  if (!isRecord(record) || record.kind !== RUN_RECORD_KIND) return false;
  if (typeof record.digest !== "string" || !HEX64.test(record.digest)) return false;
  return canonicalDigest(record.body) === record.digest;
}

/**
 * Verify every run in a ledger against one deployment challenge, in addition
 * to the chain. The chain proves the records were not edited or removed; this
 * proves they all belong to the deployment the caller is asking about.
 */
export function auditLedger(records: unknown[], spec: ModelRunSpec): LedgerAudit {
  const chain = verifyLedger(records);

  const runs = records.map((record, index) => {
    if (!isRecord(record) || record.kind !== RUN_RECORD_KIND) {
      return { index, digest: "", correct: false, error: "not a run record" };
    }

    const digest = typeof record.digest === "string" ? record.digest : "";
    const verification = verifyRunBody(record.body, spec);

    return {
      index,
      digest,
      correct: verification.correct,
      error: verification.error ?? null,
    };
  });

  return {
    ok: chain.ok && runs.every((run) => run.correct),
    count: records.length,
    chain,
    runs,
  };
}

/** Recompute every record digest and every link in an append-only ledger. */
export function verifyLedger(records: unknown[]): LedgerVerification {
  const errors: Array<{ index: number; reason: string }> = [];
  let expectedPrevious: string | null = null;
  let head: string | null = null;

  records.forEach((record, index) => {
    if (!isRecord(record) || record.kind !== RUN_RECORD_KIND) {
      errors.push({ index, reason: "not a run record" });
      return;
    }
    if (!verifyRunRecord(record)) {
      errors.push({ index, reason: "record digest does not match its body" });
    }
    const body = isRecord(record.body) ? record.body : {};
    if ((body.previous ?? null) !== expectedPrevious) {
      errors.push({
        index,
        reason: `previous link is ${String(body.previous)} but the ledger head is ${String(expectedPrevious)}`,
      });
    }
    expectedPrevious = typeof record.digest === "string" ? record.digest : null;
    head = expectedPrevious;
  });

  return { ok: errors.length === 0, count: records.length, head, errors };
}
