import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import {
  findTask,
  score,
  simulate,
  tasks,
} from "../../../packages/core/src/index.ts";
import type {
  AppInfo,
  Artifact,
  Attestation,
  BuildSearchQuery,
  BuildSort,
  Challenge,
  Circuit,
  ClaimKind,
  ClaimScope,
  Identity,
  LeaderboardEntry,
  IdentityLink,
  IdentityLinkPayload,
  InputValues,
  Publication,
  PublicationPayload,
  PublicationSource,
  Semantics,
  SourceQuery,
  SourceResolution,
  Task,
  Values,
  VerificationOutput,
  Visibility,
} from "../../../packages/core/src/index.ts";

import { AdapterRegistry, createDefaultRegistry } from "./adapters/registry.ts";
import { anchorPending, anchorThreshold, publicationLeaf } from "./anchorer.ts";
import {
  asPublicKey,
  cryptoPolicy,
  keyId,
  profileFor,
  suiteFor,
  verifyPayload,
} from "./identity.ts";
import { merkleProof, verifyProof } from "./merkle.ts";
import {
  createChallengeRegistry,
  type ChallengeRegistry,
} from "./challenges.ts";
import { RarextStore } from "./store.ts";
import { tapeOutStatus } from "./tapeout.ts";
import {
  claimScope,
  createSemanticsRegistry,
  semanticsForChallenge,
  type SemanticsRegistry,
} from "./semantics.ts";
import {
  asManifest,
  BlobStore,
  emptyInclusionProof,
  manifestInclusion,
  verifyManifestInclusion,
} from "./storage.ts";
import { buildBundle, verifyBundle } from "./bundle.ts";
import { ChainRegistry, loadChainConfigs } from "./chains/registry.ts";
import { VerifierModuleRegistry } from "./verifierModules.ts";
import { verifyWorkerSignature } from "./worker.ts";
import {
  ACTIONS,
  actionFor,
  summarizeEarnings,
  workOrders,
  type VerificationSubmission,
} from "./work.ts";
import { verifyCapability, decodeCapability } from "./capabilities.ts";
import {
  loadRevocations,
  verifyRevocation,
  type Revocation,
  type RevocationKind,
} from "./revocations.ts";
import { registrySeedList } from "./registries.ts";
import type { StorageInclusionProof } from "../../../packages/core/src/index.ts";
import {
  createVerifierRegistry,
  type VerifierRegistry,
} from "./verifiers.ts";

const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL("../../web/public/", import.meta.url));
const VERIFIER_MODULES_DIR = fileURLToPath(new URL("../../verifiers/", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

export interface AppOptions {
  store?: RarextStore;
  publicDir?: string;
  registry?: AdapterRegistry;
  challenges?: ChallengeRegistry;
  verifiers?: VerifierRegistry;
  semantics?: SemanticsRegistry;
  chains?: ChainRegistry;
  blobs?: BlobStore;
  fetch?: typeof fetch;
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }

  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolvePromise(undefined);
        return;
      }

      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function asCircuit(value: unknown): Circuit {
  const record = asRecord(value);
  if (!Array.isArray(record.components)) {
    throw new Error("circuit.components must be an array");
  }
  return record as unknown as Circuit;
}

function asInputs(value: unknown): InputValues {
  return asRecord(value) as InputValues;
}

function artifactFromCircuit(circuit: Circuit): Artifact {
  return {
    app: "logic",
    kind: "logic.netlist",
    version: 1,
    mediaType: "application/json",
    body: circuit,
  };
}

function asArtifact(value: unknown): Artifact {
  const record = asRecord(value);

  if (
    typeof record.app !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(record.app)
  ) {
    throw new Error("artifact.app must be a lowercase app id");
  }

  if (typeof record.kind !== "string" || record.kind.length === 0) {
    throw new Error("artifact.kind must be a string");
  }

  if (
    typeof record.version !== "number" ||
    !Number.isInteger(record.version) ||
    record.version < 1
  ) {
    throw new Error("artifact.version must be a positive integer");
  }

  if (typeof record.mediaType !== "string" || record.mediaType.length === 0) {
    throw new Error("artifact.mediaType must be a string");
  }

  if (!("body" in record)) {
    throw new Error("artifact.body is required");
  }

  return {
    app: record.app,
    kind: record.kind,
    version: record.version,
    mediaType: record.mediaType,
    body: record.body,
  };
}

function asAttestation(value: unknown): Attestation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Partial<Attestation>;

  if (
    typeof record.circuitHash !== "string" ||
    typeof record.traceHash !== "string" ||
    typeof record.correct !== "boolean"
  ) {
    return undefined;
  }

  return {
    id: typeof record.id === "string" ? record.id : randomUUID(),
    verifier: typeof record.verifier === "string" ? record.verifier : "author",
    app: typeof record.app === "string" ? record.app : undefined,
    challengeId:
      typeof record.challengeId === "string" ? record.challengeId : undefined,
    taskId: typeof record.taskId === "string" ? record.taskId : "unknown",
    circuitHash: record.circuitHash,
    traceHash: record.traceHash,
    correct: record.correct,
    score: typeof record.score === "number" ? record.score : 0,
    gateCount: typeof record.gateCount === "number" ? record.gateCount : 0,
    semanticsId:
      typeof record.semanticsId === "string" ? record.semanticsId : "unknown",
    semanticsVersion:
      typeof record.semanticsVersion === "number" ? record.semanticsVersion : 1,
    semanticsHash:
      typeof record.semanticsHash === "string" ? record.semanticsHash : "",
    claimKind: record.claimKind ?? "satisfies",
    scope: record.scope ?? null,
    verifierHash:
      typeof record.verifierHash === "string" ? record.verifierHash : "",
    proofKind: record.proofKind === "salted" ? "salted" : "recomputable",
    signatureAlgorithm:
      record.signatureAlgorithm === "ml-dsa-44" ||
      record.signatureAlgorithm === "ml-dsa-65"
        ? record.signatureAlgorithm
        : "ecdsa-p256",
    cryptoProfile:
      record.signatureAlgorithm === "ml-dsa-44" ||
      record.signatureAlgorithm === "ml-dsa-65"
        ? "post-quantum"
        : "classical",
    createdAt:
      typeof record.createdAt === "string"
        ? record.createdAt
        : new Date().toISOString(),
  };
}

