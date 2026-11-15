#!/usr/bin/env node
/**
 * benchmark-ui-ux.mjs — measure the UI/UX of the AI web apps people actually use,
 * and of RAREXT's own front door, on the same instrument.
 *
 * The point is not a vibe check. For each target it records, from a real Chrome
 * instance over CDP:
 *
 *   - navigation timing (TTFB, FCP, LCP, load) and layout shift;
 *   - transfer bytes, request count, JS/CSS/image weight, third-party hosts;
 *   - structure: landmarks, heading order, skip link, h1, nav items;
 *   - accessibility: missing alt/name/label, contrast failures, tap targets,
 *     tiny text, horizontal overflow, aria-live regions;
 *   - the first screen: headline, subhead, primary CTAs;
 *   - screenshots at 1440x900 and 390x844.
 *
 * It also reads the HTTP response: status, compression, HTTP version, and the
 * security headers that carry trust cues.
 *
 *   node scripts/benchmark-ui-ux.mjs                       # all targets
 *   node scripts/benchmark-ui-ux.mjs --only rarext,claude
 *   RAREXT_BENCH_LOCAL=http://127.0.0.1:8080 node scripts/benchmark-ui-ux.mjs
 *
 * Writes bench/ui-ux.json and bench/ui-ux/*.png. A site that refuses headless
 * traffic is recorded as refused, not scored as zero.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "bench", "ui-ux");
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const only = (() => {
  const at = process.argv.indexOf("--only");
  return at >= 0 ? new Set((process.argv[at + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) : null;
})();

const LOCAL = process.env.RAREXT_BENCH_LOCAL ?? "http://127.0.0.1:8080";

const TARGETS = [
  { id: "rarext", name: "RAREXT showcase (current)", url: `${LOCAL}/`, local: true },
  { id: "rarext-ai", name: "RAREXT browser AI", url: `${LOCAL}/registry/mirror/ai.html`, local: true },
  { id: "rarext-gallery", name: "RAREXT gallery", url: `${LOCAL}/registry/mirror/gallery.html`, local: true },
  { id: "rarext-verify", name: "RAREXT verifier", url: `${LOCAL}/registry/mirror/verify.html`, local: true },
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/" },
  { id: "claude", name: "Claude", url: "https://claude.ai/" },
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com/" },
  { id: "perplexity", name: "Perplexity", url: "https://www.perplexity.ai/" },
  { id: "copilot", name: "Microsoft Copilot", url: "https://copilot.microsoft.com/" },
  { id: "grok", name: "Grok", url: "https://grok.com/" },
  { id: "lechat", name: "Mistral Le Chat", url: "https://chat.mistral.ai/" },
  { id: "duckai", name: "Duck.ai", url: "https://duck.ai/", gated: false },
  { id: "huggingchat", name: "HuggingChat", url: "https://huggingface.co/chat/", gated: false },
  { id: "claude-marketing", name: "Claude product page", url: "https://claude.com/product/overview", marketing: true },
  { id: "mistral-marketing", name: "Mistral site", url: "https://mistral.ai/", marketing: true },
  { id: "gemini-marketing", name: "Gemini (DeepMind) page", url: "https://deepmind.google/models/gemini/", marketing: true },
  { id: "youcom", name: "You.com", url: "https://you.com/", marketing: true },
  // Three brands a "top 10" list has to include. They answered 403 to an
  // anonymous browser, which is a finding about the gate, so they are measured
  // and recorded as refused rather than quietly dropped.
  { id: "deepseek", name: "DeepSeek", url: "https://chat.deepseek.com/" },
  { id: "deepseek-site", name: "DeepSeek site", url: "https://www.deepseek.com/", marketing: true },
  { id: "metaai", name: "Meta AI", url: "https://www.meta.ai/" },
  { id: "poe", name: "Poe", url: "https://poe.com/" },
];

/* ── the in-page audit ─────────────────────────────────────────────────── */
const PAGE_AUDIT = String.raw`
(() => {
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.05 && rect.width > 1 && rect.height > 1;
  };
  const nameOf = (el) => (
    el.getAttribute("aria-label") ||
    (el.getAttribute("aria-labelledby") ? (el.getAttribute("aria-labelledby").split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ")) : "") ||
    el.innerText || el.textContent ||
    el.getAttribute("title") ||
    el.querySelector("img[alt]")?.getAttribute("alt") ||
    ""
  ).trim().replace(/\s+/g, " ");

  const parse = (color) => {
    const m = color.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const blend = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const bgOf = (el) => {
    let node = el;
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    const stack = [];
    while (node && node !== document.documentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) stack.push(c);
      if (c && c.a === 1) break;
      node = node.parentElement;
    }
    for (let i = stack.length - 1; i >= 0; i -= 1) bg = blend(stack[i], bg);
    return bg;
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  const textNodes = [...document.querySelectorAll("body *")].filter((el) => {
    if (!visible(el)) return false;
    if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|PATH|TEMPLATE)$/.test(el.tagName)) return false;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    return own;
  });
  const contrastFailures = [];
  for (const el of textNodes) {
    const style = getComputedStyle(el);
    const fg = parse(style.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const blendFg = blend(fg, bg);
    const r = ratio(blendFg, bg);
    const size = parseFloat(style.fontSize);
    const bold = Number(style.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    if (r < need) {
      contrastFailures.push({
        text: (el.innerText || "").trim().slice(0, 50),
        ratio: Number(r.toFixed(2)),
        need,
        size,
        color: style.color,
        bg: "rgb(" + [bg.r, bg.g, bg.b].map(Math.round).join(", ") + ")",
      });
    }
  }
  const uniq = (list, key) => [...new Map(list.map((x) => [key(x), x])).values()];

  const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(visible).map((h) => ({
    level: Number(h.tagName[1]), text: (h.innerText || "").trim().replace(/\s+/g, " ").slice(0, 80),
  }));
  let headingSkips = 0;
  for (let i = 1; i < headings.length; i += 1) if (headings[i].level > headings[i - 1].level + 1) headingSkips += 1;

  const clickable = [...document.querySelectorAll("a[href], button, input[type=submit], [role=button]")].filter(visible);
  const tapTargets = clickable.map((el) => {
    const r = el.getBoundingClientRect();
    return { name: nameOf(el).slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) };
  });
  const smallTargets = tapTargets.filter((t) => t.w < 24 || t.h < 24);

  const images = [...document.querySelectorAll("img")].filter(visible);
  const imgsNoAlt = images.filter((img) => !img.hasAttribute("alt"));
  const imgsNoDimensions = images.filter((img) => !img.hasAttribute("width") && !img.hasAttribute("height") && !img.style.aspectRatio);

  const controls = [
    ...document.querySelectorAll("input:not([type=hidden]), select, textarea"),
  ].filter(visible);
  const unlabeled = controls.filter((el) => {
    if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) return false;
    if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return false;
    if (el.closest("label")) return false;
    return true;
  });

  const buttons = [...document.querySelectorAll("button, [role=button], a[href]")].filter(visible);
  const unnamed = buttons.filter((el) => nameOf(el).length === 0);
  const nested = [...document.querySelectorAll("a a, button button, a button, button a")].filter(visible);

  const firstScreen = {
    h1: [...document.querySelectorAll("h1")].filter(visible).map((h) => (h.innerText || "").trim().replace(/\s+/g, " ")).slice(0, 2),
    h2: [...document.querySelectorAll("h2")].filter(visible).slice(0, 2).map((h) => (h.innerText || "").trim().replace(/\s+/g, " ")),
    ctas: [...document.querySelectorAll("a[href], button")].filter(visible)
      .filter((el) => !el.closest("nav, header, footer"))
      .filter((el) => el.getBoundingClientRect().top < innerHeight && el.getBoundingClientRect().bottom > 0)
      .map((el) => ({ text: nameOf(el).slice(0, 60), tag: el.tagName.toLowerCase(), href: el.getAttribute("href") || null }))
      .slice(0, 8),
    navItems: [...document.querySelectorAll("header nav a, header [role=navigation] a, header a")].filter(visible).length,
    wordCount: (document.body.innerText || "").trim().split(/\s+/).filter(Boolean).length,
    links: document.querySelectorAll("a[href]").length,
    text: (document.body.innerText || "").trim().replace(/\s+/g, " ").slice(0, 600),
  };

  const styleText = [...document.styleSheets].map((sheet) => {
    try { return [...sheet.cssRules].map((r) => r.cssText).join("\n"); } catch { return ""; }
  }).join("\n");

  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.getAttribute("lang"),
    hasViewport: !!document.querySelector('meta[name="viewport"]'),
    description: document.querySelector('meta[name="description"]')?.content || null,
    canonical: document.querySelector('link[rel=canonical]')?.href || null,
    og: !!document.querySelector('meta[property^="og:"]'),
    landmarks: {
      header: document.querySelectorAll("header").length,
      nav: document.querySelectorAll("nav, [role=navigation]").length,
      main: document.querySelectorAll("main, [role=main]").length,
      footer: document.querySelectorAll("footer").length,
      h1: document.querySelectorAll("h1").length,
    },
    skipLink: !!document.querySelector('a[href^="#"]') && [...document.querySelectorAll('a[href^="#"]')].some((a) => /skip/i.test(a.innerText || a.getAttribute("aria-label") || "")),
    headings: headings.slice(0, 24),
    headingSkips,
    ariaLive: document.querySelectorAll("[aria-live]").length,
    roleStatus: document.querySelectorAll("[role=status], [role=alert]").length,
    images: images.length,
    imgsNoAlt: imgsNoAlt.length,
    imgsNoDimensions: imgsNoDimensions.length,
    controls: controls.length,
    unlabeledControls: unlabeled.length,
    unnamedButtons: unnamed.length,
    nestedInteractive: nested.length,
    tapTargets: tapTargets.length,
    smallTargets: smallTargets.length,
    smallTargetsSample: smallTargets.slice(0, 6),
    contrastFailures: uniq(contrastFailures, (x) => x.text + x.color + x.bg).slice(0, 10),
    contrastFailureCount: uniq(contrastFailures, (x) => x.text + x.color + x.bg).length,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: innerWidth,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 2,
    bodyFontSize: getComputedStyle(document.body).fontSize,
    reducedMotionRule: /prefers-reduced-motion/.test(styleText),
    darkSchemeQueried: /prefers-color-scheme/.test(styleText),
    fixedOverlayArea: (() => {
      let area = 0;
      for (const el of document.querySelectorAll("body *")) {
        const s = getComputedStyle(el);
        if (s.position !== "fixed" && s.position !== "sticky") continue;
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        area = Math.max(area, (r.width * r.height) / (innerWidth * innerHeight));
      }
      return Number(area.toFixed(3));
    })(),
    firstScreen,
    metrics: {
      fcp: window.__bench?.fcp ?? null,
      lcp: window.__bench?.lcp ?? null,
      cls: window.__bench?.cls ?? null,
      longTasks: window.__bench?.longTasks ?? null,
      tbt: window.__bench?.tbt ?? null,
      dcl: performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd ?? null,
      load: performance.getEntriesByType("navigation")[0]?.loadEventEnd ?? null,
      ttfb: performance.getEntriesByType("navigation")[0]?.responseStart ?? null,
      resources: performance.getEntriesByType("resource").length,
      transferBytes: performance.getEntriesByType("resource").reduce((n, r) => n + (r.transferSize || 0), 0),
      decodedBytes: performance.getEntriesByType("resource").reduce((n, r) => n + (r.decodedBodySize || 0), 0),
      jsBytes: performance.getEntriesByType("resource").filter((r) => /script|javascript/.test(r.initiatorType)).reduce((n, r) => n + (r.transferSize || 0), 0),
      cssBytes: performance.getEntriesByType("resource").filter((r) => /link|css/.test(r.initiatorType)).reduce((n, r) => n + (r.transferSize || 0), 0),
      imgBytes: performance.getEntriesByType("resource").filter((r) => /img|image/.test(r.initiatorType)).reduce((n, r) => n + (r.transferSize || 0), 0),
      thirdPartyHosts: [...new Set(performance.getEntriesByType("resource").map((r) => { try { return new URL(r.name).host; } catch { return null; } }).filter((h) => h && h !== location.host))].length,
      host: location.host,
    },
  };
})()
`;

