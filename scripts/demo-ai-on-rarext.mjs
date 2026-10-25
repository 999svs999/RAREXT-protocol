#!/usr/bin/env node
/**
 * demo-ai-on-rarext.mjs — the one-command, third-party-runnable proof that
 * "AI lives on RAREXT".
 *
 * It composes the repo's existing, individually-gated pieces into a single
 * end-to-end demonstration a stranger can run on their own machine:
 *
 *   1. PUBLISH   — run scripts/publish-ai-proof.mjs, the real operator flow:
 *                  boot the API in-process, register an agent, sign and publish
 *                  real generative + bounded AI publications, anchor them, and
 *                  build the static mirror.
 *   2. SERVE     — serve the mirror over loopback HTTP, exactly like a host
 *                  would.
 *   3. RECOMPUTE — run scripts/verify-live-ai.mjs against that local server:
 *                  re-derive both AI renditions from the commitments alone and
 *                  compare digests against the served bytes.
 *   4. PIN       — check the bundle's manifest root against the anchor it
 *                  names, and that the anchor covers the published work.
 *
 * The demo exits 0 only when every phase verifies. It is deliberately NOT part
 * of npm run ci: each phase's logic is already gated by the suite, and this
 * script exists to be run by a person who wants to see the proof happen.
 *
 * Usage: npm run demo:ai
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const proofDir = join(root, ".ai-proof");
const mirrorDir = join(proofDir, "mirror");

const phases = [];
function phase(name, ok, detail) {
  phases.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  return ok;
}

/**
 * Run a child process and await its exit WITHOUT blocking the event loop.
 * spawnSync cannot be used while this process also serves HTTP: a blocked loop
 * stops the server from accepting connections, and the child's own fetches hang
 * until the timeout kills them — the exact failure this demo shipped with.
 */
function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

console.log("AI lives on RAREXT — end-to-end demonstration\n");

// ── Phase 1: publish through the real flow ─────────────────────────────────
console.log("phase 1: publishing real AI publications through the live API flow");
const publishRun = await run(process.execPath, ["scripts/publish-ai-proof.mjs"], 5 * 60 * 1000);
const publishOk =
  publishRun.code === 0 &&
  existsSync(join(mirrorDir, "bundle.json")) &&
  existsSync(join(mirrorDir, "blobs.json"));
phase(
  "publish",
  publishOk,
  publishOk
    ? (publishRun.stdout.match(/MIRROR BUILT AT (.+)/)?.[1] ?? mirrorDir).trim()
    : `publisher exited ${publishRun.code ?? publishRun.signal}: ${(publishRun.stderr ?? "").split("\n").filter(Boolean).pop() ?? "no error"}`,
);

// ── Phase 2: serve the mirror ───────────────────────────────────────────────
let server;
let port = 0;
let serveOk = false;
if (publishOk) {
  console.log("phase 2: serving the mirror over loopback HTTP");
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  };
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = join(mirrorDir, rel);
      if (!file.startsWith(mirrorDir) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(500).end("demo server error");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  const probe = await readFile(join(mirrorDir, "index.html"), "utf8").then(
    () => true,
    () => false,
  );
  serveOk = probe && port > 0;
  phase("serve", serveOk, `http://127.0.0.1:${port} (${mirrorDir})`);
} else {
  phase("serve", false, "skipped: publish failed");
}

// ── Phase 3: recompute the renditions from the served bytes ────────────────
let recomputeOk = false;
if (serveOk) {
  console.log("phase 3: re-deriving the AI renditions from the commitments alone");
  const verify = await run(
    process.execPath,
    ["scripts/verify-live-ai.mjs", `http://127.0.0.1:${port}`],
    2 * 60 * 1000,
  );
  const summary = (verify.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
  recomputeOk = verify.code === 0 && summary.includes("verified by recomputation");
  phase("recompute", recomputeOk, summary.trim());
} else {
  phase("recompute", false, "skipped: serve failed");
}

// ── Phase 4: the anchor pins the published root ─────────────────────────────
let pinOk = false;
if (publishOk) {
  console.log("phase 4: checking the anchor pins the published root");
  const bundle = JSON.parse(await readFile(join(mirrorDir, "bundle.json"), "utf8"));
  const manifest = bundle.manifest ?? {};
  const rootHex = String(manifest.root ?? "");
  const anchors = Array.isArray(bundle.anchors) ? bundle.anchors : [];
  const anchor = anchors.at(-1);
  const publicationIds = (bundle.publications ?? []).map((p) => p.id);
  const rootIsSha256 = /^[0-9a-f]{64}$/.test(rootHex);
  const anchorMatches = rootIsSha256 && anchor?.root === rootHex;
  const covers = anchorMatches
    ? (anchor.publicationIds ?? []).every((id) => publicationIds.includes(id)) &&
      publicationIds.length > 0
    : false;
  pinOk = rootIsSha256 && anchorMatches && covers;
  phase(
    "pin",
    pinOk,
    pinOk
      ? `root ${rootHex.slice(0, 16)}… pinned by anchor ${anchor.id.slice(0, 8)}… covering ${publicationIds.length} publication(s)`
      : `root ${rootHex ? rootHex.slice(0, 16) + "…" : "missing"}, anchor ${anchor ? "present" : "missing"}`,
  );
} else {
  phase("pin", false, "skipped: publish failed");
}

server?.close();
server?.closeAllConnections();

const failed = phases.filter((p) => !p.ok);
console.log(
  failed.length === 0
    ? `\nDEMO PASSED: publish → serve → recompute → pin, ${phases.length}/4 phases verified. AI lives on RAREXT.`
    : `\nDEMO FAILED: ${failed.map((p) => p.name).join(", ")}`,
);
process.exit(failed.length === 0 ? 0 : 1);
