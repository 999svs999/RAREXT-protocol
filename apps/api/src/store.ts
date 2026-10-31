import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { CURRENT_SNAPSHOT_VERSION, migrateSnapshot } from "./migrations.ts";
import type {
  Revocation,
  RevocationKind,
} from "./revocations.ts";
import type { CreditRecord } from "./work.ts";
import type {
  Anchor,
  Artifact,
  BuildLineage,
  BuildSearchQuery,
  BuildSummary,
  Challenge,
  Circuit,
  Delegation,
  Identity,
  IdentityLink,
  JsonWebKey,
  KeyRotation,
  Profile,
  Publication,
  SignatureSuite,
} from "../../../packages/core/src/index.ts";

export interface FeedQuery {
  taskId?: string;
  author?: string;
  parentId?: string;
  limit?: number;
  offset?: number;
}

export interface RetiredKey {
  handle: string;
  keyId: string;
  publicKey: JsonWebKey;
  algorithm: SignatureSuite;
  retiredAt: string;
}

interface Snapshot {
  version: number;
  publications: Publication[];
  identities: Identity[];
  anchors: Anchor[];
  identityLinks?: IdentityLink[];
  revocations?: Revocation[];
  credits?: CreditRecord[];
  rotations?: KeyRotation[];
  delegations?: Delegation[];
  challenges?: Challenge[];
}

export class RarextStore {
  private readonly publications = new Map<string, Publication>();
  private readonly profiles = new Map<string, Profile>();
  private readonly order: string[] = [];
  private readonly identitiesByHandle = new Map<string, Identity>();
  private readonly identitiesByKey = new Map<string, Identity>();
  private readonly retiredKeys = new Map<string, RetiredKey>();
  private readonly rotations: KeyRotation[] = [];
  private readonly delegations: Delegation[] = [];
  private readonly challengeRecords = new Map<string, Challenge>();
  private readonly anchors = new Map<string, Anchor>();
  private readonly anchoredIds = new Set<string>();
  private readonly identityLinks = new Map<string, IdentityLink>();
  private readonly revocations = new Map<string, Revocation>();
  private readonly credits: CreditRecord[] = [];
  private readonly filePath: string | null;

  constructor(filePath?: string) {
    this.filePath = filePath ? resolve(filePath) : null;
    if (this.filePath) this.load();
  }

  addPublication(publication: Publication, persist = true): void {
    const app = publication.app ?? publication.artifact?.app ?? "logic";
    const artifact: Artifact =
      publication.artifact ??
      {
        app,
        kind: app === "logic" ? "logic.netlist" : `${app}.artifact`,
        version: 1,
        mediaType: "application/json",
        body: publication.circuit ?? null,
      };
    const challengeId = publication.challengeId ?? publication.taskId;
    const circuit =
      publication.circuit ??
      (app === "logic" && artifact.body
        ? (artifact.body as Circuit)
        : undefined);
    const normalized: Publication = {
      ...publication,
      app,
      challengeId,
      artifact,
      taskId: challengeId,
      circuit,
      authorKey: publication.authorKey ?? null,
      delegatedBy: publication.delegatedBy ?? null,
      verified: publication.verified ?? false,
      signature: publication.signature ?? null,
      nonce: publication.nonce ?? null,
      visibility: publication.visibility ?? "public",
      artifactCommitment: publication.artifactCommitment ?? null,
      signatureAlgorithm: publication.signatureAlgorithm ?? "ecdsa-p256",
      source: publication.source ?? null,
      attestedAt: publication.attestedAt ?? publication.attestation.createdAt,
    };

    this.publications.set(normalized.id, normalized);
    this.order.unshift(normalized.id);

    const verified = this.identitiesByHandle.has(normalized.author) || normalized.verified;
    const existing = this.profiles.get(normalized.author);

    if (existing) {
      existing.publications += 1;
      existing.attestations += 1;
      existing.bestScore = Math.max(existing.bestScore, normalized.attestation.score);
      existing.totalScore += normalized.attestation.score;
      existing.verified = verified;
      existing.lastPublishedAt = normalized.createdAt;
    } else {
      this.profiles.set(normalized.author, {
        handle: normalized.author,
        verified,
        publications: 1,
        attestations: 1,
        bestScore: normalized.attestation.score,
        totalScore: normalized.attestation.score,
        createdAt: normalized.createdAt,
        lastPublishedAt: normalized.createdAt,
      });
    }

    if (persist) this.persist();
  }

