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
import { existsSync, cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(ROOT, "site", "registry");
const WORKTREE = join(ROOT, ".data", "deploy-mirror-repo");
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
const originResponse = await fetch(originBundleUrl);
if (!originResponse.ok) {
  console.error(`the origin's bundle is not readable (${originResponse.status}) — refusing to publish a peer from nothing`);
  process.exit(1);
}
const originBytes = new Uint8Array(await originResponse.arrayBuffer());
const originRoot = JSON.parse(new TextDecoder().decode(originBytes)).manifest.root;
console.log(`origin root: ${originRoot}`);

const localBundle = readFileSync(join(SOURCE, "bundle.json"));
const localRoot = JSON.parse(localBundle.toString("utf8")).manifest.root;
if (localRoot !== originRoot || sha256(localBundle) !== sha256(originBytes)) {
  console.error("the committed tree disagrees with the served origin — republish before deploying a peer");
  process.exit(1);
}

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
const deadline = Date.now() + 180_000;
let liveBundle = null;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  try {
    const response = await fetch(`${BASE}/registry/bundle.json`, { signal: AbortSignal.timeout(15_000) });
    if (response.ok) {
      liveBundle = new Uint8Array(await response.arrayBuffer());
      if (sha256(liveBundle) === sha256(originBytes)) break;
      liveBundle = null;
    }
  } catch {}
}
if (!liveBundle) {
  console.error(`the peer did not serve matching bundle bytes within 3 minutes — check ${BASE}`);
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
