import { existsSync, readFileSync } from "node:fs";

import { voteProblems } from "../../../packages/core/src/index.ts";
import type { Challenge, GovernanceVote, JsonWebKey } from "../../../packages/core/src/index.ts";
import { asChallenge } from "./challenges.ts";
import { asPublicKey, verifyPayload } from "./identity.ts";

const MEMBER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_COMMUNITY_LENGTH = 64;
const MAX_PROOF_AGE_MS = 10 * 60 * 1000;

export interface Sponsor {
  handle: string;
  community: string | null;
  publicKey: JsonWebKey;
}

export interface SponsorInput {
  handle: string;
  community?: string | null;
  publicKey: JsonWebKey;
}

export interface SponsorRegistry {
  readonly size: number;
  has(handle: string): boolean;
  get(handle: string): Sponsor | null;
  list(): Sponsor[];
}

export interface ChallengeEvent {
  kind: "rarext.challenge.v1";
  version: 1;
  challengeId: string;
  status: "sponsored";
  member: string;
  community: string | null;
  createdAt: string;
  challenge: Challenge;
}

export interface SponsorshipSuccess {
  challenge: Challenge;
  event: ChallengeEvent;
  nonce: string;
}

export interface SponsorshipFailure {
  status: number;
  error: string;
}

export type SponsorshipResult = SponsorshipSuccess | SponsorshipFailure;

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }

  return value as Record<string, unknown>;
}

function asSponsor(value: unknown, index: number): Sponsor {
  const record = asObject(value, `member ${index}`);

  if (typeof record.handle !== "string" || !MEMBER_PATTERN.test(record.handle)) {
    throw new Error(`member ${index} has an invalid handle`);
  }

  let community: string | null = null;

  if (record.community !== undefined && record.community !== null) {
    if (
      typeof record.community !== "string" ||
      record.community.trim().length === 0 ||
      record.community.trim().length > MAX_COMMUNITY_LENGTH
    ) {
      throw new Error(`member ${record.handle} has an invalid community`);
    }

    community = record.community.trim();
  }

  return {
    handle: record.handle,
    community,
    publicKey: asPublicKey(record.publicKey),
  };
}

function configuredSponsors(): SponsorInput[] {
  const source = process.env.RAREXT_SPONSOR_MEMBERS?.trim();

  if (!source) return [];

  let text = source;

  if (!source.startsWith("[") && !source.startsWith("{")) {
    if (!existsSync(source)) {
      throw new Error(`RAREXT_SPONSOR_MEMBERS file not found: ${source}`);
    }
    text = readFileSync(source, "utf8");
  }

  const parsed = JSON.parse(text) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && "members" in parsed
      ? (parsed as { members: unknown }).members
      : null;

  if (!Array.isArray(list)) {
    throw new Error("RAREXT_SPONSOR_MEMBERS must be an array or { members: [] }");
  }

  return list as SponsorInput[];
}

export function createSponsorRegistry(members?: SponsorInput[]): SponsorRegistry {
  const registry = new Map<string, Sponsor>();

  for (const [index, input] of (members ?? configuredSponsors()).entries()) {
    const sponsor = asSponsor(input, index);

    if (registry.has(sponsor.handle)) {
      throw new Error(`duplicate sponsor member: ${sponsor.handle}`);
    }

    registry.set(sponsor.handle, sponsor);
  }

  return {
    size: registry.size,
    has: (handle) => registry.has(handle),
    get: (handle) => registry.get(handle) ?? null,
    list: () => [...registry.values()],
  };
}

function fail(status: number, error: string): SponsorshipFailure {
  return { status, error };
}

/**
 * The half of a sponsorship that is the same whoever is being sponsored.
 *
 * A sponsor's assertion is one shape — which member, when, under which nonce, signed by that
 * member's key — and the only thing that differs between sponsoring a challenge and sponsoring a
 * vote is WHAT the assertion carries. Extracting this means a fix to the freshness window, the
 * nonce bound, or the roster check lands in both at once, instead of in whichever path was
 * remembered; the messages keep naming the thing being sponsored, because an operator reading
 * "vote sponsorship is not configured" learns something "sponsorship is not configured" hides.
 */
interface SponsorAssertion {
  sponsor: Sponsor;
  nonce: string;
  payload: Record<string, unknown>;
}