  getPublication(id: string): Publication | null {
    return this.publications.get(id) ?? null;
  }

  /** Every publication in insertion order; callers filter what they expose. */
  listPublications(): Publication[] {
    return this.order
      .map((id) => this.publications.get(id))
      .filter((publication): publication is Publication => publication !== undefined);
  }

  isAnchored(publicationId: string): boolean {
    return this.anchoredIds.has(publicationId);
  }

  findPublicationByNonce(nonce: string): Publication | null {
    for (const id of this.order) {
      const publication = this.publications.get(id);
      if (publication?.nonce === nonce) return publication;
    }
    return null;
  }

  listFeed(query: FeedQuery = {}): Publication[] {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const offset = Math.max(query.offset ?? 0, 0);

    return this.order
      .map((id) => this.publications.get(id))
      .filter((publication): publication is Publication => publication !== undefined)
      .filter((publication) => publication.visibility === "public")
      .filter((publication) => !query.taskId || publication.taskId === query.taskId)
      .filter((publication) => !query.author || publication.author === query.author)
      .filter(
        (publication) =>
          query.parentId === undefined || publication.parentId === query.parentId,
      )
      .slice(offset, offset + limit);
  }

  searchBuilds(query: BuildSearchQuery = {}): BuildSummary[] {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const offset = Math.max(query.offset ?? 0, 0);
    const builds = this.allSummaries()
      .filter((build) => build.visibility === "public")
      .filter((build) => !query.taskId || build.taskId === query.taskId)
      .filter(
        (build) => !query.challengeId || build.challengeId === query.challengeId,
      )
      .filter((build) => !query.app || build.app === query.app)
      .filter((build) => !query.author || build.author === query.author)
      .filter(
        (build) =>
          query.parentId === undefined || build.parentId === query.parentId,
      )
      .filter((build) => !query.root || build.parentId === null)
      .filter((build) => !query.source || build.source?.kind === query.source)
      .filter(
        (build) =>
          query.minScore === undefined ||
          build.attestation.score >= query.minScore,
      )
      .filter(
        (build) =>
          query.maxGates === undefined ||
          build.attestation.gateCount <= query.maxGates,
      );

    const sort = query.sort ?? "recent";

    builds.sort((a, b) => {
      if (sort === "score") {
        return (
          b.attestation.score - a.attestation.score ||
          a.attestation.gateCount - b.attestation.gateCount ||
          b.createdAt.localeCompare(a.createdAt)
        );
      }

      if (sort === "gates") {
        return (
          a.attestation.gateCount - b.attestation.gateCount ||
          b.attestation.score - a.attestation.score ||
          b.createdAt.localeCompare(a.createdAt)
        );
      }

      if (sort === "reuses") {
        return (
          b.reuses - a.reuses ||
          b.attestation.score - a.attestation.score ||
          b.createdAt.localeCompare(a.createdAt)
        );
      }

      return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
    });

    return builds.slice(offset, offset + limit);
  }

  getBuild(id: string): BuildSummary | null {
    return this.allSummaries().find((build) => build.id === id) ?? null;
  }

