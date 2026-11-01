/**
 * The node journey, as a rule the SDK owns and every surface shares.
 *
 * The five rails — binding, registry, ledger, governance, federation — lived in
 * `scripts/node-journey.mjs`, which meant a CLI was the only way to ask "is this node a full
 * node?" and an AI agent had to spawn a child process or re-implement the checks. The rails
 * now live HERE, parameterized over the fetch (a test injects one; a real caller uses the
 * platform's), and the CLI is a thin formatter over this document. One implementation, two
 * surfaces, the same verdicts.
 *
 * The rails, in the journey's own order:
 *
 *   binding     the node's /.well-known/rarext.json, verified against the pinned root
 *   registry    the bundle the node serves, recomputed through verifyBundle
 *   ledger      the work rail's commitment — reachability and shape, labeled as that
 *   governance  the 民主 rail answers
 *   federation  the list the node's own decisions admitted, parsed by the seed's own rule
 *
 * The first two rails VERIFY content; the later rails verify the economy's rails are live
 * and shaped — labeled as exactly that, because reachability is not verification.
 */

import {
  parseRegistrySeedList,
  verifySiteBinding,
} from "../../core/src/index.ts";
import { readSiteBinding, verifyBundle } from "./index.ts";

export interface JourneyRail {
  rail: string;
  ok: boolean;
  evidence: string[];
}

export interface JourneyDocument {
  origin: string;
  root: string | null;
  registry: string | null;
  ok: boolean;
  rails: JourneyRail[];
}

export interface JourneyOptions {
  /** The root the REGISTRY pins — the caller owes it, or the binding rail is INDETERMINATE. */
  root?: string | undefined;
  /** The registry id the node should answer for. */
  registry?: string | undefined;
  /** Loopback and private addresses are refused unless the caller says otherwise. */
  allowPrivate?: boolean | undefined;
  /** Injectable for tests; defaults to the platform fetch. */
  fetch?: typeof fetch | undefined;
}