function asVisibility(value: unknown): Visibility {
  if (value === "unlisted" || value === "sealed") return value;
  return "public";
}

function asClaim(value: unknown): { kind?: ClaimKind; scope?: ClaimScope | null } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const record = value as { kind?: unknown; scope?: unknown };
  const kinds = ["satisfies", "attests", "produces", "derives"];

  if (record.kind !== undefined && !kinds.includes(String(record.kind))) {
    throw new Error(`claim.kind must be one of: ${kinds.join(", ")}`);
  }

  return {
    kind: record.kind as ClaimKind | undefined,
    scope: claimScope(record.scope),
  };
}

function asHandle(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(value)) {
    throw new Error("author must be a lowercase handle of 1-32 characters");
  }
  return value;
}

function asText(value: unknown, max: number, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }

  const text = value.trim();

  if (text.length === 0 || text.length > max) {
    throw new Error(`${field} must be between 1 and ${max} characters`);
  }

  return text;
}

function optionalText(value: unknown, max: number, field: string): string {
  if (value === undefined || value === null) return "";

  if (typeof value !== "string" || value.length > max) {
    throw new Error(`${field} must be a string of at most ${max} characters`);
  }

  return value.trim();
}

function optionalId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("parentId must be a string");
  return value;
}

function parseLimit(value: string | null): number {
  if (value === null) return 50;
  const limit = Number(value);
  if (!Number.isFinite(limit)) throw new Error("limit must be a number");
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function parseOffset(value: string | null): number {
  if (value === null) return 0;
  const offset = Number(value);
  if (!Number.isFinite(offset)) throw new Error("offset must be a number");
  return Math.min(Math.max(Math.trunc(offset), 0), 1_000_000);
}

function parseOptionalNumber(value: string | null, field: string): number | undefined {
  if (value === null || value === "") return undefined;

  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error(`${field} must be a number`);
  }

  return number;
}

function parseBuildSort(value: string | null): BuildSort {
  if (value === null || value === "") return "recent";

  if (value === "recent" || value === "score" || value === "gates" || value === "reuses") {
    return value;
  }

  throw new Error("sort must be recent, score, gates, or reuses");
}

function parseSourceKind(
  value: string | null,
): PublicationSource["kind"] | undefined {
  if (value === null || value === "") return undefined;

  if (value === "github" || value === "gitlab" || value === "codeberg" || value === "url") {
    return value;
  }

  throw new Error("source must be github, gitlab, codeberg, or url");
}

function asPayload(value: Record<string, unknown>): PublicationPayload {
  if (value.kind !== "rarext.publication" && value.kind !== "fabric.publication") {
    throw new Error("payload.kind must be rarext.publication");
  }

  if (value.version !== 1) {
    throw new Error("payload.version must be 1");
  }

  const author = asHandle(value.author);

  if (typeof value.authorKey !== "string" || !/^[0-9a-f]{64}$/.test(value.authorKey)) {
    throw new Error("payload.authorKey must be a 64-character hex key id");
  }

  const circuit =
    value.circuit === undefined || value.circuit === null
      ? undefined
      : asCircuit(value.circuit);
  const artifact =
    value.artifact === undefined || value.artifact === null
      ? circuit
        ? artifactFromCircuit(circuit)
        : undefined
      : asArtifact(value.artifact);

  if (!artifact) {
    throw new Error("payload.artifact or payload.circuit is required");
  }

  if (value.app !== undefined && value.app !== artifact.app) {
    throw new Error("payload.app must match payload.artifact.app");
  }

  const challengeId =
    typeof value.challengeId === "string"
      ? value.challengeId
      : typeof value.taskId === "string"
        ? value.taskId
        : null;

  if (!challengeId) {
    throw new Error("payload.challengeId or payload.taskId must be a string");
  }

  const createdAt = value.createdAt;

  if (typeof createdAt !== "string") {
    throw new Error("payload.createdAt must be an ISO timestamp");
  }

  const timestamp = Date.parse(createdAt);

  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) {
    throw new Error("payload.createdAt must be within 10 minutes of now");
  }

  if (
    typeof value.nonce !== "string" ||
    value.nonce.length < 8 ||
    value.nonce.length > 128
  ) {
    throw new Error("payload.nonce must be between 8 and 128 characters");
  }

  return {
    kind: "rarext.publication",
    version: 1,
    author,
    authorKey: value.authorKey,
    title: asText(value.title, 120, "title"),
    body: optionalText(value.body, 2000, "body"),
    app: artifact.app,
    challengeId,
    artifact,
    taskId: challengeId,
    circuit:
      circuit ??
      (artifact.app === "logic" &&
      artifact.kind === "logic.netlist" &&
      typeof artifact.body === "object" &&
      artifact.body !== null
        ? asCircuit(artifact.body)
        : undefined),
    parentId: optionalId(value.parentId),
    claim: asClaim(value.claim) ?? null,
    visibility: asVisibility(value.visibility),
    artifactCommitment:
      typeof value.artifactCommitment === "string" ? value.artifactCommitment : null,
    attestation: asAttestation(value.attestation),
    source:
      value.source === undefined || value.source === null
        ? null
        : asSource(value.source),
    createdAt,
    nonce: value.nonce,
  };
}

function asSource(value: unknown): PublicationSource {
  const record = asRecord(value);
  const kind = record.kind;

  if (
    kind !== "github" &&
    kind !== "gitlab" &&
    kind !== "codeberg" &&
    kind !== "url"
  ) {
    throw new Error("source.kind must be github, gitlab, codeberg, or url");
  }

  if (typeof record.url !== "string" || record.url.length > 500) {
    throw new Error("source.url must be a URL string");
  }

  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    throw new Error("source.url must be a valid URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("source.url must use https");
  }

  const optional = (field: string, max: number): string | null => {
    const raw = record[field];
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw !== "string" || raw.length > max) {
      throw new Error(`source.${field} must be a string of at most ${max} characters`);
    }
    return raw;
  };

  const repo = optional("repo", 200);
  if (repo !== null && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("source.repo must be owner/name");
  }

  return {
    kind,
    repo,
    url: url.toString(),
    ref: optional("ref", 200),
    path: optional("path", 500),
    commit: optional("commit", 100),
    license: optional("license", 100),
  };
}

