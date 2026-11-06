#!/usr/bin/env node
/**
 * demo-model-runtime.mjs — the end-to-end proof that a real local model can
 * live on RAREXT.
 *
 *   probe    an actual serving engine (Ollama here; Strata and FreeToken are
 *            the same OpenAI surface) and commit its deployment manifest
 *   verify   start the transcript verifier a RAREXT node calls
 *   registry spawn a real RAREXT node with that verifier and challenge loaded
 *   infer    send a real completion through the attested gateway
 *   publish  the gateway signs and publishes the transcript; the node verifies
 *   anchor   anchor the bundle and find the publication inside it
 *   replay   re-run the same request against the engine and compare the output
 *   ledger   recompute the local append-only chain
 *
 * Exits 0 only when every phase holds. If no engine is listening, it starts a
 * deterministic mock upstream so the integration still runs in CI — and says so.
 *
 * Usage: node scripts/demo-model-runtime.mjs
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalDigest } from "../apps/runtime/src/digest.ts";
import {
  probeEngine,
  probeEngineCatalog,
  openAiChatUrl,
  extractOpenAiText,
} from "../apps/runtime/src/engines.ts";
import { startGateway } from "../apps/runtime/src/gateway.ts";
import { RunLedger, writeJsonFile } from "../apps/runtime/src/ledger.ts";
import {
  assessModelFit,
  buildDeployment,
  commitDeployment,
  hardwareFromHost,
  normalizeEndpoint,
} from "../apps/runtime/src/manifest.ts";
import { challengeFor, challengeIdFor, challengesFile, RuntimePublisher } from "../apps/runtime/src/publisher.ts";
import { verifyDeploymentBody, verifyRunBody } from "../apps/runtime/src/transcript.ts";
import { createVerifierServer, runSpecFromChallenge, verifierConfig } from "../apps/runtime/src/verifier.ts";
import { RarextClient } from "../packages/agent-sdk/src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const state = mkdtempSync(join(tmpdir(), "rarext-model-runtime-"));
const proofDir = join(root, ".ai-proof", "model-runtime");

const phases = [];
function phase(name, ok, detail) {
  phases.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  return ok;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function ollama() {
  for (const endpoint of ["http://127.0.0.1:11434"]) {
    try {
      const tags = await getJson(`${endpoint}/api/tags`);
      const names = (tags.models ?? []).map((model) => model.name);
      if (names.length === 0) return null;
      const model = names.includes("qwen2.5:0.5b") ? "qwen2.5:0.5b" : names[0];
      return { endpoint, model, real: true };
    } catch {
      // Try the next endpoint.
    }
  }
  return null;
}

/** Deterministic stand-in used only when no engine is installed. */
async function startMockEngine() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "mock-deterministic-1", object: "model", created: 0, owned_by: "rarext-mock" }],
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const last = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
      const text = `AI lives on RAREXT (mock): ${typeof last?.content === "string" ? last.content : ""}`;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: 0,
          model: body.model ?? "mock-deterministic-1",
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
        }),
      );
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { server, endpoint: `http://127.0.0.1:${port}`, model: "mock-deterministic-1", real: false };
}

