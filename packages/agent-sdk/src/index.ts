import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  canonicalize,
  cidV1,
  foldAnnouncements,
  planSeedUnion,
  readBundleResponseBytes,
  unresolvedIdentity,
  verifyAiArtifact,
  verifyBundleShape,
  verifyCandidates,
  verifyGenerativeReplay,
} from "@rarext/core";
import type {
  AnnouncementEvent,
  AnnouncementIdentity,
  AnnouncementVerifier,
  AiLocalVerification,
  BundleSeed,
  CandidateOutcome,
  GenerativeBody,
  GenerativeSpec,
} from "@rarext/core";
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
  Bundle,
  BundleVerification,
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
  SeedPin,
  Semantics,
  Sha256,
  SignatureSuite,
  SimulationResult,
  SourceQuery,
  SourceResolution,
  Task,
  Values,
  Visibility,
} from "@rarext/core";

export type {
  AnnouncementIdentity,
  AnnouncementKeyHistory,
  AnnouncementRevocation,
  AppInfo,
  Artifact,
  BuildLineage,
  BuildSearchQuery,
  BuildSort,
  BuildSummary,
  Bundle,
  BundleVerification,
  Challenge,
  Claim,
  ClaimKind,
  ClaimScope,
  LeaderboardEntry,
  SeedPin,
  Semantics,
  VerificationOutput,
} from "@rarext/core";

const nodeSha256: Sha256 = (bytes) =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

export { cidV1, verifyBundleShape, verifyCandidates } from "@rarext/core";

/** A bundle verified locally against the root a seed pins. */
export function verifyBundle(bundle: Bundle): BundleVerification {
  return verifyBundleShape(bundle, nodeSha256);
}

/** The CIDv1 of bytes, computed with node:crypto in the SDK's runtime. */
export function cidV1Raw(bytes: Uint8Array): string {
  return cidV1(nodeSha256, bytes);
}

/**
 * The seed list a client discovers mirrors from (docs/MIRRORS.md).
 */
export type { AnnouncementEvent } from "@rarext/core";
/**
 * A resident's own resolver: the keys of the world it lives in, read from the
 * documents a publisher serves (`GET /v1/identities/<handle>`, its rotations,
 * and `GET /v1/revocations`). Answers the same port an operator's server does,
 * so a resident with no server of its own can fold announcements and believe
 * what the keys it trusts actually said.
 */
export {
  identityDocumentUrls,
  identityFromPublishedDocuments,
  identityFromPublishedOrigin,
} from "./published-identity.ts";
/**
 * The federation query: a published seed list, read and asked registry by
 * registry for a copy of ITS bundle. A registry that does not answer is
 * reported, never fatal — one dead host must not blind a resident to the rest.
 */
export {
  DEFAULT_REGISTRY_TIMEOUT_MS,
  findVerifiedBundlesFromRegistryList,
  joinRegistryNetwork,
  registriesFromPublishedList,
  registryListDigestOf,
} from "./registries.ts";
export type {
  NetworkJoinOptions,
  NetworkJoinResult,
  RegistryListOptions,
  RegistryListResult,
  RegistryOutcome,
} from "./registries.ts";
export type {
  IdentityDocumentSurface,
  IdentityDocumentUrls,
  PublishedIdentityOptions,
} from "./published-identity.ts";
export { DEFAULT_IDENTITY_TIMEOUT_MS } from "./published-identity.ts";

/**
 * The seed list a client discovers mirrors from (docs/MIRRORS.md).
 *
 * `announcements` (RFC 0019 step 1) is inherited from core's `BundleSeed`,
 * because the fold that reads it is core's too — see `foldAnnouncements`.
 */
export interface SeedDocument extends BundleSeed {
  pins?: SeedPin[];
}

export interface VerifiedBundleSource {
  bundle: Bundle;
  root: string;
  source: string;
}

/** What multi-seed discovery adds to a single verified copy: its provenance. */
export interface VerifiedBundleFromSeeds extends VerifiedBundleSource {
  /** How many distinct candidate URLs the union held. */
  candidates: number;
  /** The seeds (their URLs) that nominated the winning copy. */
  seeds: string[];
}