function asLinkPayload(value: Record<string, unknown>): IdentityLinkPayload {
  if (value.kind !== "rarext.identity-link") {
    throw new Error("payload.kind must be rarext.identity-link");
  }

  if (value.version !== 1) {
    throw new Error("payload.version must be 1");
  }

  const handle = asHandle(value.handle);

  if (typeof value.keyId !== "string" || !/^[0-9a-f]{64}$/.test(value.keyId)) {
    throw new Error("payload.keyId must be a 64-character hex key id");
  }

  if (typeof value.network !== "string" || !/^[a-z0-9_-]{2,32}$/.test(value.network)) {
    throw new Error("payload.network must be a lowercase adapter id");
  }

  if (
    typeof value.externalId !== "string" ||
    value.externalId.length === 0 ||
    value.externalId.length > 100
  ) {
    throw new Error("payload.externalId must be between 1 and 100 characters");
  }

  if (typeof value.proofUrl !== "string" || value.proofUrl.length > 500) {
    throw new Error("payload.proofUrl must be a URL string");
  }

  let proofUrl: URL;
  try {
    proofUrl = new URL(value.proofUrl);
  } catch {
    throw new Error("payload.proofUrl must be a valid URL");
  }

  if (proofUrl.protocol !== "https:") {
    throw new Error("payload.proofUrl must use https");
  }

  if (typeof value.createdAt !== "string") {
    throw new Error("payload.createdAt must be an ISO timestamp");
  }

  const timestamp = Date.parse(value.createdAt);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 10 * 60 * 1000) {
    throw new Error("payload.createdAt must be within 10 minutes of now");
  }

  if (
    typeof value.nonce !== "string" ||
    value.nonce.length < 8 ||
    value.nonce.length > 128
  ) {
    throw new Error("payload.nonce must be between 8 and 128 characters");
  }

  return {
    kind: "rarext.identity-link",
    version: 1,
    handle,
    keyId: value.keyId,
    network: value.network,
    externalId: value.externalId,
    proofUrl: proofUrl.toString(),
    createdAt: value.createdAt,
    nonce: value.nonce,
  };
}

async function serveStatic(
  pathname: string,
  publicDir: string,
  res: ServerResponse,
): Promise<boolean> {
  const root = resolve(publicDir);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(root, relative);

  if (target !== root && !target.startsWith(root + sep)) {
    return false;
  }

  try {
    const file = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(file);
    return true;
  } catch {
    return false;
  }
}

interface PublishInput {
  author: string;
  title: string;
  body: string;
  app: string;
  challengeId: string;
  artifact: Artifact;
  circuit?: Circuit;
  parentId: string | null;
  source: PublicationSource | null;
  createdAt: string;
  authorKey: string | null;
  verified: boolean;
  signature: string | null;
  nonce: string | null;
  claim?: { kind?: ClaimKind; scope?: ClaimScope | null };
  visibility?: Visibility;
  artifactCommitment?: string | null;
  attestation?: Attestation;
}

type PublishResult =
  | { status: number; body: Publication }
  | { status: number; body: { error: string; attestation?: unknown } };