function spawnApi(env) {
  const child = spawn(process.execPath, ["apps/api/src/server.ts"], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let onLine = null;

  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (const line of String(chunk).split("\n")) {
      if (line.trim() !== "" && onLine) onLine(line.trim());
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const base = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`API did not start: ${stderr.slice(-500)}`)), 20_000);
    onLine = (line) => {
      const match = line.match(/listening on (https?:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1].replace(/\/$/, ""));
      }
    };
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`API exited ${code}: ${stderr.slice(-500)}`));
    });
  });

  return { child, base, output: () => ({ stdout, stderr }) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let api = null;
let gateway = null;
let verifier = null;
let mock = null;

try {
  console.log("AI lives on RAREXT — local model runtime demonstration\n");

  // ── 1. Probe an engine and commit the deployment ─────────────────────────
  const found = await ollama();
  let engineSpec;
  if (found) {
    engineSpec = found;
  } else {
    mock = await startMockEngine();
    engineSpec = mock;
    console.log("  (no Ollama at 127.0.0.1:11434 — using the deterministic mock engine)");
  }

  // ── 0. Plan: does the model fit this host? ───────────────────────────────
  const catalog = await probeEngineCatalog({ endpoint: engineSpec.endpoint });
  const planned =
    catalog.models.find((entry) => entry.id === engineSpec.model) ?? catalog.models[0] ?? null;
  const plannedHardware = hardwareFromHost("cpu", engineSpec.real ? "host CPU" : "mock");
  const fit = planned ? assessModelFit(planned, plannedHardware) : null;
  phase(
    "plan",
    fit !== null,
    fit && planned
      ? `${planned.id}${planned.quantization ? ` (${planned.quantization})` : ""}: ${fit.verdict} — ${fit.note}`
      : "the engine advertised no models",
  );

  const probe = await probeEngine({
    endpoint: engineSpec.endpoint,
    model: engineSpec.model,
  });
  const deployment = commitDeployment(
    buildDeployment({
      probe,
      hardware: hardwareFromHost("cpu", engineSpec.real ? "host CPU" : "mock"),
      notes: engineSpec.real
        ? "Deployed from the local engine; Strata and FreeToken expose the same OpenAI surface."
        : "Deterministic mock upstream: integration proof without a model download.",
    }),
  );
  writeJsonFile(join(state, "deployment.json"), deployment);
  writeJsonFile(join(state, "challenges.json"), challengesFile(deployment));
  writeJsonFile(join(state, "challenge.json"), challengeFor(deployment));

  phase(
    "probe",
    typeof deployment.digest === "string" && deployment.digest.length === 64,
    `${deployment.engine.name} ${deployment.engine.version ?? ""} serving ${deployment.model.id}` +
      `${deployment.model.quantization ? ` (${deployment.model.quantization})` : ""}, ` +
      `deployment ${deployment.digest.slice(0, 16)}…`,
  );

  // ── 2. The verifier a registry calls ─────────────────────────────────────
  verifier = createVerifierServer();
  await new Promise((resolve) => verifier.listen(0, "127.0.0.1", resolve));
  const verifierPort = verifier.address().port;
  const verifierUrl = `http://127.0.0.1:${verifierPort}/verify`;
  writeJsonFile(join(state, "verifiers.json"), verifierConfig(verifierUrl));
  const challenge = challengeFor(deployment);
  const spec = runSpecFromChallenge(challenge);

  const verifierChecks = await getJson(verifierUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      artifact: { app: "ai-model-run", kind: "ai.model-run" },
      challenge,
    }),
  });
  phase(
    "verifier",
    verifierChecks.correct === false && verifierChecks.representation === "exact",
    `${verifierUrl} refuses a bodyless artifact and names representation exact`,
  );

  // ── 3. A real RAREXT node with this challenge and verifier ───────────────
  api = spawnApi({
    PORT: "0",
    HOST: "127.0.0.1",
    RAREXT_DATA: "none",
    RAREXT_CHALLENGES: join(state, "challenges.json"),
    RAREXT_VERIFIERS: join(state, "verifiers.json"),
  });
  const base = await api.base;
  const registry = new RarextClient({ baseUrl: base });
  const health = await registry.health();
  const registered = await registry.challenge(challenge.id);
  phase(
    "registry",
    health.ok === true && registered.id === challenge.id,
    `${base} loaded ${challenge.id} (app ${registered.app})`,
  );

  // ── 4. Serve and infer through the attested gateway ──────────────────────
  const publisher = await RuntimePublisher.open({
    baseUrl: base,
    handle: "rarext-runtime",
    stateDir: state,
    challengeId: challenge.id,
  });

  // The deployment itself is a model card on RAREXT: engine, model,
  // quantization, weight digest, hardware, and the digest every run cites.
  const deploymentPublication = await publisher.publishDeployment(deployment);

  gateway = await startGateway({
    deployment,
    ledgerDir: state,
    publisher,
    port: 0,
    log: (message) => console.log(`  [runtime] ${message}`),
  });

  const prompt = "Reply with exactly: AI lives on RAREXT";
  const request = {
    model: deployment.model.id,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    seed: 42,
    max_tokens: 32,
    stream: false,
  };

  const started = Date.now();
  const completion = await fetch(`${gateway.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const completionBody = await completion.json();
  const runDigest = completion.headers.get("x-rarext-run");
  const publicationId = completion.headers.get("x-rarext-publication");
  const attested = completion.headers.get("x-rarext-attested");
  const text = extractOpenAiText(completionBody);

  phase(
    "infer",
    completion.ok && typeof text === "string" && text.length > 0 && typeof runDigest === "string",
    `${deployment.model.id} answered in ${Date.now() - started}ms: ${JSON.stringify(text.slice(0, 80))} ` +
      `(run ${String(runDigest).slice(0, 12)}…)`,
  );

  // ── 5. The node verified and stored the transcript ───────────────────────
  let publication = null;
  if (publicationId) {
    publication = await getJson(`${base}/v1/publications/${publicationId}`);
  }
  const publishedBody = publication?.artifact?.body;
  const storedDigest = publishedBody ? canonicalDigest(publishedBody) : null;
  const localRecord = new RunLedger(state).latest();
  const publicationOk =
    attested === "true" &&
    publication?.attestation?.correct === true &&
    publication?.attestation?.representation === "exact" &&
    storedDigest === runDigest &&
    localRecord?.digest === runDigest;

  phase(
    "publish",
    publicationOk,
    publicationOk
      ? `publication ${publication.id.slice(0, 8)}… attested exact; body hashes to ${String(storedDigest).slice(0, 12)}…`
      : `attested=${String(attested)} publication=${String(publicationId)} stored=${String(storedDigest).slice(0, 12)} local=${String(localRecord?.digest).slice(0, 12)}`,
  );

  // ── 5b. The deployment itself is a model card on RAREXT ──────────────────
  const deploymentPublished = await getJson(
    `${base}/v1/publications/${deploymentPublication.id}`,
  );
  const deploymentVerdict = verifyDeploymentBody(deployment, spec);
  const deploymentAttested =
    deploymentVerdict.correct === true &&
    deploymentPublished?.attestation?.correct === true &&
    deploymentPublished?.attestation?.representation === "exact" &&
    deploymentPublished?.artifact?.kind === "ai.model-deployment";
  phase(
    "deployment",
    deploymentAttested,
    deploymentAttested
      ? `manifest ${deployment.digest.slice(0, 12)}… published as ${deploymentPublication.id.slice(0, 8)}… and attested exact`
      : `local=${deploymentVerdict.correct} attested=${String(deploymentPublished?.attestation?.correct)}`,
  );

  // ── 6. Anchor both and find them in the anchored bundle ──────────────────
  const anchor = await registry.anchor();
  await sleep(100);
  const bundle = await getJson(`${base}/v1/bundles/latest`);
  const inBundle = (bundle.publications ?? []).find((entry) => entry.id === publicationId);
  const deploymentInBundle = (bundle.publications ?? []).find(
    (entry) => entry.id === deploymentPublication.id,
  );
  const bundleBody = inBundle?.artifact?.body;
  const bundleDigest = bundleBody ? canonicalDigest(bundleBody) : null;
  const anchorCovers = (bundle.anchors ?? []).some(
    (entry) =>
      entry.root === bundle.manifest?.root &&
      (entry.publicationIds ?? []).includes(publicationId) &&
      (entry.publicationIds ?? []).includes(deploymentPublication.id),
  );
  const anchorBundleDeploymentOk =
    deploymentInBundle !== undefined &&
    verifyDeploymentBody(deploymentInBundle.artifact?.body, spec).correct === true;
  phase(
    "anchor",
    inBundle !== undefined &&
      deploymentInBundle !== undefined &&
      anchorBundleDeploymentOk &&
      bundleDigest === runDigest &&
      anchorCovers &&
      /^[0-9a-f]{64}$/.test(String(anchor.root ?? "")),
    `bundle leafVersion ${bundle.manifest?.leafVersion}; root ${String(bundle.manifest?.root).slice(0, 16)}… ` +
      `covers ${String(publicationId).slice(0, 8)}… and ${deploymentPublication.id.slice(0, 8)}…; ` +
      `run body re-hashes to ${String(bundleDigest).slice(0, 12)}…`,
  );

  // ── 7. Recompute the verification from the transcript alone ──────────────
  const localVerification = verifyRunBody(bundleBody, spec);
  phase(
    "recompute",
    localVerification.correct === true &&
      localVerification.details.transcriptDigest === runDigest,
    `${localVerification.details.checks.length} checks pass; transcript ${localVerification.details.transcriptDigest.slice(0, 12)}…` +
      `; ${localVerification.details.tokensPerSecond === null ? "throughput n/a" : `${localVerification.details.tokensPerSecond.toFixed(1)} tok/s over ${localVerification.details.durationMs} ms`}`,
  );

  // ── 8. Replay the output against the live engine ─────────────────────────
  let replayOk = false;
  let replayDetail = "replay metadata absent";
  if (localRecord?.body?.replay) {
    const replayResponse = await fetch(openAiChatUrl(engineSpec.endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...localRecord.body.replay.request,
        model: deployment.model.id,
        stream: false,
      }),
    });
    if (replayResponse.ok) {
      const replayJson = await replayResponse.json();
      const replayText = extractOpenAiText(replayJson);
      replayOk = replayText === localRecord.body.response.text;
      replayDetail = replayOk
        ? `output reproduced byte for byte (${replayText.length} chars)`
        : `committed ${JSON.stringify(localRecord.body.response.text.slice(0, 60))} != replayed ${JSON.stringify(replayText.slice(0, 60))}`;
    } else {
      replayDetail = `replay HTTP ${replayResponse.status}`;
    }
  }
  phase("replay", replayOk, replayDetail);

  // ── 9. The append-only chain recomputes ──────────────────────────────────
  const ledgerVerification = new RunLedger(state).verify();
  phase(
    "ledger",
    ledgerVerification.ok === true && ledgerVerification.count >= 1,
    `${ledgerVerification.count} record(s), head ${String(ledgerVerification.head).slice(0, 16)}…`,
  );

  // ── Proof artifacts ──────────────────────────────────────────────────────
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  writeJsonFile(join(proofDir, "deployment.json"), deployment);
  writeJsonFile(join(proofDir, "challenge.json"), challenge);
  writeJsonFile(join(proofDir, "bundle.json"), bundle);
  if (localRecord) writeJsonFile(join(proofDir, "run.json"), localRecord);
  writeJsonFile(join(proofDir, "verification.json"), localVerification);
  writeJsonFile(join(proofDir, "deployment-publication.json"), deploymentPublished);
  writeFileSync(
    join(proofDir, "README.md"),
    `# AI lives on RAREXT — ${deployment.model.id}\n\n` +
      `- deployment: \`${deployment.digest}\`\n` +
      `- engine: ${deployment.engine.name} ${deployment.engine.version ?? ""}\n` +
      `- model: ${deployment.model.id} (${deployment.model.quantization ?? "unknown quantization"})\n` +
      `- weights: ${deployment.model.weightsDigest ?? "not reported"}\n` +
      `- model card: \`${deploymentPublication.id}\`\n` +
      `- run: \`${runDigest}\`\n` +
      `- throughput: ${
        localVerification.details.tokensPerSecond === null
          ? "not derivable"
          : `${localVerification.details.tokensPerSecond.toFixed(2)} tok/s over ${localVerification.details.durationMs} ms`
      }\n` +
      `- publication: \`${publicationId}\`\n` +
      `- bundle root: \`${bundle.manifest?.root}\`\n\n` +
      `Re-check offline: \`node apps/runtime/src/cli.ts verify --transcript .ai-proof/model-runtime/run.json --challenge .ai-proof/model-runtime/challenge.json\`\n`,
  );

  const failed = phases.filter((entry) => !entry.ok);
  console.log(
    failed.length === 0
      ? `\nDEMO PASSED: plan -> probe -> verifier -> registry -> deployment -> infer -> publish -> anchor -> recompute -> replay -> ledger, ` +
          `${phases.length}/${phases.length} phases verified. AI lives on RAREXT.`
      : `\nDEMO FAILED: ${failed.map((entry) => entry.name).join(", ")}`,
  );
  console.log(`proof written to ${proofDir}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error(`\nDEMO ERROR: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  try {
    if (gateway) await gateway.close();
  } catch {
    // Already closed.
  }
  for (const server of [verifier, mock?.server]) {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
  if (api) {
    api.child.kill("SIGTERM");
    const output = api.output();
    if (phases.some((entry) => !entry.ok) && output.stderr.trim() !== "") {
      console.error(`\nAPI stderr:\n${output.stderr.slice(-2000)}`);
    }
  }
  if (phases.some((entry) => !entry.ok)) {
    console.error(`state kept at ${state}`);
  } else {
    rmSync(state, { recursive: true, force: true });
  }
}