const HEX64 = /^[0-9a-f]{64}$/;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function runNodeJourney(
  originInput: string,
  options: JourneyOptions = {},
): Promise<JourneyDocument> {
  const request = options.fetch ?? fetch;
  const origin = originInput.replace(/\/+$/, "");
  const root = (options.root ?? "").trim();
  const registry = (options.registry ?? "").trim();
  const allowPrivate = options.allowPrivate === true;
  const rails: JourneyRail[] = [];

  // ── Rail 1: binding ──────────────────────────────────────────────────────────
  {
    const rail: JourneyRail = { rail: "binding", ok: false, evidence: [] };
    if (root === "") {
      rail.evidence.push("no root given: a binding cannot certify itself, so this rail is INDETERMINATE, not passed");
    } else {
      try {
        const read = await readSiteBinding(origin, { allowPrivate, ...(options.fetch ? { fetch: options.fetch } : {}) });
        rail.evidence.push(`file carrier: ${read.file}${read.file === "served" ? "" : ` (${read.notes.join("; ")})`}`);
        if (read.file === "served" && read.parse.ok) {
          const verdict = verifySiteBinding(read.parse.binding, {
            pinnedRoot: root,
            ...(registry !== "" ? { expectedRegistry: registry } : {}),
          });
          rail.ok = verdict.ok;
          rail.evidence.push(
            verdict.ok
              ? `JOINED: the node answers for ${read.parse.binding.registry} at the pinned root`
              : (verdict.reason ?? "the binding does not verify"),
          );
        } else if (read.file === "served") {
          rail.evidence.push(read.parse.ok ? "" : (read.parse.reason ?? "the binding does not parse"));
        } else if (read.parse.ok === false && read.parse.reason) {
          rail.evidence.push(read.parse.reason);
        }
      } catch (error) {
        rail.evidence.push(`the binding could not be read: ${messageOf(error)}`);
      }
    }
    rails.push(rail);
  }

  // ── Rail 2: registry ─────────────────────────────────────────────────────────
  {
    const rail: JourneyRail = { rail: "registry", ok: false, evidence: [] };
    try {
      const response = await request(`${origin}/v1/bundles/latest`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        rail.evidence.push(`the node answered HTTP ${response.status} for its latest bundle`);
      } else {
        const bundle = (await response.json()) as Parameters<typeof verifyBundle>[0];
        const verification = verifyBundle(bundle);
        rail.ok = verification.valid === true && (root === "" || verification.root === root);
        if (rail.ok) {
          rail.evidence.push(`the served bundle rebuilds ${verification.root.slice(0, 16)}… (${verification.publications} publication(s))`);
        } else if (verification.reason) {
          rail.evidence.push(`the served bundle does not verify: ${verification.reason.slice(0, 140)}`);
        } else if (verification.computedRoot) {
          rail.evidence.push(
            `the served bundle rebuilds ${verification.computedRoot.slice(0, 16)}…, not the pinned ${(root || "").slice(0, 16)}…`,
          );
        } else {
          rail.evidence.push("the served bundle does not verify, and the verifier gave no recomputed root");
        }
      }
    } catch (error) {
      rail.evidence.push(`the bundle could not be read: ${messageOf(error)}`);
    }
    rails.push(rail);
  }

  // ── Rail 3: ledger ───────────────────────────────────────────────────────────
  {
    const rail: JourneyRail = { rail: "ledger", ok: false, evidence: [] };
    try {
      const response = await request(`${origin}/v1/work/ledger`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        rail.evidence.push(`the work rail answered HTTP ${response.status}`);
      } else {
        const ledger = (await response.json()) as { root?: unknown; count?: unknown };
        const shapeOk =
          typeof ledger.root === "string" && HEX64.test(ledger.root) && Number.isInteger(ledger.count) && (ledger.count as number) >= 0;
        rail.ok = shapeOk;
        rail.evidence.push(
          shapeOk
            ? `the work rail is live: commitment ${(ledger.root as string).slice(0, 16)}… over ${ledger.count} receipt(s)`
            : "the work rail answered but its commitment is not shaped like a ledger root",
        );
      }
    } catch (error) {
      rail.evidence.push(`the work rail could not be read: ${messageOf(error)}`);
    }
    rails.push(rail);
  }

  // ── Rail 4: governance ───────────────────────────────────────────────────────
  {
    const rail: JourneyRail = { rail: "governance", ok: false, evidence: [] };
    try {
      const response = await request(`${origin}/v1/governance/proposals`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        rail.evidence.push(`the governance rail answered HTTP ${response.status}`);
      } else {
        const proposals = (await response.json()) as unknown[];
        const shapeOk = Array.isArray(proposals);
        rail.ok = shapeOk;
        rail.evidence.push(
          shapeOk
            ? `the governance rail is live: ${proposals.length} proposal(s) on record`
            : "the governance rail answered but its body is not a proposal list",
        );
      }
    } catch (error) {
      rail.evidence.push(`the governance rail could not be read: ${messageOf(error)}`);
    }
    rails.push(rail);
  }

  // ── Rail 5: federation ───────────────────────────────────────────────────────
  {
    const rail: JourneyRail = { rail: "federation", ok: false, evidence: [] };
    try {
      const response = await request(`${origin}/v1/registries`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        rail.evidence.push(`the federation rail answered HTTP ${response.status}`);
      } else {
        const body = (await response.json()) as unknown;
        const parsed = parseRegistrySeedList(body);
        const shapeOk =
          typeof body === "object" && body !== null && Array.isArray((body as { registries?: unknown }).registries) &&
          (body as { registries: unknown[] }).registries.length === parsed.length;
        rail.ok = shapeOk;
        rail.evidence.push(
          shapeOk
            ? `the federation rail is walkable: ${parsed.length} admitted registry entr${parsed.length === 1 ? "y" : "ies"}, parsed by the seed's own rule`
            : "the federation rail answered but its body does not parse as a seed list",
        );
      }
    } catch (error) {
      rail.evidence.push(`the federation rail could not be read: ${messageOf(error)}`);
    }
    rails.push(rail);
  }

  return { origin, root: root || null, registry: registry || null, ok: rails.every((rail) => rail.ok), rails };
}
