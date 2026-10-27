import { verifyBundle } from "./verify.ts";
import type { Bundle } from "./verify.ts";
import type { Challenge, Publication, Semantics } from "@rarext/core";

/**
 * The mirror workbench used to trust the bytes it was shipped with: every read
 * (feed, challenges, semantics) was answered from `window.__RAREXT_BUNDLE__`
 * without checking that the bundle rebuilds anything, so a tampered mirror
 * served a tampered workbench and nothing complained — while `verify.html`, on
 * the same tree, recomputed the Merkle root and refused what failed.
 *
 * This module closes that asymmetry. On startup the workbench asks this gate
 * to verify the bundle with the SAME code the verifier page runs, pinned the
 * same way: `?root=<root>` first, then the seed's `bundleRoot` tried in the
 * same order the verifier page tries its bundle candidates. A workbench with
 * no pin verifies internal consistency only — the same rule the verifier page
 * applies — and says so.
 *
 * A refused bundle is never served: reads fall through to the network, which
 * on a static mirror is a 404 — the honest empty state. Refusal is what makes
 * a broken copy say so instead of quietly committing the very fraud the
 * protocol exists to prevent.
 */

export interface MirrorBundle {
  manifest: {
    root: string;
    leafVersion: number;
    /** The pinned root the workbench checks against, when one is available. */
    publications: { id: string; leaf: string }[];
  };
  publications: Publication[];
  challenges: Challenge[];
  semantics: Semantics[];
}

/**
 * The seed locations a mirror may reach from its own tree, in the same order
 * the verifier page tries its bundle candidates: this tree first, then the
 * sibling registry copy.
 */
export const MIRROR_SEED_URLS = ["./seed.json", "../registry/seed.json"] as const;

const HEX_ROOT = /^[0-9a-f]{64}$/;

export function isHexRoot(value: string | null | undefined): value is string {
  return typeof value === "string" && HEX_ROOT.test(value);
}

export interface MirrorPin {
  /** The pinned root, or null when nothing pinned the bundle. */
  root: string | null;
  /** Where the pin came from: `?root=` or the seed URL it was read from. */
  source: string | null;
}

/**
 * Resolve the pin for a workbench on a mirror: a valid `?root=` wins; without
 * one, the seeds are tried in order and each must carry a well-formed
 * `bundleRoot`. Unreachable seeds are skipped, not fatal — the verifier page
 * applies the same rule, and a workbench with no pin still verifies internal
 * consistency, visibly, rather than going dark.
 */
export async function resolveMirrorPin(
  requestedRoot: string | null,
  seedUrls: readonly string[] = MIRROR_SEED_URLS,
  request: typeof fetch = fetch,
): Promise<MirrorPin> {
  if (isHexRoot(requestedRoot)) {
    return { root: requestedRoot, source: "?root=" };
  }

  for (const seedUrl of seedUrls) {
    try {
      const response = await request(seedUrl);
      if (!response.ok) continue;
      const seed = (await response.json()) as { bundleRoot?: unknown };
      if (typeof seed.bundleRoot === "string" && isHexRoot(seed.bundleRoot)) {
        return { root: seed.bundleRoot, source: seedUrl };
      }
    } catch {
      // No seed reachable from here; the pinned check simply does not apply.
      continue;
    }
  }

  return { root: null, source: null };
}

export interface MirrorGateOutcome {
  /** absent: no bundle is embedded. verified: serve reads. verified-unpinned:
   *  serve reads under the internal-consistency-only rule. refused: never serve. */
  kind: "absent" | "verified" | "verified-unpinned" | "refused";
  pinnedRoot: string | null;
  pinSource: string | null;
  computedRoot: string | null;
  reason: string | null;
}

/** What the page needs to say loudly about a refused bundle. */
export interface MirrorRefusal {
  pinnedRoot: string | null;
  computedRoot: string | null;
  reason: string | null;
}

export interface MirrorGate {
  /** Settles once the bundle check (and any seed lookup it needed) finishes. */
  ready: Promise<MirrorGateOutcome>;
  outcome(): MirrorGateOutcome | null;
  /** The mirror read path, or null to fall through to the network. */
  read(path: string): unknown;
  refusal(): MirrorRefusal | null;
}

export function startMirrorGate(
  bundle: MirrorBundle | undefined,
  options: {
    requestedRoot?: string | null;
    seedUrls?: readonly string[];
    fetch?: typeof fetch;
    onVerified?: (outcome: MirrorGateOutcome) => void;
    onRefused?: (refusal: MirrorRefusal) => void;
  } = {},
): MirrorGate {
  if (!bundle) {
    const absent: MirrorGateOutcome = {
      kind: "absent",
      pinnedRoot: null,
      pinSource: null,
      computedRoot: null,
      reason: null,
    };
    return {
      ready: Promise.resolve(absent),
      outcome: () => null,
      read: () => null,
      refusal: () => null,
    };
  }

  let state: MirrorGateOutcome | null = null;
  let refusal: MirrorRefusal | null = null;

  const ready = (async () => {
    const pin = await resolveMirrorPin(
      options.requestedRoot ?? null,
      options.seedUrls ?? MIRROR_SEED_URLS,
      options.fetch ?? fetch,
    );

    const verification = await verifyBundle(
      bundle as unknown as Bundle,
      undefined,
      pin.root ?? undefined,
    );

    if (verification.valid) {
      state = {
        kind: pin.root ? "verified" : "verified-unpinned",
        pinnedRoot: pin.root,
        pinSource: pin.source,
        computedRoot: verification.computedRoot,
        reason: null,
      };
      options.onVerified?.(state);
    } else {
      refusal = {
        pinnedRoot: pin.root,
        computedRoot: verification.computedRoot,
        reason: verification.reason,
      };
      state = {
        kind: "refused",
        pinnedRoot: pin.root,
        pinSource: pin.source,
        computedRoot: verification.computedRoot,
        reason: verification.reason,
      };
      options.onRefused?.(refusal);
    }

    return state;
  })();

  return {
    ready,
    outcome: () => state,
    read(path) {
      // While the check is unresolved nothing is served, and once the bundle
      // is refused nothing is ever served: null falls through to the network,
      // which on a static mirror is a 404 — the honest empty state.
      if (!state || state.kind === "refused") return null;
      return mirrorRead(bundle, path);
    },
    refusal: () => refusal,
  };
}

/**
 * The reads the mirror answers when — and only when — the gate has verified
 * the bundle. Writes are not here: they always need a live registry.
 */
export function mirrorRead(bundle: MirrorBundle, path: string): unknown {
  const url = new URL(path, "https://mirror.invalid");
  const publications = [...bundle.publications].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );

  if (url.pathname === "/v1/feed" || url.pathname === "/v1/artifacts") {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    return publications.slice(offset, offset + limit);
  }

  if (url.pathname === "/v1/challenges") return bundle.challenges;
  if (url.pathname === "/v1/semantics") return bundle.semantics;

  if (url.pathname === "/v1/apps") {
    return bundle.challenges.map((challenge) => ({
      id: challenge.app,
      name: challenge.app,
      version: "1",
      description: challenge.description,
      artifactKinds: [],
      challengeCount: 1,
      verifier: "builtin",
      configured: true,
      url: null,
    }));
  }

  if (url.pathname === "/v1/adapters") return [];
  if (url.pathname === "/v1/tapeout/status") {
    return { configured: false, chainId: null, blockNumber: null };
  }

  return null;
}
