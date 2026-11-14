/**
 * The human-facing verifier.
 *
 * RAREXT's whole promise is "you can check it yourself", but that promise is
 * only worth anything if a person who is not a protocol engineer can use it. This
 * page is that: paste a RAREXT link or a 64-character code, press one button, and
 * read one sentence.
 *
 * The logic lives here, split into pure parts (`resolveInput`, `describeVerdict`)
 * that node tests exercise directly, and a thin DOM layer that never runs on
 * import. The verdict is the same `verifyBundle` the mirror page and the registry
 * use, so this page cannot disagree with the rest of the protocol.
 */

import { parseRarextUri, urlForRarextUri } from "../../../packages/core/src/index.ts";
import { verifyBundle, type Bundle, type BundleVerification, type ChallengeIndex } from "./verify.ts";

/** The registry's shared cap: a bundle bigger than this is refused before it is read. */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

const HEX64 = /^[0-9a-f]{64}$/;

export interface ResolvedInput {
  /** What the bytes must rebuild to, or null when the input names no root. */
  pinnedRoot: string | null;
  /** URLs to try, in order. */
  candidates: string[];
  /** A short human description of what was understood. */
  understood: string;
}

export type InputResolution = { ok: true; resolved: ResolvedInput } | { ok: false; reason: string };

/** The copies a page looks for when only a root is named. */
export const SAME_ORIGIN_CANDIDATES = ["./bundle.json", "../registry/bundle.json", "../bundle.json"];

/** Turn whatever a person pasted into a root and a list of URLs to try. */
export function resolveInput(raw: string, pageUrl: string): InputResolution {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "Paste a RAREXT link or a 64-character code to check." };

  // A full URL: keep it, and read a ?root= pin out of its query if present.
  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text, pageUrl);
    } catch {
      return { ok: false, reason: `${JSON.stringify(text)} does not look like a web address.` };
    }
    const requested = url.searchParams.get("root");
    const pinnedRoot = requested !== null && HEX64.test(requested.toLowerCase()) ? requested.toLowerCase() : null;
    const candidate = url.pathname.endsWith("bundle.json") ? url.href : new URL("bundle.json", url.href).href;
    return {
      ok: true,
      resolved: {
        pinnedRoot,
        candidates: [candidate],
        understood: `A copy at ${url.host}` + (pinnedRoot === null ? "" : `, pinned to ${pinnedRoot.slice(0, 12)}…`),
      },
    };
  }

  // A bare 64-character code: the object by its root, with nothing to trust.
  if (HEX64.test(text.toLowerCase())) {
    return {
      ok: true,
      resolved: {
        pinnedRoot: text.toLowerCase(),
        candidates: SAME_ORIGIN_CANDIDATES,
        understood: `An object named by its code (${text.slice(0, 12)}…); checking the copies on this page.`,
      },
    };
  }

  // A RAREXT reference: `rarext:<root>` or `rarext:<host>/<path>@<root>`.
  if (/^rarext:/i.test(text)) {
    const parsed = parseRarextUri(text);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    const base = urlForRarextUri(parsed.uri, pageUrl.startsWith("http:") ? "http" : "https");
    const candidates =
      base === null ? SAME_ORIGIN_CANDIDATES : [base.endsWith("bundle.json") ? base : `${base.replace(/\/$/, "")}/bundle.json`];
    return {
      ok: true,
      resolved: {
        pinnedRoot: parsed.uri.root,
        candidates,
        understood:
          base === null
            ? `An object named by its code (${parsed.uri.root.slice(0, 12)}…); checking the copies on this page.`
            : `A copy at ${parsed.uri.authority}, pinned to ${parsed.uri.root.slice(0, 12)}…`,
      },
    };
  }

  return {
    ok: false,
    reason:
      "That is not something we can check. Paste a RAREXT link (rarext:host/path@code), a web address, or a 64-character code.",
  };
}

export interface Verdict {
  tone: "ok" | "bad" | "unreachable";
  headline: string;
  sentence: string;
  /** Facts to show under "the numbers", not in the headline. */
  facts: Array<{ label: string; value: string }>;
}

/** One sentence a person can act on, from the arithmetic. */
export function describeVerdict(
  result: BundleVerification | null,
  pinnedRoot: string | null,
  publications: number,
  source: string | null,
  refusals: string[],
): Verdict {
  if (result === null) {
    return {
      tone: "unreachable",
      headline: "We could not check this copy.",
      sentence:
        "Every place we looked was unreachable or refused to hand over the bytes. That is not proof of a problem — only that this page could not see the copy.",
      facts: refusals.map((refusal, index) => ({ label: `Tried (${index + 1})`, value: refusal })),
    };
  }

  if (result.valid) {
    return {
      tone: "ok",
      headline: "This copy is honest.",
      sentence:
        `Its ${result.publications} item${result.publications === 1 ? "" : "s"} rebuild the exact code the network agreed on. ` +
        "Nothing here has been added, changed, or removed.",
      facts: [
        { label: "Code this copy rebuilds to", value: result.root },
        { label: "Code we computed ourselves", value: result.computedRoot },
        { label: "Items checked", value: String(result.publications) },
        ...(source === null ? [] : [{ label: "Read from", value: source }]),
        ...(pinnedRoot === null ? [] : [{ label: "You asked for", value: pinnedRoot }]),
      ],
    };
  }

  // A self-consistent copy that is simply not the object the link named is a
  // different answer from a copy whose own contents do not match its own claim.
  const selfConsistent = result.root === result.computedRoot;
  const differentObject = selfConsistent && pinnedRoot !== null && result.root !== pinnedRoot;
  return {
    tone: "bad",
    headline: differentObject ? "This is a different object than you asked for." : "This copy has been altered.",
    sentence: differentObject
      ? "The copy is self-consistent, but it is not the object your link named. Something in the chain pointed at the wrong thing."
      : "The items inside do not rebuild the code this copy claims. Do not trust its contents.",
    facts: [
      { label: "Code this copy claims", value: result.root },
      { label: "Code we computed ourselves", value: result.computedRoot },
      { label: "Why not", value: result.reason ?? "the roots differ" },
      ...(source === null ? [] : [{ label: "Read from", value: source }]),
      ...(pinnedRoot === null ? [] : [{ label: "You asked for", value: pinnedRoot }]),
    ],
  };
}

