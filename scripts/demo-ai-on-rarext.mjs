#!/usr/bin/env node
/**
 * demo-ai-on-rarext.mjs — the AI lives on RAREXT, purely.
 *
 * The weights AND the engine are content-addressed RAREXT artifacts. The engine
 * is a PORTABLE network artifact (a JS module run on a sandboxed worker thread by
 * default), and it READS THE COMMITTED WEIGHTS: it parses the RXHF container out
 * of the model bytes and runs the transformer over the tensors. Two independent
 * nodes fetch the same shards, verify them, and answer the same canonical run.
 *
 * To prove the output is driven by the weights — not a constant — the demo then
 * commits a PERTURBED copy of the same weights and shows the same engine answers
 * differently.
 *
 *   RAREXT_WEB4_GGUF=/tmp/model.rarext npm run demo:ai-on-rarext
 *
 * Optional: RAREXT_WEB4_ENGINE_RUNTIME=worker|wasm (default worker),
 * RAREXT_WEB4_ENGINE_MODULE=<path> (default RAREXT's GGUF engine), and
 * RAREXT_WEB4_PROMPT=<text> (default "abcdefgh"; use a prompt the model can
 * tokenize, and a model whose greedy decode varies, or weight-dependence cannot
 * be shown).
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const state = mkdtempSync(join(tmpdir(), "rarext-ai-on-rarext-"));
const blobs = join(state, "blobs");

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["apps/runtime/src/cli.ts", ...args], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function spawnReady(args, ready) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no start within 30s: ${stderr.slice(-500)}`)), 30_000);
    child.stdout.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        const match = ready(line.trim());
        if (match) {
          clearTimeout(timer);
          resolve(match);
        }
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code}: ${stderr.slice(-500)}`));
    });
  });
  return { child, ready: promise, stop: () => child.kill("SIGTERM") };
}

/** Zero every 16th byte of a container's tensor-data region, so the weights the
 *  engine reads are genuinely different (the header/tokenizer stay intact). */
function perturbContainer(source, target) {
  const bytes = readFileSync(source);
  const jsonLen = Number(bytes.readBigUInt64LE(8));
  const dataStart = Math.ceil((16 + jsonLen) / 32) * 32;
  const copy = Buffer.from(bytes);
  let changed = 0;
  for (let offset = dataStart; offset < copy.length; offset += 16) {
    if (copy[offset] !== 0) {
      copy[offset] = 0;
      changed += 1;
    }
  }
  writeFileSync(target, copy);
  return changed;
}

const procs = [];
const phase = (name, detail) => console.log(`  [OK] ${name} — ${detail}`);
// A prompt every fixture can tokenize: the tiny test models carry the bytes
// a–h, and a real model tokenizes the same string. Override when a model needs
// a different prompt, but keep it representable or the run is degenerate.
const prompt = process.env.RAREXT_WEB4_PROMPT ?? "abcdefgh";
const ask = async (url, model) => {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 8, temperature: 0, seed: 7 }),
  });
  if (!response.ok) throw new Error(`inference failed: HTTP ${response.status} ${await response.text()}`);
  return route(await response.json());
};
const route = (body) => ({
  text: body.choices?.[0]?.message?.content ?? "",
  digest: body.rarext_trace?.digest ?? null,
});

