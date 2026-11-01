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
  RASTER_RULE,
  assembleBundle,
  attestBoundedRun,
  boundedRenditionFor,
  attestGenerativeRun,
  attestRun,
  canonicalize,
  cidV1,
  matchRecordRoot,
  publicationRoot,
  toHex,
  generate,
  foldAnnouncements,
  planSeedUnion,
  publicationFromSignedInput,
  renditionFor,
  readBundleResponseBytes,
  parseRarextUri,
  unresolvedIdentity,
  urlForRarextUri,
  verifyAiArtifact,
  verifyBundleShape,
  verifyCandidates,
  verifyGenerativeReplay,
  bundleSemanticsCommitment,
  semanticsCommitmentHolds,
  semanticsRecordDigest,
  semanticsKey,
  type SemanticsCommitmentStatus,
  voteStatement,
  sha256Hex,
  stateArchiveRoot,
  type GovernanceBudget,
  type GovernanceProposal,
  type GovernanceVote,

} from "../../core/src/index.ts";
import {
  allowPrivateFromSeeds,
  fetchWithUrlPolicy,
} from "../../../packages/core/src/urls.ts";
import { encodePngRaster } from "./png.ts";
import { requireFiniteSeed, requireSteps, requireValues } from "./validate.ts";
import type {
  AttestationBinding,
  AnnouncementDocumentCache,
  AnnouncementDocumentCacheEntry,
  AnnouncementEvent,
  AnnouncementIdentity,
  AnnouncementVerifier,
  AiLocalVerification,
  BundleSeed,
  CandidateOutcome,
  CandidateRefusal,
  GenerativeBody,
  GenerativeMedia,
  GenerativeSpec,
} from "../../core/src/index.ts";
import type {
  AdapterInfo,
  AdapterStatus,
  Anchor,
  CreditRecordFields,
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
  BoundedSpec,
  BoundedBody,
  BoundedMedia,
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
  XorshiftModel,
  KeyRotationPayload,
  LeaderboardEntry,
  OperatorAttestation,
  Profile,
  HashFn,
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
} from "../../core/src/index.ts";

export type {
  AnnouncementDocumentCache,
  AnnouncementDocumentCacheEntry,
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
} from "../../core/src/index.ts";

const nodeSha256: Sha256 = (bytes) =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

export { cidV1, verifyBundleShape, verifyCandidates } from "../../core/src/index.ts";

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
export type { AnnouncementEvent } from "../../core/src/index.ts";
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
 * RFC 0019's question 5, on the resident's side of reading announcements: the
 * document cache the fold consults. See `./announcement-cache.ts` for what it
 * holds and what it deliberately never holds.
 */
export {
  DEFAULT_ANNOUNCEMENT_CACHE_ENTRIES,
  MemoryAnnouncementCache,
} from "./announcement-cache.ts";
export type { MemoryAnnouncementCacheOptions } from "./announcement-cache.ts";
/**
 * The federation query: a published seed list, read and asked registry by
 * registry for a copy of ITS bundle. A registry that does not answer is
 * reported, never fatal — one dead host must not blind a resident to the rest.
 */
