import { verifyDeploymentBody, verifyProviderCardBody, verifyRunBody } from "./transcript.ts";
import { commitDeployment, requireValidDeployment } from "./manifest.ts";
import type { ProviderCard } from "./model-bundle.ts";
import { runSpecFromChallenge } from "./verifier.ts";
import type { DeploymentCommitment, ModelRunSpec, ProviderCardVerification } from "./types.ts";
import {
  MODEL_DEPLOYMENT_ARTIFACT_KIND,
  MODEL_PROVIDER_ARTIFACT_KIND,
  MODEL_RUN_ARTIFACT_KIND,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface DiscoveredCard {
  publicationId: string;
  deploymentId: string;
  modelId: string;
  quantization: string | null;
  weightsDigest: string | null;
  engine: string;
  backend: string;
  /** "remote" when the card commits an endpoint the publisher does not execute. */
  placement: string;
  deploymentDigest: string;
  /** The bundle's attestation says the registry verified it. */
  attested: boolean;
  /** This process recomputed the manifest and checked it against the challenge. */
  verified: boolean;
  error: string | null;
}

export interface DiscoveredRun {
  publicationId: string;
  runDigest: string;
  modelId: string;
  attested: boolean;
  verified: boolean;
  tokensPerSecond: number | null;
  error: string | null;
}

export interface DiscoveredProvider {
  publicationId: string;
  providerCardDigest: string;
  endpoint: string;
  modelId: string;
  bundleDigest: string;
  bundleId: string;
  shardCount: number;
  totalBytes: number;
  attested: boolean;
  verified: boolean;
  error: string | null;
}

export interface DiscoveryReport {
  root: string | null;
  leafVersion: number | null;
  cards: DiscoveredCard[];
  providers: DiscoveredProvider[];
  runs: DiscoveredRun[];
  /** Every card, provider, and run in the bundle was recomputed and attested. */
  ok: boolean;
  error?: string;
}

/**
 * Every anchored bundle a registry serves, newest first. An anchor covers the
 * publications that were pending when it was made, so a provider card and a run
 * published later can live in different batches. Discovery that read only
 * `latest` would stop finding providers after the next anchor; this reads the
 * anchor list and fetches each batch.
 */
export async function fetchAnchoredBundles(input: {
  registry: string;
  fetchImpl?: typeof fetch;
}): Promise<unknown[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const registry = input.registry.replace(/\/+$/, "");
  const response = await fetchImpl(`${registry}/v1/bundles/latest`);
  if (!response.ok) {
    throw new Error(`registry returned HTTP ${response.status} for ${registry}/v1/bundles/latest`);
  }
  const latest = (await response.json()) as unknown;
  const bundles: unknown[] = [latest];
  const seen = new Set<string>();

  const rootOf = (value: unknown): string | null =>
    isRecord(value) && isRecord(value.manifest) && typeof value.manifest.root === "string"
      ? value.manifest.root
      : null;
  const latestRoot = rootOf(latest);
  if (latestRoot !== null) seen.add(latestRoot);

  const anchorsResponse = await fetchImpl(`${registry}/v1/anchors`);
  if (anchorsResponse.ok) {
    const anchors = (await anchorsResponse.json()) as unknown;
    for (const anchor of Array.isArray(anchors) ? anchors : []) {
      const root = isRecord(anchor) && typeof anchor.root === "string" ? anchor.root : null;
      if (root === null || seen.has(root)) continue;
      seen.add(root);
      const bundleResponse = await fetchImpl(`${registry}/v1/bundles/${root}`);
      if (bundleResponse.ok) bundles.push(await bundleResponse.json());
    }
  }

  return bundles;
}

function attestationOf(publication: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(publication.attestation) ? publication.attestation : null;
}

function attested(attestation: Record<string, unknown> | null): boolean {
  return attestation?.correct === true && attestation.representation === "exact";
}

function idOf(publication: Record<string, unknown>): string {
  return typeof publication.id === "string" ? publication.id : "";
}

function challengeFor(
  challenges: Map<string, unknown>,
  publication: Record<string, unknown>,
): { spec: ModelRunSpec | null; error: string | null } {
  const challengeId = typeof publication.challengeId === "string" ? publication.challengeId : "";
  const challenge = challenges.get(challengeId);

  if (challenge === undefined) {
    return { spec: null, error: `challenge ${challengeId || "(missing)"} is not in the bundle` };
  }

  try {
    return { spec: runSpecFromChallenge(challenge), error: null };
  } catch (error) {
    return {
      spec: null,
      error: error instanceof Error ? error.message : "challenge is not valid",
    };
  }
}

/**
 * Verify every model card and run in a bundle without a server.
 *
 * The bundle's attestations are reported but not trusted: each artifact is
 * re-run through the same verifier the registry used, against the challenge
 * carried in the same bundle. A card or run that was edited after publication
 * fails here even if its attestation still says correct.
 */
export function discoverBundle(bundle: unknown): DiscoveryReport {
  if (!isRecord(bundle)) {
    return {
      root: null,
      leafVersion: null,
      cards: [],
      providers: [],
      runs: [],
      ok: false,
      error: "bundle must be an object",
    };
  }

  const manifest = isRecord(bundle.manifest) ? bundle.manifest : {};
  const publications = Array.isArray(bundle.publications) ? bundle.publications : [];
  const challenges = new Map<string, unknown>();

  for (const challenge of Array.isArray(bundle.challenges) ? bundle.challenges : []) {
    if (isRecord(challenge) && typeof challenge.id === "string") {
      challenges.set(challenge.id, challenge);
    }
  }

  const cards: DiscoveredCard[] = [];
  const providers: DiscoveredProvider[] = [];
  const runs: DiscoveredRun[] = [];

  for (const raw of publications) {
    if (!isRecord(raw)) continue;

    const artifact = isRecord(raw.artifact) ? raw.artifact : {};
    const body = artifact.body;
    const attestation = attestationOf(raw);
    const challenge = challengeFor(challenges, raw);

    if (artifact.kind === MODEL_DEPLOYMENT_ARTIFACT_KIND) {
      const result = challenge.spec
        ? verifyDeploymentBody(body, challenge.spec)
        : null;
      const record = isRecord(body) ? body : {};
      const model = isRecord(record.model) ? record.model : {};
      const hardware = isRecord(record.hardware) ? record.hardware : {};
      const engine = isRecord(record.engine) ? record.engine : {};

      cards.push({
        publicationId: idOf(raw),
        deploymentId: typeof record.id === "string" ? record.id : "",
        modelId: typeof model.id === "string" ? model.id : "",
        quantization: typeof model.quantization === "string" ? model.quantization : null,
        weightsDigest: typeof model.weightsDigest === "string" ? model.weightsDigest : null,
        engine: typeof engine.name === "string" ? engine.name : "",
        backend: typeof hardware.backend === "string" ? hardware.backend : "unknown",
        placement: typeof record.placement === "string" ? record.placement : "local",
        deploymentDigest: result?.details.deploymentDigest ?? "",
        attested: attested(attestation),
        verified: result?.correct === true,
        error: challenge.error ?? result?.error ?? null,
      });
      continue;
    }

    if (artifact.kind === MODEL_PROVIDER_ARTIFACT_KIND) {
      const result: ProviderCardVerification | null = challenge.spec
        ? verifyProviderCardBody(body, challenge.spec)
        : null;
      const record = isRecord(body) ? body : {};
      const bundleRef = isRecord(record.bundle) ? record.bundle : {};
      const model = isRecord(record.model) ? record.model : {};

      providers.push({
        publicationId: idOf(raw),
        providerCardDigest: typeof record.digest === "string" ? record.digest : "",
        endpoint: typeof record.endpoint === "string" ? record.endpoint : "",
        modelId: typeof model.id === "string" ? model.id : "",
        bundleDigest: typeof bundleRef.digest === "string" ? bundleRef.digest : "",
        bundleId: typeof bundleRef.id === "string" ? bundleRef.id : "",
        shardCount: typeof bundleRef.shardCount === "number" ? bundleRef.shardCount : 0,
        totalBytes: typeof bundleRef.totalBytes === "number" ? bundleRef.totalBytes : 0,
        attested: attested(attestation),
        verified: result?.correct === true,
        error: challenge.error ?? result?.error ?? null,
      });
      continue;
    }

    if (artifact.kind === MODEL_RUN_ARTIFACT_KIND) {
      const result = challenge.spec ? verifyRunBody(body, challenge.spec) : null;
      const record = isRecord(body) ? body : {};
      const model = isRecord(record.model) ? record.model : {};

      runs.push({
        publicationId: idOf(raw),
        runDigest: result?.details.transcriptDigest ?? "",
        modelId: typeof model.id === "string" ? model.id : "",
        attested: attested(attestation),
        verified: result?.correct === true,
        tokensPerSecond: result?.details.tokensPerSecond ?? null,
        error: challenge.error ?? result?.error ?? null,
      });
    }
  }

  const entries = [...cards, ...providers, ...runs];
  return {
    root: typeof manifest.root === "string" ? manifest.root : null,
    leafVersion: typeof manifest.leafVersion === "number" ? manifest.leafVersion : null,
    cards,
    providers,
    runs,
    ok: entries.length > 0 && entries.every((entry) => entry.verified && entry.attested),
  };
}

export interface VerifiedRemoteDeployment {
  card: DiscoveredCard;
  /** The committed manifest, re-derived from the card and re-hashed here. */
  deployment: DeploymentCommitment;
}

export interface VerifiedRemoteDeployments {
  deployments: VerifiedRemoteDeployment[];
  error: string | null;
}

/**
 * The remote deployments a bundle actually proves.
 *
 * A card is returned only when this process recomputed it, it commits
 * `placement: "remote"`, and the manifest re-hashes to the digest the verifier
 * derived from the same bytes. The bundle's attestation is not consulted: a
 * control plane can adopt a card the registry never attested, but it cannot
 * adopt one whose bytes do not verify.
 */
export function verifiedRemoteDeployments(bundle: unknown): VerifiedRemoteDeployments {
  const report = discoverBundle(bundle);
  if (report.error) return { deployments: [], error: report.error };

  const publications =
    isRecord(bundle) && Array.isArray(bundle.publications) ? bundle.publications : [];
  const byPublication = new Map<string, Record<string, unknown>>();
  for (const raw of publications) {
    if (isRecord(raw)) byPublication.set(idOf(raw), raw);
  }

  const deployments: VerifiedRemoteDeployment[] = [];
  for (const card of report.cards) {
    // `remote` is an endpoint somebody else runs; `web4` is an endpoint whose
    // weights are committed RAREXT blobs. Both are network placements and both
    // are adopted only after this process recomputes the card.
    if (!card.verified || (card.placement !== "remote" && card.placement !== "web4")) continue;

    const raw = byPublication.get(card.publicationId);
    const artifact = raw !== undefined && isRecord(raw.artifact) ? raw.artifact : null;
    if (artifact === null) continue;

    let deployment: DeploymentCommitment;
    try {
      const body = artifact.body;
      if (!isRecord(body)) continue;
      const { digest: _claimed, ...manifest } = body;
      deployment = commitDeployment(requireValidDeployment(manifest));
    } catch {
      continue;
    }
    if (deployment.digest !== card.deploymentDigest) continue;
    deployments.push({ card, deployment });
  }

  return {
    deployments,
    error: deployments.length === 0 ? "the bundle carries no verified remote model card" : null,
  };
}

export interface VerifiedProvider {
  provider: DiscoveredProvider;
  card: ProviderCard;
}

export interface VerifiedProviders {
  providers: VerifiedProvider[];
  error: string | null;
}

/**
 * The provider cards a bundle actually proves. A card is returned only when
 * this process recomputed it against the challenge and, when a bundle digest
 * is supplied, it names that bundle. The attestation is not consulted: a
 * provider is adopted because its bytes verify, not because a registry said so.
 */
export function verifiedProviders(bundle: unknown, bundleDigest?: string): VerifiedProviders {
  const report = discoverBundle(bundle);
  if (report.error) return { providers: [], error: report.error };

  const publications =
    isRecord(bundle) && Array.isArray(bundle.publications) ? bundle.publications : [];
  const byPublication = new Map<string, Record<string, unknown>>();
  for (const raw of publications) {
    if (isRecord(raw)) byPublication.set(idOf(raw), raw);
  }

  const providers: VerifiedProvider[] = [];
  for (const provider of report.providers) {
    if (!provider.verified) continue;
    if (bundleDigest !== undefined && provider.bundleDigest !== bundleDigest) continue;

    const raw = byPublication.get(provider.publicationId);
    const artifact = raw !== undefined && isRecord(raw.artifact) ? raw.artifact : null;
    if (artifact === null || !isRecord(artifact.body)) continue;
    providers.push({ provider, card: artifact.body as unknown as ProviderCard });
  }

  return {
    providers,
    error:
      providers.length === 0
        ? bundleDigest === undefined
          ? "the bundle carries no verified provider card"
          : `the bundle carries no verified provider for bundle ${bundleDigest}`
        : null,
  };
}

export interface RegistryDiscovery {
  providers: VerifiedProvider[];
  /** How many anchored bundles were checked across all registries. */
  scanned: number;
  /** Per-registry failures; one unreachable mirror does not hide the rest. */
  errors: string[];
}

/**
 * Find verified providers across several registries. A bundle is
 * content-addressed, so two registries that carry the same anchor and cards
 * produce the same answer; discovery unions them by provider card digest. An
 * unreachable mirror is reported, not fatal: the point of naming more than one
 * registry is that no single one is required.
 */
export async function fetchVerifiedProvidersAcrossRegistries(input: {
  registries: string[];
  bundleDigest?: string;
  fetchImpl?: typeof fetch;
}): Promise<RegistryDiscovery> {
  const registries = [...new Set(input.registries.map((entry) => entry.replace(/\/+$/, "")))];
  const byDigest = new Map<string, VerifiedProvider>();
  const errors: string[] = [];
  let scanned = 0;

  for (const registry of registries) {
    try {
      const bundles = await fetchAnchoredBundles({ registry, fetchImpl: input.fetchImpl });
      for (const bundle of bundles) {
        scanned += 1;
        const found = verifiedProviders(bundle, input.bundleDigest);
        for (const entry of found.providers) {
          byDigest.set(`${entry.card.digest}:${entry.card.endpoint}`, entry);
        }
        if (found.providers.length === 0 && found.error) errors.push(`${registry}: ${found.error}`);
      }
    } catch (error) {
      errors.push(`${registry}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { providers: [...byDigest.values()], scanned, errors };
}
