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
/**
 * The artifact kind the deployment commitment is published under. It shares
 * the run challenge/app: one challenge commits one deployment, and both the
 * manifest and the runs it produced are verified against it.
 */
export const MODEL_DEPLOYMENT_ARTIFACT_KIND = "ai.model-deployment";
/**
 * A provider's own claim, published under the model challenge: "I fetched this
 * bundle, verified every shard, and serve it at this endpoint." It is a normal
 * signed publication, so a bundle carries the providers alongside the card and
 * the runs, and discovery can find them without being told a URL in advance.
 */
export const MODEL_PROVIDER_ARTIFACT_KIND = "ai.model-provider";

/** A transcript larger than this is not published; inference still succeeds. */
export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
/** Largest request body the gateway will read. */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export type EngineName = "ollama" | "strata" | "freetoken" | "openai-compatible" | "anthropic";
export type ApiShape = "openai" | "anthropic";
export type HardwareBackend =
  | "cpu"
  | "metal"
  | "cuda"
  | "rocm"
  | "vulkan"
  | "cloud"
  /** A machine contributed to the RAREXT network, neither this host nor a cloud vendor. */
  | "network"
  | "unknown";
/**
 * Where the model actually runs.
 *
 * - `local`: an engine on this host.
 * - `remote`: an endpoint this process does not execute; the weights and the
 *   compute are somebody else's, named by the engine URL.
 * - `web4`: a RAREXT provider. The weights are content-addressed blobs in
 *   RAREXT storage, the provider fetched and verified them, and the deployment
 *   commits the bundle digest so a reader can check the model bytes.
 */
export type Placement = "local" | "remote" | "web4";

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
  /**
   * Where the engine runs. Omitted on manifests written before cloud
   * deployment existed; absent means local, which is what those manifests were.
   */
  placement?: Placement;
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

/**
 * The model bytes a web4 run was produced from. Absent on local/remote runs,
 * whose weights the operator trusts the engine to name.
 */
export interface RunBundleRef {
  /** sha256 of the canonical model bundle. */
  digest: string;
  /** Commitment over the shard list. */
  shardsRoot: string;
  /** sha256:<hex> of the reassembled model file. */
  weightsDigest: string;
  /** Content address of the bundle manifest blob. */
  manifestHash: string;
}

/**
 * What several providers said to the same request. The gateway queries every
 * configured provider, groups the responses by canonical digest, and records
 * which endpoints returned the response the run carries. It is evidence a
 * reader can reproduce by querying the same endpoints, not proof that the
 * operators are independent — but a single provider can no longer be the whole
 * claim.
 */
export interface RunQuorumProvider {
  endpoint: string;
  /** canonical sha256 of the exact response body this provider returned. */
  responseDigest: string;
  /**
   * The operator identity the provider committed in its card, when one was
   * committed. Quorum is counted over distinct operators so one operator
   * cannot satisfy the threshold by running several endpoints.
   */
  operator?: string | null;
  /**
   * The machine identity the provider attested in its card, when one was. A
   * deployment may require its agreeing providers to sit on distinct machines,
   * so an operator cannot satisfy the threshold by pointing at several
   * processes on one box.
   */
  machine?: string | null;
}

export interface RunQuorum {
  /** How many identical responses the deployment requires. */
  required: number;
  /** How many providers answered at all. */
  responded: number;
  /** How many returned the response this run records. */
  agreed: number;
  providers: RunQuorumProvider[];
}

/**
 * What a completed quorum run pays. The gateway derives it from the quorum
 * evidence and the bounty the deployment committed; the verifier recomputes it.
 * The ledger root is over {@link CreditRecordFields} records, one per distinct
 * operator whose answer the run carries — so the payment is a fact about the
 * transcript, not the recorder's word.
 */
export interface RunInferenceCredits {
  action: "infer";
  /** Credits each distinct agreeing operator earned. */
  bounty: number;
  /** How many distinct operators were paid. */
  paid: number;
  /** Commitment over the run's credit records. */
  ledgerRoot: string;
}

export interface ModelRunBody {
  kind: typeof RUN_KIND;
  deployment: { id: string; digest: string };
  model: { id: string; weightsDigest: string | null };
  engine: { name: EngineName; version: string | null };
  /** Present when the run names a RAREXT-hosted model bundle. */
  bundle?: RunBundleRef;
  /** Present when the deployment required agreement across providers. */
  quorum?: RunQuorum;
  /** Present when the deployment committed a bounty and a quorum agreed. */
  credits?: RunInferenceCredits;
  /** The upstream API shape the transcript records. Absent on older records. */
  api?: ApiShape;
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
  /**
   * Present when the challenge commits a RAREXT-hosted model. A run or card
   * that does not name the same bundle fails, so weights cannot be swapped
   * between a verified card and an unrelated transcript.
   */
  bundleDigest?: string;
  shardsRoot?: string;
  manifestHash?: string;
  /**
   * How many providers must agree before a run is attested. Absent or 1 means
   * the single committed endpoint is enough. When set, a run without matching
   * quorum evidence fails verification.
   */
  quorum?: number;
  /**
   * Distinct provider-operator identities the deployment committed, when its
   * provider cards named them. A quorum run must count that many distinct
   * operators among the providers that agreed, not just that many endpoints.
   */
  operators?: string[];
  /**
   * The credits each distinct agreeing operator earns for a run, when the
   * deployment commits a bounty. When set, the verifier requires every run to
   * carry matching `credits`, recomputed from the quorum evidence.
   */
  inferenceBounty?: number;
  /**
   * When "machine", the quorum must be met by agreeing providers that attested
   * DISTINCT machines. `machines` is the operator-aligned machine list the
   * deployment committed from the signed provider cards, so a run cannot invent
   * a machine: each agreeing provider's (operator, machine) pair must be one the
   * deployment committed.
   */
  independence?: "machine";
  /** Machine identities, aligned index-for-index with `operators`. */
  machines?: string[];
}

export interface ProviderCardVerification {
  correct: boolean;
  score: number;
  proof: unknown;
  details: {
    representation: "exact";
    providerCardDigest: string;
    endpoint: string;
    bundleDigest: string;
    modelId: string;
    checks: string[];
  };
  error?: string;
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
    /** Wall time covered by startedAt/completedAt, when both parse. */
    durationMs: number | null;
    /** completionTokens per second over durationMs, when both are known. */
    tokensPerSecond: number | null;
    checks: string[];
  };
  error?: string;
}

export interface DeploymentVerification {
  correct: boolean;
  score: number;
  proof: unknown;
  details: {
    representation: "exact";
    deploymentDigest: string;
    modelId: string;
    weightsDigest: string | null;
    engine: EngineName;
    backend: HardwareBackend;
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

export interface LedgerAudit {
  ok: boolean;
  count: number;
  /** Hash-chain and record-digest verification. */
  chain: LedgerVerification;
  /** Each run verified against the same deployment challenge. */
  runs: Array<{
    index: number;
    digest: string;
    correct: boolean;
    error: string | null;
  }>;
}