function verifySponsorAssertion(
  input: unknown,
  sponsors: SponsorRegistry,
  label: string,
  kind: string,
  now: number,
): SponsorAssertion | SponsorshipFailure {
  if (sponsors.size === 0) {
    return fail(503, `${label} sponsorship is not configured`);
  }

  let body: Record<string, unknown>;

  try {
    body = asObject(input, "body");
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : "invalid body");
  }

  if (typeof body.signature !== "string" || body.signature.length === 0) {
    return fail(400, "signature must be a base64 string");
  }

  let payload: Record<string, unknown>;

  try {
    payload = asObject(body.payload, "payload");
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : "invalid payload");
  }

  if (payload.kind !== kind || payload.version !== 1) {
    return fail(400, `payload must be a version 1 ${label} sponsorship`);
  }

  if (typeof payload.member !== "string" || payload.member.length === 0) {
    return fail(400, "payload.member must be a string");
  }

  const sponsor = sponsors.get(payload.member);

  if (!sponsor) {
    return fail(403, "member is not an authorized sponsor");
  }

  if (typeof payload.createdAt !== "string") {
    return fail(400, "payload.createdAt must be an ISO timestamp");
  }

  const timestamp = Date.parse(payload.createdAt);

  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > MAX_PROOF_AGE_MS) {
    return fail(400, "payload.createdAt must be within 10 minutes of now");
  }

  if (
    typeof payload.nonce !== "string" ||
    payload.nonce.length < 8 ||
    payload.nonce.length > 128
  ) {
    return fail(400, "payload.nonce must be between 8 and 128 characters");
  }

  if (!verifyPayload(sponsor.publicKey, payload, body.signature)) {
    return fail(401, "signature does not match the sponsor member");
  }

  return { sponsor, nonce: payload.nonce, payload };
}

export function verifyChallengeSponsorship(
  input: unknown,
  sponsors: SponsorRegistry,
  now = Date.now(),
): SponsorshipResult {
  const assertion = verifySponsorAssertion(input, sponsors, "challenge", "rarext.challenge-sponsorship.v1", now);

  if ("status" in assertion) return assertion;

  const { sponsor, payload, nonce } = assertion;

  let challenge: Challenge;

  try {
    const raw = asObject(payload.challenge, "payload.challenge");
    challenge = asChallenge({
      ...raw,
      createdAt:
        typeof raw.createdAt === "string" ? raw.createdAt : payload.createdAt,
    });
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : "invalid challenge");
  }

  challenge.status = "sponsored";
  challenge.sponsor = sponsor.handle;

  return {
    challenge,
    nonce,
    event: {
      kind: "rarext.challenge.v1",
      version: 1,
      challengeId: challenge.id,
      status: "sponsored",
      member: sponsor.handle,
      community: sponsor.community,
      createdAt: new Date(now).toISOString(),
      challenge,
    },
  };
}

/**
 * A sponsored ballot: THE SPONSOR PAYS, THE VOTER STILL SIGNS.
 *
 * Two signatures, two meanings, and the route must not confuse them. The SPONSOR signs an
 * assertion that carries the whole ballot, so a sponsor cannot be tricked into paying for a
 * different one — change a field and their signature stops matching. The VOTER signs the ballot
 * itself, and that signature is verified here, so a sponsor cannot push a vote nobody cast: the
 * money buys the storage, never the choice.
 *
 * The vote's own signature is checked through a PORT rather than re-implemented, because the same
 * check runs when a ballot arrives unsponsored; one rule, two callers.
 */
export interface VoteSponsorship {
  vote: GovernanceVote;
  member: string;
  nonce: string;
}

export type VoteSponsorshipResult = VoteSponsorship | SponsorshipFailure;

export function verifyVoteSponsorship(
  input: unknown,
  sponsors: SponsorRegistry,
  verifyVote: (vote: GovernanceVote) => boolean,
  now = Date.now(),
): VoteSponsorshipResult {
  const assertion = verifySponsorAssertion(input, sponsors, "vote", "rarext.vote-sponsorship.v1", now);

  if ("status" in assertion) return assertion;

  const raw = assertion.payload.vote;

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail(400, "payload.vote must carry the ballot being sponsored");
  }

  const vote = raw as GovernanceVote;
  const problems = voteProblems(vote);

  if (problems.length > 0) {
    return fail(400, problems[0] as string);
  }

  if (!verifyVote(vote)) {
    return fail(
      401,
      "the sponsored vote's signature does not match its own voter: a sponsor pays for a ballot, it does not cast one",
    );
  }

  return { vote, member: assertion.sponsor.handle, nonce: assertion.nonce };
}
