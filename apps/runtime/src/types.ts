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
  /**
   * The engine image/binary digest when the operator can report one. Null is
   * honest; a replay that pins the engine treats a changed digest as a
   * different engine.
   */
  digest?: string | null;
  /**
   * sha256 over `{name, version, digest}`: the engine pin a run records and a
   * replay checks against the provider's present engine.
   */
  fingerprint?: string;
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
 * What an engine claims about its arithmetic. `deterministic-replay` is the
 * strong class: the deployment asserts that a second, independently recorded
 * run reproduces the decode trace token-for-token. The protocol cannot prove
 * the arithmetic from one run, so the claim is backed by evidence: a witness run
 * the provider signed. A deployment that does not commit a class makes no claim.
 */
export type DeterminismClass = "deterministic-replay";

/**
 * An independently recorded second run, carrying its own provider signature.
 * It is not the recorder's word: the provider that produced it signed the
 * request and the response (including the decode trace), so a gateway cannot
 * fabricate a matching witness for a run the engine would not reproduce.
 */
export interface ReplayWitness {
  kind: "rarext.replay-witness.v1";
  /** The independent provider that produced the second run. */
  provider: {
    endpoint: string;
    /** The signing provider's key id (the operator), when known. */
    operator?: string | null;
    machine?: string | null;
  };
  /** The exact request the witness sent; it must equal the run's request. */
  request: unknown;
  /** The exact response the independent provider returned. */
  response: unknown;
  /** The provider's own signed receipt over that request and response. */
  receipt: unknown;
  recordedAt: string;
}

/** A run's determinism claim: the class plus the witness that backs it. */
export interface DeterminismClaim {
  kind: "rarext.determinism.v1";
  class: DeterminismClass;
  witness: ReplayWitness;
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
  /**
   * The measurement the provider attested. A deployment may commit an allowlist
   * of measurements, and then a provider running software the deployment did not
   * approve is refused — the machine claim is checked, not taken on faith.
   */
  measurement?: string | null;
  /**
   * The provider's full independence attestation, including the vendor-signed
   * quote. Recorded so a verifier can check the quote against the deployment's
   * pinned vendor key without trusting the gateway.
   */
  attestation?: RunProviderAttestation;
  /**
   * The provider's OWN signature over the request and the response it returned.
   * Recorded so the transcript proves what the provider said, rather than
   * trusting the gateway that relayed it.
   */
  receipt?: unknown;
}

