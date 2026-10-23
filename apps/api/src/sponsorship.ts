import { existsSync, readFileSync } from "node:fs";

import type { Challenge, JsonWebKey } from "../../../packages/core/src/index.ts";
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

export function verifyChallengeSponsorship(
  input: unknown,
  sponsors: SponsorRegistry,
  now = Date.now(),
): SponsorshipResult {
  if (sponsors.size === 0) {
    return fail(503, "challenge sponsorship is not configured");
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

  if (payload.kind !== "rarext.challenge-sponsorship.v1" || payload.version !== 1) {
    return fail(400, "payload must be a version 1 challenge sponsorship");
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
    nonce: payload.nonce,
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
