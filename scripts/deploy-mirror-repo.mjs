#!/usr/bin/env node
// Deploy the committed site/registry tree to the SECOND registry's repository
// (999svs999/RAREXT-mirror) and verify the live bytes — the first true peer.
//
// The rule this script exists to keep: a second registry is a second CUSTODY,
// not a second source of truth. It serves exactly the artifacts the real
// publish flow committed — never a rebuild from an ad-hoc node — and the
// deployment is not "done" until the live bytes on the peer verify to the same
// root the origin serves.
//
//   site/registry/bundle.json    -> /registry/bundle.json
//   site/registry/seed.json      -> /registry/seed.json
//   site/registry/mirror/*       -> /mirror/*     (the verify page)
//
// The peer's URL structure mirrors the origin's exactly, because the convention
// that turns a registry URL into a bundle URL (`<registry>/registry/bundle.json`)
// is the thing a second registry exists to honor.
//
// Pages is expected to serve the main branch root; the script enables it when
// the repository does not have it yet (idempotent on subsequent runs).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(ROOT, "site", "registry");
// A per-process worktree, not a shared one: the scheduled ship and a manual
// re-run overlapped on this path and both tried to clone into it, which fails
// with "cannot copy .../info/exclude: File exists". Unique dirs make the runs
// independent; stale ones from a killed run are swept first.
const WORKTREE = join(ROOT, ".data", `deploy-mirror-repo-${process.pid}`);
for (const stale of readdirSafe(join(ROOT, ".data"))) {
  if (!stale.startsWith("deploy-mirror-repo-")) continue;
  const full = join(ROOT, ".data", stale);
  try {
    if (Date.now() - statSync(full).mtimeMs > 60 * 60 * 1000) rmSync(full, { recursive: true, force: true });
  } catch {
    // a dir that vanished mid-scan is fine
  }
}
// Legacy fixed-name clone dir from the pre-pid code never matches the prefix
// above, and a leftover one is what failed a run with "cannot copy
// .../info/exclude: File exists". Sweep it unconditionally.
rmSync(join(ROOT, ".data", "deploy-mirror-repo"), { recursive: true, force: true });
const OWNER = "999svs999";
const REPO = "RAREXT-mirror";
const REPO_SLUG = `${OWNER}/${REPO}`;
const BASE = `https://${OWNER}.github.io/${REPO}`;
const DRY_RUN = process.argv.includes("--dry-run");
const GIT_ID = ["-c", "user.name=R", "-c", "user.email=r@R.local"];

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (!existsSync(SOURCE)) {
  console.error(`no committed registry tree at ${SOURCE} — run the real publish first`);
  process.exit(1);
}

// The origin's own served bundle is the truth this deployment must match, not
// the working tree: the tree is what gets copied, the SERVED bytes are what
// the peer is verified against.
const originBundleUrl = "https://999svs999.github.io/RAREXT-protocol/registry/bundle.json";
const localBundle = readFileSync(join(SOURCE, "bundle.json"));
const localRoot = JSON.parse(localBundle.toString("utf8")).manifest.root;

// GitHub Pages serves the pushed tree through a CDN, so the bytes are not
// available the instant `git push` returns. Comparing once turned that propagation
// delay into a hard failure ("the committed tree disagrees with the served
// origin") on the 23:46 ship, minutes after the same code passed by hand — a race,
// not a defect. Poll until the origin catches up, and only fail if it never does.
const WAIT_MS = Number(process.env.RAREXT_ORIGIN_WAIT_MS || 180000);
const STEP_MS = 10000;
const startedAt = Date.now();
let originBytes = null;
let originRoot = null;
let lastReason = "no attempt";
for (;;) {
  try {
    const originResponse = await fetch(originBundleUrl, { cache: "no-store" });
    if (!originResponse.ok) {
      lastReason = `origin bundle HTTP ${originResponse.status}`;
    } else {
      const bytes = new Uint8Array(await originResponse.arrayBuffer());
      const root = JSON.parse(new TextDecoder().decode(bytes)).manifest.root;
      if (root === localRoot && sha256(localBundle) === sha256(bytes)) {
        originBytes = bytes;
        originRoot = root;
        break;
      }
      lastReason = `origin root ${root} vs committed ${localRoot}`;
    }
  } catch (error) {
    lastReason = String(error?.message ?? error).slice(0, 120);
  }
  if (Date.now() - startedAt > WAIT_MS) {
    console.error(`the committed tree still disagrees with the served origin after ${Math.round(WAIT_MS / 1000)}s (${lastReason}) — refusing to deploy a peer from a stale projection`);
    process.exit(1);
  }
  console.log(`waiting for the origin to serve the new tree (${lastReason})…`);
  await new Promise((r) => setTimeout(r, STEP_MS));
}
console.log(`origin root: ${originRoot} (matched after ${Math.round((Date.now() - startedAt) / 1000)}s)`);

if (DRY_RUN) {
  console.log("dry run: the committed tree matches the served origin; stopping before any network write");
  process.exit(0);
}