/**
 * One step in the search for a verified copy. The demo prints these as they
 * happen; the verification itself stays in core's `verifyCandidates`.
 */
export type FindVerifiedBundleEvent = CandidateOutcome;

export interface FindVerifiedBundleOptions {
  fetch?: typeof fetch;
  /** The sha256 digest the client trusts; defaults to node:crypto. */
  sha256?: Sha256;
  timeoutMs?: number;
  /** Observe each candidate as it is tried, refused, or accepted. */
  onCandidate?: (event: FindVerifiedBundleEvent) => void;
  /** Observe each announcement record as it is accepted or reported and skipped. */
  onAnnouncement?: (event: AnnouncementEvent) => void;
  /**
   * Where a named handle's key history is resolved from. Without one, core's
   * `unresolvedIdentity` applies: a record carrying its own key is checked
   * against that key, and a record carrying none is refused — an envelope
   * never mints its own authority.
   */
  identity?: AnnouncementIdentity;
}

/**
 * Federation's first step in the SDK: try the seed's own bundle URL and then
 * each mirror, read BYTES, verify the CID pin when the seed carries one, verify
 * the bundle shape, and accept only the first copy whose recomputed root equals
 * the seed's `bundleRoot`.
 *
 * Internal validity is not enough — a mirror can rewrite both its bundle and
 * the root inside it — so the pin is what makes the copy trustworthy. Every
 * candidate that fails is skipped with its reason recorded; if none verifies,
 * the error names every candidate and why, so an outage reads as evidence
 * rather than as an opaque failure.
 */
export async function findVerifiedBundle(
  seed: SeedDocument,
  options: FindVerifiedBundleOptions = {},
): Promise<VerifiedBundleSource> {
  const found = await findVerifiedBundleFromSeeds([seed], options);
  return { bundle: found.bundle, root: found.root, source: found.source };
}

/**
 * The same search across SEEDS: the union of every seed's own bundle URL and
 * its mirrors, deduplicated, so a copy only one operator nominated is still
 * tried when the other operators' candidates all fail — a resident who trusts
 * two operators gets both operators' redundancy, not whichever seed came
 * first.
 *
 * The union is planned before anything is fetched, and planning enforces ONE
 * disagreement rule (core's `planSeedUnion`): every seed naming the same
 * primary `bundle` URL must pin the same `bundleRoot` and the same `bundleCid`
 * when both carry one. Any disagreement throws naming the registry, the field,
 * and every value with the seed URL that pinned it — two operators disagreeing
 * about what the registry is stops the resident, it does not race them. A seed
 * that carries no `bundleCid` beside one that does is not a disagreement, and
 * the stricter pin governs the shared candidates.
 *
 * Each candidate is verified exactly as `findVerifiedBundle` verifies one,
 * against the pins of the seeds that nominated it, and every refusal is
 * recorded with its reason and, when several seeds are pooled, the seeds that
 * nominated it.
 *
 * RFC 0019 step 1: when a seed carries `announcements`, each document is
 * fetched through the same capped reader a bundle gets, every record is
 * verified (canonical payload, signature by the repo's identity primitives
 * against a key whose id is derived by `publicKeyId` and whose suite is
 * derived by `suiteOf`, and the `issuedAt`/`expiresAt` window), and each
 * survivor is pooled with the seeds BEFORE the union is planned — so the
 * disagreement rule covers announcements with no new rule of its own: an
 * announcement that pins a different root or CID for a registry the seed
 * names throws the same loud error, naming both values and both sources,
 * before anything is fetched. An announcement that cannot be fetched, parsed,
 * or verified is reported with its reason and skipped, never fatal while
 * another location verifies — announcements are redundancy, like mirrors.
 *
 * That whole step is ONE function, core's `foldAnnouncements`, called here
 * with this client's fetch and this package's identity primitives. The API
 * twin `bundleFromSeeds` calls the same one, so a fix to the order, the
 * wording, or the refusal record lands in both paths at once.
 */
