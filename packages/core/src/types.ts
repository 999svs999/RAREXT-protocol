export type Bit = 0 | 1;

export type ComponentType = "INPUT" | "OUTPUT" | "NAND" | "LATCH";

export interface Component {
  id: string;
  type: ComponentType;
  inputs?: string[];
}

export interface Circuit {
  components: Component[];
}

export interface Artifact {
  app: string;
  kind: string;
  version: number;
  mediaType: string;
  body: unknown;
}

export interface Challenge {
  id: string;
  app: string;
  title: string;
  description: string;
  version: number;
  spec: unknown;
  semanticsId: string;
  semanticsVersion: number;
  createdAt: string;
}

export type ClaimKind = "satisfies" | "attests" | "produces" | "derives";

export type ProofKind = "recomputable" | "committed" | "attested";

export interface ClaimScope {
  [key: string]: string;
}

export interface SemanticsInterpretation {
  doc: string;
  owner: string;
  reviewedAt: string;
}

export interface Semantics {
  id: string;
  app: string;
  version: number;
  claimKind: ClaimKind;
  title: string;
  summary: string;
  specHash: string;
  verifierHash: string | null;
  inputs: string[];
  outputs: string[];
  interpretation: SemanticsInterpretation | null;
  owner: string;
  origin: "declared" | "derived";
  createdAt: string;
}

export type SemanticsBinding = "ok" | "missing" | "version-mismatch" | "spec-mismatch";

export interface Claim {
  kind: ClaimKind;
  subject: string;
  semanticsId: string;
  semanticsVersion: number;
  semanticsHash: string;
  predicate: string;
  scope: ClaimScope | null;
  proofKind: ProofKind;
  proofHash: string;
  verifier: string;
  verifierHash: string;
  createdAt: string;
}

export interface AppInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  artifactKinds: string[];
  challengeCount: number;
  verifier: "builtin" | "http";
  configured: boolean;
  url: string | null;
}

export interface VerificationOutput {
  correct: boolean;
  score: number;
  gateCount?: number;
  proof?: unknown;
  details?: unknown;
}

export type InputValues = Record<string, Bit>;
export type Values = Record<string, Bit>;

export interface SimulationResult {
  outputs: Values;
  values: Values;
  settled: boolean;
  iterations: number;
  trace: Values[];
}

export interface TaskCase {
  inputs: InputValues;
  outputs: Values;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  inputs: string[];
  outputs: string[];
  cases: TaskCase[];
  referenceGateCount: number;
}

export interface DesignScore {
  taskId: string;
  correct: boolean;
  passed: number;
  total: number;
  gateCount: number;
  efficiency: number;
  score: number;
}

export interface Attestation {
  id: string;
  verifier: string;
  app?: string;
  challengeId?: string;
  taskId: string;
  circuitHash: string;
  traceHash: string;
  correct: boolean;
  score: number;
  gateCount: number;
  semanticsId: string;
  semanticsVersion: number;
  semanticsHash: string;
  claimKind: ClaimKind;
  scope: ClaimScope | null;
  verifierHash: string;
  createdAt: string;
}

export type StorageTier = "public" | "sealed";

export interface BlobRecord {
  hash: string;
  size: number;
  mediaType: string;
  tier: StorageTier;
  sealed: boolean;
  createdAt: string;
}

export interface StorageManifestEntry {
  hash: string;
  size: number;
  tier: StorageTier;
  sealed: boolean;
  retentionUntil: string | null;
}

export interface StorageManifest {
  policy: string;
  blobs: StorageManifestEntry[];
}

export interface StorageUsage {
  tier: StorageTier;
  blobs: number;
  bytes: number;
  retainedUntil: string | null;
}

export interface StorageInclusionProof {
  hash: string;
  index: number;
  leaf: string;
  proof: string[];
  root: string;
  manifestId: string | null;
  anchorId: string | null;
  anchorRoot: string | null;
  valid: boolean;
}