/** The independence attestation as a run records it, quote included. */
export interface RunProviderAttestation {
  kind?: string;
  scheme?: string;
  machine?: string | null;
  measurement?: string | null;
  issuedAt?: string;
  /** The measurement of the code the enclave runs, when it attested one. */
  code?: string;
  /** The vendor-signed image manifest vouching for that code, when present. */
  image?: unknown;
  /** The digest of the enclave's encryption public key, when it serves one. */
  enclaveKey?: string;
  /** The freshness nonce the quote was made for, when the deployment challenged it. */
  challenge?: string;
  quote?: { signature: string; publicKey: unknown; suite: string };
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
  engine: { name: EngineName; version: string | null; fingerprint?: string | null };
  /** Present when the run names a RAREXT-hosted model bundle. */
  bundle?: RunBundleRef;
  /**
   * Present when a non-quorum run records the single provider that answered.
   * It carries the endpoint, the operator/attestation the gateway observed, and
   * the provider's own receipt, so a run that commits an engine or bundle is
   * attributable even without a quorum.
   */
  provider?: RunQuorumProvider;
  /** Present when the deployment required agreement across providers. */
  quorum?: RunQuorum;
  /**
   * Present when the run claims a determinism class. A deterministic-replay run
   * carries an independently recorded witness whose decode trace matches this
   * run token-for-token; the verifier checks the witness's provider signature,
   * the shared request, and the trace, so the claim is evidence, not a label.
   */
  determinism?: DeterminismClaim;
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
  /**
   * An ALLOWLIST of accepted machine measurements. When committed, every
   * agreeing provider must attest a measurement on the list, so a quorum cannot
   * be met by a provider running software the deployment did not approve.
   */
  measurements?: string[];
  /**
   * The engine the deployment pinned: a fingerprint over the serving engine's
   * name, version, and (when known) image digest. A run records it, and a
   * replay refuses a provider whose present engine differs.
   */
  engineFingerprint?: string;
  /**
   * The vendor key id whose machine quotes the deployment accepts, when it
   * pinned one. Every agreeing provider's quote must verify under a key with
   * this id, so a forged or unverifiable quote is refused.
   */
  teeVendor?: string;
  /**
   * The root-rotation epoch the deployment has learned. When committed, every
   * agreeing provider's quote must present an append-only root chain from
   * `teeVendor` reaching at least this epoch, terminating at the CURRENT root,
   * and never at a revoked one. A quote whose chain stops at a retired root is
   * refused as stale. Committed only with `teeVendor`.
   */
  teeRootEpoch?: number;
  /**
   * The minimum certificate-chain depth a hardware-rooted deployment requires.
   * A bare leaf is depth 0; a leaf certified by a platform key certified by the
   * vendor root is depth 2. Committed only with `teeVendor`.
   */
  teeChainDepth?: number;
  /**
   * The measured-boot stages a deployment requires the chain to extend through
   * ("firmware", "os", "app"). A quote whose chain omits any of them is refused,
   * so a leaf signed outside the measured boot cannot pass. Committed only with
   * `teeVendor`.
   */
  teeBootStages?: string[];
  /**
   * The measurement the deployment approves for each named boot stage. When
   * committed, each agreeing provider's chain must carry exactly these values,
   * so the stage names are checked, not merely present. Committed only with
   * `teeBootStages`.
   */
  teeStageMeasurements?: Record<string, string>;
  /**
   * When "challenge", the deployment requires a FRESH attestation: the gateway
   * supplies a nonce, the provider binds it into a freshly-signed quote, and a
   * replayed (stale) attestation is refused. Committed only with `teeVendor`.
   */
  teeFreshness?: "challenge";
  /**
   * The measurement of the enclave's own code the deployment approves. When
   * committed, every agreeing provider must attest that code digest, so an
   * enclave running other code is refused. Committed only with `teeVendor`.
   */
  teeCodeMeasurement?: string;
  /**
   * The vendor ROOT key id the enclave IMAGE manifest's certificate chain must
   * terminate at. When committed, every agreeing provider must present a manifest
   * whose chain reaches that root for its code — so a manifest signed by a bare
   * operator key is refused, and the code identity is bound to the pinned trust
   * anchor. Committed only with `teeVendor`.
   */
  teeSignedImage?: string;
  /**
   * The minimum certificate-chain depth the enclave IMAGE manifest must present.
   * A bare leaf (the signer is its own root) is depth 0; a signer certified by the
   * anchor is depth ≥ 1. When committed, a manifest signed directly by the pinned
   * root with no chain is refused, so the signer must be CERTIFIED by the anchor,
   * not merely equal to it. Committed only with `teeSignedImage`.
   */
  teeSignedImageDepth?: number;
  /**
   * When true, the deployment requires every run to carry a valid DECODE TRACE:
   * the native class's token ids, or an engine's token+logprob judgment. A run
   * whose response has no trace is refused, so a provider or engine cannot
   * silently omit the trace and still pass. Committed when `labels.trace` is
   * "required".
   */
  requireTrace?: boolean;
  /**
   * When true, the deployment requires every run to be REPLAYABLE: deterministic
   * decoding (temperature 0 and a seed) with a committed replay envelope. The
   * gateway refuses a sampled request, and the verifier requires the run to carry
   * a valid replay envelope. Committed when `labels.replay` is "required".
   */
  requireReplay?: boolean;
  /**
   * The determinism class the deployment commits. "deterministic-replay" is the
   * strong claim: every run must carry an independently recorded witness whose
   * decode trace (native token ids, or an engine token+logprob judgment) matches
   * the run token-for-token. The witness must be signed by an independent
   * provider, share the exact request, and never come from the run's own
   * providers. Committed only with `requireTrace` and `requireReplay`.
   */
  determinism?: DeterminismClass;
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
