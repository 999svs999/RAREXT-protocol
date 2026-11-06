#!/usr/bin/env node
/**
 * rarext-runtime — deploy a large model behind an OpenAI/Anthropic-compatible
 * endpoint, and publish every inference as a RAREXT-verifiable transcript.
 *
 *   node apps/runtime/src/cli.ts deploy  --endpoint http://127.0.0.1:11434 --model qwen2.5:0.5b
 *   node apps/runtime/src/cli.ts verifier --port 8788
 *   node apps/runtime/src/cli.ts serve   --manifest .rarext-runtime/deployment.json --publish
 *   node apps/runtime/src/cli.ts replay  --transcript run.json --endpoint http://127.0.0.1:11434
 *   node apps/runtime/src/cli.ts verify  --transcript run.json --challenge challenges.json
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  probeEngine,
  probeEngineCatalog,
  openAiChatUrl,
  extractOpenAiText,
  pullOllamaModel,
} from "./engines.ts";
import type { PullProgress } from "./engines.ts";
import { RunLedger, writeJsonFile } from "./ledger.ts";
import {
  assessModelFit,
  buildDeployment,
  commitDeployment,
  formatBytes,
  hardwareFromHost,
  normalizeEndpoint,
  requireValidDeployment,
} from "./manifest.ts";
import { challengeFor, challengeIdFor, challengesFile, RuntimePublisher } from "./publisher.ts";
import { startGateway } from "./gateway.ts";
import { auditLedger, verifyRunBody } from "./transcript.ts";
import { discoverBundle } from "./discovery.ts";
import {
  createVerifierServer,
  runSpecFromChallenge,
  verifierConfig,
  RUNTIME_VERIFIER_MANIFEST,
} from "./verifier.ts";
import type {
  DeploymentCommitment,
  EngineName,
  HardwareBackend,
  ModelRunBody,
  ModelRunSpec,
  RunRecord,
} from "./types.ts";

const COMMANDS = [
  "plan",
  "deploy",
  "publish-deployment",
  "discover",
  "serve",
  "verifier",
  "verify",
  "replay",
  "ledger",
  "inspect",
] as const;
type Command = (typeof COMMANDS)[number];

function usage(): never {
  console.error(`rarext-runtime — AI lives on RAREXT

Usage: node apps/runtime/src/cli.ts <command> [options]

Commands:
  plan      list the engine's models and whether each fits this host's memory
  deploy    probe a local engine and write deployment.json + challenges.json + verifiers.json
  publish-deployment  publish the deployment commitment (a model card) to RAREXT
  discover  verify every model card and run in a bundle, without a server
  serve     serve the attested OpenAI/Anthropic gateway in front of a deployment
  verifier  run the HTTP verifier a RAREXT node calls
  verify    verify a transcript offline against a challenge
  replay    re-run a transcript against the live engine and compare the output
  ledger    verify an append-only run ledger
  inspect   print a manifest's digest and fields

Common options:
  --endpoint <url>      engine base URL (default http://127.0.0.1:11434 for deploy)
  --engine <name>       ollama | strata | freetoken | openai-compatible
  --model <id>          engine-native model id
  --manifest <path>     deployment.json (default .rarext-runtime/deployment.json)
  --state <dir>         runtime state directory (default .rarext-runtime)
  --backend <name>      cpu | metal | cuda | rocm | vulkan | unknown
  --device <label>      device label recorded in the manifest
  --pull                fetch a missing Ollama model before committing it
  --out <dir>           where deploy writes files (default .rarext-runtime)
  --port <n>            gateway port (default 8790) or verifier port (default 8788)
  --host <host>         bind host (default 127.0.0.1)
  --publish             publish run transcripts to RAREXT
  --registry <url>      RAREXT API base (default http://127.0.0.1:8787)
  --handle <name>       runtime publication handle (default rarext-runtime)
  --challenge <id>      challenge id to publish under (default derived from manifest)
  --transcript <path>   run record JSON for verify/replay
  --challenge <path>    challenge file for verify (same flag, disambiguated by command)
  --json                machine-readable output
`);
  process.exit(2);
}

function flag(values: Record<string, unknown>, name: string): string | undefined {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
}

function bool(values: Record<string, unknown>, name: string): boolean {
  return values[name] === true;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function specFromChallengeFile(path: string): ModelRunSpec {
  const challengeFile = readJson(path) as unknown;
  const challenge =
    typeof challengeFile === "object" && challengeFile !== null && "challenges" in challengeFile
      ? (challengeFile as { challenges: unknown[] }).challenges[0]
      : challengeFile;
  return runSpecFromChallenge(challenge);
}

function loadBody(path: string): ModelRunBody {
  let value: unknown;

  if (path.endsWith(".jsonl")) {
    // A ledger is one record per line; the latest line is the run a caller
    // usually wants to verify or replay.
    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) throw new Error(`ledger is empty: ${path}`);
    value = JSON.parse(lines[lines.length - 1]);
  } else {
    value = readJson(path);
  }

  if (typeof value === "object" && value !== null && "body" in value) {
    return (value as RunRecord).body;
  }
  return value as ModelRunBody;
}

function deploymentFrom(values: Record<string, unknown>): DeploymentCommitment {
  const manifestPath = resolve(flag(values, "manifest") ?? join(flag(values, "state") ?? ".rarext-runtime", "deployment.json"));
  const value = readJson(manifestPath) as unknown;
  const manifest = requireValidDeployment(value);
  const digest = (value as { digest?: unknown }).digest;
  return typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest)
    ? { ...manifest, digest }
    : commitDeployment(manifest);
}

async function commandPlan(values: Record<string, unknown>): Promise<number> {
  const endpoint = normalizeEndpoint(flag(values, "endpoint") ?? "http://127.0.0.1:11434");
  const engine = flag(values, "engine") as EngineName | undefined;
  const hardware = hardwareFromHost(
    (flag(values, "backend") as HardwareBackend | undefined) ?? "unknown",
    flag(values, "device") ?? null,
  );

  const catalog = await probeEngineCatalog({ endpoint, engine });
  const rows = catalog.models.map((model) => ({ model, fit: assessModelFit(model, hardware) }));

  if (bool(values, "json")) {
    console.log(JSON.stringify({ engine: catalog.engine, hardware, models: rows }, null, 2));
    return 0;
  }

  console.log(
    `engine    ${catalog.engine.name}${catalog.engine.version ? ` ${catalog.engine.version}` : ""} at ${catalog.engine.endpoint}`,
  );
  console.log(
    `hardware  ${hardware.backend}${hardware.device ? ` / ${hardware.device}` : ""} on ${hardware.os} ${hardware.arch}` +
      (hardware.memoryBytes === null ? "" : ` (${formatBytes(hardware.memoryBytes)} host memory)`),
  );

  if (rows.length === 0) {
    console.log("\nthe engine advertises no models — pull or load one first");
    return 0;
  }

  const idWidth = Math.max(5, ...rows.map(({ model }) => model.id.length));
  const quantWidth = Math.max(5, ...rows.map(({ model }) => (model.quantization ?? "-").length));
  const sizeWidth = 10;

  console.log("");
  console.log(
    `${"model".padEnd(idWidth)}  ${"quant".padEnd(quantWidth)}  ${"weights".padStart(sizeWidth)}  fit`,
  );
  for (const { model, fit } of rows) {
    console.log(
      `${model.id.padEnd(idWidth)}  ${(model.quantization ?? "-").padEnd(quantWidth)}  ` +
        `${(fit.modelBytes === null ? "?" : formatBytes(fit.modelBytes)).padStart(sizeWidth)}  ${fit.verdict}`,
    );
  }

  const notes = rows.filter(({ fit }) => fit.verdict !== "fits");
  if (notes.length > 0) {
    console.log("");
    for (const { model, fit } of notes) console.log(`${model.id}: ${fit.note}`);
  }

  return 0;
}

async function commandDeploy(values: Record<string, unknown>): Promise<number> {
  const endpoint = normalizeEndpoint(flag(values, "endpoint") ?? "http://127.0.0.1:11434");
  const engine = flag(values, "engine") as EngineName | undefined;
  const model = flag(values, "model");
  const out = resolve(flag(values, "out") ?? ".rarext-runtime");
  const backend = (flag(values, "backend") as HardwareBackend | undefined) ?? "unknown";
  const device = flag(values, "device") ?? null;

  let probe;
  try {
    probe = await probeEngine({ endpoint, engine, model });
  } catch (error) {
    if (!bool(values, "pull")) throw error;
    if (!model) {
      throw new Error("--pull needs --model so the runtime knows what to fetch");
    }
    if (engine !== undefined && engine !== "ollama") {
      throw new Error(
        `--pull is implemented for Ollama only; pull ${model} with ${engine}'s own installer, then run deploy without --pull`,
      );
    }

    console.error(`[runtime] ${model} is not loaded; pulling it from ${endpoint}`);
    let lastStatus = "";
    await pullOllamaModel({
      endpoint,
      model,
      onProgress: (progress: PullProgress) => {
        if (progress.status === lastStatus) return;
        lastStatus = progress.status;
        const bytes =
          progress.total === null
            ? ""
            : ` (${progress.completed ?? 0}/${progress.total} bytes)`;
        console.error(`[runtime] ${progress.status}${bytes}`);
      },
    });
    probe = await probeEngine({ endpoint, engine, model });
  }
  const manifest = commitDeployment(
    buildDeployment({
      probe,
      hardware: hardwareFromHost(backend, device),
      id: flag(values, "id"),
    }),
  );

  writeJsonFile(join(out, "deployment.json"), manifest);
  writeJsonFile(join(out, "challenges.json"), challengesFile(manifest));
  const verifierUrl = flag(values, "verifier-url") ?? "http://127.0.0.1:8788/verify";
  writeJsonFile(join(out, "verifiers.json"), verifierConfig(verifierUrl));
  writeJsonFile(join(out, "verifier-manifest.json"), RUNTIME_VERIFIER_MANIFEST);

  if (bool(values, "json")) {
    console.log(
      JSON.stringify(
        {
          deployment: manifest,
          challenge: challengeFor(manifest),
          challengeId: challengeIdFor(manifest),
          files: {
            deployment: join(out, "deployment.json"),
            challenges: join(out, "challenges.json"),
            verifiers: join(out, "verifiers.json"),
          },
          verifierUrl,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`deployment ${manifest.id}`);
  console.log(`  engine    ${manifest.engine.name}${manifest.engine.version ? ` ${manifest.engine.version}` : ""} at ${manifest.engine.endpoint}`);
  console.log(`  model     ${manifest.model.id}${manifest.model.quantization ? ` (${manifest.model.quantization})` : ""}`);
  console.log(`  weights   ${manifest.model.weightsDigest ?? "not reported by the engine"}`);
  console.log(`  hardware  ${manifest.hardware.backend}${manifest.hardware.device ? ` / ${manifest.hardware.device}` : ""} on ${manifest.hardware.os} ${manifest.hardware.arch}`);
  console.log(`  digest    ${manifest.digest}`);
  console.log(`\nwrote:`);
  console.log(`  ${join(out, "deployment.json")}`);
  console.log(`  ${join(out, "challenges.json")}   (RAREXT_CHALLENGES)`);
  console.log(`  ${join(out, "verifiers.json")}    (RAREXT_VERIFIERS, verifier at ${verifierUrl})`);
  console.log(`\nnext:`);
  console.log(`  node apps/runtime/src/cli.ts verifier --port 8788`);
  console.log(`  RAREXT_CHALLENGES=${join(out, "challenges.json")} RAREXT_VERIFIERS=${join(out, "verifiers.json")} node apps/api/src/server.ts`);
  console.log(`  node apps/runtime/src/cli.ts serve --manifest ${join(out, "deployment.json")} --publish`);
  return 0;
}

async function commandPublishDeployment(values: Record<string, unknown>): Promise<number> {
  const deployment = deploymentFrom(values);
  const state = resolve(flag(values, "state") ?? ".rarext-runtime");
  const registry = flag(values, "registry") ?? "http://127.0.0.1:8787";
  const handle = flag(values, "handle") ?? "rarext-runtime";
  const challengeId = flag(values, "challenge") ?? challengeIdFor(deployment);

  const publisher = await RuntimePublisher.open({
    baseUrl: registry,
    handle,
    stateDir: state,
    challengeId,
  });
  const publication = await publisher.publishDeployment(deployment);

  if (bool(values, "json")) {
    console.log(JSON.stringify(publication, null, 2));
    return 0;
  }

  console.log(`deployment ${deployment.id} published as ${publication.id.slice(0, 12)}… under ${challengeId}`);
  console.log(`  digest     ${deployment.digest}`);
  console.log(
    `  model      ${deployment.model.id}${deployment.model.quantization ? ` (${deployment.model.quantization})` : ""}`,
  );
  console.log(`  weights    ${deployment.model.weightsDigest ?? "not reported by the engine"}`);
  console.log(`  registry   ${registry}`);
  return 0;
}

async function commandDiscover(values: Record<string, unknown>): Promise<number> {
  let bundle: unknown;

  const bundlePath = flag(values, "bundle");
  if (bundlePath) {
    bundle = readJson(resolve(bundlePath));
  } else {
    const registry = (flag(values, "registry") ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
    const response = await fetch(`${registry}/v1/bundles/latest`);
    if (!response.ok) {
      throw new Error(`registry returned HTTP ${response.status} for ${registry}/v1/bundles/latest`);
    }
    bundle = (await response.json()) as unknown;
  }

  const report = discoverBundle(bundle);

  if (bool(values, "json")) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  console.log(
    `bundle root ${String(report.root ?? "").slice(0, 16)}… leafVersion ${report.leafVersion ?? "?"}`,
  );

  if (report.cards.length === 0 && report.runs.length === 0) {
    console.log("no model cards or runs in the bundle");
    return 1;
  }

  if (report.cards.length > 0) {
    const idWidth = Math.max(10, ...report.cards.map((card) => card.deploymentId.length));
    const modelWidth = Math.max(5, ...report.cards.map((card) => card.modelId.length));
    const quantWidth = Math.max(5, ...report.cards.map((card) => (card.quantization ?? "-").length));

    console.log("\nmodel cards");
    console.log(
      `${"deployment".padEnd(idWidth)}  ${"model".padEnd(modelWidth)}  ${"quant".padEnd(quantWidth)}  verdict`,
    );
    for (const card of report.cards) {
      const verdict = card.verified
        ? card.attested
          ? "verified"
          : "verified (attestation missing)"
        : "FAILED";
      console.log(
        `${card.deploymentId.padEnd(idWidth)}  ${card.modelId.padEnd(modelWidth)}  ` +
          `${(card.quantization ?? "-").padEnd(quantWidth)}  ${verdict}`,
      );
      if (card.error) console.log(`  ${card.error}`);
    }
  }

  if (report.runs.length > 0) {
    console.log("\nruns");
    for (const run of report.runs) {
      const verdict = run.verified
        ? run.attested
          ? "verified"
          : "verified (attestation missing)"
        : "FAILED";
      const speed =
        run.tokensPerSecond === null ? "" : ` ${run.tokensPerSecond.toFixed(1)} tok/s`;
      console.log(
        `  ${run.runDigest.slice(0, 16)}…  ${run.modelId}${speed}  ${verdict}`,
      );
      if (run.error) console.log(`    ${run.error}`);
    }
  }

  console.log(
    `\n${report.ok ? "PASS" : "FAIL"} — ${report.cards.length} card(s), ${report.runs.length} run(s) recomputed from the bundle`,
  );
  return report.ok ? 0 : 1;
}

async function commandServe(values: Record<string, unknown>): Promise<number> {
  const deployment = deploymentFrom(values);
  const state = resolve(flag(values, "state") ?? ".rarext-runtime");
  const publish = bool(values, "publish");
  const registry = flag(values, "registry") ?? "http://127.0.0.1:8787";
  const handle = flag(values, "handle") ?? "rarext-runtime";
  const challengeId = flag(values, "challenge") ?? challengeIdFor(deployment);

  const publisher = publish
    ? await RuntimePublisher.open({ baseUrl: registry, handle, stateDir: state, challengeId })
    : null;

  const gateway = await startGateway({
    deployment,
    ledgerDir: state,
    publisher,
    host: flag(values, "host") ?? "127.0.0.1",
    port: flag(values, "port") ? Number(flag(values, "port")) : 8790,
    log: (message) => console.error(`[runtime] ${message}`),
  });

  console.log(`rarext-runtime serving ${deployment.model.id} on ${gateway.url}`);
  console.log(`  openai     POST ${gateway.url}/v1/chat/completions`);
  console.log(`  anthropic  POST ${gateway.url}/v1/messages`);
  console.log(`  deployment GET  ${gateway.url}/v1/deployment`);
  console.log(`  runs       GET  ${gateway.url}/v1/rarext/runs`);
  console.log(`  ledger     GET  ${gateway.url}/v1/rarext/ledger`);
  console.log(`  publishing ${publisher ? `as ${handle} under ${challengeId} -> ${registry}` : "off (local ledger only)"}`);

  const stop = async () => {
    await gateway.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise<void>(() => {});
  return 0;
}

async function commandVerifier(values: Record<string, unknown>): Promise<number> {
  const server = createVerifierServer();
  const port = flag(values, "port") ? Number(flag(values, "port")) : 8788;
  const host = flag(values, "host") ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const bound = address !== null && typeof address === "object" ? address.port : port;
  console.log(`rarext model-run verifier on http://${host}:${bound}/verify`);
  console.log(JSON.stringify(verifierConfig(`http://${host}:${bound}/verify`), null, 2));
  return 0;
}

async function commandVerify(values: Record<string, unknown>): Promise<number> {
  const transcriptPath = flag(values, "transcript");
  if (!transcriptPath) throw new Error("--transcript is required");
  const body = loadBody(resolve(transcriptPath));

  const challengePath = flag(values, "challenge");
  if (!challengePath) throw new Error("--challenge is required");
  const spec = specFromChallengeFile(resolve(challengePath));
  const result = verifyRunBody(body, spec);

  if (bool(values, "json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.correct ? "PASS" : "FAIL"} — ${result.details.checks.length} checks, transcript ${result.details.transcriptDigest.slice(0, 16)}…`);
    if (result.error) console.log(`  ${result.error}`);
  }
  return result.correct ? 0 : 1;
}

async function commandReplay(values: Record<string, unknown>): Promise<number> {
  const transcriptPath = flag(values, "transcript");
  if (!transcriptPath) throw new Error("--transcript is required");
  const body = loadBody(resolve(transcriptPath));
  if (!body.replay) {
    console.error("transcript has no replay envelope (it was sampled, not deterministic)");
    return 1;
  }

  const endpoint = normalizeEndpoint(flag(values, "endpoint") ?? body.replay.endpoint);
  const request = {
    ...(body.replay.request as Record<string, unknown>),
    model: flag(values, "model") ?? body.model.id,
    stream: false,
  };

  const response = await fetch(openAiChatUrl(endpoint), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    console.error(`replay failed: HTTP ${response.status} ${await response.text()}`);
    return 1;
  }

  const json = (await response.json()) as unknown;
  const text = extractOpenAiText(json);
  const same = text === body.response.text;
  if (bool(values, "json")) {
    console.log(JSON.stringify({ same, expected: body.response.text, replayed: text }, null, 2));
  } else {
    console.log(`${same ? "PASS" : "FAIL"} — replay ${same ? "reproduced" : "did NOT reproduce"} the committed output (${text.length} chars)`);
    if (!same) {
      console.log(`  committed: ${JSON.stringify(body.response.text.slice(0, 160))}`);
      console.log(`  replayed:  ${JSON.stringify(text.slice(0, 160))}`);
    }
  }
  return same ? 0 : 1;
}

async function commandLedger(values: Record<string, unknown>): Promise<number> {
  const dir = resolve(flag(values, "state") ?? ".rarext-runtime");
  const ledger = new RunLedger(dir);
  const challengePath = flag(values, "challenge");

  // Without a challenge this is the chain check. With one, every run is also
  // verified against the deployment, so a ledger cannot mix two models under a
  // valid chain and still pass.
  const result = challengePath
    ? auditLedger(ledger.records(), specFromChallengeFile(resolve(challengePath)))
    : ledger.verify();

  if (bool(values, "json")) {
    console.log(JSON.stringify(result, null, 2));
  } else if ("runs" in result) {
    console.log(
      `${result.ok ? "PASS" : "FAIL"} — ${result.count} run(s), chain ${result.chain.ok ? "intact" : "broken"}, ` +
        `${result.runs.filter((run) => run.correct).length}/${result.runs.length} match the challenge, head ${String(result.chain.head).slice(0, 16)}…`,
    );
    for (const error of result.chain.errors) console.log(`  chain [${error.index}] ${error.reason}`);
    for (const run of result.runs) {
      if (!run.correct) console.log(`  run [${run.index}] ${run.digest.slice(0, 16)}… ${run.error ?? "does not match"}`);
    }
  } else {
    console.log(`${result.ok ? "PASS" : "FAIL"} — ${result.count} run(s), head ${String(result.head).slice(0, 16)}…`);
    for (const error of result.errors) console.log(`  [${error.index}] ${error.reason}`);
  }
  return result.ok ? 0 : 1;
}

async function commandInspect(values: Record<string, unknown>): Promise<number> {
  const deployment = deploymentFrom(values);
  console.log(JSON.stringify(deployment, null, 2));
  return 0;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      endpoint: { type: "string" },
      engine: { type: "string" },
      model: { type: "string" },
      manifest: { type: "string" },
      state: { type: "string" },
      backend: { type: "string" },
      device: { type: "string" },
      pull: { type: "boolean" },
      out: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      publish: { type: "boolean" },
      registry: { type: "string" },
      handle: { type: "string" },
      challenge: { type: "string" },
      transcript: { type: "string" },
      bundle: { type: "string" },
      "verifier-url": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });

  if (bool(values, "help")) usage();
  const command = positionals[0] as Command | undefined;
  if (!command || !COMMANDS.includes(command)) usage();

  switch (command) {
    case "plan":
      return commandPlan(values);
    case "deploy":
      return commandDeploy(values);
    case "publish-deployment":
      return commandPublishDeployment(values);
    case "discover":
      return commandDiscover(values);
    case "serve":
      return commandServe(values);
    case "verifier":
      return commandVerifier(values);
    case "verify":
      return commandVerify(values);
    case "replay":
      return commandReplay(values);
    case "ledger":
      return commandLedger(values);
    case "inspect":
      return commandInspect(values);
    default:
      usage();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