export {
  DEFAULT_REGISTRY_TIMEOUT_MS,
  findVerifiedBundlesFromRegistryList,
  FEDERATION_APP,
  REGISTRY_LIST_COMMITMENT_KIND,
  federationCommitment,
  joinRegistryNetwork,
  registriesFromPublishedList,
  registryListDigestOf,
} from "./registries.ts";
export type {
  FederationCommitment,
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
export { runNodeJourney } from "./journey.ts";
export type { JourneyDocument, JourneyOptions, JourneyRail } from "./journey.ts";
import { runNodeJourney as runNodeJourneyForClient } from "./journey.ts";
import type { JourneyDocument as JourneyDocumentForClient } from "./journey.ts";
export { readSiteBinding, DEFAULT_SITE_BINDING_TIMEOUT_MS } from "./site-binding.ts";
export type { CarrierOutcome, SiteBindingRead, SiteBindingReadOptions } from "./site-binding.ts";

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
  /** Every refusal recorded before the winning copy was accepted, each with its stage. */
  refusals: CandidateRefusal[];
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
  /**
   * RFC 0019 question 5: an optional document cache (the SDK ships
   * `MemoryAnnouncementCache`). Whatever it answers, the record loop verifies
   * the cached document fully, every fold — a cache holds the DOCUMENT, never
   * a decided verdict, so revocation and expiry still bite on a hit.
   */
  cache?: AnnouncementDocumentCache;
  /**
   * The caller's TTL over cached entries, in ms; an entry older than this is a
   * miss and is refetched. Omitted means the caller chose no TTL.
   */
  cacheMaxAgeMs?: number;
  /**
   * Allow mirror and announcement URLs at private/loopback hosts. Off by default;
   * a LOCAL seed grants it automatically, because its own environment is local.
   */
  allowPrivateHosts?: boolean;
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

  // Mirrors and announcement documents are named by the SEEDS, not by this
  // caller — so they are third-party URLs, and the same two policies that guard a
  // registry list guard them: http/https only, and no loopback or private host
  // unless the seed that nominated it is itself local, which means a local tree
  // and not a public document pointing inward. An `allowPrivateHosts` option
  // overrides for a caller who means it.
  // "Is this seed local?" is asked of the URL the seed ITSELF points at — its own
  // location, or failing that its primary bundle — not of the mirrors, because
  // those are exactly what the policy is about. A fixture (or a demo tree) whose
  // primary location is on loopback is a local environment and earns the
  // allowance; a public seed naming a private MIRROR does not.
  const allowPrivate = options.allowPrivateHosts ?? allowPrivateFromSeeds(seeds);

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
    // Guarded with core's policy, exactly as the API's twin guards it: a record's
    // document URL is third-party content, and a refusal here lands in the fold's
    // own refusal record with this reason.
    fetch: (url, init) => {
      const target = typeof url === "string" ? url : url instanceof URL ? url.href : String(url);
      return fetchWithUrlPolicy(target, (init ?? {}) as RequestInit, { fetch: request, allowPrivate });
    },
    timeoutMs,
    onAnnouncement: options.onAnnouncement,
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.cacheMaxAgeMs === undefined ? {} : { cacheMaxAgeMs: options.cacheMaxAgeMs }),
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
      // Every hop is checked, not just the URL: a 3xx into a private address is
      // the walk-around the policy would otherwise have.
      const response = await fetchWithUrlPolicy(url, { signal: AbortSignal.timeout(timeoutMs) }, {
        fetch: request,
        allowPrivate,
      });
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { httpStatus: response.status });
      return readBundleResponseBytes(response);
    },
  });

  if (outcome.status !== "verified") {
    // The refusals travel WITH the error, each carrying the stage it was refused at — the evidence
    // an operator needs, and the reason a resolver's attempts can be structural instead of prose.
    throw Object.assign(new Error(outcome.message), { refusals: outcome.refusals });
  }
  // And a WINNING copy still names everything that was refused on the way to it.
  return { ...outcome, refusals: outcome.refusals };
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
/**
 * Resolve a `rarext:` reference to a VERIFIED object — the client half of RFC 0022.
 *
 * The reference says what is meant and where to look; this says nothing about what to believe.
 * It turns the reference into the candidate set the SDK already knows how to walk
 * (`findVerifiedBundleFromSeeds` owns that walk, the pins and the refusal records — this adds no
 * second one) and accepts only a copy whose recomputed root equals the root THE REFERENCE
 * CARRIES. A location is a hint: when the first candidate serves bytes that do not rebuild to the
 * pinned root they are refused by name and the next candidate is tried, which is what makes a
 * reference safe to carry across mirrors.
 *
 * What is deliberately not here: resolving a registry ID to a host. An id needs the federation
 * list — a document, fetched with its own rules — and an authority in a reference is a hint about
 * where to look, so this asks the caller for either a hostname or the candidates. Guessing would
 * make the hint load-bearing.
 */
export interface RarextResolveOptions extends FindVerifiedBundleOptions {
  /**
   * Extra places to look. A bare root names an object and no location, so a caller that holds one
   * supplies the candidates it knows (its node, a mirror, a registry's bundle URL).
   */
  candidates?: string[];
  /**
   * The scheme for the reference's own location. A `rarext:` reference carries none — it is not a
   * URL — so a loopback deployment says `http` here rather than the reference pretending.
   */
  scheme?: "https" | "http";
  /** Observe each candidate as it is tried, refused, or accepted. */
  onCandidate?: (event: FindVerifiedBundleEvent) => void;
}

export type RarextResolveResult =
  | {
      ok: true;
      /**
       * What the root turned out to name: a registry's bundle, a record (a publication or an
       * anchor — core owns the registry of record identities), or raw bytes.
       */
      kind: "bundle" | "publication" | "anchor" | "credit" | "blob";
      root: string;
      source: string;
      /** A bundle, when the root named one. */
      bundle?: Bundle;
      /** The record, when the root named one — a publication, an anchor, or a credit receipt. */
      record?: Publication | Anchor | CreditRecordFields;
      /** A blob's bytes and the media type the host served them with, when the root named bytes. */
      bytes?: Uint8Array;
      mediaType?: string;
      candidates: number;
      /** Locations that were tried and refused before one verified. Evidence, not noise. */
      attempts: RarextAttempt[];
    }
  | { ok: false; reason: string; attempts: RarextAttempt[] };

/**
 * WHAT an attempt's refusal WAS, structurally — the difference an operator debugging mirrors asks
 * for first: was the host DOWN, did it answer without the object, or did it serve something that
 * does not rebuild the pinned root? A kind, not prose to be matched: the failure mode this closes is
 * exactly the one where a caller greps a message string and misfiles a dead mirror as a liar.
 */
export type RarextAttemptKind = "unreachable" | "unavailable" | "malformed" | "mismatch";

export interface RarextAttempt {
  url: string;
  reason: string;
  kind: RarextAttemptKind;
}

/** Is this authority something DNS can resolve, or just a name a registry uses for itself? */
function authorityIsHost(authority: string): boolean {
  return authority.includes(".") || authority.includes(":");
}

/**
 * Read each candidate ONCE, then interpret what came back.
 *
 * The readings after the bundle are: a PUBLICATION record (the root recomputed from the record — the
 * identity the storage economy writes things down under) and raw BYTES (their sha256). Both need the
 * same fetch, and fetching twice would be worse than wasteful: a mirror could change between calls
 * and the client would then be reasoning about two different objects while calling them one.
 *
 * The fetch is the walk's own policy-guarded one, with the same timeout and the same private-address
 * allowance, because what counts as a readable third-party location does not change because we
 * stopped expecting a bundle.
 */
async function readCandidate(
  url: string,
  root: string,
  ports: {
    fetch?: typeof fetch;
    sha256?: Sha256;
    timeoutMs?: number;
    allowPrivate: boolean;
    attempts: RarextAttempt[];
  },
): Promise<
  | { kind: "publication" | "anchor" | "credit"; source: string; record: Publication | Anchor | CreditRecordFields }
  | { kind: "blob"; source: string; bytes: Uint8Array; mediaType?: string }
  | null
