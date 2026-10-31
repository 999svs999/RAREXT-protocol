import { createHash } from "node:crypto";

import {
  parseFederationCommitmentArtifact,
  parseRegistrySeedList,
  registryListDigest,
  type Bundle,
  type RegistrySeedEntry,
} from "../../../packages/core/src/index.ts";

/**
 * Does the registry's PUBLISHED SEED LIST match what its own bundle commits to?
 *
 * RFC 0020 commits a registry to its federation list as an ordinary publication, so an agent
 * can check the promise rather than trust it: the bundle says "the list at this URL has this
 * digest", and the list is fetched and hashed HERE with core's rule — the same rule the
 * browser proof page recomputes and the SDK's registriesFromPublishedList applies. The
 * registry is asked for the DATA, never for the VERDICT.
 *
 * Like verify-semantics, this carries its own limit in the response: matching proves the list
 * beside the bundle is the one committed to; it does not vouch for any registry the list names.
 */
export interface FederationReport {
  /** The digest inside the bundle's commitment. */
  committedDigest: string;
  /** The digest computed HERE from the list as it was fetched. */
  listDigest: string;
  /** True only when the two digests are equal. */
  matches: boolean;
  /** The registries the list names, as data — a claim, not a fact. */
  registries: Array<{ id: string; operator: string; url: string }>;
  /** The URL the commitment names for the list. */
  listUrl: string;
  /** What this check does NOT establish. Read it before quoting the verdict. */
  limit: string;
}

function sha256Bytes(bytes: Uint8Array): Uint8Array {
  // node's createHash, spelled the way core's Sha256 contract expects — bytes in, bytes out.
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export async function verifyRegistryFederation(registry: {
  bundle(): Promise<Bundle>;
}): Promise<FederationReport | null> {
  const bundle = await registry.bundle();

  let commitment: { listUrl: string; digest: string } | null = null;
  for (const publication of bundle.publications ?? []) {
    if (publication.artifact?.kind !== "registry-list-commitment") continue;
    const body = parseFederationCommitmentArtifact(publication.artifact as never);
    if (!body) continue;
    commitment = { listUrl: body.listUrl, digest: body.digest };
    break;
  }
  if (!commitment) return null;

  const response = await fetch(commitment.listUrl, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`the committed seed list answered ${response.status} at ${commitment.listUrl}`);
  }
  const entries = parseRegistrySeedList(await response.json()) as RegistrySeedEntry[];
  const listDigest = registryListDigest(entries, sha256Bytes);

  return {
    committedDigest: commitment.digest,
    listDigest,
    matches: listDigest === commitment.digest,
    registries: entries.map((entry) => ({ id: entry.id, operator: entry.operator, url: entry.url })),
    listUrl: commitment.listUrl,
    limit:
      "this proves the published list is the one the bundle commits to; it does not vouch for any registry the list names",
  };
}
