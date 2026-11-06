/**
 * RAREXT Runtime — deploy a large model on hardware you own, and publish every
 * inference as an artifact a stranger can re-hash (and, when the engine is
 * deterministic, replay).
 *
 * The two reference deployments this layer is modelled on are Strata
 * (github.com/Niko1221/Strata) and FreeToken (github.com/FlashML-org/FreeToken):
 * both put a large model behind an OpenAI/Anthropic-compatible server on
 * localhost, with the weights and quantization named explicitly. This module
 * treats that local server as an *engine* and adds the part neither project
 * ships: a deployment commitment and an append-only, signed transcript ledger
 * that can be published to RAREXT.
 */

export const RUNTIME_VERSION = "0.1.0";

export const DEPLOYMENT_KIND = "rarext.model-deployment.v1";
export const RUN_KIND = "rarext.model-run.v1";
export const RUN_RECORD_KIND = "rarext.model-run.record.v1";

/** The app id the registry verifies model-run transcripts under. */
export const MODEL_RUN_APP = "ai-model-run";
/** The artifact kind the registry verifies model-run transcripts under. */
export const MODEL_RUN_ARTIFACT_KIND = "ai.model-run";

/** A transcript larger than this is not published; inference still succeeds. */
export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
/** Largest request body the gateway will read. */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export type EngineName = "ollama" | "strata" | "freetoken" | "openai-compatible";
export type ApiShape = "openai" | "anthropic";
export type HardwareBackend = "cpu" | "metal" | "cuda" | "rocm" | "vulkan" | "unknown";

export interface EngineRef {
  /** Which serving engine is behind the endpoint. */
  name: EngineName;
  /** Engine version when the engine reports one. */
  version: string | null;
  /** Base URL, normalised without a trailing slash and without `/v1`. */
  endpoint: string;
}

export interface ModelRef {
  /** Engine-native model id, e.g. `qwen2.5:0.5b`. */
  id: string;
  family: string | null;
  /** Human parameter count, e.g. `494M` or `35B`. */
  parameters: string | null;
  /** Quantization label, e.g. `Q4_K_M`, `NVFP4`, `FP8`. */
  quantization: string | null;
  /** Weight container format, e.g. `gguf`, `safetensors`. */
  format: string | null;
  sizeBytes: number | null;
  /**
   * Digest of the weight bytes as the engine reports them. Prefixed with the
   * algorithm, e.g. `sha256:...`. Null when the engine does not expose one —
   * an honest null, never a fabricated hash.
   */
  weightsDigest: string | null;
  /** Advertised context window, when the engine reports one. */
  contextLength: number | null;
}

export interface HardwareRef {
  backend: HardwareBackend;
  /** Device label when known, e.g. `Apple M4 Pro`, `NVIDIA RTX 4090`. */
  device: string | null;
  /** Host memory visible to the runtime, in bytes. */
  memoryBytes: number | null;
  os: string;
  arch: string;
}

export interface DeploymentManifest {
  kind: typeof DEPLOYMENT_KIND;
  /** Stable slug for this deployment, derived from model id unless supplied. */
  id: string;
  engine: EngineRef;
  model: ModelRef;
  hardware: HardwareRef;
  /** Which API shapes the runtime exposes. */
  apis: ApiShape[];
  createdAt: string;
  labels?: Record<string, string>;
  notes?: string;
}

export interface DeploymentCommitment extends DeploymentManifest {
  /** sha256 over the canonical manifest. */
  digest: string;
}

export interface SamplingParams {
  temperature: number;
  topP: number | null;
  seed: number | null;
  maxTokens: number | null;
  stream: false;
}

export interface TranscriptRequest {
  /** The exact request object forwarded upstream. */
  body: unknown;
  digest: string;
  /** Canonical byte length of `body`. */
  bytes: number;
}

export interface TranscriptResponse {
  /** The exact response object (JSON) or `{ kind: "sse", data }` for a stream. */
  body: unknown;
  digest: string;
  /** Canonical byte length of `body`. */
  bytes: number;
  /** Assistant text extracted from the response, for reading and grep. */
  text: string;
  textDigest: string;
}

export interface TokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface ReplayEnvelope {
  api: ApiShape;
  endpoint: string;
  /** The request body to send on replay (exactly the transcript's request). */
  request: unknown;
  params: SamplingParams;
}

export interface ModelRunBody {
  kind: typeof RUN_KIND;
  deployment: { id: string; digest: string };
  model: { id: string; weightsDigest: string | null };
  engine: { name: EngineName; version: string | null };
  request: TranscriptRequest;
  response: TranscriptResponse;
  sampling: SamplingParams;
  usage: TokenUsage | null;
  startedAt: string;
  completedAt: string;
  /** Digest of the previous run record on this node, or null for the first. */
  previous: string | null;
  /** What a holder of the same deployment needs in order to replay the run. */
  replay: ReplayEnvelope | null;
}

export interface RunRecord {
  kind: typeof RUN_RECORD_KIND;
  body: ModelRunBody;
  /** sha256 over the canonical body. */
  digest: string;
}

/** The committed challenge spec a model-run publication is verified against. */
export interface ModelRunSpec {
  deploymentDigest: string;
  modelId: string;
  weightsDigest: string | null;
  engine: EngineName;
}

export interface EngineProbe {
  engine: EngineRef;
  model: ModelRef;
  apis: ApiShape[];
  /** Every model the engine advertised, so the caller can choose another. */
  models: ModelRef[];
}

export interface ModelRunVerification {
  correct: boolean;
  score: number;
  proof: unknown;
  details: {
    representation: "exact";
    transcriptDigest: string;
    deploymentDigest: string;
    requestDigest: string;
    responseDigest: string;
    textDigest: string;
    replayable: boolean;
    checks: string[];
  };
  error?: string;
}

export interface LedgerVerification {
  ok: boolean;
  count: number;
  head: string | null;
  errors: Array<{ index: number; reason: string }>;
}