export type AdapterKind = "network" | "source";

export type AdapterCapability =
  | "anchor"
  | "identity"
  | "assets"
  | "source"
  | "read";

export interface AdapterInfo {
  id: string;
  name: string;
  kind: AdapterKind;
  capabilities: AdapterCapability[];
  configured: boolean;
  status: "ready" | "unconfigured" | "error";
  description: string;
  url: string | null;
}

export interface AdapterStatus extends AdapterInfo {
  details: Record<string, unknown>;
}

export interface AdapterReceipt {
  adapter: string;
  status: "ok" | "skipped" | "error";
  reference: string | null;
  error?: string;
}

export interface PublicationSource {
  kind: "github" | "gitlab" | "codeberg" | "url";
  repo: string | null;
  url: string;
  ref: string | null;
  path: string | null;
  commit: string | null;
  license: string | null;
}

export interface SourceQuery {
  repo: string;
  ref?: string | null;
  path?: string | null;
  taskId?: string | null;
}

export interface SourceResolution {
  source: PublicationSource;
  title: string | null;
  description: string | null;
  stars: number | null;
  circuit: Circuit | null;
  circuitHash: string | null;
  score: DesignScore | null;
}

export interface IdentityLink {
  id: string;
  handle: string;
  network: string;
  externalId: string;
  proofUrl: string;
  verified: boolean;
  createdAt: string;
}

export interface IdentityLinkPayload {
  kind: "rarext.identity-link";
  version: 1;
  handle: string;
  keyId: string;
  network: string;
  externalId: string;
  proofUrl: string;
  createdAt: string;
  nonce: string;
}

export interface Publication {
  id: string;
  author: string;
  authorKey: string | null;
  title: string;
  body: string;
  app: string;
  challengeId: string;
  artifact: Artifact;
  taskId: string;
  circuit?: Circuit;
  parentId: string | null;
  source: PublicationSource | null;
  createdAt: string;
  attestedAt: string;
  verified: boolean;
  signature: string | null;
  nonce: string | null;
  attestation: Attestation;
}

export type BuildSort = "recent" | "score" | "gates" | "reuses";

export interface BuildSearchQuery {
  taskId?: string;
  challengeId?: string;
  app?: string;
  author?: string;
  parentId?: string;
  root?: boolean;
  source?: PublicationSource["kind"];
  minScore?: number;
  maxGates?: number;
  sort?: BuildSort;
  limit?: number;
  offset?: number;
}

export interface BuildSummary extends Publication {
  reuses: number;
}

export interface BuildLineage {
  build: BuildSummary;
  ancestors: BuildSummary[];
  descendants: BuildSummary[];
}

export interface LeaderboardEntry {
  rank: number;
  buildId: string;
  author: string;
  app: string;
  challengeId: string;
  score: number;
  gateCount: number;
  createdAt: string;
}

export interface Profile {
  handle: string;
  verified: boolean;
  publications: number;
  attestations: number;
  bestScore: number;
  totalScore: number;
  createdAt: string;
  lastPublishedAt: string | null;
}

export interface Identity {
  handle: string;
  keyId: string;
  publicKey: JsonWebKey;
  createdAt: string;
}

export interface Anchor {
  id: string;
  root: string;
  publicationIds: string[];
  leafCount: number;
  leafVersion?: number;
  createdAt: string;
  adapter: string;
  reference: string | null;
  receipts: AdapterReceipt[];
}

export interface PublicationPayload {
  kind: "rarext.publication";
  version: 1;
  author: string;
  authorKey: string;
  title: string;
  body: string;
  app?: string;
  challengeId?: string;
  artifact?: Artifact;
  taskId: string;
  circuit?: Circuit;
  claim?: { kind?: ClaimKind; scope?: ClaimScope | null } | null;
  parentId: string | null;
  source?: PublicationSource | null;
  createdAt: string;
  nonce: string;
}