  getBuildLineage(id: string): BuildLineage | null {
    const builds = this.allSummaries();
    const byId = new Map(builds.map((build) => [build.id, build]));
    const build = byId.get(id);

    if (!build) return null;

    const ancestors: BuildSummary[] = [];
    const seen = new Set([build.id]);
    let current = build;

    while (current.parentId) {
      if (seen.has(current.parentId)) break;
      const parent = byId.get(current.parentId);
      if (!parent) break;
      seen.add(parent.id);
      ancestors.unshift(parent);
      current = parent;
    }

    const descendants: BuildSummary[] = [];
    const queue = [build.id];

    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const children = builds.filter((candidate) => candidate.parentId === parentId);

      for (const child of children) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        descendants.push(child);
        queue.push(child.id);
      }
    }

    return { build, ancestors, descendants };
  }

  getProfile(handle: string): Profile | null {
    return this.profiles.get(handle) ?? null;
  }

  listProfiles(): Profile[] {
    return [...this.profiles.values()].sort((a, b) => b.totalScore - a.totalScore);
  }

  addIdentity(identity: Identity, persist = true): void {
    if (this.identitiesByHandle.has(identity.handle)) {
      throw new Error("handle is already registered");
    }
    if (this.identitiesByKey.has(identity.keyId)) {
      throw new Error("public key is already registered");
    }

    this.identitiesByHandle.set(identity.handle, identity);
    this.identitiesByKey.set(identity.keyId, identity);

    const profile = this.profiles.get(identity.handle);
    if (profile) profile.verified = true;

    if (persist) this.persist();
  }

  getIdentity(handle: string): Identity | null {
    return this.identitiesByHandle.get(handle) ?? null;
  }

  getIdentityByKey(keyId: string): Identity | null {
    return this.identitiesByKey.get(keyId) ?? null;
  }

  /**
   * A key that ever belonged to a handle: the current key or one it was rotated
   * from. Old publications and capabilities keep verifying after a rotation.
   */
  resolveKey(keyId: string): { handle: string; keyId: string; publicKey: JsonWebKey; algorithm: SignatureSuite; current: boolean } | null {
    const identity = this.identitiesByKey.get(keyId);

    if (identity) {
      return {
        handle: identity.handle,
        keyId,
        publicKey: identity.publicKey,
        algorithm: identity.algorithm,
        current: true,
      };
    }

    const retired = this.retiredKeys.get(keyId);

    return retired ? { ...retired, current: false } : null;
  }

  keysForHandle(handle: string): { keyId: string; publicKey: JsonWebKey; algorithm: SignatureSuite }[] {
    const identity = this.identitiesByHandle.get(handle);
    const keys: { keyId: string; publicKey: JsonWebKey; algorithm: SignatureSuite }[] = [];

    if (identity) {
      keys.push({ keyId: identity.keyId, publicKey: identity.publicKey, algorithm: identity.algorithm });
    }

    for (const retired of this.retiredKeys.values()) {
      if (retired.handle === handle) {
        keys.push({
          keyId: retired.keyId,
          publicKey: retired.publicKey,
          algorithm: retired.algorithm,
        });
      }
    }

    return keys;
  }

  addRotation(rotation: KeyRotation, persist = true): void {
    const identity = this.identitiesByHandle.get(rotation.handle);

    if (!identity) throw new Error("identity is not registered");
    if (identity.keyId !== rotation.fromKeyId) throw new Error("rotation does not start from the current key");
    if (rotation.toKeyId === rotation.fromKeyId) throw new Error("rotation must change the key");
    if (this.resolveKey(rotation.toKeyId)) throw new Error("the new key is already registered");
    if (this.rotations.some((record) => record.handle === rotation.handle && record.fromKeyId === rotation.fromKeyId)) {
      throw new Error("this key has already been rotated");
    }

    this.rotations.push(rotation);
    this.retiredKeys.set(rotation.fromKeyId, {
      handle: rotation.handle,
      keyId: rotation.fromKeyId,
      publicKey: rotation.fromPublicKey,
      algorithm: rotation.fromAlgorithm,
      retiredAt: rotation.createdAt,
    });

    const next: Identity = {
      ...identity,
      keyId: rotation.toKeyId,
      publicKey: rotation.toPublicKey,
      algorithm: rotation.toAlgorithm,
    };

    this.identitiesByKey.delete(rotation.fromKeyId);
    this.identitiesByHandle.set(rotation.handle, next);
    this.identitiesByKey.set(rotation.toKeyId, next);

    if (persist) this.persist();
  }

  rotationsFor(handle: string): KeyRotation[] {
    return this.rotations.filter((rotation) => rotation.handle === handle);
  }

  addDelegation(delegation: Delegation, persist = true): void {
    const identity = this.identitiesByHandle.get(delegation.handle);

    if (!identity) throw new Error("identity is not registered");
    if (identity.keyId !== delegation.rootKeyId) throw new Error("delegation root is not the current key");
    if (this.resolveKey(delegation.delegateKeyId) || this.isDelegatedKey(delegation.delegateKeyId)) {
      throw new Error("the delegate key is already in use");
    }

    this.delegations.push(delegation);
    if (persist) this.persist();
  }

  /**
   * Durable challenge storage (ROADMAP): a challenge created through the API survives a
   * restart, exactly like a publication does. Challenges configured through
   * RAREXT_CHALLENGES stay configured — this collection only holds what a deployment
   * created at runtime, and a duplicate id replaces rather than duplicates, because the
   * route refuses a duplicate anyway and the store must not grow two rows for one id.
   */
  addChallenge(challenge: Challenge, persist = true): void {
    this.challengeRecords.set(challenge.id, challenge);
    if (persist) this.persist();
  }

  challenges(): Challenge[] {
    return [...this.challengeRecords.values()];
  }

  delegationsFor(handle: string): Delegation[] {
    return this.delegations.filter((delegation) => delegation.handle === handle);
  }

  isDelegatedKey(keyId: string): boolean {
    return this.delegations.some((delegation) => delegation.delegateKeyId === keyId);
  }

  activeDelegation(
    handle: string,
    delegateKeyId: string,
    app: string | null,
    now = Date.now(),
  ): Delegation | null {
    const identity = this.identitiesByHandle.get(handle);

    if (!identity) return null;

    return (
      this.delegations.find(
        (delegation) =>
          delegation.handle === handle &&
          delegation.delegateKeyId === delegateKeyId &&
          delegation.rootKeyId === identity.keyId &&
          (delegation.app === null || delegation.app === app) &&
          (delegation.expiresAt === null || Date.parse(delegation.expiresAt) > now),
      ) ?? null
    );
  }

  addAnchor(anchor: Anchor, persist = true): void {
    if (this.anchors.has(anchor.id)) return;
    const normalized: Anchor = { ...anchor, receipts: anchor.receipts ?? [] };
    this.anchors.set(normalized.id, normalized);
    for (const id of normalized.publicationIds) this.anchoredIds.add(id);
    if (persist) this.persist();
  }

  getAnchor(id: string): Anchor | null {
    return this.anchors.get(id) ?? null;
  }

  listAnchors(): Anchor[] {
    return [...this.anchors.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  pendingPublications(): Publication[] {
    return this.order
      .map((id) => this.publications.get(id))
      .filter((publication): publication is Publication => publication !== undefined)
      .filter((publication) => !this.anchoredIds.has(publication.id))
      .reverse();
  }

  addCredit(record: CreditRecord): void {
    this.credits.push(record);
    this.persist();
  }

  listCredits(): CreditRecord[] {
    return [...this.credits];
  }

  addRevocation(revocation: Revocation, persist = true): void {
    if (this.revocations.has(revocation.id)) return;
    this.revocations.set(revocation.id, revocation);
    if (persist) this.persist();
  }

  listRevocations(): Revocation[] {
    return [...this.revocations.values()].sort((a, b) =>
      b.issuedAt.localeCompare(a.issuedAt),
    );
  }

  isRevoked(kind: RevocationKind, target: string): Revocation | null {
    for (const revocation of this.revocations.values()) {
      if (revocation.kind === kind && revocation.target === target) return revocation;
    }
    return null;
  }

  addIdentityLink(link: IdentityLink, persist = true): void {
    if (this.identityLinks.has(link.id)) return;
    this.identityLinks.set(link.id, link);
    if (persist) this.persist();
  }

  findIdentityLink(
    handle: string,
    network: string,
    externalId: string,
  ): IdentityLink | null {
    for (const link of this.identityLinks.values()) {
      if (
        link.handle === handle &&
        link.network === network &&
        link.externalId.toLowerCase() === externalId.toLowerCase()
      ) {
        return link;
      }
    }
    return null;
  }

  listIdentityLinks(handle?: string): IdentityLink[] {
    return [...this.identityLinks.values()]
      .filter((link) => !handle || link.handle === handle)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  identityCount(): number {
    return this.identitiesByHandle.size;
  }

  identityLinkCount(): number {
    return this.identityLinks.size;
  }

  anchorCount(): number {
    return this.anchors.size;
  }

  count(): number {
    return this.publications.size;
  }

  private allSummaries(): BuildSummary[] {
    const reuses = new Map<string, number>();

    for (const publication of this.publications.values()) {
      if (!publication.parentId) continue;
      reuses.set(publication.parentId, (reuses.get(publication.parentId) ?? 0) + 1);
    }

    return this.order
      .map((id) => this.publications.get(id))
      .filter((publication): publication is Publication => publication !== undefined)
      .map((publication) => ({
        ...publication,
        reuses: reuses.get(publication.id) ?? 0,
      }));
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      const migrated = migrateSnapshot(parsed);

      if (!Array.isArray(migrated.snapshot.publications)) {
        throw new Error("publications must be an array");
      }

      const snapshot = migrated.snapshot as unknown as Partial<Snapshot>;

      for (const identity of snapshot.identities ?? []) {
        this.addIdentity(identity, false);
      }

      for (const rotation of snapshot.rotations ?? []) {
        this.rotations.push(rotation);
        this.retiredKeys.set(rotation.fromKeyId, {
          handle: rotation.handle,
          keyId: rotation.fromKeyId,
          publicKey: rotation.fromPublicKey,
          algorithm: rotation.fromAlgorithm,
          retiredAt: rotation.createdAt,
        });
      }

      for (const delegation of snapshot.delegations ?? []) {
        this.delegations.push(delegation);
      }

      for (const challenge of snapshot.challenges ?? []) {
        this.addChallenge(challenge, false);
      }

      for (const publication of [...(snapshot.publications ?? [])].reverse()) {
        this.addPublication(publication, false);
      }

      for (const anchor of snapshot.anchors ?? []) {
        this.addAnchor(anchor, false);
      }

      for (const link of snapshot.identityLinks ?? []) {
        this.addIdentityLink(link, false);
      }

      for (const revocation of snapshot.revocations ?? []) {
        this.addRevocation(revocation, false);
      }

      for (const credit of snapshot.credits ?? []) {
        this.credits.push(credit);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`could not load ${this.filePath}: ${message}`);
    }
  }

  private persist(): void {
    if (!this.filePath) return;

    const snapshot: Snapshot = {
      version: CURRENT_SNAPSHOT_VERSION,
      publications: this.order
        .map((id) => this.publications.get(id))
        .filter((publication): publication is Publication => publication !== undefined),
      identities: [...this.identitiesByKey.values()],
      anchors: [...this.anchors.values()],
      identityLinks: [...this.identityLinks.values()],
      revocations: [...this.revocations.values()],
      credits: [...this.credits],
      rotations: [...this.rotations],
      delegations: [...this.delegations],
      challenges: this.challenges(),
    };

    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`);
    renameSync(temp, this.filePath);
  }
}