export function createApp(options: AppOptions = {}): ReturnType<typeof createServer> {
  const store = options.store ?? new RarextStore();
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;  const registry = options.registry ?? createDefaultRegistry(options.fetch);
  const challenges = options.challenges ?? createChallengeRegistry();
  const semantics = options.semantics ?? createSemanticsRegistry(() => challenges.list());
  const verifiers =
    options.verifiers ?? createVerifierRegistry(options.fetch, semantics);
  const blobs =
    options.blobs ??
    new BlobStore(process.env.RAREXT_BLOB_DIR ?? ".data/blobs");
  const chainRegistry = options.chains ?? new ChainRegistry(loadChainConfigs(), options.fetch);
  const verifierModules = new VerifierModuleRegistry(VERIFIER_MODULES_DIR);

  async function publish(input: PublishInput): Promise<PublishResult> {
    const challenge = challenges.get(input.challengeId);

    if (!challenge) {
      return {
        status: 404,
        body: { error: `unknown challenge: ${input.challengeId}` },
      };
    }

    if (input.parentId && !store.getPublication(input.parentId)) {
      return { status: 404, body: { error: `unknown parent: ${input.parentId}` } };
    }

    const verifier = verifiers.get(input.app);

    if (!verifier) {
      return { status: 404, body: { error: `no verifier for app: ${input.app}` } };
    }

    if (!verifier.supports(input.artifact, challenge)) {
      return {
        status: 422,
        body: {
          error: `artifact kind ${input.artifact.kind} is not supported for app ${input.app}`,
        },
      };
    }

    let attestation: Attestation;

    if (input.visibility === "sealed") {
      // The registry never sees the body, so it cannot run the verifier. The
      // author attests to it instead, and the proof is salted so it cannot be
      // brute-forced or checked by a third party. The claim is weaker on
      // purpose, and the semantics record says so.
      if (!input.attestation) {
        return {
          status: 422,
          body: {
            error:
              "a sealed publication must carry the author's own attestation, because the registry cannot verify what it cannot read",
          },
        };
      }

      attestation = input.attestation;
    } else {
      try {
        attestation = await verifiers.verify(input.artifact, challenge, {
          claimKind: input.claim?.kind,
          scope: input.claim?.scope ?? null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "verification failed";
        return { status: 422, body: { error: message } };
      }
    }

    const authorIdentity = input.authorKey
      ? store.getIdentityByKey(input.authorKey)
      : null;
    const suite = authorIdentity?.algorithm ?? "ecdsa-p256";

    attestation.signatureAlgorithm = suite;
    attestation.cryptoProfile = profileFor(suite);

    if (!attestation.correct) {
      return {
        status: 422,
        body: { error: "artifact does not pass the challenge", attestation },
      };
    }

    const publication: Publication = {
      id: randomUUID(),
      author: input.author,
      authorKey: input.authorKey,
      signatureAlgorithm: suite,
      title: input.title,
      body: input.body,
      app: input.app,
      challengeId: challenge.id,
      artifact:
        input.visibility === "sealed"
          ? { ...input.artifact, body: null }
          : input.artifact,
      taskId: challenge.id,
      circuit: input.circuit,
      visibility: input.visibility ?? "public",
      artifactCommitment: input.artifactCommitment ?? null,
      parentId: input.parentId,
      source: input.source,
      createdAt: input.createdAt,
      attestedAt: attestation.createdAt,
      verified: input.verified,
      signature: input.signature,
      nonce: input.nonce,
      attestation,
    };

    store.addPublication(publication);
    return { status: 201, body: publication };
  }

  async function maybeAnchor(): Promise<void> {
    const threshold = anchorThreshold();
    if (threshold > 0 && store.pendingPublications().length >= threshold) {
      await anchorPending(store, registry);
    }
  }

  function withSemanticsHash(record: Semantics) {
    return { ...record, semanticsHash: semantics.hashOf(record) };
  }

  function storageTiers() {
    const policy = semantics.get("storage/storage-v1");
    const limits = (policy?.inputs ?? []) as string[];

    return {
      policy: "storage-v1",
      semanticsId: policy?.id ?? "storage/storage-v1",
      semanticsVersion: policy?.version ?? 1,
      semanticsHash: policy ? semantics.hashOf(policy) : null,
      tiers: [
        {
          id: "public",
          label: "Open storage",
          open: true,
          description:
            "Content-addressed bytes, replicated, with a verifiable inclusion proof. Free to store; the operator cannot read sealed entries.",
        },
        {
          id: "sealed",
          label: "Sealed storage",
          open: false,
          description:
            "Client-side encrypted. The node stores ciphertext it cannot read, and the claim covers possession and terms rather than content.",
        },
      ],
      licensed: limits.length > 0 ? limits : ["public", "sealed"],
    };
  }

  /**
   * The chain of trust for a stored blob: the bytes hash to a digest, the digest
   * is a leaf in a manifest, the manifest is a publication, and the publication
   * is a leaf in an anchor root. Every step is checkable by the holder of the
   * bytes, without trusting this operator.
   */
  function blobInclusionProof(hash: string): StorageInclusionProof {
    const manifests = store
      .listFeed({ limit: 100 })
      .filter((publication) => {
        if (publication.app !== "storage") return false;
        const body = publication.artifact?.body as { blobs?: unknown } | undefined;
        const entries = Array.isArray(body?.blobs) ? body.blobs : [];
        return entries.some(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as { hash?: unknown }).hash === hash,
        );
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const publication = manifests[0];
    if (!publication) return emptyInclusionProof(hash);

    const manifest = asManifest(publication.artifact?.body);
    const inclusion = manifestInclusion(manifest, hash);
    if (!inclusion) return emptyInclusionProof(hash);

    const anchor = store
      .listAnchors()
      .find((candidate) => candidate.publicationIds.includes(publication.id));

    return {
      hash,
      index: inclusion.index,
      leaf: inclusion.leaf,
      proof: inclusion.proof,
      root: inclusion.root,
      manifestId: publication.id,
      anchorId: anchor?.id ?? null,
      anchorRoot: anchor?.root ?? null,
      valid: verifyManifestInclusion(manifest, hash, inclusion.proof, inclusion.root),
    };
  }

  function withSemantics(challenge: Challenge) {
    const record = semanticsForChallenge(semantics, challenge);

    return {
      ...challenge,
      semanticsBinding: semantics.bindingFor(challenge),
      semanticsHash: semantics.hashOf(record),
      semanticsOrigin: record.origin,
    };
  }

  function listApps(): AppInfo[] {
    const allChallenges = challenges.list();

    return verifiers.list().map((verifier) => ({
      id: verifier.id,
      name: verifier.name,
      version: verifier.version,
      description: verifier.description,
      artifactKinds: verifier.artifactKinds,
      challengeCount: allChallenges.filter(
        (challenge) => challenge.app === verifier.id,
      ).length,
      verifier: verifier.verifier,
      configured: verifier.configured,
      url: verifier.url,
    }));
  }

  const server = createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");

    try {
      if (req.method === "OPTIONS") {
        send(res, 204);
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const { pathname, searchParams } = url;

      if (req.method === "GET" && pathname === "/health") {
        send(res, 200, {
          ok: true,
          publications: store.count(),
          identities: store.identityCount(),
          anchors: store.anchorCount(),
          identityLinks: store.identityLinkCount(),
          adapters: registry.list().length,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/tasks") {
        send(res, 200, tasks);
        return;
      }

      if (req.method === "GET" && pathname === "/v1/challenges") {
        send(res, 200, challenges.list().map(withSemantics));
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/challenges/")) {
        const id = pathname.slice("/v1/challenges/".length);
        const challenge = challenges.get(id);

        if (!challenge) {
          send(res, 404, { error: "challenge not found" });
          return;
        }

        send(res, 200, withSemantics(challenge));
        return;
      }

      if (req.method === "GET" && pathname === "/v1/semantics") {
        send(res, 200, semantics.list().map(withSemanticsHash));
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/semantics/")) {
        const id = pathname.slice("/v1/semantics/".length);
        const versionParam = url.searchParams.get("version");
        const version = versionParam ? Number(versionParam) : undefined;
        const record = semantics.get(id, Number.isFinite(version) ? version : undefined);

        if (!record) {
          send(res, 404, { error: "semantics not found" });
          return;
        }

        send(res, 200, withSemanticsHash(record));
        return;
      }

      if (req.method === "GET" && pathname === "/v1/verifiers") {
        send(res, 200, {
          verifiers: verifierModules.list().map((module) => ({
            ...module,
            url: `/v1/verifiers/${module.app}/${module.hash}.mjs`,
          })),
        });
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/verifiers/")) {
        const rest = pathname.slice("/v1/verifiers/".length);
        const [id, file] = rest.split("/");

        if (!id || !file || !file.endsWith(".mjs")) {
          send(res, 404, { error: "not found" });
          return;
        }

        const hash = file.slice(0, -".mjs".length);
        const found = verifierModules.bytesFor(id, hash, VERIFIER_MODULES_DIR);

        if (!found) {
          send(res, 404, { error: "no module with that hash" });
          return;
        }

        res.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
          "x-rarext-module-hash": found.module.hash,
        });
        res.end(found.bytes);
        return;
      }

      if (req.method === "GET" && pathname === "/v1/work") {
        const keyId = url.searchParams.get("keyId");
        send(res, 200, {
          actions: ACTIONS,
          orders: workOrders(challenges.list(), {
            verifiers: Object.fromEntries(
              verifierModules.list().map((module) => [
                module.app,
                {
                  id: module.id,
                  hash: module.hash,
                  format: module.format,
                  url: `/v1/verifiers/${module.app}/${module.hash}.mjs`,
                },
              ]),
            ),
          }),
          earnings: keyId ? summarizeEarnings(keyId, store.listCredits()) : null,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/work/earnings") {
        const keyId = url.searchParams.get("keyId") ?? "";
        send(res, 200, summarizeEarnings(keyId, store.listCredits()));
        return;
      }

      if (req.method === "POST" && pathname === "/v1/verifications") {
        const body = asRecord(await readJson(req));
        const submission = body as unknown as VerificationSubmission;

        if (
          typeof submission.challengeId !== "string" ||
          !submission.artifact ||
          !submission.attestation ||
          !submission.worker?.keyId
        ) {
          send(res, 400, { error: "a verification needs a challenge, an artifact, an attestation, and a worker" });
          return;
        }

        const challenge = challenges.get(submission.challengeId);

        if (!challenge) {
          send(res, 404, { error: "unknown challenge" });
          return;
        }

        // The registry recomputes the attestation itself. A worker that hands
        // back something the verifier would not produce gets nothing.
        let recomputed: Attestation;

        try {
          recomputed = await verifiers.verify(
            submission.artifact as Artifact,
            challenge,
          );
        } catch (error) {
          send(res, 422, {
            error: error instanceof Error ? error.message : "verification failed",
          });
          return;
        }

        const matches =
          recomputed.circuitHash === submission.attestation.circuitHash &&
          recomputed.traceHash === submission.attestation.traceHash &&
          recomputed.correct === submission.attestation.correct &&
          recomputed.score === submission.attestation.score;

        if (!matches) {
          send(res, 422, {
            error: "the attestation does not match what the verifier produced",
          });
          return;
        }

        const workerOk = verifyWorkerSignature(submission);

        if (!workerOk) {
          send(res, 401, { error: "the worker signature is not valid" });
          return;
        }

        const order = workOrders([challenge])[0];
        const bounty = order?.bounty ?? actionFor("verify").base;

        const artifactHash = recomputed.circuitHash;
        const alreadyPaid = store
          .listCredits()
          .some(
            (credit) =>
              credit.keyId === submission.worker.keyId &&
              credit.artifactHash === artifactHash,
          );

        if (alreadyPaid) {
          send(res, 409, {
            error: "this work has already been credited to this worker",
          });
          return;
        }

        store.addCredit({
          keyId: submission.worker.keyId,
          action: "verify",
          bounty,
          challengeId: challenge.id,
          artifactHash,
          at: new Date().toISOString(),
        });

        send(res, 201, {
          accepted: true,
          bounty,
          attestation: recomputed,
          earnings: summarizeEarnings(submission.worker.keyId, store.listCredits()),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/revocations") {
        send(res, 200, store.listRevocations());
        return;
      }

      if (req.method === "POST" && pathname === "/v1/revocations") {
        const body = asRecord(await readJson(req));
        const raw = body.revocation ?? body;
        const record = asRecord(raw);

        if (
          typeof record.id !== "string" ||
          typeof record.target !== "string" ||
          !["capability", "verifier", "artifact"].includes(String(record.kind))
        ) {
          send(res, 400, {
            error: "a revocation needs an id, a kind, and a target",
          });
          return;
        }

        const issuer = typeof record.issuer === "string" ? record.issuer : null;
        const identity = issuer ? store.getIdentity(issuer) : null;

        if (!identity) {
          send(res, 401, { error: "the issuer is not a registered handle" });
          return;
        }

        const signature = typeof body.signature === "string" ? body.signature : null;

        if (!signature) {
          send(res, 400, { error: "a revocation must be signed" });
          return;
        }

        const revocation: Revocation = {
          id: record.id,
          kind: record.kind as RevocationKind,
          target: record.target,
          reason: typeof record.reason === "string" ? record.reason : "",
          issuer: issuer ?? "",
          issuedAt:
            typeof record.issuedAt === "string"
              ? record.issuedAt
              : new Date().toISOString(),
        };

        if (!verifyRevocation(identity.publicKey, { revocation, signature })) {
          send(res, 401, { error: "the revocation signature is not valid" });
          return;
        }

        store.addRevocation(revocation);
        send(res, 201, revocation);
        return;
      }

      if (req.method === "GET" && pathname === "/v1/registries") {
        send(res, 200, {
          self: {
            url: `http://${req.headers.host ?? "127.0.0.1:8787"}`,
            chain: chainRegistry.list().map((chain) => chain.id),
          },
          registries: registrySeedList(),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/chains") {
        send(res, 200, {
          chains: chainRegistry.list(),
          adapters: chainRegistry.info(),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/chains/status") {
        send(res, 200, await chainRegistry.status());
        return;
      }

      if (req.method === "GET" && pathname === "/v1/market") {
        const listings = store
          .listFeed({ limit: 100 })
          .filter((publication) => publication.app === "market")
          .filter((publication) => publication.artifact.kind === "market.listing");

        send(res, 200, {
          listings: listings.map((listing) => ({
            id: listing.id,
            seller: listing.author,
            title: listing.title,
            body: listing.body,
            artifact: listing.artifact.body,
            score: listing.attestation.score,
            cryptoProfile: listing.attestation.cryptoProfile,
            createdAt: listing.createdAt,
          })),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/participants") {
        const profiles = store
          .listFeed({ limit: 100 })
          .filter((publication) => publication.app === "market")
          .filter(
            (publication) => publication.artifact.kind === "participant.profile",
          );

        send(res, 200, {
          participants: profiles.map((profile) => {
            const body = profile.artifact.body as Record<string, unknown>;

            return {
              handle: profile.author,
              keyId: profile.authorKey,
              kind: body.kind ?? "unknown",
              model: body.model ?? null,
              hardware: body.hardware ?? null,
              tools: body.tools ?? [],
              doesNotClaim: body.doesNotClaim ?? [],
              cryptoProfile: profile.attestation.cryptoProfile,
              attestedAt: profile.createdAt,
            };
          }),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/market/aggregate") {
        const answers = store
          .listFeed({ limit: 100 })
          .filter((publication) => publication.app === "market")
          .filter(
            (publication) => publication.artifact.kind === "market.aggregate",
          );

        send(res, 200, {
          answers: answers.map((answer) => {
            const body = answer.artifact.body as Record<string, unknown>;
            const contributions = Array.isArray(body.contributions)
              ? body.contributions
              : [];

            return {
              id: answer.id,
              question: body.question ?? "",
              aggregate: body.aggregate ?? null,
              participants: [
                ...new Set(
                  contributions
                    .map((entry) => (entry as { participant?: string }).participant)
                    .filter((name): name is string => typeof name === "string"),
                ),
              ],
              contributions: contributions.length,
              createdAt: answer.createdAt,
            };
          }),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/crypto") {
        send(res, 200, cryptoPolicy());
        return;
      }

      if (req.method === "GET" && pathname === "/v1/apps") {
        send(res, 200, listApps());
        return;
      }

      if (req.method === "GET" && pathname === "/v1/storage/tiers") {
        send(res, 200, storageTiers());
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/bundles")) {
        const requested = pathname.slice("/v1/bundles".length).replace(/^\//, "");
        const bundle = buildBundle(
          store,
          challenges.list(),
          semantics.list(),
          requested && requested !== "latest" ? requested : undefined,
        );

        if (!bundle) {
          send(res, 404, {
            error: requested ? `no anchor with root ${requested}` : "nothing has been anchored yet",
          });
          return;
        }

        if (url.searchParams.get("verify") === "1") {
          send(res, 200, { ...bundle, verification: verifyBundle(bundle) });
          return;
        }

        send(res, 200, bundle);
        return;
      }

      if (req.method === "GET" && pathname === "/v1/storage/usage") {
        send(res, 200, blobs.usage());
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/storage/retention/")) {
        const hash = pathname.slice("/v1/storage/retention/".length);
        const term = blobs.retention(hash);

        if (!term) {
          send(res, 404, { error: "blob not found" });
          return;
        }

        send(res, term.matured ? 200 : 425, term);
        return;
      }

      if (req.method === "GET" && pathname === "/v1/blobs") {
        send(res, 200, blobs.list());
        return;
      }

      if (req.method === "POST" && pathname === "/v1/blobs") {
        const body = asRecord(await readJson(req));
        const content = body.content;

        if (typeof content !== "string" || content.length === 0) {
          throw new Error("content must be a base64 string or text");
        }

        const bytes = body.encoding === "base64"
          ? Buffer.from(content, "base64")
          : Buffer.from(content, "utf8");

        const tier = body.tier === "sealed" ? "sealed" : "public";
        const record = blobs.put(bytes, {
          mediaType: typeof body.mediaType === "string" ? body.mediaType : undefined,
          tier,
          sealed: body.sealed === true || tier === "sealed",
          retentionUntil:
            typeof body.retentionUntil === "string" ? body.retentionUntil : null,
        });

        send(res, 201, record);
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/blobs/")) {
        const rest = pathname.slice("/v1/blobs/".length);
        const proofRequested = rest.endsWith("/proof");
        const hash = proofRequested ? rest.slice(0, -"/proof".length) : rest;

        if (proofRequested) {
          send(res, 200, blobInclusionProof(hash));
          return;
        }

        const found = blobs.get(hash);

        if (!found) {
          send(res, 404, { error: "blob not found" });
          return;
        }

        send(res, 200, {
          ...found.record,
          content: found.bytes.toString("base64"),
          encoding: "base64",
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/adapters") {
        send(res, 200, registry.list());
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/adapters/")) {
        const id = pathname.slice("/v1/adapters/".length);
        const status = await registry.status(id);

        if (!status) {
          send(res, 404, { error: "adapter not found" });
          return;
        }

        send(res, 200, status);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/simulate") {
        const body = asRecord(await readJson(req));
        const circuit = asCircuit(body.circuit);
        const inputs = asInputs(body.inputs);
        const initial = body.initial === undefined ? {} : asInputs(body.initial);

        send(res, 200, simulate(circuit, inputs, initial as Values));
        return;
      }

      if (req.method === "POST" && pathname === "/v1/score") {
        const body = asRecord(await readJson(req));
        const circuit = asCircuit(body.circuit);

        if (typeof body.taskId !== "string") {
          throw new Error("taskId must be a string");
        }

        const task = findTask(body.taskId);

        if (!task) {
          send(res, 404, { error: `unknown task: ${body.taskId}` });
          return;
        }

        send(res, 200, score(circuit, task));
        return;
      }

      if (req.method === "GET" && pathname === "/v1/feed") {
        const parentId = searchParams.get("parentId");

        send(
          res,
          200,
          store.listFeed({
            taskId: searchParams.get("taskId") ?? undefined,
            author: searchParams.get("author") ?? undefined,
            parentId: parentId === null ? undefined : parentId,
            limit: parseLimit(searchParams.get("limit")),
            offset: parseOffset(searchParams.get("offset")),
          }),
        );
        return;
      }

      if (
        req.method === "GET" &&
        (pathname === "/v1/builds" || pathname === "/v1/artifacts")
      ) {
        const parentId = searchParams.get("parentId");
        const query: BuildSearchQuery = {
          taskId: searchParams.get("taskId") ?? undefined,
          challengeId: searchParams.get("challengeId") ?? undefined,
          app: searchParams.get("app") ?? undefined,
          author: searchParams.get("author") ?? undefined,
          parentId: parentId === null || parentId === "" ? undefined : parentId,
          root: searchParams.get("root") === "true",
          source: parseSourceKind(searchParams.get("source")),
          minScore: parseOptionalNumber(searchParams.get("minScore"), "minScore"),
          maxGates: parseOptionalNumber(searchParams.get("maxGates"), "maxGates"),
          sort: parseBuildSort(searchParams.get("sort")),
          limit: parseLimit(searchParams.get("limit")),
          offset: parseOffset(searchParams.get("offset")),
        };

        send(res, 200, store.searchBuilds(query));
        return;
      }

      if (req.method === "GET" && pathname === "/v1/leaderboard") {
        const offset = parseOffset(searchParams.get("offset"));
        const builds = store.searchBuilds({
          app: searchParams.get("app") ?? undefined,
          challengeId: searchParams.get("challengeId") ?? undefined,
          sort: "score",
          limit: parseLimit(searchParams.get("limit")),
          offset,
        });
        const entries: LeaderboardEntry[] = builds.map((build, index) => ({
          rank: offset + index + 1,
          buildId: build.id,
          author: build.author,
          app: build.app,
          challengeId: build.challengeId,
          score: build.attestation.score,
          gateCount: build.attestation.gateCount,
          createdAt: build.createdAt,
        }));

        send(res, 200, entries);
        return;
      }

      if (
        req.method === "GET" &&
        (pathname.startsWith("/v1/builds/") ||
          pathname.startsWith("/v1/artifacts/"))
      ) {
        const base = pathname.startsWith("/v1/builds/")
          ? "/v1/builds/"
          : "/v1/artifacts/";
        const rest = pathname.slice(base.length);

        if (rest.endsWith("/lineage")) {
          const id = rest.slice(0, -"/lineage".length);
          const lineage = store.getBuildLineage(id);

          if (!lineage) {
            send(res, 404, { error: "build not found" });
            return;
          }

          send(res, 200, lineage);
          return;
        }

        if (rest.includes("/")) {
          send(res, 404, { error: "not found" });
          return;
        }

        const build = store.getBuild(rest);

        if (!build) {
          send(res, 404, { error: "build not found" });
          return;
        }

        send(res, 200, build);
        return;
      }

      if (req.method === "GET" && pathname === "/v1/profiles") {
        send(res, 200, store.listProfiles());
        return;
      }

      if (
        req.method === "POST" &&
        (pathname === "/v1/publications" || pathname === "/v1/artifacts")
      ) {
        const body = asRecord(await readJson(req));

        if (body.payload !== undefined) {
          if (typeof body.signature !== "string") {
            throw new Error("signature must be a base64 string");
          }

          const rawPayload = asRecord(body.payload);
          const payload = asPayload(rawPayload);
          const identity = store.getIdentity(payload.author);

          if (!identity) {
            send(res, 401, { error: `author is not registered: ${payload.author}` });
            return;
          }

          if (identity.keyId !== payload.authorKey) {
            send(res, 401, { error: "authorKey does not match the registered identity" });
            return;
          }

          if (!verifyPayload(identity.publicKey, rawPayload, body.signature)) {
            send(res, 401, { error: "invalid publication signature" });
            return;
          }

          if (store.findPublicationByNonce(payload.nonce)) {
            send(res, 409, { error: "publication nonce has already been used" });
            return;
          }

          const artifact =
            payload.artifact ??
            artifactFromCircuit(payload.circuit as Circuit);

          const result = await publish({
            author: payload.author,
            title: payload.title,
            body: payload.body,
            app: payload.app ?? artifact.app,
            challengeId: payload.challengeId ?? payload.taskId,
            artifact,
            circuit: payload.circuit,
            parentId: payload.parentId,
            source: payload.source ?? null,
            createdAt: payload.createdAt,
            authorKey: identity.keyId,
            verified: true,
            signature: body.signature,
            nonce: payload.nonce,
            claim: asClaim(body.claim) ?? asClaim(payload.claim),
            visibility: asVisibility(payload.visibility),
            artifactCommitment:
              typeof payload.artifactCommitment === "string"
                ? payload.artifactCommitment
                : null,
            attestation: asAttestation(payload.attestation),
          });

          send(res, result.status, result.body);
          if (result.status === 201) await maybeAnchor();
          return;
        }

        const circuit =
          body.circuit === undefined || body.circuit === null
            ? undefined
            : asCircuit(body.circuit);
        const artifact = body.artifact
          ? asArtifact(body.artifact)
          : circuit
            ? artifactFromCircuit(circuit)
            : null;

        if (!artifact) {
          throw new Error("artifact or circuit is required");
        }

        const challengeId =
          typeof body.challengeId === "string"
            ? body.challengeId
            : typeof body.taskId === "string"
              ? body.taskId
              : null;

        if (!challengeId) {
          throw new Error("challengeId or taskId must be a string");
        }

        if (typeof body.app === "string" && body.app !== artifact.app) {
          throw new Error("app must match artifact.app");
        }

        const author = asHandle(body.author);

        if (store.getIdentity(author)) {
          send(res, 401, { error: "this handle requires a signed publication" });
          return;
        }

        const result = await publish({
          author,
          title: asText(body.title, 120, "title"),
          body: optionalText(body.body, 2000, "body"),
          app: artifact.app,
          challengeId,
          artifact,
          circuit,
          parentId: optionalId(body.parentId),
          source:
            body.source === undefined || body.source === null
              ? null
              : asSource(body.source),
          createdAt: new Date().toISOString(),
          authorKey: null,
          verified: false,
          signature: null,
          nonce: null,
          claim: asClaim(body.claim),
          visibility: asVisibility(body.visibility),
          artifactCommitment:
            typeof body.artifactCommitment === "string"
              ? body.artifactCommitment
              : null,
        });

        send(res, result.status, result.body);
        if (result.status === 201) await maybeAnchor();
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/publications/")) {
        const id = pathname.slice("/v1/publications/".length);
        const publication = store.getPublication(id);

        if (!publication) {
          send(res, 404, { error: "publication not found" });
          return;
        }

        if (publication.visibility !== "public") {
          const capability = url.searchParams.get("capability");
          const identity = publication.authorKey
            ? store.getIdentityByKey(publication.authorKey)
            : null;

          if (!capability || !identity) {
            send(res, 404, { error: "publication not found" });
            return;
          }

          const check = verifyCapability(
            identity.publicKey,
            capability,
            publication.id,
          );

          if (!check.ok) {
            send(res, 403, { error: check.reason });
            return;
          }

          const decoded = decodeCapability(capability);
          const revoked = decoded
            ? store.isRevoked("capability", decoded.grant.nonce)
            : null;

          if (revoked) {
            send(res, 403, {
              error: `this capability was revoked: ${revoked.reason || "no reason given"}`,
            });
            return;
          }
        }

        send(res, 200, publication);
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/profiles/")) {
        const handle = pathname.slice("/v1/profiles/".length);
        const profile = store.getProfile(handle);

        if (!profile) {
          send(res, 404, { error: "profile not found" });
          return;
        }

        send(res, 200, profile);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/identities") {
        const body = asRecord(await readJson(req));
        const handle = asHandle(body.handle);
        const publicKey = asPublicKey(body.publicKey);
        const id = keyId(publicKey);
        const algorithm = suiteFor(publicKey);

        if (!algorithm) {
          send(res, 400, { error: "unsupported signature suite" });
          return;
        }

        if (store.getIdentity(handle)) {
          send(res, 409, { error: "handle is already registered" });
          return;
        }

        if (store.getIdentityByKey(id)) {
          send(res, 409, { error: "public key is already registered" });
          return;
        }

        const identity: Identity = {
          handle,
          keyId: id,
          algorithm,
          publicKey,
          createdAt: new Date().toISOString(),
        };

        store.addIdentity(identity);
        send(res, 201, identity);
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/identities/")) {
        const handle = pathname.slice("/v1/identities/".length);
        const identity = store.getIdentity(handle);

        if (!identity) {
          send(res, 404, { error: "identity not found" });
          return;
        }

        send(res, 200, identity);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/identity-links") {
        const body = asRecord(await readJson(req));

        if (typeof body.signature !== "string") {
          throw new Error("signature must be a base64 string");
        }

        const rawPayload = asRecord(body.payload);
        const payload = asLinkPayload(rawPayload);
        const identity = store.getIdentity(payload.handle);

        if (!identity) {
          send(res, 401, { error: `identity is not registered: ${payload.handle}` });
          return;
        }

        if (identity.keyId !== payload.keyId) {
          send(res, 401, { error: "payload.keyId does not match the registered identity" });
          return;
        }

        if (!verifyPayload(identity.publicKey, rawPayload, body.signature)) {
          send(res, 401, { error: "invalid identity-link signature" });
          return;
        }

        if (store.findIdentityLink(payload.handle, payload.network, payload.externalId)) {
          send(res, 409, { error: "identity link already exists" });
          return;
        }

        try {
          await registry.verifyIdentityLink(payload.network, {
            handle: payload.handle,
            network: payload.network,
            externalId: payload.externalId,
            proofUrl: payload.proofUrl,
            nonce: payload.nonce,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "proof verification failed";
          send(res, 422, { error: message });
          return;
        }

        const link: IdentityLink = {
          id: randomUUID(),
          handle: payload.handle,
          network: payload.network,
          externalId: payload.externalId,
          proofUrl: payload.proofUrl,
          verified: true,
          createdAt: new Date().toISOString(),
        };

        store.addIdentityLink(link);
        send(res, 201, link);
        return;
      }

      if (req.method === "GET" && pathname === "/v1/identity-links") {
        send(res, 200, store.listIdentityLinks(searchParams.get("handle") ?? undefined));
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/identity-links/")) {
        const handle = pathname.slice("/v1/identity-links/".length);

        if (!store.getIdentity(handle)) {
          send(res, 404, { error: "identity not found" });
          return;
        }

        send(res, 200, store.listIdentityLinks(handle));
        return;
      }

      if (req.method === "POST" && pathname === "/v1/sources/github/resolve") {
        const body = asRecord(await readJson(req));

        if (typeof body.repo !== "string") {
          throw new Error("repo must be a string");
        }

        if (
          body.ref !== undefined &&
          body.ref !== null &&
          typeof body.ref !== "string"
        ) {
          throw new Error("ref must be a string");
        }

        if (
          body.path !== undefined &&
          body.path !== null &&
          typeof body.path !== "string"
        ) {
          throw new Error("path must be a string");
        }

        if (
          body.taskId !== undefined &&
          body.taskId !== null &&
          typeof body.taskId !== "string"
        ) {
          throw new Error("taskId must be a string");
        }

        const query: SourceQuery = {
          repo: body.repo,
          ref: body.ref ?? null,
          path: body.path ?? null,
          taskId: body.taskId ?? null,
        };

        const resolved = await registry.resolveSource("github", query);
        send(res, 200, resolved);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/anchors") {
        const anchor = await anchorPending(store, registry);

        if (!anchor) {
          send(res, 409, { error: "nothing to anchor" });
          return;
        }

        send(res, 201, anchor);
        return;
      }

      if (req.method === "GET" && pathname === "/v1/anchors") {
        send(res, 200, store.listAnchors());
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/v1/anchors/")) {
        const id = pathname.slice("/v1/anchors/".length);
        const anchor = store.getAnchor(id);

        if (!anchor) {
          send(res, 404, { error: "anchor not found" });
          return;
        }

        send(res, 200, anchor);
        return;
      }

      if (
        req.method === "POST" &&
        pathname.startsWith("/v1/anchors/") &&
        pathname.endsWith("/proof")
      ) {
        const id = pathname.slice("/v1/anchors/".length, -"/proof".length);
        const anchor = store.getAnchor(id);

        if (!anchor) {
          send(res, 404, { error: "anchor not found" });
          return;
        }

        const body = asRecord(await readJson(req));

        if (typeof body.publicationId !== "string") {
          throw new Error("publicationId must be a string");
        }

        const index = anchor.publicationIds.indexOf(body.publicationId);

        if (index === -1) {
          send(res, 409, { error: "publication is not part of this anchor" });
          return;
        }

        const leaves = anchor.publicationIds.map((publicationId) => {
          const publication = store.getPublication(publicationId);
          if (!publication) throw new Error(`missing publication: ${publicationId}`);
          return publicationLeaf(publication, anchor.leafVersion ?? 1);
        });

        const leaf = leaves[index];
        const proof = merkleProof(leaves, index);

        send(res, 200, {
          anchorId: anchor.id,
          publicationId: body.publicationId,
          leaf,
          proof,
          root: anchor.root,
          index,
          valid: verifyProof(leaf, proof, anchor.root, index),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/tapeout/status") {
        const address = searchParams.get("address") ?? undefined;
        send(res, 200, await tapeOutStatus(address));
        return;
      }

      if (req.method === "POST" && pathname === "/v1/verify") {
        const body = asRecord(await readJson(req));

        if (typeof body.publicationId !== "string") {
          throw new Error("publicationId must be a string");
        }

        const publication = store.getPublication(body.publicationId);

        if (!publication) {
          send(res, 404, { error: "publication not found" });
          return;
        }

        const challenge = challenges.get(
          publication.challengeId ?? publication.taskId,
        );

        if (!challenge) {
          send(res, 404, { error: "challenge not found" });
          return;
        }

        if (!verifiers.get(publication.app)) {
          send(res, 404, { error: "verifier not found" });
          return;
        }

        send(
          res,
          200,
          await verifiers.verifyAttestation(
            publication.artifact,
            challenge,
            publication.attestation,
          ),
        );
        return;
      }

      if (req.method === "GET") {
        if (await serveStatic(pathname, publicDir, res)) return;
      }

      send(res, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      send(res, 400, { error: message });
    }
  });

  return server;
}
