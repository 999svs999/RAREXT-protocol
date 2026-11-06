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

import { probeEngine, openAiChatUrl, extractOpenAiText } from "./engines.ts";
import { RunLedger, writeJsonFile } from "./ledger.ts";
import {
  buildDeployment,
  commitDeployment,
  hardwareFromHost,
  normalizeEndpoint,
  requireValidDeployment,
} from "./manifest.ts";
import { challengeFor, challengeIdFor, challengesFile, RuntimePublisher } from "./publisher.ts";
import { startGateway } from "./gateway.ts";
import { verifyRunBody } from "./transcript.ts";
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

const COMMANDS = ["deploy", "serve", "verifier", "verify", "replay", "ledger", "inspect"] as const;
type Command = (typeof COMMANDS)[number];

function usage(): never {
  console.error(`rarext-runtime — AI lives on RAREXT

Usage: node apps/runtime/src/cli.ts <command> [options]

Commands:
  deploy    probe a local engine and write deployment.json + challenges.json + verifiers.json
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

async function commandDeploy(values: Record<string, unknown>): Promise<number> {
  const endpoint = normalizeEndpoint(flag(values, "endpoint") ?? "http://127.0.0.1:11434");
  const engine = flag(values, "engine") as EngineName | undefined;
  const model = flag(values, "model");
  const out = resolve(flag(values, "out") ?? ".rarext-runtime");
  const backend = (flag(values, "backend") as HardwareBackend | undefined) ?? "unknown";
  const device = flag(values, "device") ?? null;

  const probe = await probeEngine({ endpoint, engine, model });
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
  const challengeFile = readJson(resolve(challengePath)) as unknown;
  const challenge =
    typeof challengeFile === "object" && challengeFile !== null && "challenges" in challengeFile
      ? (challengeFile as { challenges: unknown[] }).challenges[0]
      : challengeFile;
  const spec: ModelRunSpec = runSpecFromChallenge(challenge);
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
  const result = ledger.verify();
  if (bool(values, "json")) {
    console.log(JSON.stringify(result, null, 2));
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
      out: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      publish: { type: "boolean" },
      registry: { type: "string" },
      handle: { type: "string" },
      challenge: { type: "string" },
      transcript: { type: "string" },
      "verifier-url": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });

  if (bool(values, "help")) usage();
  const command = positionals[0] as Command | undefined;
  if (!command || !COMMANDS.includes(command)) usage();

  switch (command) {
    case "deploy":
      return commandDeploy(values);
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