> {
  const request = ports.fetch ?? fetch;
  const sha256 = ports.sha256 ?? nodeSha256;
  const timeoutMs = ports.timeoutMs ?? 15_000;

  let response: Response;

  try {
    response = await fetchWithUrlPolicy(
      url,
      { signal: AbortSignal.timeout(timeoutMs) },
      { fetch: request, allowPrivate: ports.allowPrivate },
    );
  } catch (error) {
    ports.attempts.push({ url, reason: `not read: ${(error as Error).message}`, kind: "unreachable" });
    return null;
  }

  if (!response.ok) {
    ports.attempts.push({ url, reason: `not read: the host answered ${response.status}`, kind: "unavailable" });
    return null;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const mediaType = response.headers.get("content-type") ?? undefined;
  const wanted = root.toLowerCase();

  // The publication reading. A cheap shape test first: a publication is a JSON OBJECT, so the first
  // significant byte decides and a binary never reaches JSON.parse.
  const text = new TextDecoder().decode(bytes);

  if (text.trimStart().startsWith("{")) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      parsed = undefined;
      ports.attempts.push({ url, reason: `its JSON does not parse: ${(error as Error).message}`, kind: "malformed" });
    }

    if (parsed !== undefined && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      // Which record rule rebuilds this document to the pinned root — core owns the registry of
      // record identities, so a new record kind is one entry there and every client gains it.
      const matched = matchRecordRoot(parsed, wanted, hashFnFrom(sha256));

      if (matched !== null) {
        return { kind: matched.kind, source: url, record: parsed as Publication | Anchor };
      }

      const asPublication = publicationRoot(parsed as never, hashFnFrom(sha256)).toLowerCase();
      ports.attempts.push({
        url,
        reason:
          `no record rule rebuilds this document to the pinned ${wanted.slice(0, 16)}… ` +
          `(as a publication it is ${asPublication.slice(0, 16)}…; a record is served with its root ` +
          "and durability attached, and those are not part of it)",
        kind: "mismatch",
      });
    }
  } else {
    ports.attempts.push({ url, reason: "its bytes are not a JSON object, so they name no record", kind: "mismatch" });
  }

  // The byte reading: whatever it is, the digest decides.
  const digest = toHex(sha256(bytes)).toLowerCase();

  if (digest === wanted) {
    return { kind: "blob", source: url, bytes, mediaType };
  }

  ports.attempts.push({
    url,
    reason: `its bytes hash to ${digest.slice(0, 16)}…, not the pinned ${wanted.slice(0, 16)}…`,
    kind: "mismatch",
  });

  return null;
}

/** A `HashFn` for core's rules, built from the digest the CALLER trusts. */
function hashFnFrom(sha256: Sha256): HashFn {
  return (value) =>
    toHex(sha256(typeof value === "string" ? new TextEncoder().encode(value) : value));
}