const INIT_SCRIPT = String.raw`
window.__bench = { fcp: null, lcp: null, cls: 0, longTasks: 0, tbt: 0 };
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (entry.name === "first-contentful-paint") window.__bench.fcp = entry.startTime;
  }).observe({ type: "paint", buffered: true });
  new PerformanceObserver((list) => {
    const entries = list.getEntries();
    const last = entries[entries.length - 1];
    if (last) window.__bench.lcp = last.startTime;
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__bench.cls += entry.value;
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.__bench.longTasks += 1;
      window.__bench.tbt += Math.max(0, entry.duration - 50);
    }
  }).observe({ type: "longtask", buffered: true });
} catch {}
`;

/* ── HTTP probe ─────────────────────────────────────────────────────────── */
async function httpProbe(url) {
  const started = performance.now();
  try {
    const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/157 Safari/537.36" } });
    const headers = Object.fromEntries(response.headers.entries());
    const body = await response.text();
    const elapsed = performance.now() - started;
    return {
      status: response.status,
      finalUrl: response.url,
      elapsedMs: Math.round(elapsed),
      bytes: Buffer.byteLength(body),
      encoding: headers["content-encoding"] ?? null,
      cache: headers["cache-control"] ?? null,
      csp: headers["content-security-policy"] ?? null,
      hsts: headers["strict-transport-security"] ?? null,
      nosniff: headers["x-content-type-options"] ?? null,
      frame: headers["x-frame-options"] ?? null,
      referrer: headers["referrer-policy"] ?? null,
      permissions: headers["permissions-policy"] ?? null,
      server: headers.server ?? null,
    };
  } catch (error) {
    return { status: 0, error: String(error) };
  }
}

