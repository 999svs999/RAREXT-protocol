// Every brand in the ecosystem anchors its public web presence on RAREXT.
//
// The whole point of the protocol is that the ecosystem's state is publicly
// verifiable, not just one brand's — so FUTURISTIC, APESDAILY, BAPECLUB and the
// protocol's own site each publish a structural site record. They share ONE
// implementation (siteRecordVerifier) because the check is brand-agnostic:
// canonical origin, per-page digests, and the media served. Only the app, the
// artifact kind, and the manifest differ — and the manifest is committed to by
// `verifierHash`, which is why each brand's algorithm string is the same shared
// `structural-site-record-check` while its app field makes the hash its own.
//
// Adding a brand here does NOT retroactively touch any anchored record: records
// already published keep the verifier identity they were signed with.

import { siteRecordVerifier, type SiteRecordConfig } from "./futuristic-site.ts";
import type { AppVerifier } from "./verifiers.ts";

const SITE_ALGORITHM = "structural-site-record-check";

/** Shared manifest shape; `app` is what makes each verifierHash distinct. */
function siteManifest(app: string): SiteRecordConfig["manifest"] {
  return { app, version: 1, algorithm: SITE_ALGORITHM, representation: "exact" };
}

function brandSite(app: string, kind: string, label: string, covers: string): SiteRecordConfig {
  return {
    app,
    kind,
    name: `${label} site record`,
    description:
      `Structural verification of the ${label} site record: canonical origin, page digests as ` +
      `published, and the media served — recomputable locally from the artifact, no network ` +
      `required. Covers ${covers}. Live-byte checking against the origin is an explicit external ` +
      `step, not part of this verdict.`,
    manifest: siteManifest(app),
  };
}

/**
 * The ecosystem's site records. FUTURISTIC is deliberately absent — it has its
 * own long-standing config (FUTURISTIC_SITE_CONFIG) whose manifest must not
 * change, since anchored records commit to it.
 */
export const ECOSYSTEM_SITE_CONFIGS: SiteRecordConfig[] = [
  brandSite("apesdaily-site", "apesdaily.site.v1", "APESDAILY",
    "the AI-crypto trading technology hub: landing, launchpad, developers and contact surfaces"),
  brandSite("bapeclub-site", "bapeclub.site.v1", "BAPECLUB",
    "the private members club surface (bapeclub.app). The Shopify storefront is a separate, " +
    "independently-operated property and is NOT covered by this record"),
  brandSite("rarext-site", "rarext.site.v1", "RAREXT",
    "the protocol's own public presence, alongside the registry bundle it publishes"),
];

export function ecosystemSiteVerifiers(): AppVerifier[] {
  return ECOSYSTEM_SITE_CONFIGS.map((cfg) => siteRecordVerifier(cfg));
}