// A fresh clone every run: the branch is a pure projection of the committed
// tree, the same rule deploy-site.mjs holds for gh-pages.
rmSync(WORKTREE, { recursive: true, force: true });
mkdirSync(WORKTREE, { recursive: true });
git(["clone", "--depth", "1", `https://github.com/${REPO_SLUG}.git`, WORKTREE]);

git(["config", "user.name", "R"], { cwd: WORKTREE });
git(["config", "user.email", "r@R.local"], { cwd: WORKTREE });

// Replace everything with the origin's URL structure: the registry documents
// under /registry/, the verify page under /mirror/.
for (const entry of readdirSafe(WORKTREE)) {
  if (entry === ".git") continue;
  rmSync(join(WORKTREE, entry), { recursive: true, force: true });
}
mkdirSync(join(WORKTREE, "registry"), { recursive: true });
mkdirSync(join(WORKTREE, "mirror"), { recursive: true });
for (const entry of readdirSafe(SOURCE)) {
  if (entry === "mirror") continue;
  cpSync(join(SOURCE, entry), join(WORKTREE, "registry", entry), { recursive: true });
}
cpSync(join(SOURCE, "mirror"), join(WORKTREE, "mirror"), { recursive: true });

// The peer states its own binding — same rule as the origin's
// /.well-known/rarext.json, this origin's URL. Derived from the committed
// seed (never hand-written), and .nojekyll goes in so Pages serves the
// dot-path instead of Jekyll-ignoring it.
const committedSeed = JSON.parse(readFileSync(join(SOURCE, "seed.json"), "utf8"));
mkdirSync(join(WORKTREE, ".well-known"), { recursive: true });
writeFileSync(
  join(WORKTREE, ".well-known", "rarext.json"),
  `${JSON.stringify(
    {
      registry: "rarext",
      root: committedSeed.bundleRoot,
      bundle: `${BASE}/registry/bundle.json`,
      cid: committedSeed.bundleCid ?? undefined,
      issuedAt: new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z"),
    },
    null,
    2,
  )}\n`,
);
writeFileSync(join(WORKTREE, ".nojekyll"), "");

git(["add", "-A"], { cwd: WORKTREE });
const status = git(["status", "--porcelain"], { cwd: WORKTREE });
if (status.trim() === "") {
  console.log("the peer is already byte-identical; nothing to push");
} else {
  git(["commit", "-m", "deploy: the registry artifacts, from the real publish flow"], { cwd: WORKTREE });
  git(["push", "origin", "HEAD:main"], { cwd: WORKTREE });
  console.log("pushed to the peer's main");
}

// Pages from main / root — tolerated as a no-op once enabled.
try {
  execFileSync("gh", [
    "api", `repos/${REPO_SLUG}/pages`, "-X", "POST",
    "-f", "source[branch]=main", "-f", "source[path]=/",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  console.log("Pages enabled on the peer (main / root)");
} catch (error) {
  const message = String(error?.stderr ?? error);
  if (/already exists|409/i.test(message)) console.log("Pages already enabled on the peer");
  else throw error;
}

// The deployment is not done until the LIVE bytes verify to the same root the
// origin serves — both the bundle and the seed, which is the document that
// names the peer in the federation list.
// GitHub Pages builds queue under load and routinely take longer than three
// minutes; a short window turns a healthy deploy into a red cron. Ten minutes,
// with a per-attempt cache-buster so the CDN cannot serve the old bytes.
const deadline = Date.now() + 600_000;
let liveBundle = null;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  try {
    const response = await fetch(`${BASE}/registry/bundle.json?deploy=${Date.now()}`, { signal: AbortSignal.timeout(15_000) });
    if (response.ok) {
      liveBundle = new Uint8Array(await response.arrayBuffer());
      if (sha256(liveBundle) === sha256(originBytes)) break;
      liveBundle = null;
    }
  } catch {}
}
if (!liveBundle) {
  console.error(`the peer did not serve matching bundle bytes within 10 minutes — check ${BASE}`);
  process.exit(1);
}
console.log(`peer bundle verified: ${BASE}/registry/bundle.json rebuilds ${originRoot}`);

const liveSeedResponse = await fetch(`${BASE}/registry/seed.json`, { signal: AbortSignal.timeout(15_000) });
if (!liveSeedResponse.ok) {
  console.error(`the peer's seed is not readable (${liveSeedResponse.status})`);
  process.exit(1);
}
const liveSeed = JSON.parse(await liveSeedResponse.text());
const ids = (liveSeed.registries ?? []).map((entry) => entry.id);
if (!ids.includes("rarext") || !ids.includes("rarext-mirror")) {
  console.error(`the peer's seed does not list the federation: ${ids.join(", ")}`);
  process.exit(1);
}
console.log(`peer seed lists the federation: ${ids.join(", ")}`);
console.log("the first true peer is live and verified");

function readdirSafe(dir) {
  try {
    return execFileSync("ls", ["-A", dir], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
