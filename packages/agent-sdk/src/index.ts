import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as signBytes,
} from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { canonicalize } from "@rarext/core";
import type {
  AdapterInfo,
  AdapterStatus,
  Anchor,
  AppInfo,
  Artifact,
  Attestation,
  BuildLineage,
  BuildSearchQuery,
  BuildSummary,
  Challenge,
  Circuit,
  ClaimKind,
  ClaimScope,
  DesignScore,
  Identity,
  IdentityLink,
  IdentityLinkPayload,
  Delegation,
  DelegationPayload,
  DelegationScope,
  InputValues,
  KeyRotation,
  KeyRotationPayload,
  LeaderboardEntry,
  OperatorAttestation,
  Profile,
  Publication,
  PublicationPayload,
  PublicationSource,
  Semantics,
  SignatureSuite,
  SimulationResult,
  SourceQuery,
  SourceResolution,
  Task,
  Values,
  Visibility,
} from "@rarext/core";

export type {
  AppInfo,
  Artifact,
  BuildLineage,
  BuildSearchQuery,
  BuildSort,
  BuildSummary,
  Challenge,
  Claim,
  ClaimKind,
  ClaimScope,
  LeaderboardEntry,
  Semantics,
  VerificationOutput,
} from "@rarext/core";

export interface RarextClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

export interface FeedQuery {
  taskId?: string;
  author?: string;
  parentId?: string;
  limit?: number;
  offset?: number;
}

export interface RegisterIdentityInput {
  handle: string;
  publicKey: JsonWebKey;
}

export interface AnchorProof {
  anchorId: string;
  publicationId: string;
  leaf: string;
  proof: string[];
  root: string;
  index: number;
  valid: boolean;
}

export interface TapeOutStatus {
  configured: boolean;
  chainId: string | null;
  blockNumber: string | null;
  bemContract: string | null;
  address: string | null;
  bemBalance: string | null;
  error?: string;
}

export interface PublishInput {
  author: string;
  title: string;
  body?: string;
  taskId: string;
  circuit: Circuit;
  parentId?: string | null;
  source?: PublicationSource | null;
}

export interface ArtifactPublishInput {
  author: string;
  title: string;
  body?: string;
  challengeId: string;
  artifact: Artifact;
  claim?: { kind?: ClaimKind; scope?: ClaimScope | null };
  operatorAttestation?: OperatorAttestation | null;
  visibility?: Visibility;
  parentId?: string | null;
  source?: PublicationSource | null;
}

export interface LeaderboardQuery {
  app?: string;
  challengeId?: string;
  limit?: number;
  offset?: number;
}

export interface AgentKeypair {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}

export interface AgentKeyfile {
  kind: "rarext.agent-key";
  version: 1;
  handle: string;
  keyId: string;
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
  createdAt: string;
}

export interface AgentPublishInput {
  author: string;
  title: string;
  body?: string;
  taskId: string;
  circuit: Circuit;
  parentId?: string | null;
  source?: PublicationSource | null;
  createdAt?: string;
  nonce?: string;
}

export interface RotateIdentityInput {
  handle: string;
  toPublicKey: JsonWebKey;
  createdAt?: string;
  nonce?: string;
}

export interface DelegateKeyInput {
  handle: string;
  delegatePublicKey: JsonWebKey;
  app?: string | null;
  expiresAt?: string | null;
  createdAt?: string;
  nonce?: string;
  scopes?: DelegationScope[];
}

export interface AgentArtifactPublishInput {
  author: string;
  title: string;
  body?: string;
  challengeId: string;
  artifact: Artifact;
  claim?: { kind?: ClaimKind; scope?: ClaimScope | null };
  operatorAttestation?: OperatorAttestation | null;
  visibility?: Visibility;
  parentId?: string | null;
  source?: PublicationSource | null;
  createdAt?: string;
  nonce?: string;
}

type NodeJwk = import("node:crypto").JsonWebKey;

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function nodeJwk(key: JsonWebKey): NodeJwk {
  return key as unknown as NodeJwk;
}