try {
  console.log("The AI lives on RAREXT, purely — weights and engine are network artifacts\n");

  const weights = process.env.RAREXT_WEB4_GGUF;
  if (weights === undefined) throw new Error("set RAREXT_WEB4_GGUF to a committed model container (RXHF/GGUF)");
  const runtime = process.env.RAREXT_WEB4_ENGINE_RUNTIME ?? "worker";
  const engineArtifact =
    process.env.RAREXT_WEB4_ENGINE_MODULE ?? join(root, "apps/runtime/engines/rarext-gguf-engine.js");
  const engineName = process.env.RAREXT_WEB4_ENGINE_MODULE === undefined ? "rarext-gguf-engine" : "portable-engine";

  // 1. A RAREXT node.
  const api = spawnReady(["apps/api/src/server.ts"], (line) => {
    const match = line.match(/listening on (https?:\/\/[^\s]+)/);
    return match ? match[1].replace(/\/$/, "") : null;
  });
  procs.push(api);
  const registry = await api.ready;

  const bundle = async (weightsPath, modelId, out) => {
    const bundled = await runCli([
      "bundle",
      "--file", weightsPath,
      "--model", modelId,
      "--engine", "rarext",
      "--engine-module", engineArtifact,
      "--engine-runtime", runtime,
      "--engine-name", engineName,
      "--engine-version", "1",
      "--registry", registry,
      "--out", out,
      "--chunk-bytes", "8388608",
      "--json",
    ]);
    if (bundled.status !== 0) throw new Error(bundled.stderr || bundled.stdout);
    return JSON.parse(bundled.stdout);
  };
  const startNode = async (bundlePath) => {
    const port = await freePort();
    const node = spawnReady(
      ["apps/runtime/src/cli.ts", "provider", "--bundle", bundlePath, "--registry", registry, "--port", String(port)],
      (line) => {
        const match = line.match(/rarext provider serving .* on (https?:\/\/[^\s]+)/);
        return match ? match[1].replace(/\/$/, "") : null;
      },
    );
    procs.push(node);
    return node.ready;
  };

  // 2. Commit the weights AND the engine as one model bundle.
  const report = await bundle(weights, "ai-on-rarext", join(state, "a"));
  phase(
    "commit",
    `weights ${report.bundle.model.weightsDigest.slice(0, 18)}… and engine ` +
      `${report.engineBundle.artifactDigest.slice(0, 18)}… are RAREXT shards`,
  );

  // 3. Two independent nodes, each with NO host engine.
  const [urlA, urlB] = [await startNode(report.bundlePath), await startNode(report.bundlePath)];
  phase("nodes", "2 node(s) fetched and verified the shards from RAREXT and serve ai-on-rarext");

  // 4. Real inference, driven by the committed weights, on both nodes.
  const first = await ask(urlA, "ai-on-rarext");
  const second = await ask(urlB, "ai-on-rarext");
  if (first.text.length === 0) throw new Error("the portable engine produced no output from the committed weights");
  if (first.text !== second.text) throw new Error("the nodes disagreed");
  if (first.digest === null || first.digest !== second.digest) throw new Error("the nodes did not commit the same trace");
  phase("infer", `both nodes answered ${JSON.stringify(first.text)} from the committed weights`);
  phase("agree", `the same canonical trace ${first.digest.slice(0, 18)}… on every node`);

  // 5. Replay: the run is checked bit-for-bit against a re-execution.
  const again = await ask(urlA, "ai-on-rarext");
  if (again.digest !== first.digest) throw new Error("the replayed trace diverged");
  phase("replay", `a re-run on node A reproduced trace ${again.digest.slice(0, 18)}…`);

  // 6. Weight-dependence: the SAME engine over PERTURBED weights answers differently.
  const perturbed = join(state, "perturbed.rarext");
  const changed = perturbContainer(weights, perturbed);
  const perturbedReport = await bundle(perturbed, "ai-on-rarext-perturbed", join(state, "b"));
  const urlC = await startNode(perturbedReport.bundlePath);
  const perturbedAnswer = await ask(urlC, "ai-on-rarext-perturbed");
  if (perturbedAnswer.digest === first.digest) {
    const degenerate = first.text.length > 1 && new Set(first.text).size === 1;
    throw new Error(
      degenerate
        ? `the model's decode is degenerate (${JSON.stringify(first.text)}), so weight-dependence cannot be shown; use a model whose greedy decode varies`
        : "the perturbed weights produced the same trace; the output is not weight-driven",
    );
  }
  phase(
    "weights",
    `perturbing ${changed} committed weight bytes changed the run ` +
      `(${first.digest.slice(0, 12)}… -> ${perturbedAnswer.digest.slice(0, 12)}…)`,
  );

  console.log(
    "\nThe AI — weights and engine — lives on RAREXT. The node parsed the committed container and computed\n" +
      "the transformer itself on a sandboxed worker: no Ollama, no llama.cpp, no container runtime, no GPU,\n" +
      "no hardware root of trust — and the answer provably changes when the committed weights change.\n",
  );
} catch (error) {
  console.error(`demo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  for (const proc of procs) proc.stop();
}