export async function resolveRarextUri(
  reference: string,
  options: RarextResolveOptions = {},
): Promise<RarextResolveResult> {
  const parsed = parseRarextUri(reference);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, attempts: [] };
  }
  const { uri } = parsed;

  const candidates: string[] = [];
  if (uri.authority !== undefined || (uri.path !== undefined && uri.path.length > 0)) {
    if (uri.authority === undefined) {
      return {
        ok: false,
        reason: "a reference with a path but no authority says where inside something it wants, but not what that something is",
        attempts: [],
      };
    }
    if (!authorityIsHost(uri.authority)) {
      return {
        ok: false,
        reason: `${uri.authority} is a registry id, not a host: name the hostname its operator publishes at, or pass the candidates yourself`,
        attempts: [],
      };
    }
    // The reference-to-URL rule lives in core, beside the parser it has to agree with.
    const located = urlForRarextUri(uri, options.scheme ?? "https");
    if (located !== null) candidates.push(located);
  }
  for (const candidate of options.candidates ?? []) candidates.push(candidate);

  const unique = [...new Set(candidates)];
  if (unique.length === 0) {
    return {
      ok: false,
      reason:
        "a bare root says what to look for, not where: name at least one candidate (a registry's bundle URL, a mirror, your own node) and the root will decide",
      attempts: [],
    };
  }

  // Every refusal is recorded as it happens, so a failure reads as evidence: which location was
  // tried, and why it did not count.
    const attempts: RarextAttempt[] = [];

  // The walk's refusals, mapped STRUCTURALLY from the stage each happened at (a fetch refusal is
  // unreachable, a shape or parse refusal is malformed, a pin or root refusal is a mismatch) — never
  // by matching the message prose. Used on success (the refusals a winning copy accumulated) and on
  // failure (the aggregate's), because an operator tells a dead mirror from a lying one by the KIND,
  // not by grepping strings.
  const mapRefusals = (refusals: Array<{ url: string; reason: string; stage: string; httpStatus?: number }>) => {
    for (const refusal of refusals) {
      attempts.push({
        url: refusal.url,
        reason: refusal.reason,
        kind:
          refusal.stage === "fetch"
            ? refusal.httpStatus
              ? "unavailable"
              : "unreachable"
            : refusal.stage === "shape" || refusal.stage === "parse"
              ? "malformed"
              : "mismatch",
      });
    }
  };
  const { onCandidate, ...rest } = options;
  const seed: SeedDocument = {
    // The seed's own location is the CANDIDATE, not the reference string. `allowPrivateFromSeeds`
    // reads this field to decide whether a local tree earns the private-address allowance, and a
    // "rarext:" string is not a URL: it parses with an empty hostname, which passes the address
    // policy, so the caller's own loopback node would have been refused as if it were public.
    url: unique[0] as string,
    bundle: unique[0] as string,
    bundleRoot: uri.root,
    ...(unique.length > 1
      ? { mirrors: unique.slice(1).map((url) => ({ bundle: url, root: uri.root })) }
      : {}),
  };

  // Derived ONCE, here, and handed to both readings: the walk would derive the same thing from the
  // same seed, and a second derivation is a second rule waiting to disagree.
  const allowPrivate = rest.allowPrivateHosts ?? allowPrivateFromSeeds([seed]);

  try {
    const found = await findVerifiedBundleFromSeeds([seed], {
      ...rest,
      allowPrivateHosts: allowPrivate,
      onCandidate: (event) => {
        // Observation only: the structured evidence lands in `attempts` from the aggregate the walk
        // throws, which carries the STAGE each refusal happened at.
        onCandidate?.(event);
      },
    });
    mapRefusals(found.refusals);
    return {
      ok: true,
      kind: "bundle",
      root: found.root,
      source: found.source,
      bundle: found.bundle,
      candidates: found.candidates,
      attempts,
    };
  } catch (error) {
    // The bundle reading is exhausted. A reference does not say what it names — only the root does —
    // so the same candidates are read as RECORDS and as BYTES before anything is called missing.
    const bundleReason = (error as Error).message;

    // The walk's refusals, with the stage each happened at — mapped STRUCTURALLY (a fetch refusal is
    // unreachable, a shape or parse refusal is malformed, a pin or root refusal is a mismatch), never
    // by matching the message prose. This is the bundle reading's evidence, and it is what lets an
    // operator tell a dead mirror from a lying one without grepping strings.
    if ("refusals" in (error as object)) {
      mapRefusals(
        (error as unknown as { refusals: Array<{ url: string; reason: string; stage: string }> }).refusals,
      );
    }

    // One fetch per candidate, interpreted twice: a publication record, then raw bytes. A failure
    // reports every reading, because "not a bundle" is not the same answer as "not there".
    for (const url of unique) {
      const read = await readCandidate(url, uri.root, { ...rest, allowPrivate, attempts });

      if (read === null) continue;

      if (read.kind !== "blob") {
        return {
          ok: true,
          kind: read.kind,
          root: uri.root,
          source: read.source,
          record: read.record,
          candidates: unique.length,
          attempts,
        };
      }

      return {
        ok: true,
        kind: "blob",
        root: uri.root,
        source: read.source,
        bytes: read.bytes,
        mediaType: read.mediaType,
        candidates: unique.length,
        attempts,
      };
    }

    return {
      ok: false,
      reason:
        `${bundleReason}; and reading the same candidates as records and as bytes found none whose ` +
        `root is ${uri.root.slice(0, 16)}…`,
      attempts,
    };
  }
}

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

/**
 * Build a bundle offline: the publishing half of the rule the SDK already
 * verifies.
 *
 * Until this, an agent with no server could verify a bundle and replay its AI
 * claims, and could not MAKE one — half a protocol. The assembly is core's (the
 * same function the registry's own builder calls), the hash is node's, and the
 * createdAt is the caller's clock because a bundle's creation time is not part of
 * its root: it records when the artifact was made, not what it says.
 */

export interface SelfPublishInput {
  author: string;
  title: string;
  body?: string;
  artifact: Artifact;
  /** The run the agent performed itself — the thing being attested. */
  circuit: Circuit;
  task: Task;
  binding: AttestationBinding;
  visibility?: Visibility;
  createdAt?: string;
}

/**
 * Make AND prove: attest a run the agent performed, sign the record, and assemble
 * a bundle — with no server anywhere.
 *
 * This is the write half of "AI lives on RAREXT" in one function. Until now the
 * pieces existed apart: core could attest a run and assemble a bundle, the SDK
 * could sign a payload, and the registry was the only place they met — so an
 * agent with no server could replay the world's claims and contribute none of its
 * own.
 *
 * The honesty of it rests on two choices. The attestation comes from core's
 * `attestRun`, the same assembly the registry uses, so a resident's record and
 * the registry's describe the same run the same way — and the verifier is named by
 * the caller, because an agent attesting as itself should say so rather than
 * borrow the registry's name. The bundle is then built from that publication by
 * the same `buildBundle`, so the artifact it makes is one anybody can verify.
 */

export interface SelfPublishGenerativeInput {
  author: string;
  title: string;
  body?: string;
  /** The committed model, the seed, and how many tokens to generate. */
  model: XorshiftModel;
  seed: number;
  /**
   * How many tokens to generate. Defaults to what the challenge asks for — an
   * agent that generates a different number has answered a different question,
   * and its claim will be refused.
   */
  steps?: number;
  /**
   * The task this run answers, carried INTO the bundle. A claim replayed by a
   * stranger needs the challenge as much as the output: without it there is
   * nothing to check the output AGAINST, and the verdict is "challenge not in
   * bundle" rather than a pass.
   */
  challenge: Challenge;
  /**
   * Ship a RENDITION of the output — a picture beside the values, exactly as a
   * registry publishes one. The raster is the commitment (its digest is what the
   * evidence records); the PNG is one faithful encoding of it, because two
   * encoders produce different deflate streams for the same pixels. A resident
   * that wants an artifact the gallery can show needs this; one that only wants
   * the values does not.
   */
  rendition?: number;
  binding: { id: string; version: number; claimKind: ClaimKind };
  /**
   * The semantics record this claim is bound by, carried INTO the bundle. A
   * claim whose semantics travel with it can be replayed by a stranger; one that
   * does not is a claim about a rule the reader has to find elsewhere.
   */
  semantics?: Semantics[];
  visibility?: Visibility;
  createdAt?: string;
}