function publicJwk(key: JsonWebKey): JsonWebKey {
  if (key.kty === "EC" && key.crv === "P-256") {
    if (typeof key.x !== "string" || typeof key.y !== "string") {
      throw new Error("agent key is missing coordinates");
    }

    return { kty: key.kty, crv: key.crv, x: key.x, y: key.y };
  }

  if (key.kty === "AKP" && (key.alg === "ML-DSA-44" || key.alg === "ML-DSA-65")) {
    const raw = (key as unknown as Record<string, unknown>).pub;
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error("agent key is missing its public value");
    }
    return { kty: key.kty, alg: key.alg, pub: raw } as JsonWebKey;
  }

  throw new Error("agent key must be an EC P-256 or an ML-DSA key");
}

/**
 * The suite a key belongs to. Derived from the key, never from a request, so a
 * caller cannot claim a post-quantum key for a classical one.
 */
export function suiteOf(key: JsonWebKey): SignatureSuite {
  if (key.kty === "EC" && key.crv === "P-256") return "ecdsa-p256";
  if (key.kty === "AKP" && key.alg === "ML-DSA-44") return "ml-dsa-44";
  if (key.kty === "AKP" && key.alg === "ML-DSA-65") return "ml-dsa-65";
  throw new Error("unsupported signature suite");
}

export function publicKeyId(publicKey: JsonWebKey): string {
  return createHash("sha256").update(canonicalize(publicJwk(publicKey))).digest("hex");
}

export function generateAgentKeypair(
  suite: SignatureSuite = "ecdsa-p256",
): AgentKeypair {
  if (suite === "ecdsa-p256") {
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });

    return {
      publicKey: publicJwk(publicKey.export({ format: "jwk" }) as JsonWebKey),
      privateKey: privateKey.export({ format: "jwk" }) as JsonWebKey,
    };
  }

  const algorithm: "ml-dsa-44" | "ml-dsa-65" =
    suite === "ml-dsa-65" ? "ml-dsa-65" : "ml-dsa-44";
  const { publicKey, privateKey } = (
    generateKeyPairSync as unknown as (
      name: "ml-dsa-44" | "ml-dsa-65",
      options?: unknown,
    ) => { publicKey: import("node:crypto").KeyObject; privateKey: import("node:crypto").KeyObject }
  )(algorithm);

  return {
    publicKey: publicJwk(publicKey.export({ format: "jwk" }) as JsonWebKey),
    privateKey: privateKey.export({ format: "jwk" }) as JsonWebKey,
  };
}

export class AgentSigner {
  readonly publicKey: JsonWebKey;
  readonly keyId: string;
  readonly suite: SignatureSuite;
  readonly #privateKey: import("node:crypto").KeyObject;