export async function findVerifiedBundleFromSeeds(
  seeds: SeedDocument[],
  options: FindVerifiedBundleOptions = {},
): Promise<VerifiedBundleFromSeeds> {
  const request = options.fetch ?? fetch;
  const sha256 = options.sha256 ?? nodeSha256;
  const timeoutMs = options.timeoutMs ?? 15_000;

  // RFC 0019 step 1: core's fold fetches each announcement document the seeds
  // name, verifies every record with this package's identity primitives, and
  // pools the survivors with the trusted seeds BEFORE the union is planned. A
  // seed without `announcements` contributes nothing here: the pool is exactly
  // the seeds, so the plan, the fetches, and the error wording are byte for
  // byte today's.
  // The identity half of the port is per-call: an agent that ships a key
  // history (or reaches one through its API) passes it here, and without one
  // core's `unresolvedIdentity` applies — a keyless record is then refused
  // rather than believed on the strength of its own envelope.
  const verifier: AnnouncementVerifier = {
    ...(options.identity ?? unresolvedIdentity),
    keyIdOf: publicKeyId,
    suiteOf: announcementVerifier.suiteOf,
    verify: announcementVerifier.verify,
  };
  const pool = await foldAnnouncements(seeds, {
    verifier,
    fetch: request,
    timeoutMs,
    onAnnouncement: options.onAnnouncement,
  });

  const plan = planSeedUnion(pool);

  // The per-candidate sequence — fetch the bytes (through the shared cap),
  // the CID pin over exactly those bytes, the bundle's shape, the recomputed
  // root against the pin, every refusal recorded — is core's
  // `verifyCandidates`. The SDK's own digest travels with it, so an agent can
  // bring another sha256 and the sequence stays the same one everywhere.
  const outcome = await verifyCandidates({
    plan,
    attribute: pool.length > 1,
    sha256,
    onCandidate: options.onCandidate,
    fetchBytes: async (url) => {
      const response = await request(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return readBundleResponseBytes(response);
    },
  });

  if (outcome.status !== "verified") throw new Error(outcome.message);
  return outcome;
}

/**
 * The identity of a generative claim's committed model: canonical JSON, then
 * sha256. One implementation shared by `verifyAi` and `replayBundleAi`, so the
 * live path and the bundle path can never disagree about what the digest is.
 */
function generativeModelDigest(body: unknown): string {
  return createHash("sha256")
    .update(canonicalize((body as { model: unknown }).model))
    .digest("hex");
}

/** What core's math returned for one AI claim, plus the model's digest. */
export interface BundleAiClaimEvidence {
  /** Generative: the seed and step count the replay ran with. */
  seed?: number;
  steps?: number;
  /** Generative: `generativeModelDigest`, the same value `verifyAi` returns. */
  modelDigest?: string;
  /** Generative: what core's replay regenerated, beside what the claim carries. */
  expected?: string;
  actual?: string;
  /** Bounded: the metric core recomputed and the bound it had to meet. */
  metricName?: string;
  metricValue?: number;
  bound?: number;
  /**
   * Bounded: the metric value the attestation committed, when it carries one.
   * `metricValue` is the resident's own recomputation; this is the number the
   * claim was published with, kept only so a reader can see the two together.
   */
  attestedMetricValue?: number;
}

/** One AI claim from a bundle, replayed by whoever holds the bundle. */
export interface BundleAiClaimReplay {
  publicationId: string;
  title: string;
  representation: "exact" | "bounded" | "generative";
  /**
   * False when the replay failed AND when it could not be run: a claim nobody
   * replayed is never reported as passing. `error` says which case this is.
   */
  correct: boolean;
  /** Why the claim could not be replayed, when it could not. */
  error?: string;
  evidence?: BundleAiClaimEvidence;
}

export interface BundleAiReplay {
  /** `bundle.manifest.root`, so verdicts tie to the exact copy they came from. */
  root: string;
  /** One entry per publication that declares a representation; empty if none do. */
  claims: BundleAiClaimReplay[];
}

/**
 * Replay every AI claim a verified bundle carries — from the bundle alone.
 *
 * `findVerifiedBundle` proves the copy; this proves the claims inside it. A
 * verified bundle already carries each AI publication's artifact and the
 * challenge spec its claim was written against, so core's `verifyAiArtifact`
 * is all the math this needs: no fetch, no server, no API, and nothing an
 * attestation says can raise `correct` — the attestation is only ever compared
 * against what the resident recomputed, and a disagreement fails the claim.
 *
 * Every publication that declares a representation yields exactly one entry:
 * a publication whose challenge the bundle does not carry is an entry whose
 * error reads `challenge <id> not in bundle` rather than a silent skip (an
 * unplayable claim is a verdict, not an omission), a pair core cannot verify
 * reports core's own error, and a bundle that claims nothing AI comes back
 * with an empty list.
 */
export function replayBundleAi(bundle: Bundle): BundleAiReplay {
  const challenges = new Map(
    (bundle.challenges ?? []).map((challenge) => [challenge.id, challenge] as const),
  );
  const claims: BundleAiClaimReplay[] = [];

  for (const publication of bundle.publications ?? []) {
    const representation = publication.attestation?.representation;
    if (!representation) continue;

    const claim = {
      publicationId: publication.id,
      title: publication.title,
      representation,
    };

    const challenge = challenges.get(publication.challengeId);
    if (!challenge) {
      claims.push({
        ...claim,
        correct: false,
        error: `challenge ${publication.challengeId} not in bundle`,
      });
      continue;
    }

    const verdict = verifyAiArtifact(publication.artifact, challenge);
    if ("error" in verdict) {
      claims.push({ ...claim, correct: false, error: verdict.error });
      continue;
    }

    // The attestation's declared kind and the kind the artifact actually
    // replays as must be the same claim. A bundle can carry a claim that says
    // `exact` over a generative artifact (or the reverse) — the two are not
    // interchangeable, and reporting core's verdict for one under the other's
    // label would be a pass nobody replayed.
    if (verdict.representation !== representation) {
      claims.push({
        ...claim,
        correct: false,
        error: `attestation declares ${representation} but the artifact replays as ${verdict.representation}`,
      });
      continue;
    }

    if (verdict.representation === "generative") {
      // verifyAiArtifact has already accepted this body and spec, so core's
      // replay is run a second time only to recover the regenerated output for
      // the evidence: a claim that failed must show what it did not match, and
      // the SDK does no representation math of its own.
      const body = publication.artifact.body as GenerativeBody;
      const replay = verifyGenerativeReplay(body, challenge.spec as GenerativeSpec);

      claims.push({
        ...claim,
        correct: verdict.correct,
        evidence: {
          seed: verdict.seed,
          steps: verdict.steps,
          modelDigest: generativeModelDigest(body),
          expected: replay.expected,
          actual: body.output,
        },
      });
      continue;
    }

    // Bounded: re-derive the metric the way the proof page does and compare it
    // with the value the attestation committed. The recomputed number is what
    // the verdict rests on; an attestation that disagrees with it is a mismatch,
    // never a silent pass beside it.
    const attested = publication.attestation.metricValue;
    const agrees = attested === undefined || attested === verdict.metricValue;

    claims.push({
      ...claim,
      correct: verdict.correct && agrees,
      evidence: {
        metricName: verdict.metricName,
        metricValue: verdict.metricValue,
        bound: verdict.bound,
        ...(attested === undefined ? {} : { attestedMetricValue: attested }),
      },
    });
  }

  return { root: bundle.manifest.root, claims };
}

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
  bemDecimals: number;
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

export interface AgentIdentityLinkInput {
  handle: string;
  network: string;
  externalId: string;
  proofUrl: string;
  createdAt?: string;
  nonce?: string;
}

export interface ResetLoginChallenge {
  v: 1;
  domain: "reset-mcp-login";
  audience: string;
  address: string;
  nonce: string;
  issued_at: number;
  expires_at: number;
  [key: string]: unknown;
}

export interface TracIdentityProof {
  kind: "trac";
  challenge: ResetLoginChallenge;
  signature: string;
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

/**
 * Verify a signature over a payload — the SDK twin of the API's
 * `verifyPayload` in `apps/api/src/identity.ts`, needed here because a
 * resident that reads announcements verifies them locally rather than behind
 * the API (RFC 0019, open question 3, answered for step 1). The suite decides
 * the verification: ECDSA signs a SHA-256 digest in the P1363 encoding, ML-DSA
 * signs the message itself. Both are checked against the *canonical* payload
 * bytes, so a signature covers exactly what a reader would reconstruct.
 */
export function verifyPayload(
  publicKey: JsonWebKey,
  payload: unknown,
  signature: string,
  suite?: SignatureSuite,
): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;

  let resolved: SignatureSuite;
  try {
    resolved = suite ?? suiteOf(publicKey);
  } catch {
    return false;
  }

  try {
    const bytes = Buffer.from(signature, "base64");
    const message = Buffer.from(canonicalize(payload));
    const key = createPublicKey({ key: nodeJwk(publicKey), format: "jwk" });

    if (resolved === "ecdsa-p256") {
      if (bytes.length !== 64) return false;

      return verifyBytes("sha256", message, { key, dsaEncoding: "ieee-p1363" }, bytes);
    }

    return verifyBytes(null, message, key, bytes);
  } catch {
    return false;
  }
}

/**
 * The signature machinery core's `verifyAnnouncement` runs behind: the key id
 * and the suite are derived from the key itself (never claimed by the record),
 * and the signature is checked over the canonical payload by `verifyPayload`.
 */
const announcementVerifier: AnnouncementVerifier = {
  // An agent holding a bundle has no identity store of its own, so a handle's
  // key history is unresolvable here and core's `unresolvedIdentity` is the
  // honest answer: a record carrying its own key is checked against the key it
  // carries, and a record carrying none is refused with "no key history"
  // rather than believed on the strength of the envelope. Resolving through a
  // server (or a key history the agent ships with) is RFC 0019's open
  // question, named as such in the RFC and docs/MIRRORS.md.
  ...unresolvedIdentity,
  keyIdOf: publicKeyId,
  suiteOf: (key) => {
    try {
      return suiteOf(key);
    } catch {
      return null;
    }
  },
  verify: verifyPayload,
};

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

  identityLinkPayload(input: AgentIdentityLinkInput): IdentityLinkPayload {
    return {
      kind: "rarext.identity-link",
      version: 1,
      handle: input.handle,
      keyId: this.keyId,
      network: input.network,
      externalId: input.externalId,
      proofUrl: input.proofUrl,
      createdAt: input.createdAt ?? new Date().toISOString(),
      nonce: input.nonce ?? randomUUID(),
    };
  }
}

/**
 * The sha256 digest a Trac identity link challenge must sign as its `nonce`.
 * It binds the RESET login challenge to the exact RAREXT identity payload.
 */
export function identityLinkBinding(payload: IdentityLinkPayload): string {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
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
  reason?: string | null;
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
    externalProof?: TracIdentityProof,
  ): Promise<IdentityLink> {
    return this.request("/v1/identity-links", { payload, signature, externalProof });
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

  /**
   * Trust-minimized AI verification: fetch the challenge from the API, then
   * compute the verdict locally from the pure representation math in core.
   * The server's attestation is never trusted for the outcome. For
   * generative claims the committed model's digest is computed here too.
   */
  async verifyAi(
    challengeId: string,
    artifact: Artifact,
  ): Promise<AiLocalVerification & { modelDigest?: string }> {
    const challenge = await this.challenge(challengeId);
    const result = verifyAiArtifact(artifact, challenge);

    if ("error" in result) throw new Error(result.error);

    if (result.representation === "generative") {
      return {
        ...result,
        modelDigest: generativeModelDigest(artifact.body),
      };
    }

    return result;
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
