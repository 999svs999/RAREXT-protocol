#!/usr/bin/env node
/**
 * demo-cloud-runtime.mjs — AI lives in the cloud on RAREXT.
 *
 * The same control plane as demo-model-runtime.mjs, with no local engine and no
 * model files:
 *
 *   target    probe a remote OpenAI/Anthropic-compatible endpoint
 *   plan      list its models without claiming anything about this host
 *   deploy    commit a remote deployment (placement: "remote", memory: null)
 *   registry  start a real RAREXT node with the run verifier and challenge
 *   card      publish the deployment as a model card and attest it
 *   serve     bind the attested gateway on 0.0.0.0 behind a client token
 *   infer     forward a completion to the remote engine and record the bytes
 *   publish   publish the run; the node recomputes it and attests exact
 *   weights   prove no model file exists on this host
 *   anchor    anchor the bundle that carries the card and the run
 *   discover  recompute both offline from the bundle, with no server
 *   ledger    recompute the local chain
 *
 * Set RAREXT_CLOUD_ENDPOINT to a real provider to exercise the same path
 * against the cloud. Without it, a deterministic remote *fixture* runs on
 * loopback and the demo says so: the fixture stands in for the provider's
 * server, not for local inference, and no weights are downloaded either way.
 *
 *   RAREXT_CLOUD_ENDPOINT=https://api.provider.example \
 *   RAREXT_CLOUD_MODEL=<model> \
 *   RAREXT_CLOUD_ENGINE=openai-compatible \
 *   RAREXT_CLOUD_API=openai \
 *   RAREXT_CLOUD_UPSTREAM_KEY=<key> \
 *   node scripts/demo-cloud-runtime.mjs
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { upstreamHeaders } from "../apps/runtime/src/cloud.ts";
import { canonicalDigest } from "../apps/runtime/src/digest.ts";
import { discoverBundle, verifiedRemoteDeployments } from "../apps/runtime/src/discovery.ts";
import { startGateway } from "../apps/runtime/src/gateway.ts";
import { RunLedger, writeJsonFile } from "../apps/runtime/src/ledger.ts";
import { challengeFor, challengesFile, RuntimePublisher } from "../apps/runtime/src/publisher.ts";
import { verifyDeploymentBody, verifyRunBody } from "../apps/runtime/src/transcript.ts";
import { createVerifierServer, runSpecFromChallenge, verifierConfig } from "../apps/runtime/src/verifier.ts";
import { RarextClient } from "../packages/agent-sdk/src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const state = mkdtempSync(join(tmpdir(), "rarext-cloud-runtime-"));
const proofDir = join(root, ".ai-proof", "cloud-runtime");
const keyEnv = "RAREXT_CLOUD_UPSTREAM_KEY";
const gatewayToken = "cloud-demo-client-token";

const phases = [];
function phase(name, ok, detail) {
  phases.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  return ok;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function getJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["apps/runtime/src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}

async function startCloudFixture() {
  const key = "cloud-fixture-key";
  const seen = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    seen.push({ path: url.pathname, authorization: request.headers.authorization });

    if (url.pathname.startsWith("/v1/") && request.headers.authorization !== `Bearer ${key}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "bad upstream key" } }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "rarext-cloud-fixture-1",
              object: "model",
              owned_by: "rarext-cloud-fixture",
              metadata: { family: "fixture", quantization: "FP8", contextLength: 8192 },
            },
          ],
        }),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const last = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-cloud-fixture",
          object: "chat.completion",
          created: 0,
          model: body.model ?? "rarext-cloud-fixture-1",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: `AI lives in the cloud on RAREXT: ${String(last?.content ?? "")}`,
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 8, total_tokens: 17 },
        }),
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    server,
    endpoint: `http://127.0.0.1:${port}`,
    model: "rarext-cloud-fixture-1",
    engine: "openai-compatible",
    api: "openai",
    key,
    seen,
    real: false,
  };
}

function spawnApi(env) {
  const child = spawn(process.execPath, ["apps/api/src/server.ts"], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  let onLine = null;

  child.stdout.on("data", (chunk) => {
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

  return { child, base, output: () => stderr };
}

function modelFilesIn(dir) {
  const found = [];
  const extensions = [".gguf", ".safetensors", ".bin", ".pt", ".pth", ".onnx"];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else if (extensions.some((extension) => entry.toLowerCase().endsWith(extension))) {
        found.push(relative(dir, path));
      }
    }
  };
  walk(dir);
  return found;
}

let api = null;
let gateway = null;
let verifier = null;
let fixture = null;

try {
  console.log("AI lives in the cloud on RAREXT — no local engine, no local weights\n");

  // ── 1. The remote target ─────────────────────────────────────────────────
  const realEndpoint = process.env.RAREXT_CLOUD_ENDPOINT;
  let target;
  if (realEndpoint) {
    target = {
      server: null,
      endpoint: realEndpoint,
      model: process.env.RAREXT_CLOUD_MODEL ?? "",
      engine: process.env.RAREXT_CLOUD_ENGINE ?? "openai-compatible",
      api: process.env.RAREXT_CLOUD_API ?? "openai",
      key: process.env[keyEnv] ?? "",
      seen: [],
      real: true,
    };
  } else {
    fixture = await startCloudFixture();
    target = fixture;
  }
  if (target.model === "") {
    throw new Error("RAREXT_CLOUD_ENDPOINT is set but RAREXT_CLOUD_MODEL is empty");
  }

  const auth = upstreamHeaders({ api: target.api, auth: target.api === "anthropic" ? "x-api-key" : "bearer", token: target.key || null });
  const model = target.model;

  phase(
    "target",
    true,
    `${target.real ? "remote provider" : "remote fixture (loopback test double, not local inference)"} ` +
      `${target.endpoint} speaks ${target.api}; no Ollama, no local engine`,
  );

  // ── 2. Plan without a local fit claim ────────────────────────────────────
  const plan = await runCli(
    [
      "plan",
      "--remote",
      "--endpoint",
      target.endpoint,
      "--engine",
      target.engine,
      "--upstream-api",
      target.api,
      "--upstream-key-env",
      keyEnv,
      "--json",
    ],
    { [keyEnv]: target.key },
  );
  if (plan.status !== 0) {
    throw new Error(`plan failed: ${plan.stderr || plan.stdout}\nseen: ${JSON.stringify(target.seen)}`);
  }
  const planReport = JSON.parse(plan.stdout);
  phase(
    "plan",
    planReport.placement === "remote" &&
      planReport.hardware === null &&
      planReport.models.every((entry) => entry.fit === null),
    `${planReport.models.length} remote model(s), no host-memory verdict; local hardware is not in the decision`,
  );

  // ── 3. Deploy the remote endpoint through the real CLI ───────────────────
  const deployArgs = [
    "deploy",
    "--remote",
    "--endpoint",
    target.endpoint,
    "--engine",
    target.engine,
    "--model",
    model,
    "--upstream-api",
    target.api,
    "--upstream-key-env",
    keyEnv,
    "--out",
    state,
    "--json",
  ];
  if (!target.real) deployArgs.push("--allow-loopback");
  const deployed = await runCli(deployArgs, { [keyEnv]: target.key });
  if (deployed.status !== 0) {
    throw new Error(`deploy failed: ${deployed.stderr || deployed.stdout}`);
  }
  const deployment = JSON.parse(deployed.stdout).deployment;

  phase(
    "deploy",
    deployment.placement === "remote" &&
      deployment.hardware.backend === "cloud" &&
      deployment.hardware.memoryBytes === null &&
      deployment.engine.endpoint.replace(/\/$/, "") === target.endpoint.replace(/\/$/, ""),
    `${model} committed as ${deployment.digest.slice(0, 16)}…; placement ${deployment.placement}, ` +
      `hardware ${deployment.hardware.backend}, memory ${String(deployment.hardware.memoryBytes)}`,
  );

  writeJsonFile(join(state, "challenge.json"), challengeFor(deployment));

  // ── 4. The verifier a registry calls ─────────────────────────────────────
  verifier = createVerifierServer();
  await new Promise((resolve) => verifier.listen(0, "127.0.0.1", resolve));
  const verifierUrl = `http://127.0.0.1:${verifier.address().port}/verify`;
  writeJsonFile(join(state, "verifiers.json"), verifierConfig(verifierUrl));
  const challenge = challengeFor(deployment);
  const spec = runSpecFromChallenge(challenge);

  const verifierChecks = await getJson(verifierUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artifact: { app: "ai-model-run", kind: "ai.model-run" }, challenge }),
  });
  phase(
    "verifier",
    verifierChecks.correct === false && verifierChecks.representation === "exact",
    `${verifierUrl} refuses a bodyless artifact and names representation exact`,
  );

  // ── 5. A real RAREXT node with the challenge and verifier ────────────────
  api = spawnApi({
    PORT: "0",
    HOST: "127.0.0.1",
    RAREXT_DATA: "none",
    RAREXT_CHALLENGES: join(state, "challenges.json"),
    RAREXT_VERIFIERS: join(state, "verifiers.json"),
  });
  const baseUrl = await api.base;
  const registry = new RarextClient({ baseUrl });
  const health = await registry.health();
  const registered = await registry.challenge(challenge.id);
  phase(
    "registry",
    health.ok === true && registered.id === challenge.id,
    `${baseUrl} loaded ${challenge.id} (app ${registered.app})`,
  );

  const publisher = await RuntimePublisher.open({
    baseUrl,
    handle: "rarext-cloud-runtime",
    stateDir: state,
    challengeId: challenge.id,
  });

  // ── 6. The deployment is a model card, not a local process ───────────────
  const card = await publisher.publishDeployment(deployment);
  const cardPublished = await getJson(`${baseUrl}/v1/publications/${card.id}`);
  const cardVerdict = verifyDeploymentBody(cardPublished?.artifact?.body, spec);
  phase(
    "card",
    cardVerdict.correct === true &&
      cardPublished?.attestation?.correct === true &&
      cardPublished?.artifact?.body?.placement === "remote",
    `model card ${card.id.slice(0, 8)}… attests remote placement and ${deployment.model.id}`,
  );

  // ── 7. Serve the gateway on a public bind with a client token ────────────
  gateway = await startGateway({
    deployment,
    ledgerDir: state,
    publisher,
    host: "0.0.0.0",
    port: 0,
    publicUrl: "https://cloud.rarext.example",
    gatewayToken,
    upstreamApi: target.api,
    upstreamHeaders: auth,
    log: (message) => console.log(`  [runtime] ${message}`),
  });
  const localGateway = `http://127.0.0.1:${gateway.port}`;
  const gatewayHealth = await getJson(`${localGateway}/health`);
  const denied = await fetch(`${localGateway}${target.api === "anthropic" ? "/v1/messages" : "/v1/chat/completions"}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "should not run" }] }),
  });
  phase(
    "serve",
    gatewayHealth.placement === "remote" &&
      gatewayHealth.auth.gateway === true &&
      gatewayHealth.auth.upstream === true &&
      denied.status === 401,
    `bound 0.0.0.0:${gateway.port} as ${gateway.url}; remote placement; an unauthenticated call is refused`,
  );

  // ── 8. Infer through the gateway to the remote engine ────────────────────
  const prompt = "Reply with exactly: AI lives in the cloud on RAREXT";
  const requestBody =
    target.api === "anthropic"
      ? {
          model,
          max_tokens: 32,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        }
      : {
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          seed: 42,
          max_tokens: 32,
          stream: false,
        };

  const started = Date.now();
  const completion = await fetch(
    `${localGateway}${target.api === "anthropic" ? "/v1/messages" : "/v1/chat/completions"}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify(requestBody),
    },
  );
  const completionBody = await completion.json();
  const text =
    target.api === "anthropic"
      ? String(completionBody?.content?.[0]?.text ?? "")
      : String(completionBody?.choices?.[0]?.message?.content ?? "");
  const runDigest = completion.headers.get("x-rarext-run");
  const publicationId = completion.headers.get("x-rarext-publication");
  const attested = completion.headers.get("x-rarext-attested");

  phase(
    "infer",
    completion.ok && text.length > 0 && typeof runDigest === "string",
    `${model} answered in ${Date.now() - started}ms: ${JSON.stringify(text.slice(0, 80))} ` +
      `(run ${String(runDigest).slice(0, 12)}…)`,
  );

  // ── 9. The node verified and stored the run ──────────────────────────────
  const publication = publicationId ? await getJson(`${baseUrl}/v1/publications/${publicationId}`) : null;
  const publishedBody = publication?.artifact?.body;
  const storedDigest = publishedBody ? canonicalDigest(publishedBody) : null;
  const localRecord = new RunLedger(state).latest();
  phase(
    "publish",
    attested === "true" &&
      publication?.attestation?.correct === true &&
      publication?.attestation?.representation === "exact" &&
      storedDigest === runDigest &&
      localRecord?.digest === runDigest,
    publication
      ? `publication ${publication.id.slice(0, 8)}… attested exact; body hashes to ${String(storedDigest).slice(0, 12)}…`
      : `attested=${String(attested)} publication=${String(publicationId)}`,
  );

  // ── 10. No model file ever landed here ───────────────────────────────────
  const localWeights = modelFilesIn(state);
  phase(
    "weights",
    localWeights.length === 0 &&
      deployment.placement === "remote" &&
      deployment.hardware.memoryBytes === null &&
      (target.real || target.seen.some((entry) => entry.authorization === `Bearer ${target.key}`)),
    localWeights.length === 0
      ? `no .gguf/.safetensors/.bin/.pt/.onnx file under ${state}; ` +
          `weightsDigest ${deployment.model.weightsDigest ?? "not reported by the provider"}`
      : `local model files found: ${localWeights.join(", ")}`,
  );

  // ── 11. Anchor the card and the run, then find them in the bundle ────────
  const anchored = await runCli(["anchor", "--registry", baseUrl, "--json"]);
  if (anchored.status !== 0) {
    throw new Error(`anchor failed: ${anchored.stderr || anchored.stdout}`);
  }
  const anchor = JSON.parse(anchored.stdout);
  await sleep(100);
  const bundle = await getJson(`${baseUrl}/v1/bundles/latest`);
  const runInBundle = (bundle.publications ?? []).find((entry) => entry.id === publicationId);
  const cardInBundle = (bundle.publications ?? []).find((entry) => entry.id === card.id);
  const anchorCovers = (bundle.anchors ?? []).some(
    (entry) =>
      entry.root === bundle.manifest?.root &&
      (entry.publicationIds ?? []).includes(publicationId) &&
      (entry.publicationIds ?? []).includes(card.id),
  );
  phase(
    "anchor",
    runInBundle !== undefined &&
      cardInBundle !== undefined &&
      anchorCovers &&
      /^[0-9a-f]{64}$/.test(String(anchor.root ?? "")),
    `bundle root ${String(bundle.manifest?.root).slice(0, 16)}… covers ${String(publicationId).slice(0, 8)}… ` +
      `and card ${card.id.slice(0, 8)}…`,
  );

  // ── 12. A stranger recomputes the bundle with no server ──────────────────
  writeJsonFile(join(state, "bundle.json"), bundle);
  const discovery = discoverBundle(bundle);
  const offline = await runCli(["discover", "--bundle", join(state, "bundle.json"), "--json"]);
  const offlineReport = offline.status === 0 ? JSON.parse(offline.stdout) : null;
  phase(
    "discover",
    discovery.ok === true &&
      discovery.cards.length === 1 &&
      discovery.runs.length === 1 &&
      discovery.cards[0]?.placement === "remote" &&
      offlineReport?.ok === true,
    `offline discovery recomputed 1 card and 1 run from root ${String(discovery.root).slice(0, 16)}…; ` +
      `the CLI exits 0 with no registry reachable`,
  );

  // ── 13. RAREXT itself lists the cloud model, with no provider probe ──────
  const catalog = await runCli(["plan", "--registry", baseUrl, "--json"]);
  const catalogReport = catalog.status === 0 ? JSON.parse(catalog.stdout) : null;
  const listed = catalogReport?.cards?.find(
    (entry) => entry.deploymentDigest === deployment.digest,
  );
  phase(
    "catalog",
    catalogReport?.placement === "remote" &&
      listed?.modelId === model &&
      String(listed?.endpoint ?? "").replace(/\/$/, "") === target.endpoint.replace(/\/$/, ""),
    `RAREXT listed ${model} at ${listed?.endpoint ?? "?"} from the anchored bundle; no local probe`,
  );

  // ── 14. A second control plane adopts the card from the bundle alone ─────
  const adopted = verifiedRemoteDeployments(bundle).deployments.find(
    (entry) => entry.deployment.digest === deployment.digest,
  );
  const adoptDir = join(state, "adopted");
  mkdirSync(adoptDir, { recursive: true });
  let adoptedText = "";
  if (adopted) {
    const port = await freePort();
    const served = spawn(
      process.execPath,
      [
        "apps/runtime/src/cli.ts",
        "serve",
        "--bundle",
        join(state, "bundle.json"),
        "--deployment",
        adopted.deployment.digest,
        "--state",
        adoptDir,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--gateway-token-env",
        "RAREXT_CLOUD_GATEWAY_TOKEN",
        "--upstream-key-env",
        keyEnv,
      ],
      {
        cwd: root,
        env: { ...process.env, [keyEnv]: target.key, RAREXT_CLOUD_GATEWAY_TOKEN: gatewayToken },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let servedOutput = "";
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`serve did not start within 15s: ${servedOutput}`)),
          15_000,
        );
        served.stdout.on("data", (chunk) => {
          servedOutput += chunk;
          if (servedOutput.includes("rarext-runtime serving")) {
            clearTimeout(timer);
            resolve();
          }
        });
        served.stderr.on("data", (chunk) => {
          servedOutput += chunk;
        });
        served.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        served.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`serve exited ${code}: ${servedOutput}`));
        });
      });

      const adoptedResponse = await fetch(
        `http://127.0.0.1:${port}${target.api === "anthropic" ? "/v1/messages" : "/v1/chat/completions"}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${gatewayToken}`,
          },
          body: JSON.stringify(
            target.api === "anthropic"
              ? {
                  model: adopted.deployment.model.id,
                  max_tokens: 32,
                  temperature: 0,
                  messages: [{ role: "user", content: "adopted from the bundle" }],
                }
              : {
                  model: adopted.deployment.model.id,
                  messages: [{ role: "user", content: "adopted from the bundle" }],
                  temperature: 0,
                  seed: 43,
                  max_tokens: 32,
                  stream: false,
                },
          ),
        },
      );
      const adoptedBody = await adoptedResponse.json();
      adoptedText =
        target.api === "anthropic"
          ? String(adoptedBody?.content?.[0]?.text ?? "")
          : String(adoptedBody?.choices?.[0]?.message?.content ?? "");
    } finally {
      served.kill("SIGTERM");
      await new Promise((resolve) => served.on("close", resolve));
    }
  }
  phase(
    "adopt",
    adopted !== undefined &&
      adoptedText.length > 0 &&
      adopted.deployment.placement === "remote" &&
      adopted.deployment.hardware.memoryBytes === null,
    adopted
      ? `the CLI served ${adopted.deployment.model.id} from bundle root ` +
          `${String(bundle.manifest?.root).slice(0, 16)}… and forwarded without a local deployment file`
      : "the bundle did not yield a verified remote card",
  );

  // ── 14. Recompute the transcript from the bundle alone ───────────────────
  const localVerification = verifyRunBody(runInBundle?.artifact?.body, spec);
  phase(
    "recompute",
    localVerification.correct === true && localVerification.details.transcriptDigest === runDigest,
    `${localVerification.details.checks.length} checks pass; transcript ${localVerification.details.transcriptDigest.slice(0, 12)}…` +
      `; ${localVerification.details.tokensPerSecond === null ? "throughput n/a" : `${localVerification.details.tokensPerSecond.toFixed(1)} tok/s`}`,
  );

  // ── 14. The local chain recomputes ───────────────────────────────────────
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
  writeJsonFile(join(proofDir, "deployment-publication.json"), cardPublished);
  writeJsonFile(join(proofDir, "discovery.json"), discovery);
  writeJsonFile(join(proofDir, "catalog.json"), catalogReport ?? { error: "catalog failed" });
  writeJsonFile(
    join(proofDir, "adopted.json"),
    adopted
      ? {
          adopted: true,
          from: `bundle:${bundle.manifest?.root}`,
          deployment: adopted.deployment.digest,
          model: adopted.deployment.model.id,
          endpoint: adopted.deployment.engine.endpoint,
          forwarded: adoptedText.length > 0,
        }
      : { adopted: false, reason: "no verified remote card in the bundle" },
  );
  writeJsonFile(join(proofDir, "cloud.json"), {
    endpoint: target.endpoint,
    real: target.real,
    engine: target.engine,
    api: target.api,
    model,
    gateway: gateway.url,
    placement: deployment.placement,
    localWeights,
    upstreamAuthUsed: target.real ? null : target.seen.some((entry) => entry.authorization === `Bearer ${target.key}`),
  });
  writeFileSync(
    join(proofDir, "README.md"),
    `# AI lives in the cloud on RAREXT — ${deployment.model.id}\n\n` +
      `- deployment: \`${deployment.digest}\`\n` +
      `- placement: ${deployment.placement}\n` +
      `- remote engine: ${deployment.engine.name} at ${deployment.engine.endpoint}\n` +
      `- model: ${deployment.model.id} (${deployment.model.quantization ?? "unknown quantization"})\n` +
      `- weights: ${deployment.model.weightsDigest ?? "not reported by the provider"}\n` +
      `- local model files: ${localWeights.length === 0 ? "none" : localWeights.join(", ")}\n` +
      `- model card: \`${card.id}\`\n` +
      `- run: \`${runDigest}\`\n` +
      `- publication: \`${publicationId}\`\n` +
      `- bundle root: \`${bundle.manifest?.root}\`\n` +
      `- catalog: \`${listed?.modelId ?? "not listed"}\` at \`${listed?.endpoint ?? "?"}\`\n` +
      `- adopted from bundle: ${adopted ? `yes, forwarded \`${adopted.deployment.digest.slice(0, 16)}…\`` : "no"}\n\n` +
      `Re-check offline: \`node apps/runtime/src/cli.ts discover --bundle .ai-proof/cloud-runtime/bundle.json\`\n`,
  );

  const failed = phases.filter((entry) => !entry.ok);
  console.log(
    failed.length === 0
      ? `\nDEMO PASSED: target -> plan -> deploy -> verifier -> registry -> card -> serve -> infer -> publish -> ` +
          `weights -> anchor -> discover -> catalog -> adopt -> recompute -> ledger, ${phases.length}/${phases.length} phases verified. ` +
          "AI lives in the cloud on RAREXT."
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
  for (const server of [verifier, fixture?.server]) {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
  if (api) {
    api.child.kill("SIGTERM");
    if (phases.some((entry) => !entry.ok)) {
      const stderr = api.output();
      if (stderr.trim() !== "") console.error(`\nAPI stderr:\n${stderr.slice(-2000)}`);
    }
  }
  if (phases.some((entry) => !entry.ok)) {
    console.error(`state kept at ${state}`);
  } else {
    rmSync(state, { recursive: true, force: true });
  }
}