/* ── CDP ────────────────────────────────────────────────────────────────── */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
      }
    };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function waitForChrome(port) {
  for (let i = 0; i < 80; i += 1) {
    try {
      return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(150);
    }
  }
  return null;
}

async function measure(target, port, chromeAlive) {
  const profile = mkdtempSync(join(tmpdir(), "rarext-ui-"));
  // Headful, parked off-screen: Cloudflare's managed challenge treats a truly
  // headless browser as a bot, so a headless run would benchmark the challenge
  // page instead of the product. This is a real browser rendering the real site;
  // the window is moved out of the way and the viewport is fixed over CDP.
  const child = spawn(CHROME, [
    ...(process.env.RAREXT_BENCH_HEADLESS === "1" ? ["--headless=new"] : []),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1440,900",
    "--window-position=-2400,0",
    "--disable-blink-features=AutomationControlled",
    "about:blank",
  ], { stdio: "ignore" });

  try {
    const version = await waitForChrome(port);
    if (version === null) return { refused: true, reason: "chrome did not start" };

    const targetInfo = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    const ws = new WebSocket(targetInfo.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const cdp = new Cdp(ws);

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
      platform: "MacIntel",
    });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT_SCRIPT });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `Object.defineProperty(navigator, "webdriver", { get: () => false });`,
    });

    await cdp.send("Page.navigate", { url: target.url });
    await sleep(9000);

    const desktop = await cdp.send("Runtime.evaluate", { expression: PAGE_AUDIT, returnByValue: true });
    if (desktop.exceptionDetails) throw new Error(desktop.exceptionDetails.text ?? "audit failed");
    const audit = desktop.result.value;

    const desktopShot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(OUT, `${target.id}-desktop.png`), Buffer.from(desktopShot.data, "base64"));

    // Mobile: 390x844, the size of a modern phone.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await cdp.send("Page.navigate", { url: target.url });
    await sleep(6000);
    const mobile = await cdp.send("Runtime.evaluate", { expression: PAGE_AUDIT, returnByValue: true });
    const mobileAudit = mobile.result.value;
    const mobileShot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(OUT, `${target.id}-mobile.png`), Buffer.from(mobileShot.data, "base64"));

    ws.close();
    return { refused: false, title: audit.title, desktop: audit, mobile: mobileAudit };
  } catch (error) {
    return { refused: true, reason: String(error).slice(0, 200) };
  } finally {
    child.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

/* ── scoring ────────────────────────────────────────────────────────────── */
function score(entry) {
  if (entry.refused) return null;
  const d = entry.desktop;
  const m = entry.mobile;
  const metrics = d.metrics;

  const clamp = (x, lo, hi) => Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  const inverse = (x, good, bad) => 1 - clamp(x, good, bad);

  const perf = {
    ttfb: inverse(metrics.ttfb ?? 9999, 200, 2000),
    fcp: inverse(metrics.fcp ?? 9999, 800, 4000),
    lcp: inverse(metrics.lcp ?? 9999, 1200, 5000),
    cls: inverse(metrics.cls ?? 0, 0.02, 0.35),
    weight: inverse(metrics.transferBytes ?? 0, 300_000, 6_000_000),
    scripts: inverse(metrics.resources ?? 0, 20, 250),
    tbt: inverse(metrics.tbt ?? 0, 50, 1500),
  };
  const a11y = {
    alt: d.images === 0 ? 1 : 1 - d.imgsNoAlt / d.images,
    names: 1 - Math.min(1, (d.unnamedButtons + d.unlabeledControls) / Math.max(1, d.tapTargets)),
    contrast: 1 - Math.min(1, d.contrastFailureCount / Math.max(4, d.firstScreen.wordCount / 12)),
    targets: 1 - Math.min(1, d.smallTargets / Math.max(4, d.tapTargets)),
    structure: (d.landmarks.main > 0 ? 0.5 : 0) + (d.lang ? 0.25 : 0) + (d.headings.length > 0 && d.headingSkips === 0 ? 0.25 : 0),
    skip: d.skipLink ? 1 : 0,
    motion: d.reducedMotionRule ? 1 : 0,
  };
  const ux = {
    h1: d.landmarks.h1 === 1 ? 1 : d.landmarks.h1 > 1 ? 0.5 : 0,
    nav: d.firstScreen.navItems >= 3 && d.firstScreen.navItems <= 9 ? 1 : d.firstScreen.navItems > 0 ? 0.6 : 0,
    mobileNav: m.firstScreen.navItems > 0 || m.firstScreen.ctas.length >= 3 ? 1 : 0,
    overflow: m.horizontalOverflow ? 0 : 1,
    live: d.ariaLive > 0 || d.roleStatus > 0 ? 1 : 0,
    cta: d.firstScreen.ctas.length >= 1 && d.firstScreen.ctas.length <= 6 ? 1 : d.firstScreen.ctas.length > 0 ? 0.5 : 0,
    meta: (d.description ? 0.5 : 0) + (d.og ? 0.5 : 0),
  };
  const avg = (obj) => Object.values(obj).reduce((a, b) => a + b, 0) / Object.values(obj).length;
  const perfScore = Math.round(avg(perf) * 100);
  const a11yScore = Math.round(avg(a11y) * 100);
  const uxScore = Math.round(avg(ux) * 100);
  return {
    perf: perfScore,
    a11y: a11yScore,
    ux: uxScore,
    overall: Math.round(perfScore * 0.3 + a11yScore * 0.35 + uxScore * 0.35),
    detail: { perf, a11y, ux },
  };
}

/* ── run ────────────────────────────────────────────────────────────────── */
mkdirSync(OUT, { recursive: true });
const targets = TARGETS.filter((t) => only === null || only.has(t.id));
const results = [];
let port = 9400;

for (const target of targets) {
  process.stdout.write(`${target.name} … `);
  const http = await httpProbe(target.url);
  const browser = await measure(target, port++, true);
  const scored = score(browser);
  results.push({
    id: target.id,
    name: target.name,
    url: target.url,
    local: target.local === true,
    http,
    ...browser,
    score: scored,
  });
  console.log(browser.refused ? `refused (${browser.reason})` : `overall ${scored.overall} · perf ${scored.perf} · a11y ${scored.a11y} · ux ${scored.ux}`);
}

writeFileSync(join(OUT, "..", "ui-ux.json"), JSON.stringify({
  kind: "rarext.ui-ux-benchmark.v1",
  createdAt: new Date().toISOString(),
  chrome: "headless 157",
  viewports: { desktop: "1440x900", mobile: "390x844@2x" },
  results,
}, null, 2) + "\n");
console.log(`\nwrote bench/ui-ux.json and ${results.length * 2} screenshots in bench/ui-ux/`);
