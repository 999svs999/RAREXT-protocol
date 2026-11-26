#!/usr/bin/env node
/**
 * run-projects.mjs — RAREXT AI runs all the projects.
 *
 * An operations layer, not a chat demo: the manifest (projects.json) declares
 * every project and the gates that prove it is healthy; this runner executes
 * them for real, and writes RECEIPTS — one digest per gate over its exact
 * output, duration, and exit code — plus the live service probes. The receipt
 * file is what the published mirror serves, so anyone can check a project's
 * status against the bytes that produced it.
 *
 *   node tools/ops/run-projects.mjs                 # everything
 *   node tools/ops/run-projects.mjs --only bapeclub # one project
 *   node tools/ops/run-projects.mjs --json          # machine output
 *
 * The runner reports failures honestly; a red gate is a result, not an error
 * of the runner.
 */

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const manifestPath = process.argv.includes("--manifest")
  ? resolve(process.argv[process.argv.indexOf("--manifest") + 1])
  : join(root, "tools/ops/projects.json");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1].split(",") : null;
const asJson = process.argv.includes("--json");
const outDir = join(root, "tools/ops/out");
const mirrorDir = join(root, "site/registry/mirror");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const HOME = homedir();
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function runGate(cwd, cmd, timeoutMs) {
  return new Promise((resolveGate) => {
    const t0 = Date.now();
    const child = spawn("bash", ["-lc", cmd], { cwd, env: process.env });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveGate({
        exit: code === null ? -1 : code,
        ms: Date.now() - t0,
        outputTail: out.split("\n").filter((l) => l.trim() !== "").slice(-4).join("\n"),
        digest: sha256(`${code}\n${Date.now() - t0}\n${out}`),
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveGate({ exit: -1, ms: Date.now() - t0, outputTail: String(error), digest: sha256(String(error)) });
    });
  });
}

async function probeService(service) {
  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const response = await fetch(service.url, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 (rarext-ops)" },
    });
    clearTimeout(timer);
    const body = await response.text();
    return {
      ok: response.status === service.expect,
      status: response.status,
      ms: Date.now() - t0,
      digest: sha256(body).slice(0, 16),
    };
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: String(error).slice(0, 120) };
  }
}

const results = { startedAt: new Date().toISOString(), manifest: manifestPath, projects: [], services: [] };

for (const project of manifest.projects) {
  if (only && !only.includes(project.id)) continue;
  const cwd = project.path.startsWith("/") ? project.path : join(HOME, project.path);
  if (!existsSync(join(cwd, "package.json"))) {
    results.projects.push({ id: project.id, path: cwd, ok: false, error: "no package.json" });
    continue;
  }
  let git = { head: null, dirty: null };
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
    git = { head: head.slice(0, 12), dirty: status.trim() !== "" };
  } catch { /* not a git repo — recorded as null */ }

  const gates = [];
  for (const gate of project.gates) {
    if (!asJson) process.stdout.write(`  [ .. ] ${project.id}/${gate.id} — ${gate.cmd}`);
    const gateResult = await runGate(cwd, gate.cmd, gate.timeoutMs ?? 600000);
    gateResult.id = gate.id;
    gateResult.cmd = gate.cmd;
    gateResult.ok = gateResult.exit === 0;
    gates.push(gateResult);
    if (!asJson) process.stdout.write(`\r  [ ${gateResult.ok ? "PASS" : "FAIL"} ] ${project.id}/${gate.id} — ${gateResult.ms} ms  ${gateResult.digest.slice(0, 12)}…\n`);
  }
  results.projects.push({ id: project.id, path: cwd, role: project.role, git, gates, ok: gates.every((g) => g.ok) });
}

for (const service of manifest.services ?? []) {
  if (!asJson) process.stdout.write(`  [ .. ] service ${service.id}`);
  let probe = await probeService(service);
  // optional self-heal: one `heal` command on first failure, then re-probe once.
  // edge-direct uses this because the ISP renumbers the IPv6 prefix and the
  // direct hostname's AAAA goes stale until it is updated.
  let healed = null;
  if (!probe.ok && service.heal) {
    try {
      const out = execFileSync("bash", ["-lc", service.heal], { cwd: process.cwd(), encoding: "utf8", timeout: 120000 });
      healed = out.trim().split("\n").slice(-2).join(" | ").slice(0, 160);
    } catch (error) {
      healed = `heal failed: ${String(error).slice(0, 120)}`;
    }
    if (!asJson) process.stdout.write(`\r  [ heal ] service ${service.id} — ${healed}\n  [ .. ] service ${service.id}`);
    probe = await probeService(service);
  }
  results.services.push({ id: service.id, url: service.url, healed, ...probe });
  if (!asJson) process.stdout.write(`\r  [ ${probe.ok ? "PASS" : "FAIL"} ] service ${service.id} — ${probe.ms} ms${healed ? " (healed)" : ""}\n`);
}

results.finishedAt = new Date().toISOString();
results.allOk = results.projects.every((p) => p.ok) && results.services.every((s) => s.ok);

mkdirSync(outDir, { recursive: true });
const stamp = results.startedAt.replace(/[:.]/g, "-");
writeFileSync(join(outDir, `run-${stamp}.json`), JSON.stringify(results, null, 1));
const latest = {
  generatedAt: results.finishedAt,
  allOk: results.allOk,
  projects: results.projects.map((p) => ({
    id: p.id, role: p.role ?? null, git: p.git ?? null, ok: p.ok,
    gates: (p.gates ?? []).map((g) => ({ id: g.id, ok: g.ok, ms: g.ms, digest: g.digest })),
  })),
  services: results.services.map((s) => ({ id: s.id, ok: s.ok, ms: s.ms, status: s.status ?? null })),
};
writeFileSync(join(outDir, "latest.json"), JSON.stringify(latest, null, 1));
// the published status: the mirror serves these bytes, so the live page and
// the receipts cannot drift apart.
// The published status lives at its owner location (apps/web/public) and is
// mirrored byte-identically into site/registry/mirror — the claim-check
// compares the two and refuses drift.
const webPublic = join(root, "apps/web/public");
mkdirSync(webPublic, { recursive: true });
writeFileSync(join(webPublic, "projects.json"), JSON.stringify(latest, null, 1));
mkdirSync(mirrorDir, { recursive: true });
writeFileSync(join(mirrorDir, "projects.json"), JSON.stringify(latest, null, 1));

if (!asJson) {
  console.log(`\nRAREXT ops — ${results.projects.length} project(s), ${results.services.length} service(s)`);
  for (const p of results.projects) {
    console.log(`  ${p.ok ? "PASS" : "FAIL"}  ${p.id}  ${p.gates.map((g) => `${g.id}:${g.ok ? "ok" : "FAIL"}`).join(" ")}  ${p.git?.head ? "@" + p.git.head : ""}`);
  }
  for (const s of results.services) {
    console.log(`  ${s.ok ? "PASS" : "FAIL"}  service ${s.id}  ${s.ms} ms`);
  }
  console.log(`all ok: ${results.allOk}`);
  console.log(`receipts: tools/ops/out/run-${stamp}.json`);
}
process.exit(results.allOk ? 0 : 1);