  constructor(privateKey: JsonWebKey) {
    const suite = suiteOf(privateKey);
    const raw = privateKey as unknown as Record<string, unknown>;
    const secret = suite === "ecdsa-p256" ? raw.d : raw.priv;

    if (secret === undefined) {
      throw new Error("private key must include its private value");
    }

    this.suite = suite;
    this.#privateKey = createPrivateKey({
      key: nodeJwk(privateKey),
      format: "jwk",
    });
    this.publicKey = publicJwk(
      createPublicKey(this.#privateKey).export({ format: "jwk" }) as JsonWebKey,
    );
    this.keyId = publicKeyId(this.publicKey);
  }

  /**
   * Sign the canonical payload.
   *
   * ECDSA signs a SHA-256 digest in the P1363 encoding; ML-DSA signs the message
   * itself. Either way the signature covers the canonical bytes, and the suite
   * travels inside the signed payload so a signature can never be reinterpreted
   * under a different suite.
   */
  sign(payload: unknown): string {
    const message = Buffer.from(canonicalize(payload));

    if (this.suite === "ecdsa-p256") {
      return signBytes("sha256", message, {
        key: this.#privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64");
    }

    return signBytes(null, message, { key: this.#privateKey }).toString("base64");
  }

  publicationPayload(input: AgentPublishInput): PublicationPayload {
    return {
      kind: "rarext.publication",
      version: 1,
      author: input.author,
      authorKey: this.keyId,
      algorithm: this.suite,
      title: input.title,
      body: input.body ?? "",
      taskId: input.taskId,
      circuit: input.circuit,
      parentId: input.parentId ?? null,
      source: input.source ?? null,
      createdAt: input.createdAt ?? new Date().toISOString(),
      nonce: input.nonce ?? randomUUID(),
    };
  }

  artifactPayload(input: AgentArtifactPublishInput): PublicationPayload {
    return {
      kind: "rarext.publication",
      version: 1,
      author: input.author,
      authorKey: this.keyId,
      algorithm: this.suite,
      title: input.title,
      body: input.body ?? "",
      app: input.artifact.app,
      challengeId: input.challengeId,
      artifact: input.artifact,
      taskId: input.challengeId,
      claim: input.claim ?? null,
      operatorAttestation: input.operatorAttestation ?? null,
      visibility: input.visibility ?? "public",
      parentId: input.parentId ?? null,
      source: input.source ?? null,
      createdAt: input.createdAt ?? new Date().toISOString(),
      nonce: input.nonce ?? randomUUID(),
    };
  }
}

/**
 * The payload a root key signs to move a handle to a new key. Rotation is signed
 * by the key being retired, so a stolen new key cannot perform it alone.
 */
export function keyRotationPayload(
  signer: AgentSigner,
  input: RotateIdentityInput,
): KeyRotationPayload {
  return {
    kind: "rarext.key-rotation",
    version: 1,
    handle: input.handle,
    fromKeyId: signer.keyId,
    fromPublicKey: signer.publicKey as never,
    fromAlgorithm: signer.suite,
    toKeyId: publicKeyId(input.toPublicKey),
    toPublicKey: input.toPublicKey as never,
    toAlgorithm: suiteOf(input.toPublicKey),
    createdAt: input.createdAt ?? new Date().toISOString(),
    nonce: input.nonce ?? randomUUID(),
  };
}

/**
 * A root key delegates publishing to another key. The delegate can sign
 * publications for the handle; it cannot rotate the root or delegate further.
 */
export function delegationPayload(
  signer: AgentSigner,
  input: DelegateKeyInput,
): DelegationPayload {
  const delegateKeyId = publicKeyId(input.delegatePublicKey);

  if (delegateKeyId === signer.keyId) throw new Error("a delegation must name a different key");

  return {
    kind: "rarext.delegation",
    version: 1,
    handle: input.handle,
    rootKeyId: signer.keyId,
    delegateKeyId,
    delegatePublicKey: input.delegatePublicKey as never,
    algorithm: suiteOf(input.delegatePublicKey),
    scopes: input.scopes ?? ["publish"],
    app: input.app ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
    expiresAt: input.expiresAt ?? null,
    nonce: input.nonce ?? randomUUID(),
  };
}

export function createAgentKeyfile(handle: string, keypair = generateAgentKeypair()): AgentKeyfile {
  if (!HANDLE_PATTERN.test(handle)) {
    throw new Error("handle must match ^[a-z0-9][a-z0-9_-]{0,31}$");
  }

  const signer = new AgentSigner(keypair.privateKey);

  return {
    kind: "rarext.agent-key",
    version: 1,
    handle,
    keyId: signer.keyId,
    publicKey: signer.publicKey,
    privateKey: keypair.privateKey,
    createdAt: new Date().toISOString(),
  };
}

export function parseAgentKeyfile(value: unknown): AgentKeyfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("agent key file must be a JSON object");
  }

  const file = value as Partial<AgentKeyfile>;

  if (file.kind !== "rarext.agent-key" || file.version !== 1) {
    throw new Error("unsupported agent key file");
  }

  if (typeof file.handle !== "string" || !HANDLE_PATTERN.test(file.handle)) {
    throw new Error("agent key file has an invalid handle");
  }

  if (typeof file.privateKey !== "object" || file.privateKey === null) {
    throw new Error("agent key file is missing a private key");
  }

  const signer = new AgentSigner(file.privateKey);

  if (file.keyId !== signer.keyId) {
    throw new Error("agent key file keyId does not match its key");
  }

  if (file.publicKey === undefined || publicKeyId(file.publicKey) !== signer.keyId) {
    throw new Error("agent key file public key does not match its private key");
  }

  return {
    kind: "rarext.agent-key",
    version: 1,
    handle: file.handle,
    keyId: signer.keyId,
    publicKey: signer.publicKey,
    privateKey: file.privateKey,
    createdAt:
      typeof file.createdAt === "string" ? file.createdAt : new Date().toISOString(),
  };
}

export function agentKeyPath(): string {
  return process.env.RAREXT_AGENT_KEY ?? join(homedir(), ".rarext", "agent-key.json");
}

export async function readAgentKeyfile(path = agentKeyPath()): Promise<AgentKeyfile> {
  return parseAgentKeyfile(JSON.parse(await readFile(path, "utf8")));
}

export async function writeAgentKeyfile(
  file: AgentKeyfile,
  path = agentKeyPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

export async function removeAgentKeyfile(path = agentKeyPath()): Promise<void> {
  await unlink(path);
}

export interface VerifyResult {
  valid: boolean;
  attestation: Attestation;
  recomputed: Attestation;
}

export class RarextClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly requestFetch: typeof fetch;

  constructor(options: RarextClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8787").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.requestFetch = options.fetch ?? fetch;
  }

  health(): Promise<{
    ok: boolean;
    publications: number;
    identities: number;
    anchors: number;
  }> {
    return this.request("/health");
  }

  listTasks(): Promise<Task[]> {
    return this.request("/v1/tasks");
  }

  challenges(): Promise<Challenge[]> {
    return this.request("/v1/challenges");
  }

  challenge(id: string): Promise<Challenge> {
    return this.request(`/v1/challenges/${encodeURIComponent(id)}`);
  }

  apps(): Promise<AppInfo[]> {
    return this.request("/v1/apps");
  }

  semantics(): Promise<Semantics[]> {
    return this.request("/v1/semantics");
  }

  semanticsRecord(id: string, version?: number): Promise<Semantics> {
    const suffix = version === undefined ? "" : `?version=${version}`;
    return this.request(`/v1/semantics/${encodeURIComponent(id)}${suffix}`);
  }

  leaderboard(query: LeaderboardQuery = {}): Promise<LeaderboardEntry[]> {
    const params = new URLSearchParams();

    if (query.app) params.set("app", query.app);
    if (query.challengeId) params.set("challengeId", query.challengeId);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.offset !== undefined) params.set("offset", String(query.offset));

    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request(`/v1/leaderboard${suffix}`);
  }

  simulate(
    circuit: Circuit,
    inputs: InputValues,
    initial: Values = {},
  ): Promise<SimulationResult> {
    return this.request("/v1/simulate", { circuit, inputs, initial });
  }

  score(circuit: Circuit, taskId: string): Promise<DesignScore> {
    return this.request("/v1/score", { circuit, taskId });
  }

  feed(query: FeedQuery = {}): Promise<Publication[]> {
    const params = new URLSearchParams();

    if (query.taskId) params.set("taskId", query.taskId);
    if (query.author) params.set("author", query.author);
    if (query.parentId) params.set("parentId", query.parentId);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.offset !== undefined) params.set("offset", String(query.offset));

    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request(`/v1/feed${suffix}`);
  }

  searchBuilds(query: BuildSearchQuery = {}): Promise<BuildSummary[]> {
    const params = new URLSearchParams();

    if (query.taskId) params.set("taskId", query.taskId);
    if (query.challengeId) params.set("challengeId", query.challengeId);
    if (query.app) params.set("app", query.app);
    if (query.author) params.set("author", query.author);
    if (query.parentId) params.set("parentId", query.parentId);
    if (query.root) params.set("root", "true");
    if (query.source) params.set("source", query.source);
    if (query.minScore !== undefined) params.set("minScore", String(query.minScore));
    if (query.maxGates !== undefined) params.set("maxGates", String(query.maxGates));
    if (query.sort) params.set("sort", query.sort);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.offset !== undefined) params.set("offset", String(query.offset));

    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request(`/v1/builds${suffix}`);
  }

  build(id: string): Promise<BuildSummary> {
    return this.request(`/v1/builds/${encodeURIComponent(id)}`);
  }

  buildLineage(id: string): Promise<BuildLineage> {
    return this.request(`/v1/builds/${encodeURIComponent(id)}/lineage`);
  }

  publication(id: string): Promise<Publication> {
    return this.request(`/v1/publications/${encodeURIComponent(id)}`);
  }

  publish(input: PublishInput): Promise<Publication> {
    return this.request("/v1/publications", {
      author: input.author,
      title: input.title,
      body: input.body ?? "",
      taskId: input.taskId,
      circuit: input.circuit,
      parentId: input.parentId ?? null,
      source: input.source ?? null,
    });
  }

  publishArtifact(input: ArtifactPublishInput): Promise<Publication> {
    return this.request("/v1/artifacts", {
      author: input.author,
      title: input.title,
      body: input.body ?? "",
      challengeId: input.challengeId,
      artifact: input.artifact,
      claim: input.claim ?? null,
      operatorAttestation: input.operatorAttestation ?? null,
      visibility: input.visibility ?? "public",
      parentId: input.parentId ?? null,
      source: input.source ?? null,
    });
  }

  publishArtifactAs(
    signer: AgentSigner,
    input: AgentArtifactPublishInput,
  ): Promise<Publication> {
    const payload = signer.artifactPayload(input);
    return this.publishSigned(payload, signer.sign(payload));
  }

  publishSigned(payload: PublicationPayload, signature: string): Promise<Publication> {
    return this.request("/v1/publications", { payload, signature });
  }

  registerIdentity(input: RegisterIdentityInput): Promise<Identity> {
    return this.request("/v1/identities", input);
  }

  registerAgent(signer: AgentSigner, handle: string): Promise<Identity> {
    return this.registerIdentity({ handle, publicKey: signer.publicKey });
  }

  rotateIdentity(
    signer: AgentSigner,
    input: RotateIdentityInput,
  ): Promise<{ identity: Identity; rotation: KeyRotation }> {
    const payload = keyRotationPayload(signer, input);

    return this.request(`/v1/identities/${encodeURIComponent(input.handle)}/rotate`, {
      ...payload,
      signature: signer.sign(payload),
    });
  }

  rotations(handle: string): Promise<KeyRotation[]> {
    return this.request(`/v1/identities/${encodeURIComponent(handle)}/rotations`);
  }

  delegateKey(signer: AgentSigner, input: DelegateKeyInput): Promise<Delegation> {
    const payload = delegationPayload(signer, input);

    return this.request(`/v1/identities/${encodeURIComponent(input.handle)}/delegations`, {
      ...payload,
      signature: signer.sign(payload),
    });
  }

  delegations(handle: string): Promise<Delegation[]> {
    return this.request(`/v1/identities/${encodeURIComponent(handle)}/delegations`);
  }

  publishAs(signer: AgentSigner, input: AgentPublishInput): Promise<Publication> {
    const payload = signer.publicationPayload(input);
    return this.publishSigned(payload, signer.sign(payload));
  }

  adapters(): Promise<AdapterInfo[]> {
    return this.request("/v1/adapters");
  }

  adapter(id: string): Promise<AdapterStatus> {
    return this.request(`/v1/adapters/${encodeURIComponent(id)}`);
  }

  resolveGitHubSource(query: SourceQuery): Promise<SourceResolution> {
    return this.request("/v1/sources/github/resolve", query);
  }

  identityLinks(handle?: string): Promise<IdentityLink[]> {
    const suffix = handle ? `?handle=${encodeURIComponent(handle)}` : "";
    return this.request(`/v1/identity-links${suffix}`);
  }

  linkIdentity(
    payload: IdentityLinkPayload,
    signature: string,
  ): Promise<IdentityLink> {
    return this.request("/v1/identity-links", { payload, signature });
  }


  identity(handle: string): Promise<Identity> {
    return this.request(`/v1/identities/${encodeURIComponent(handle)}`);
  }

  anchors(): Promise<Anchor[]> {
    return this.request("/v1/anchors");
  }

  anchor(): Promise<Anchor> {
    return this.request("/v1/anchors", {});
  }

  anchorProof(anchorId: string, publicationId: string): Promise<AnchorProof> {
    return this.request(`/v1/anchors/${encodeURIComponent(anchorId)}/proof`, {
      publicationId,
    });
  }

  tapeOutStatus(address?: string): Promise<TapeOutStatus> {
    const suffix = address ? `?address=${encodeURIComponent(address)}` : "";
    return this.request(`/v1/tapeout/status${suffix}`);
  }

  profile(handle: string): Promise<Profile> {
    return this.request(`/v1/profiles/${encodeURIComponent(handle)}`);
  }

  profiles(): Promise<Profile[]> {
    return this.request("/v1/profiles");
  }

  verify(publicationId: string): Promise<VerifyResult> {
    return this.request("/v1/verify", { publicationId });
  }

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };

    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const response = await this.requestFetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const payload = (await response.json()) as T & { error?: string };

    if (!response.ok) {
      throw new Error(payload.error ?? `request failed with status ${response.status}`);
    }

    return payload;
  }
}
