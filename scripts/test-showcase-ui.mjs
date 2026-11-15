#!/usr/bin/env node
/**
 * test-showcase-ui.mjs — the landing page's behaviour, exercised in a browser.
 *
 * Static HTML checks cannot tell you whether "Tamper" actually turns the verdict
 * red, whether the seed changes the trace, whether the mobile menu traps focus,
 * or whether the page quietly calls a third party. This drives a real Chrome over
 * CDP and asserts each of those.
 *
 *   node scripts/preview-showcase.mjs --port 8080 &
 *   node scripts/test-showcase-ui.mjs                    # 127.0.0.1:8080
 *   SHOWCASE_URL=https://rarext-com.pages.dev node scripts/test-showcase-ui.mjs
 *
 * Exit is non-zero on the first failed assertion.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL_UNDER_TEST = process.env.SHOWCASE_URL ?? "http://127.0.0.1:8080/";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function equal(name, actual, expected) {
  check(name, actual === expected, `${JSON.stringify(actual)} === ${JSON.stringify(expected)}`);
}

const profile = mkdtempSync(join(tmpdir(), "rarext-ui-test-"));
const port = 9490;
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--hide-scrollbars",
  "--window-size=1440,900",
  "about:blank",
], { stdio: "ignore" });

let ws;
try {
  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await sleep(150);
    }
  }
  if (version === null) throw new Error("Chrome did not start");

  const info = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") {
      consoleErrors.push(message.params.exceptionDetails.text ?? "exception");
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      consoleErrors.push(message.params.args?.map((arg) => arg.value ?? arg.description).join(" ") ?? "console.error");
    }
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      consoleErrors.push(message.params.entry.text);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const messageId = ++id;
    pending.set(messageId, { resolve, reject });
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: URL_UNDER_TEST });
  await sleep(2500);

  // ── structure ──────────────────────────────────────────────────────────
  const structure = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    return {
      title: document.title,
      lang: document.documentElement.lang,
      h1: document.querySelectorAll("h1").length,
      main: !!q("main#main"),
      skip: q(".skip")?.getAttribute("href"),
      h1Text: q("h1")?.innerText.replace(/\\s+/g, " ").trim(),
      description: q('meta[name="description"]')?.content ?? "",
      canonical: q('link[rel="canonical"]')?.href ?? "",
      live: document.querySelectorAll("[aria-live], [role=status]").length,
      inputsLabelled: [...document.querySelectorAll("input")].every((el) => !!document.querySelector('label[for="' + el.id + '"]')),
      imagesAltd: [...document.querySelectorAll("img")].every((el) => el.hasAttribute("alt")),
      buttonsNamed: [...document.querySelectorAll("button")].every((el) => (el.getAttribute("aria-label") || el.innerText || "").trim().length > 0),
      pinned: !!q("a[data-pin-root]"),
      links: ["./mirror/ai.html", "./mirror/gallery.html", "./mirror/verify.html"].every((href) => !!q('a[href="' + href + '"]')),
    };
  })()`);
  check("one h1", structure.h1 === 1, structure.h1Text);
  check("landmark structure", structure.main && structure.lang === "en", `main=${structure.main} lang=${structure.lang}`);
  check("skip link targets main", structure.skip === "#main", structure.skip);
  check("meta description + canonical", structure.description.length > 50 && structure.canonical.endsWith("rarext.com/"), structure.canonical);
  check("live regions present", structure.live >= 1, String(structure.live));
  check("labels, alt text, button names", structure.inputsLabelled && structure.imagesAltd && structure.buttonsNamed, "all controls named");
  check("required proof links present", structure.pinned && structure.links, "pinned verifier + ai/gallery/verify links");

  // ── the live proof ─────────────────────────────────────────────────────
  const initial = await evaluate(`(() => ({
    badge: document.getElementById("verdict-badge")?.textContent,
    state: document.getElementById("verdict-badge")?.dataset.state,
    output: document.getElementById("proof-output")?.innerText,
    model: document.getElementById("model-digest")?.textContent,
    trace: document.getElementById("trace-digest")?.textContent,
    replay: document.getElementById("replay-verdict")?.textContent,
    tokens: document.querySelectorAll("#proof-output .tok").length,
  }))()`);
  equal("proof verifies on load", initial.state, "verified");
  check("proof renders 32 tokens", initial.tokens === 32, String(initial.tokens));
  check("digests are populated", /^[0-9a-f]{12}…[0-9a-f]{6}$/.test(initial.model) && /^[0-9a-f]{12}…[0-9a-f]{6}$/.test(initial.trace), `${initial.model} / ${initial.trace}`);
  check("replay says match", /match/.test(initial.replay ?? ""), initial.replay);

  // Tamper: one token changes, so the verdict must flip to refused.
  await evaluate(`document.getElementById("tamper-proof").click()`);
  await sleep(300);
  const tampered = await evaluate(`(() => ({
    state: document.getElementById("verdict-badge")?.dataset.state,
    badge: document.getElementById("verdict-badge")?.textContent,
    marked: document.querySelectorAll("#proof-output .tampered").length,
    replay: document.getElementById("replay-verdict")?.textContent,
    note: document.getElementById("proof-note")?.textContent,
  }))()`);
  equal("tamper flips the verdict", tampered.state, "refused");
  equal("tamper marks exactly one token", tampered.marked, 1);
  check("tamper is explained", /refused/i.test(tampered.replay ?? "") && /one token changed/i.test(tampered.note ?? ""), tampered.note);

  // Run restores the truthful verdict.
  await evaluate(`document.getElementById("run-proof").click()`);
  await sleep(300);
  equal("re-run restores verification", await evaluate(`document.getElementById("verdict-badge").dataset.state`), "verified");

  // A different seed produces a different trace and a different output.
  const before = await evaluate(`document.getElementById("proof-output").innerText`);
  await evaluate(`(() => { const el = document.getElementById("proof-seed"); el.value = "7"; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await sleep(400);
  const after = await evaluate(`(() => ({
    output: document.getElementById("proof-output").innerText,
    trace: document.getElementById("trace-digest").textContent,
    state: document.getElementById("verdict-badge").dataset.state,
  }))()`);
  check("seed changes the output", before !== after.output, "seed 42 vs 7");
  check("seed changes the trace", initial.trace !== after.trace, `${initial.trace} vs ${after.trace}`);
  equal("new seed still verifies", after.state, "verified");

  // ── theme ──────────────────────────────────────────────────────────────
  const themeBefore = await evaluate(`document.documentElement.dataset.theme`);
  await evaluate(`document.getElementById("theme-toggle").click()`);
  await sleep(150);
  const themeAfter = await evaluate(`(() => ({
    theme: document.documentElement.dataset.theme,
    pressed: document.getElementById("theme-toggle").getAttribute("aria-pressed"),
    stored: localStorage.getItem("rarext-theme"),
  }))()`);
  check("theme toggles", themeBefore !== themeAfter.theme, `${themeBefore} -> ${themeAfter.theme}`);
  equal("theme button reports state", themeAfter.pressed, String(themeAfter.theme === "light"));
  equal("theme choice persists", themeAfter.stored, themeAfter.theme);

  // ── no third-party requests, and a weight budget ───────────────────────
  const network = await evaluate(`(() => {
    const entries = performance.getEntriesByType("resource");
    return {
      hosts: [...new Set(entries.map((e) => { try { return new URL(e.name).host; } catch { return null; } }).filter(Boolean))],
      count: entries.length,
      bytes: entries.reduce((n, e) => n + (e.transferSize || 0), 0),
      js: entries.filter((e) => /\\.js(\\?|$)/.test(e.name)).reduce((n, e) => n + (e.transferSize || 0), 0),
      css: entries.filter((e) => /\\.css(\\?|$)/.test(e.name)).reduce((n, e) => n + (e.transferSize || 0), 0),
    };
  })()`);
  check("no third-party hosts", network.hosts.every((host) => host === new global.URL(URL_UNDER_TEST).host || network.hosts.length === 0), network.hosts.join(", ") || "none");
  check("page weight under 200 KB", network.bytes < 200_000, `${network.bytes} bytes over ${network.count} requests`);
  check("stylesheet under 40 KB", network.css < 40_000, `${network.css} bytes`);
  check("script under 40 KB", network.js < 40_000, `${network.js} bytes`);

  // ── mobile: no overflow, menu opens, Escape closes and restores focus ──
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Page.navigate", { url: URL_UNDER_TEST });
  await sleep(2000);
  const mobile = await evaluate(`(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth + 2,
    width: document.documentElement.scrollWidth,
    inner: innerWidth,
    ctaVisible: !!document.querySelector(".hero-actions .btn.primary") && getComputedStyle(document.querySelector(".hero-actions .btn.primary")).display !== "none",
    navHidden: getComputedStyle(document.querySelector(".site-header .primary")).display === "none",
    menuVisible: getComputedStyle(document.getElementById("menu-open")).display !== "none",
  }))()`);
  check("no horizontal overflow at 390px", !mobile.overflow, `${mobile.width} <= ${mobile.inner}`);
  check("primary CTA stays visible on mobile", mobile.ctaVisible, "displayed");
  check("desktop nav swaps to menu", mobile.navHidden && mobile.menuVisible, "nav hidden, menu shown");

  await evaluate(`document.getElementById("menu-open").click()`);
  await sleep(250);
  const opened = await evaluate(`(() => ({
    open: document.getElementById("mobile-nav").open,
    expanded: document.getElementById("menu-open").getAttribute("aria-expanded"),
    modal: document.getElementById("mobile-nav").matches(":modal"),
  }))()`);
  check("mobile menu opens as a modal", opened.open && opened.modal, `open=${opened.open} modal=${opened.modal}`);
  equal("menu button reports expanded", opened.expanded, "true");

  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(300);
  const closed = await evaluate(`(() => ({
    open: document.getElementById("mobile-nav").open,
    expanded: document.getElementById("menu-open").getAttribute("aria-expanded"),
    focus: document.activeElement?.id,
  }))()`);
  equal("Escape closes the menu", closed.open, false);
  equal("menu button resets", closed.expanded, "false");
  equal("focus returns to the menu button", closed.focus, "menu-open");

  check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "none");
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exit(1);