/** Read a response body, refusing anything above the shared cap. */
export async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BUNDLE_BYTES) {
    throw new Error(`declares ${declared} bytes, above the ${MAX_BUNDLE_BYTES} byte cap`);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BUNDLE_BYTES) {
    throw new Error(`is larger than the ${MAX_BUNDLE_BYTES} byte cap`);
  }
  return text;
}

export interface CheckOutcome {
  verdict: Verdict;
  publications: number;
}

/** Fetch and check the first candidate that verifies; keep every refusal. */
export async function checkCopy(
  resolved: ResolvedInput,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckOutcome> {
  const refusals: string[] = [];
  for (const url of resolved.candidates) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) {
        refusals.push(`${url} — answered ${response.status}`);
        continue;
      }
      const bundle = JSON.parse(await readCapped(response)) as Bundle;
      const challenges: ChallengeIndex = Object.fromEntries(
        (bundle.challenges ?? []).map((challenge) => [
          challenge.id,
          (challenge.spec ?? {}) as Record<string, unknown>,
        ]),
      );
      const result = await verifyBundle(bundle, challenges, resolved.pinnedRoot ?? undefined);
      if (!result.valid) {
        refusals.push(`${url} — ${result.reason ?? "did not verify"}`);
        // A copy that parsed but failed the arithmetic is still the answer: show
        // it as "altered", not "unreachable".
        return { verdict: describeVerdict(result, resolved.pinnedRoot, result.publications, url, refusals), publications: result.publications };
      }
      return {
        verdict: describeVerdict(result, resolved.pinnedRoot, result.publications, url, refusals),
        publications: result.publications,
      };
    } catch (error) {
      refusals.push(`${url} — ${error instanceof Error ? error.message : "unreachable"}`);
    }
  }
  return { verdict: describeVerdict(null, resolved.pinnedRoot, 0, null, refusals), publications: 0 };
}

// ── DOM wiring (never runs on import) ────────────────────────────────────────

function render(verdict: Verdict): void {
  const panel = document.getElementById("verdict");
  if (panel === null) return;
  panel.dataset.tone = verdict.tone;
  panel.setAttribute("role", "status");
  const glyph = verdict.tone === "ok" ? "✓" : verdict.tone === "bad" ? "!" : "?";
  const icon = document.getElementById("verdict-icon");
  if (icon !== null) {
    icon.textContent = glyph;
    icon.dataset.tone = verdict.tone;
  }
  const headline = document.getElementById("verdict-headline");
  if (headline !== null) headline.textContent = verdict.headline;
  const sentence = document.getElementById("verdict-sentence");
  if (sentence !== null) sentence.textContent = verdict.sentence;
  const facts = document.getElementById("verdict-facts") as HTMLElement | null;
  if (facts !== null) {
    facts.replaceChildren();
    for (const fact of verdict.facts) {
      const row = document.createElement("div");
      row.className = "fact";
      const label = document.createElement("span");
      label.textContent = fact.label;
      const value = document.createElement("code");
      value.textContent = fact.value;
      row.append(label, value);
      facts.append(row);
    }
  }
  panel.hidden = false;
}

function wire(): void {
  const form = document.getElementById("check-form") as HTMLFormElement | null;
  const input = document.getElementById("check-input") as HTMLInputElement | null;
  const note = document.getElementById("check-note") as HTMLElement | null;
  const button = document.getElementById("check-run") as HTMLButtonElement | null;
  if (form === null || input === null || note === null || button === null) return;

  const params = new URLSearchParams(location.search);
  const preset = params.get("root");
  const ref = params.get("ref");
  if (ref !== null) input.value = ref;
  else if (preset !== null) input.value = preset;

  const run = async (): Promise<void> => {
    const resolution = resolveInput(input.value, location.href);
    if (!resolution.ok) {
      note.textContent = resolution.reason;
      note.dataset.tone = "bad";
      return;
    }
    note.textContent = resolution.resolved.understood;
    note.dataset.tone = "ok";
    button.disabled = true;
    button.textContent = "Checking…";
    try {
      const outcome = await checkCopy(resolution.resolved);
      render(outcome.verdict);
    } finally {
      button.disabled = false;
      button.textContent = "Check it";
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void run();
  });

  // A link that already names a root runs on load, so a shared URL is one click
  // — or zero.
  if (preset !== null || ref !== null) void run();
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
}
