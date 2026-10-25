#!/usr/bin/env node
// Deploy the committed site/ tree to the gh-pages branch, then verify the live
// bytes and roots. The branch is a pure projection of site/:
//
//   site/index.html              -> /index.html
//   site/registry/*              -> /registry/*
//   site/registry/mirror/*       -> /mirror/*
//
// --dry-run performs the local checks without touching the branch or network.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SITE = join(ROOT, "site");
const WORKTREE = join(ROOT, ".data", "deploy-gh-pages");
const BRANCH = "gh-pages";
const DRY_RUN = process.argv.includes("--dry-run");
const GIT_ID = ["-c", "user.name=R", "-c", "user.email=r@R.local"];

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function gitBytes(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

function requireRoot(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label} is not a 64-hex root: ${JSON.stringify(value)}`);
  }
  return value;
}

function checkRoots() {
  const seedPath = join(SITE, "registry", "seed.json");
  const bundlePath = join(SITE, "registry", "bundle.json");
  const mirrorPath = join(SITE, "registry", "mirror", "bundle.json");

  const seed = readJson(seedPath);
  const bundle = readJson(bundlePath);
  const mirror = readJson(mirrorPath);
  const root = requireRoot(bundle?.manifest?.root, "bundle.manifest.root");

  const candidates = [
    ["seed.bundleRoot", seed?.bundleRoot],
    ["bundle.manifest.root", bundle?.manifest?.root],
    ["mirror manifest.root", mirror?.manifest?.root],
    ...(Array.isArray(seed?.mirrors)
      ? seed.mirrors.map((entry, index) => [`seed.mirrors[${index}].root`, entry?.root])
      : []),
    ...(Array.isArray(seed?.registries)
      ? seed.registries
          .filter((entry) => entry && Object.hasOwn(entry, "root"))
          .map((entry, index) => [`seed.registries[${index}].root`, entry.root])
      : []),
  ];

  for (const [label, value] of candidates) {
    requireRoot(value, label);
    if (value !== root) {
      fail(`root mismatch: ${label} is ${value}, expected ${root}`);
    }
  }

  if (JSON.stringify(bundle) !== JSON.stringify(mirror)) {
    fail("root mismatch: site/registry/bundle.json and site/registry/mirror/bundle.json differ");
  }

  if (bundle?.manifest?.anchorRoot && bundle.manifest.anchorRoot !== root) {
    fail(
      `root mismatch: bundle.manifest.anchorRoot is ${bundle.manifest.anchorRoot}, expected ${root}`,
    );
  }

  return { seed, bundle, mirror, root };
}

function collectFiles() {
  const files = [];
  const fixed = [
    ["index.html", "index.html"],
    ["favicon.svg", "favicon.svg"],
    ["og.png", "og.png"],
    ["styles.css", "styles.css"],
    [".nojekyll", ".nojekyll"],
    ["registry/bundle.json", "registry/bundle.json"],
    ["registry/seed.json", "registry/seed.json"],
    ["registry/index.html", "registry/index.html"],
  ];

  for (const [source, target] of fixed) {
    files.push({ source, target });
  }

  const mirrorDir = join(SITE, "registry", "mirror");
  for (const entry of readdirSync(mirrorDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const source = `registry/mirror/${entry.name}`;
    if (!entry.isFile()) {
      fail(`mirror source is not a regular file: site/${source}`);
    }
    files.push({ source, target: `mirror/${entry.name}` });
  }

  const targets = new Set();
  for (const file of files) {
    if (targets.has(file.target)) fail(`duplicate deploy target: ${file.target}`);
    targets.add(file.target);
  }

  return files;
}

function checkCommittedSources(files) {
  const dirty = git(["status", "--porcelain", "--", "site"]).trim();
  if (dirty) {
    fail(`site/ is not committed; commit it before deploy:\n${dirty}`);
  }

  for (const file of files) {
    const abs = join(SITE, file.source);
    if (!existsSync(abs)) fail(`missing repo source: site/${file.source}`);

    const stat = lstatSync(abs);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail(`repo source is not a regular file: site/${file.source}`);
    }

    const bytes = readFileSync(abs);
    const head = gitBytes(["show", `HEAD:site/${file.source}`]);
    if (!bytes.equals(head)) {
      fail(`repo source differs from HEAD: site/${file.source}`);
    }

    file.bytes = bytes;
    file.sha256 = sha256(bytes);
  }
}

function removeWorktree() {
  if (!existsSync(WORKTREE)) return;
  try {
    git(["worktree", "remove", "--force", WORKTREE]);
  } catch {
    rmSync(WORKTREE, { recursive: true, force: true });
  }
}

function prepareWorktree() {
  git(["fetch", "origin", BRANCH]);
  removeWorktree();
  git(["worktree", "prune"]);
  git(["worktree", "add", "--detach", WORKTREE, `origin/${BRANCH}`]);

  for (const entry of readdirSync(WORKTREE)) {
    if (entry === ".git") continue;
    rmSync(join(WORKTREE, entry), { recursive: true, force: true });
  }
}

function writeAndCheck(files) {
  for (const file of files) {
    const target = join(WORKTREE, file.target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);

    const written = readFileSync(target);
    if (!written.equals(file.bytes)) {
      fail(`deployed file is not byte-identical to repo source: ${file.target}`);
    }
  }
}

function publishBranch(files, root, sourceCommit) {
  prepareWorktree();
  writeAndCheck(files);

  const changed = git(["-C", WORKTREE, "status", "--porcelain"]).trim();
  if (!changed) {
    console.log("gh-pages already matches site/; nothing to commit");
    return null;
  }

  git(["-C", WORKTREE, "add", "-A"]);
  git([
    "-C",
    WORKTREE,
    ...GIT_ID,
    "commit",
    "-s",
    "-m",
    `site: publish anchored root ${root.slice(0, 12)}`,
    "-m",
    "Project the committed site/ tree onto gh-pages: landing page, registry bundle and seed, and the static mirror. site/registry/mirror is published at /mirror/.",
    "-m",
    `Source: ${sourceCommit}\nRoot: ${root}\nFiles: ${files.length}`,
  ]);

  const commit = git(["-C", WORKTREE, "rev-parse", "HEAD"]).trim();
  git(["-C", WORKTREE, "push", "origin", `HEAD:${BRANCH}`]);
  try {
    git(["update-ref", `refs/heads/${BRANCH}`, commit]);
  } catch {
    // A local branch is optional; the pushed branch is the source of truth.
  }
  return commit;
}

function liveBaseFor(seed) {
  if (typeof seed?.bundle !== "string") fail("seed.bundle is missing");
  const bundleUrl = new URL(seed.bundle);
  const suffix = "/registry/bundle.json";
  if (!bundleUrl.pathname.endsWith(suffix)) {
    fail(`seed.bundle does not end with ${suffix}: ${seed.bundle}`);
  }
  return `${bundleUrl.origin}${bundleUrl.pathname.slice(0, -suffix.length)}/`;
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`live ${label} is not JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function liveUrl(base, target) {
  return new URL(target, base);
}

async function fetchLiveFile(base, target, expected, commit) {
  const deadline = Date.now() + 180_000;
  let attempt = 0;
  let last = "no attempt";

  while (Date.now() < deadline) {
    attempt += 1;
    const url = liveUrl(base, target);
    url.searchParams.set("deploy", commit.slice(0, 12));
    url.searchParams.set("attempt", String(attempt));

    try {
      const response = await fetch(url, { cache: "no-store", redirect: "follow" });
      if (!response.ok) {
        last = `HTTP ${response.status}`;
      } else {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.equals(expected)) {
          console.log(`live ${target} ${sha256(bytes).slice(0, 12)}`);
          return bytes;
        }
        last = `bytes ${sha256(bytes).slice(0, 12)} != ${sha256(expected).slice(0, 12)}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  fail(`live deploy mismatch: /${target} (${last})`);
}

async function verifyLinks(base, page, html) {
  const pageUrl = new URL(page, base);
  const sitePrefix = new URL(base).pathname;
  const seen = new Map();

  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const href = match[1];
    if (!href || href.startsWith("#") || href.startsWith("mailto:")) continue;
    const url = new URL(href, pageUrl);
    if (url.origin !== pageUrl.origin) continue;
    if (!url.pathname.startsWith(sitePrefix)) continue;
    seen.set(url.href, url);
  }

  for (const url of seen.values()) {
    url.searchParams.set("deploy-check", "1");
    const response = await fetch(url, { cache: "no-store", redirect: "follow" });
    if (!response.ok) {
      fail(`link in /${page} does not resolve: ${url.pathname} -> HTTP ${response.status}`);
    }
  }

  return seen.size;
}

async function verifyLive(files, seed, root, sourceCommit) {
  const base = liveBaseFor(seed);
  const live = new Map();

  await Promise.all(
    files.map(async (file) => {
      live.set(file.target, await fetchLiveFile(base, file.target, file.bytes, sourceCommit));
    }),
  );

  const seedLive = parseJsonBytes(live.get("registry/seed.json"), "registry/seed.json");
  const bundleLive = parseJsonBytes(live.get("registry/bundle.json"), "registry/bundle.json");
  const mirrorLive = parseJsonBytes(live.get("mirror/bundle.json"), "mirror/bundle.json");

  const liveRoots = [
    ["seed.bundleRoot", seedLive?.bundleRoot],
    ["bundle.manifest.root", bundleLive?.manifest?.root],
    ["mirror manifest.root", mirrorLive?.manifest?.root],
    ...(Array.isArray(seedLive?.mirrors)
      ? seedLive.mirrors.map((entry, index) => [`seed.mirrors[${index}].root`, entry?.root])
      : []),
  ];
  for (const [label, value] of liveRoots) {
    requireRoot(value, `live ${label}`);
    if (value !== root) {
      fail(`live root mismatch: ${label} is ${value}, expected ${root}`);
    }
  }

  const blobFile = parseJsonBytes(live.get("mirror/blobs.json"), "mirror/blobs.json");
  const media = Object.fromEntries(
    (Array.isArray(blobFile?.blobs) ? blobFile.blobs : [])
      .filter((blob) => typeof blob?.hash === "string" && typeof blob?.content === "string")
      .map((blob) => [blob.hash, blob.content]),
  );
  const challenges = Object.fromEntries(
    (bundleLive.challenges ?? []).map((challenge) => [challenge.id, challenge.spec ?? {}]),
  );

  const verifyModule = await import(pathToFileURL(join(ROOT, "apps/web/src/verify.ts")).href);
  const result = await verifyModule.verifyBundle(bundleLive, challenges, root, media);
  if (!result.valid) fail(`live verifier rejected the copy: ${result.reason ?? "unknown reason"}`);

  const claims = (result.aiClaims ?? []).filter((claim) => claim.representation);
  const byRepresentation = new Map(
    claims.map((claim) => [claim.representation, claim]),
  );
  for (const representation of ["generative", "bounded"]) {
    const claim = byRepresentation.get(representation);
    if (!claim) fail(`live verifier did not find the ${representation} AI representation`);
    if (!claim.media || claim.media.matches !== true) {
      fail(`live verifier did not re-derive the ${representation} rendition`);
    }
    if (claim.media.blobMatches !== true) {
      fail(`live verifier did not match the ${representation} rendition bytes`);
    }
  }

  const aiBlobs = (blobFile.blobs ?? []).filter(
    (blob) => blob?.ai && typeof blob.ai.representation === "string",
  );
  const galleryRepresentations = new Set(aiBlobs.map((blob) => blob.ai.representation));
  for (const representation of ["generative", "bounded"]) {
    if (!galleryRepresentations.has(representation)) {
      fail(`live gallery data is missing the ${representation} rendition`);
    }
  }

  const gallery = live.get("mirror/gallery.html").toString("utf8");
  if (!gallery.includes("record.ai.representation")) {
    fail("live gallery does not render representation badges");
  }

  let links = 0;
  links += await verifyLinks(base, "index.html", live.get("index.html").toString("utf8"));
  links += await verifyLinks(
    base,
    "registry/",
    live.get("registry/index.html").toString("utf8"),
  );

  console.log(`live base ${base}`);
  console.log(`live roots equal ${root}`);
  console.log(`live renditions ${[...byRepresentation.keys()].sort().join(", ")}`);
  console.log(`live links checked ${links}`);

  // The last smoke check: re-derive the AI renditions from the live mirror's
  // bytes alone, the same verification a stranger runs with
  // scripts/verify-live-ai.mjs. Spawned asynchronously on purpose — a blocking
  // spawn would freeze this process's own pending fetches.
  const { spawn } = await import("node:child_process");
  const verifyAi = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["scripts/verify-live-ai.mjs", base + "mirror"],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 2 * 60 * 1000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  const aiSummary = verifyAi.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  if (verifyAi.code !== 0) {
    console.error(`live AI recomputation failed (${verifyAi.code}): ${aiSummary || verifyAi.stderr.trim()}`);
    process.exitCode = 1;
  } else {
    console.log(`live AI ${aiSummary.trim()}`);
  }
}

async function main() {
  const roots = checkRoots();
  const files = collectFiles();
  checkCommittedSources(files);

  const sourceCommit = git(["rev-parse", "HEAD"]).trim();
  console.log(`source ${sourceCommit}`);
  console.log(`root   ${roots.root}`);
  console.log(`files  ${files.length}`);

  if (DRY_RUN) {
    for (const file of files) {
      console.log(`  site/${file.source} -> /${file.target} ${file.sha256.slice(0, 12)}`);
    }
    return;
  }

  let commit = null;
  try {
    commit = publishBranch(files, roots.root, sourceCommit);
  } finally {
    removeWorktree();
  }

  if (commit) console.log(`pushed ${commit} to origin/${BRANCH}`);
  await verifyLive(files, roots.seed, roots.root, sourceCommit);
}

await main();
