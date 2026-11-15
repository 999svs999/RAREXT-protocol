import { generateTokens } from "../../../packages/core/src/index.ts";
import {
  STARTER_MODEL,
  STARTER_SEED,
  STARTER_STEPS,
  checkClaim,
  runCommittedModel,
} from "./ai.ts";

/**
 * The landing page's live proof.
 *
 * It runs the committed starter model class in this tab, renders the token
 * stream, and shows the two digests the evidence is built from. "Tamper" changes
 * one token and asks the same replay rule the registry uses — the verdict becomes
 * a refusal, because the bytes no longer reproduce.
 *
 * DOM wiring only. The model, the canonicalisation, and the replay rule stay in
 * `ai.ts` and core, so this page cannot invent a second answer.
 */

const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

const seedInput = $<HTMLInputElement>("proof-seed");
const output = $("proof-output");
const badge = $("verdict-badge");
const modelDigest = $("model-digest");
const traceDigest = $("trace-digest");
const replayVerdict = $("replay-verdict");
const note = $("proof-note");
const runButton = $<HTMLButtonElement>("run-proof");
const tamperButton = $<HTMLButtonElement>("tamper-proof");

const short = (hex: string): string => (hex.length > 20 ? `${hex.slice(0, 12)}…${hex.slice(-6)}` : hex);
const reduced = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

function setBadge(state: "pending" | "verified" | "refused", text: string): void {
  if (!badge) return;
  badge.dataset.state = state;
  badge.textContent = text;
}

function renderTokens(tokens: number[], tamperedAt: number | null): void {
  if (!output) return;
  output.replaceChildren();
  const stream = document.createElement("code");
  stream.className = "output-text";
  tokens.forEach((id, index) => {
    const span = document.createElement("span");
    span.className = "tok";
    span.dataset.alt = String(index % 2);
    span.textContent = STARTER_MODEL.vocab[id] ?? "?";
    if (tamperedAt === index) span.classList.add("tampered");
    if (!reduced()) {
      span.style.animationDelay = `${Math.min(index * 18, 420)}ms`;
    }
    stream.append(span);
  });
  output.append(stream);
  output.append(Object.assign(document.createElement("span"), { className: "token-count", textContent: `${tokens.length} tokens` }));
}

async function run(seed: number, tamper: boolean): Promise<void> {
  const tokens = generateTokens(STARTER_MODEL, seed, STARTER_STEPS);
  const tamperedAt = tamper ? 0 : null;
  if (tamper) {
    tokens[0] = (tokens[0]! + 1) % STARTER_MODEL.vocab.length;
  }
  const claimed = tokens.map((id) => STARTER_MODEL.vocab[id]).join("");

  setBadge("pending", "checking…");
  runButton?.setAttribute("aria-busy", "true");
  const started = performance.now();
  try {
    const { proof } = await runCommittedModel(STARTER_MODEL, seed, STARTER_STEPS);
    const verdict = checkClaim(STARTER_MODEL, seed, claimed, STARTER_STEPS);
    const took = Math.max(1, Math.round(performance.now() - started));

    renderTokens(tokens, tamperedAt);
    if (modelDigest) modelDigest.textContent = short(proof.modelDigest);
    if (traceDigest) traceDigest.textContent = short(proof.traceHash);
    if (modelDigest) modelDigest.title = proof.modelDigest;
    if (traceDigest) traceDigest.title = proof.traceHash;

    if (verdict.correct) {
      setBadge("verified", "verified");
      if (replayVerdict) replayVerdict.textContent = "match · recomputed here";
      if (note) note.textContent = `Ran in ${took} ms · ${STARTER_STEPS} tokens · nothing left this tab.`;
    } else {
      setBadge("refused", "refused");
      if (replayVerdict) replayVerdict.textContent = `refused · expected a different trace`;
      if (note)
        note.textContent = `Ran in ${took} ms. One token changed, so the replay refused. The digest is the test, not the label.`;
    }
  } catch (error) {
    setBadge("refused", "error");
    if (note) note.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    runButton?.removeAttribute("aria-busy");
  }
}

const currentSeed = (): number => {
  const value = Number(seedInput?.value ?? STARTER_SEED);
  return Number.isFinite(value) && Number.isInteger(value) ? value : STARTER_SEED;
};

runButton?.addEventListener("click", () => void run(currentSeed(), false));
tamperButton?.addEventListener("click", () => void run(currentSeed(), true));
seedInput?.addEventListener("change", () => void run(currentSeed(), false));

if (output && badge) {
  void run(currentSeed(), false);
}

/* ── theme ──────────────────────────────────────────────────────────────── */
const themeButton = $<HTMLButtonElement>("theme-toggle");
function syncThemeButton(): void {
  if (!themeButton) return;
  const light = document.documentElement.dataset.theme === "light";
  themeButton.setAttribute("aria-pressed", String(light));
  themeButton.setAttribute("aria-label", light ? "Switch to dark theme" : "Switch to light theme");
}
themeButton?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("rarext-theme", next);
  } catch {
    // A blocked store is not a broken page: the choice lasts this session.
  }
  syncThemeButton();
});
syncThemeButton();

/* ── mobile menu ────────────────────────────────────────────────────────── */
const menu = $<HTMLDialogElement>("mobile-nav");
const menuOpen = $<HTMLButtonElement>("menu-open");
const menuClose = $<HTMLButtonElement>("menu-close");
menuOpen?.addEventListener("click", () => {
  menu?.showModal();
  menuOpen.setAttribute("aria-expanded", "true");
});
const closeMenu = (): void => {
  menu?.close();
  menuOpen?.setAttribute("aria-expanded", "false");
  menuOpen?.focus();
};
menuClose?.addEventListener("click", closeMenu);
menu?.addEventListener("click", (event) => {
  if (event.target === menu) closeMenu();
});
menu?.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
menu?.addEventListener("close", () => menuOpen?.setAttribute("aria-expanded", "false"));

/* ── copy the reproduce command ─────────────────────────────────────────── */
const copyButton = $<HTMLButtonElement>("copy-command");
const copyStatus = $("copy-status");
copyButton?.addEventListener("click", async () => {
  const text = $("reproduce-command")?.textContent ?? "";
  try {
    await navigator.clipboard.writeText(text);
    if (copyStatus) copyStatus.textContent = "Copied. It runs without a key or an account.";
  } catch {
    if (copyStatus) copyStatus.textContent = "Copy was blocked — select the block and copy it manually.";
  }
});