/**
 * Make AND prove an AI output: run the committed model here, attest the run
 * under the agent's own verifier name, sign it, and assemble the bundle.
 *
 * The circuit path (`selfPublish`) proves a computation; this proves a
 * GENERATION — the artifact the vision is actually about. The agent does not ask
 * anyone what the model produced: it runs the committed model itself and the
 * attestation records what the replay found. The verifier manifest is the
 * agent's own, hashed as its identity, so a stranger can see which rule was run
 * rather than a borrowed name.
 */

export interface SelfPublishBoundedInput {
  author: string;
  title: string;
  body?: string;
  /** The lossy reconstruction: what the agent's own model produced. */
  values: number[];
  /** The task, carrying the committed reference, metric and bound. */
  challenge: Challenge;
  binding: { id: string; version: number; claimKind: ClaimKind };
  semantics?: Semantics[];
  visibility?: Visibility;
  createdAt?: string;
  /**
   * Ship a RENDITION of the reconstruction — the strip that draws it against the
   * committed reference, at the shape the caller asks for (defaulting to the rule's
   * own: one lane per value at the rule's scale). The reference must come from the
   * challenge; a resident cannot render a strip against a reference it chose itself
   * and call the result this artifact's picture.
   */
  rendition?: { width?: number; height?: number };
}

/**
 * Make AND prove a LOSSY output — the representation real model classes take.
 *
 * `ai-generative` demands exact replay. That is the right demand for a small
 * deterministic model and the wrong one for a quantized network, a compressed
 * embedding, or a neural codec: nobody can hash-compare a float tensor
 * regenerated on other hardware. This path instead promises a DISTANCE — "the
 * max absolute error against the committed reference is within the bound" — and
 * the metric is recomputed by anyone holding the challenge and the values.
 *
 * The agent computes the metric itself and attests under the RULE's name
 * (`bounded-metric-replay`), because that is the rule it ran; who ran it is the
 * signature.
 */
