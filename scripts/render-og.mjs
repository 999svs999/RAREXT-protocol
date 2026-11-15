#!/usr/bin/env node
// Render scripts/og-card.html to site/og.png at 1200x630.
//
// The Open Graph card is part of the front door: it is what a shared link shows
// before anyone visits. Rendering it from HTML keeps it in step with the page's
// words and type, and keeps it reproducible without an image editor.
//
//   node scripts/render-og.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CARD = new URL("./og-card.html", import.meta.url);
const OUT = new URL("../site/og.png", import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const profile = mkdtempSync(join(tmpdir(), "rarext-og-"));
const port = 9497;
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "about:blank",
], { stdio: "ignore" });

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
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const messageId = ++id;
    pending.set(messageId, { resolve, reject });
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });

  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: pathToFileURL(CARD.pathname).href });
  await sleep(900);

  const overflow = await send("Runtime.evaluate", {
    expression: "JSON.stringify({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })",
    returnByValue: true,
  });
  const size = JSON.parse(overflow.result.value);
  if (size.w !== 1200 || size.h !== 630) {
    throw new Error(`card is ${size.w}x${size.h}, expected 1200x630`);
  }

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  ws.close();
  console.log(`wrote site/og.png (1200x630, ${Buffer.from(shot.data, "base64").length} bytes)`);
} finally {
  chrome.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