export function selfPublishBounded(
  signer: AgentSigner,
  input: SelfPublishBoundedInput,
): { attestation: Attestation; publication: Publication; bundle: Bundle; payload: PublicationPayload } {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const app = "ai-bounded";
  const challengeId = input.challenge.id;
  const values = requireValues(input.values);
  const spec = input.challenge.spec as BoundedSpec;
  if (input.rendition !== undefined && !Array.isArray(spec.reference)) {
    throw new Error("selfPublishBounded: the challenge carries no committed reference to render a rendition against");
  }
  // The strip, assembled by core's shared rule — the same one the publisher and the
  // registry's own verifier use, so a resident's picture is the artifact's picture.
  const media: BoundedMedia | undefined =
    input.rendition === undefined
      ? undefined
      : boundedRenditionFor(spec.reference as number[], values, {
          encodePng: (raster, width, height) => new Uint8Array(encodePngRaster(raster, width, height)),
          sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
        }, input.rendition);
  const body: BoundedBody = { values, ...(media ? { media } : {}) };
  const artifact: Artifact = {
    app,
    kind: "ai.bounded",
    version: 1,
    mediaType: "application/json",
    body,
  };

  const attestation = attestBoundedRun({
    artifact,
    body,
    spec,
    app,
    challengeId,
    verifier: "bounded-metric-replay",
    verifierManifest: { app, version: 1, metrics: ["maxAbsError", "meanAbsError"], representation: "bounded" },
    bound: input.binding,
    id: randomUUID(),
    createdAt,
    sha256: (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex"),
  });

  const payload = signer.artifactPayload({
    author: input.author,
    title: input.title,
    ...(input.body === undefined ? {} : { body: input.body }),
    artifact,
    challengeId,
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    createdAt,
  });

  const publication = publicationFromSignedInput(
    {
      author: payload.author!,
      title: payload.title!,
      body: payload.body!,
      app: payload.app!,
      challengeId: payload.challengeId!,
      artifact: payload.artifact!,
      parentId: payload.parentId ?? null,
      source: payload.source ?? null,
      createdAt: payload.createdAt!,
      authorKey: payload.authorKey!,
      verified: true,
      signature: signer.sign(payload),
      nonce: payload.nonce ?? null,
      visibility: payload.visibility ?? "public",
    },
    {
      attestation,
      verification: "recomputed",
      attestationKeyId: null,
      attestationSignature: null,
      challenge: input.challenge,
      suite: signer.suite,
      id: randomUUID(),
    },
  );

  return {
    attestation,
    publication,
    bundle: buildBundle([publication], {
      challenges: [input.challenge],
      ...(input.semantics === undefined ? {} : { semantics: input.semantics }),
      createdAt,
    }),
    payload,
  };
}

export function selfPublishGenerative(
  signer: AgentSigner,
  input: SelfPublishGenerativeInput,
): { attestation: Attestation; publication: Publication; bundle: Bundle; payload: PublicationPayload } {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const app = "ai-generative";
  const challengeId = input.challenge.id;
  // Validated before anything is computed or signed: a record with a fractional
  // gate count or an output generated from a NaN seed is not a weak claim, it is
  // a claim nobody can use.
  const steps = requireSteps(input.steps ?? (input.challenge.spec as { steps?: number }).steps ?? 0);
  const seed = requireFiniteSeed(input.seed);

  // The agent runs the model itself — the output is computed, never claimed.
  const output = generate(input.model, seed, steps);

  // The rendition, when asked for: rendered from the same model and seed, so it is
  // a function of the commitment rather than a picture sitting beside it.
  // The assembly lives in core — one copy for every surface that ships a rendition.
  const media: GenerativeMedia | undefined =
    input.rendition === undefined
      ? undefined
      : renditionFor(input.model, seed, input.rendition, {
          encodePng: (raster, size) => new Uint8Array(encodePngRaster(raster, size)),
          sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
        });

  const body: GenerativeBody = { model: input.model, seed, output, ...(media ? { media } : {}) };
  const artifact: Artifact = {
    app,
    kind: "ai.generative",
    version: 1,
    mediaType: "application/json",
    body,
  };

  const attestation = attestGenerativeRun({
    artifact,
    body,
    spec: { steps } as GenerativeSpec,
    app,
    challengeId,
    // The name and manifest describe the RULE that was run, not who ran it —
    // an agent replaying the committed model is running `xorshift32-replay`
    // exactly as the registry does, and saying otherwise would make its claim
    // unverifiable. WHO ran it is the signature, which is not borrowed.
    verifier: "xorshift32-replay",
    verifierManifest: { app, version: 1, algorithm: "xorshift32-replay", representation: "generative" },
    bound: input.binding,
    id: randomUUID(),
    createdAt,
    sha256: (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex"),
  });

  const payload = signer.artifactPayload({
    author: input.author,
    title: input.title,
    ...(input.body === undefined ? {} : { body: input.body }),
    artifact,
    challengeId,
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    createdAt,
  });

  const publication = publicationFromSignedInput(
    {
      author: payload.author!,
      title: payload.title!,
      body: payload.body!,
      app: payload.app!,
      challengeId: payload.challengeId!,
      artifact: payload.artifact!,
      parentId: payload.parentId ?? null,
      source: payload.source ?? null,
      createdAt: payload.createdAt!,
      authorKey: payload.authorKey!,
      verified: true,
      signature: signer.sign(payload),
      nonce: payload.nonce ?? null,
      visibility: payload.visibility ?? "public",
    },
    {
      attestation,
      verification: "recomputed",
      attestationKeyId: null,
      attestationSignature: null,
      challenge: input.challenge,
      suite: signer.suite,
      id: randomUUID(),
    },
  );

  return {
    attestation,
    publication,
    bundle: buildBundle([publication], {
      challenges: [input.challenge],
      ...(input.semantics === undefined ? {} : { semantics: input.semantics }),
      createdAt,
    }),
    payload,
  };
}

export function selfPublish(
  signer: AgentSigner,
  input: SelfPublishInput,
  options: { verifier?: string } = {},
): {
  attestation: Attestation;
  publication: Publication;
  bundle: Bundle;
  /**
   * The exact payload that was signed. Returned so a caller can verify the
   * signature it just made against its own public key — the difference between
   * "there is a signature" and "the signature is over this record".
   */
  payload: PublicationPayload;
} {
  const createdAt = input.createdAt ?? new Date().toISOString();

  const attestation = attestRun({
    circuit: input.circuit,
    task: input.task,
    binding: input.binding,
    verifier: options.verifier ?? "resident",
    id: randomUUID(),
    createdAt,
    sha256: (value: string) => createHash("sha256").update(value).digest("hex"),
  });

  const payload = signer.artifactPayload({
    author: input.author,
    title: input.title,
    ...(input.body === undefined ? {} : { body: input.body }),
    artifact: input.artifact,
    challengeId: input.task.id,
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    createdAt,
  });
  const signature = signer.sign(payload);

  // The non-null assertions are exact: `artifactPayload` sets author, title,
  // body, app, challengeId, artifact, authorKey, createdAt and nonce
  // unconditionally. The payload TYPE is loose because a payload read off the
  // wire may lack them — a difference between what is built here and what is
  // accepted from elsewhere, not an uncertainty about this object.
  const publication = publicationFromSignedInput(
    {
      author: payload.author!,
      title: payload.title!,
      body: payload.body!,
      app: payload.app!,
      challengeId: payload.challengeId!,
      artifact: payload.artifact!,
      circuit: input.circuit,
      parentId: payload.parentId ?? null,
      source: payload.source ?? null,
      createdAt: payload.createdAt!,
      authorKey: payload.authorKey!,
      verified: true,
      signature,
      nonce: payload.nonce ?? null,
      visibility: payload.visibility ?? "public",
    },
    {
      attestation,
      verification: "recomputed",
      attestationKeyId: null,
      attestationSignature: null,
      challenge: { id: input.task.id },
      suite: signer.suite,
      id: randomUUID(),
    },
  );

  return { attestation, publication, bundle: buildBundle([publication], { createdAt }), payload };
}

export function buildBundle(
  publications: Publication[],
  options: {
    anchors?: Anchor[];
    challenges?: Challenge[];
    semantics?: Semantics[];
    anchor?: Anchor | null;
    leafVersion?: number;
    createdAt?: string;
    bundleVersion?: number;
  } = {},
): Bundle {
  return assembleBundle({
    publications,
    ...(options.anchors === undefined ? {} : { anchors: options.anchors }),
    ...(options.challenges === undefined ? {} : { challenges: options.challenges }),
    ...(options.semantics === undefined ? {} : { semantics: options.semantics }),
    ...(options.anchor === undefined ? {} : { anchor: options.anchor }),
    ...(options.leafVersion === undefined ? {} : { leafVersion: options.leafVersion }),
    ...(options.bundleVersion === undefined ? {} : { bundleVersion: options.bundleVersion }),
    createdAt: options.createdAt ?? new Date().toISOString(),
    sha256: nodeSha256,
  });
}

/**
 * Does the registry's semantics commitment cover the records the bundle carries?
 *
 * RFC 0003's question 1, answered by a reader with no server and no key: the registry commits
 * to `id@version -> digest` as an ordinary publication, so an agent holding a bundle can tell
 * whether the MEANING it just resolved is the one the registry anchored. Returns null when the
 * bundle records no commitment at all — an artifact that never made the claim, which must not
 * be reported as one whose claim failed.
 *
 * The comparison is core's (`semanticsCommitmentHolds`), so the page a human reads and the
 * agent that reads the same bundle apply one rule rather than two that can disagree.
 */
export function verifyBundleSemantics(bundle: Bundle): SemanticsCommitmentStatus | null {
  const commitment = bundleSemanticsCommitment(bundle);
  if (!commitment) return null;

  const records = bundle.semantics ?? [];
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const digests: Record<string, string> = {};
  for (const record of records) digests[semanticsKey(record)] = semanticsRecordDigest(record, sha256);
  return semanticsCommitmentHolds(commitment, records, (record) => digests[semanticsKey(record)]!);
}

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

export { crc32, encodePngRaster } from "./png.ts";

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

  /** The registry's own bundle: what it commits to, and the root it reports for it. */
  bundle(): Promise<Bundle> {
    return this.request("/v1/bundles");
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

  // ── The participation economy, as typed methods ─────────────────────────────
  // An AI agent runs the whole operator/participant loop without hand-building
  // HTTP: verify the node it is joining (journey), leave a participation receipt,
  // propose, vote, pledge, execute. Every signature is built HERE from the
  // signer's key, so the client's output is a signed document, not a wish.

  /** The five-rail journey against THIS client's node (see journey.ts). */
  journey(options: { root?: string; registry?: string; allowPrivate?: boolean } = {}): Promise<JourneyDocumentForClient> {
    return runNodeJourneyForClient(this.baseUrl, { ...options, fetch: this.requestFetch });
  }

  /** The work rail's whole-ledger commitment. */
  ledger(): Promise<{ root: string; count: number; at: string }> {
    return this.request("/v1/work/ledger");
  }

  /** A participant's receipts, each with its identity and inclusion proof. */
  earnings(keyId: string): Promise<{
    records: Array<CreditRecordFields & { root: string; ledger: { root: string; index: number; proof: string[] } | null }>;
  }> {
    return this.request(`/v1/work/earnings?keyId=${encodeURIComponent(keyId)}`);
  }

  /**
   * Leave a participation receipt: the signer asserts they verified `root` (a mirror-verify, by
   * default), the node corroborates what it can know — registered key, signature, root anchored —
   * and the ledger records a zero-bounty receipt a later budget decision can pay.
   */
  async participate(
    signer: AgentSigner,
    act: string,
    root: string,
  ): Promise<{ receipt: CreditRecordFields & { root: string; ledger: { root: string; index: number; proof: string[] } | null } }> {
    const assertion = {
      kind: "rarext.participation.v1",
      participant: signer.keyId,
      act,
      root,
      at: new Date().toISOString(),
    };
    return this.request("/v1/work/participation", {
      ...assertion,
      signature: signer.sign(assertion),
    });
  }

  /**
   * The treasury view: the receipt classes a decision can name, sized from this node's own ledger.
   * An agent sizing a pledge reads the class it will actually resolve against — receipts and
   * DISTINCT holders per act, with a per-root breakdown — instead of guessing at a population it
   * cannot see. `pending` names the budgets already in flight so a new pledge is not made blind.
   */
  treasury(): Promise<{
    ledgerRoot: string;
    classes: Array<{
      act: string;
      receipts: number;
      holders: number;
      byRoot: Array<{ root: string; receipts: number; holders: number }>;
    }>;
    pending: Array<Record<string, unknown>>;
    at: string;
  }> {
    return this.request("/v1/work/treasury");
  }

  /**
   * Claim the operator's anchoring: the signer asserts it ran the node that committed `root`, the
   * node corroborates what it can know — registered key, signature, root THIS node anchored — and
   * the ledger records a zero-bounty receipt (the mining analogy with the mint removed). A later
   * budget decision can pay the operators it names; this is the operator's side of the roles, and
   * an agent that runs a node earns its standing through this call.
   */
  async claimAnchoring(
    signer: AgentSigner,
    root: string,
  ): Promise<{ receipt: CreditRecordFields & { root: string; ledger: { root: string; index: number; proof: string[] } | null } }> {
    const claim = {
      kind: "rarext.anchor-work.v1",
      operator: signer.keyId,
      root,
      at: new Date().toISOString(),
    };
    return this.request("/v1/work/anchor", {
      ...claim,
      signature: signer.sign(claim),
    });
  }

  /** Propose a decision. */
  propose(document: GovernanceProposal): Promise<{ root: string; proposal: GovernanceProposal }> {
    return this.request("/v1/governance/proposals", document);
  }

  /** Attach a registry admission to a proposal: the join request. */
  attachAdmission(root: string, admission: Record<string, unknown>): Promise<{ root: string; admission: Record<string, unknown> }> {
    return this.request(`/v1/governance/proposals/${encodeURIComponent(root)}/admission`, admission);
  }

  /** Cast a signed ballot, built here from the voter's key via core's voteStatement. */
  async vote(signer: AgentSigner, proposalRoot: string, choice: string, closesAt: string): Promise<GovernanceVote> {
    const base = {
      kind: "rarext.governance-vote.v1",
      proposalRoot,
      choice,
      voter: `anon-${sha256Hex(nodeSha256, canonicalize(signer.publicKey)).slice(0, 8)}`,
      publicKey: signer.publicKey,
      issuedAt: new Date(Date.parse(closesAt) - 60_000).toISOString(),
      suite: signer.suite,
    };
    const signed = { ...base, signature: signer.sign(voteStatement(base as unknown as GovernanceVote)) };
    return this.request(`/v1/governance/proposals/${encodeURIComponent(proposalRoot)}/votes`, signed);
  }

  /** Pledge a budget toward a proposal: a single key, or a receipt-holders spec. */
  async pledgeBudget(
    signer: AgentSigner,
    input: {
      proposalRoot: string;
      to: string | { kind: "receipt-holders"; act: string; root?: string };
      amount: number;
      reason: string;
      payOn: string;
    },
  ): Promise<{ root: string; budget: GovernanceBudget }> {
    const payload = {
      kind: "rarext.governance-budget.v1",
      version: 1,
      from: signer.keyId,
      to: input.to,
      amount: input.amount,
      reason: input.reason,
      payOn: input.payOn,
      createdAt: new Date().toISOString(),
      proposalRoot: input.proposalRoot,
    };
    return this.request(`/v1/governance/proposals/${encodeURIComponent(input.proposalRoot)}/budget`, {
      payload,
      signature: signer.sign(payload),
    });
  }

  /** Execute a decided proposal: pay a budget, apply an admission. Anyone may call this. */
  execute(proposalRoot: string): Promise<{
    executed: true;
    records?: Array<Record<string, unknown>>;
    admitted?: Record<string, unknown>;
    holders?: string[];
    ledgerRoot?: string;
  }> {
    return this.request(`/v1/governance/proposals/${encodeURIComponent(proposalRoot)}/execute`, {});
  }

  /** The federation list THIS node's decisions have admitted, seed-shaped. */
  registries(): Promise<{ registries: Array<Record<string, unknown>> }> {
    return this.request("/v1/registries");
  }

  /**
   * The node's capabilities document: an agent landing cold bootstraps from this one answer —
   * the paths the node serves, as data, held against the route table so it cannot drift.
   */
  capabilities(): Promise<{
    kind: string;
    version: 1;
    binding: string;
    rails: Array<{ path: string; note?: string }>;
    families: string[];
  }> {
    return this.request("/v1/capabilities");
  }

  /**
   * Discovery: who this node is, and the peers it knows — each carrying HOW it knows them (a seed
   * the operator configured, or a decision this node's own 民主 rail applied). The provenance is
   * the substance: an admitted peer and an inherited one are different claims.
   */
  nodes(): Promise<{
    self: { registry: string | null; origin: string; binding: string; anchoredRoot: string | null; chain: string[] };
    known: Array<Record<string, unknown> & { id: string; source: string }>;
    at: string;
  }> {
    return this.request("/v1/nodes");
  }

  /**
   * What needs deciding: the proposals whose window is still open, with their attachments and
   * their tally so far. An agent finds work to weigh in on without already knowing a root.
   */
  openDecisions(): Promise<{
    open: Array<{
      root: string;
      proposal: GovernanceProposal;
      closesAt: string;
      admission: Record<string, unknown> | null;
      budget: Record<string, unknown> | null;
      votes: number;
      tally: Record<string, unknown>;
    }>;
    at: string;
  }> {
    return this.request("/v1/governance/open");
  }

  /** The chain of state archives: the ledger's history, tamper-evident by construction. */
  stateHistory(): Promise<{ archives: Array<Record<string, unknown> & { anchorRoot: string; previousStateRoot: string; stateRoot: string }> }> {
    return this.request("/v1/history");
  }

  /** One state archive, by the anchor root it was frozen at. */
  stateArchive(anchorRoot: string): Promise<Record<string, unknown>> {
    return this.request(`/v1/history/${encodeURIComponent(anchorRoot)}`);
  }

  /**
   * Verify the state chain the node serves: every archive's root recomputes with core's rule,
   * and every link names the archive before it (the head anchoring to genesis). The node's word
   * is not the verdict — this recomputes it.
   */
  async verifyStateChain(): Promise<{ ok: boolean; failures: string[]; count: number }> {
    const { archives } = await this.stateHistory();
    const failures: string[] = [];
    let previous = "0".repeat(64);
    for (const [index, archive] of archives.entries()) {
      const record = archive as unknown as Parameters<typeof stateArchiveRoot>[0];
      if (archive.previousStateRoot !== previous) {
        failures.push(`archive ${index} (${archive.anchorRoot.slice(0, 8)}…) does not chain to the archive before it`);
      }
      const { stateRoot: _served, ...rest } = archive;
      if (stateArchiveRoot(rest as never, (value: string) => sha256Hex(nodeSha256, value)) !== archive.stateRoot) {
        failures.push(`archive ${index} (${archive.anchorRoot.slice(0, 8)}…) does not rebuild its served state root`);
      }
      previous = archive.stateRoot;
    }
    return { ok: failures.length === 0, failures, count: archives.length };
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
