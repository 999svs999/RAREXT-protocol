#!/usr/bin/env node
// Rehearses the public-testnet handoff on one machine.
//
//   node scripts/testnet-rehearsal.mjs [--keep] [--no-tls] [--verbose]
//
// It starts a chain node, three token-protected holders, a token-protected pin
// service, and an API over HTTPS (unless openssl is unavailable). The external
// agent uses only the public SDK, publishes and verifies a build, then the
// operator anchors it and checks the proof. The rehearsal also writes and
// reads a signed storage placement, builds a static mirror, restarts the API
// and chain on the same state, backs up and restores the registry, and verifies
// the mirror after the API is gone.
//
// It is deliberately loopback-only. DNS, firewall rules, the public certificate,
// a real chain, and external monitoring are operator handoff items this cannot
// prove for you.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createTcpServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AgentSigner,
  RarextClient,
  generateAgentKeypair,
} from "../packages/agent-sdk/src/index.ts";
import { verifyBundle as verifyWebBundle } from "../apps/web/src/verify.ts";
import { createBackup, readBackup, restoreBackup, verifyBackup, writeBackup } from "../apps/api/src/backup.ts";
import { cidV1Raw } from "../apps/api/src/adapters/content.ts";
import { decodeBytes, encodeBytes } from "../apps/api/src/erasure.ts";
import { DurabilityLedger, httpHolder } from "../apps/api/src/durability.ts";
import { signPlacement } from "../apps/api/src/placements.ts";
import { runExternalAgent } from "../examples/external-agent/agent.ts";

const root = new URL("..", import.meta.url).pathname;
const verbose = process.argv.includes("--verbose");
const keep = process.argv.includes("--keep");
const noTls = process.argv.includes("--no-tls");
const runId = randomBytes(4).toString("hex");
const work = join(root, ".data", `testnet-rehearsal-${runId}`);
const stateDir = join(work, "state");
const blobsDir = join(work, "blobs");
const chainDir = join(work, "chain");
const pinDir = join(work, "pins");
const holderDirs = [0, 1, 2].map((index) => join(work, `holder-${index}`));
const mirrorDir = join(work, "mirror");

const API_TOKEN = `api-${runId}`;
const HOLDER_TOKEN = `holder-${runId}`;
const PIN_TOKEN = `pin-${runId}`;

const children = [];
let api = null;
let chain = null;

function tail(text, limit = 12_000) {
  return text.length > limit ? text.slice(-limit) : text;
}

function start(name, script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const service = { name, child, output: "", exited: false };

  const capture = (chunk) => {
    const text = String(chunk);
    service.output = tail(service.output + text);
    if (verbose) process.stdout.write(`[${name}] ${text}`);
  };

  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("exit", () => {
    service.exited = true;
  });
  children.push(service);
  return service;
}

async function stop(service) {
  if (!service || service.exited) return;

  service.child.kill("SIGTERM");
  const timer = setTimeout(() => service.child.kill("SIGKILL"), 5_000);
  try {
    await once(service.child, "exit");
  } finally {
    clearTimeout(timer);
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(name, url, service, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  let last = "no response";

  while (Date.now() < deadline) {
    if (service.exited) {
      throw new Error(
        `${name} exited before it was ready\n${tail(service.output)}`,
      );
    }

    try {
      const response = await fetch(url, { headers: options.headers });
      last = `HTTP ${response.status}`;
      if (response.ok) return response;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`${name} was not ready at ${url}: ${last}\n${tail(service.output)}`);
}

function hasOpenssl() {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function main() {
  mkdirSync(work, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(blobsDir, { recursive: true });
  mkdirSync(chainDir, { recursive: true });
  mkdirSync(pinDir, { recursive: true });

  const tlsEnabled = !noTls && hasOpenssl();
  const certPath = join(work, "tls-cert.pem");
  const keyPath = join(work, "tls-key.pem");

  if (tlsEnabled) {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  } else if (!noTls) {
    console.log("openssl not found: exercising HTTP instead of HTTPS");
  }

  const [apiPort, chainPort, pinPort, ...holderPorts] = await Promise.all(
    Array.from({ length: 6 }, () => freePort()),
  );
  const apiBase = `${tlsEnabled ? "https" : "http"}://127.0.0.1:${apiPort}`;
  const chainBase = `http://127.0.0.1:${chainPort}`;
  const pinBase = `http://127.0.0.1:${pinPort}`;
  const holderUrls = holderPorts.map(
    (port, index) => `holder-${index}=http://127.0.0.1:${port}`,
  );
  const holderSpec = holderUrls.join(",");

  console.log(`workdir      ${work}`);
  console.log(`transport    ${tlsEnabled ? "HTTPS (self-signed)" : "HTTP (loopback only)"}`);

  const chainEnv = {
    PORT: String(chainPort),
    HOST: "127.0.0.1",
    RAREXT_CHAIN_ID: "rarex-rehearsal-1",
    RAREXT_CHAIN_KEY: join(chainDir, "key.json"),
    RAREXT_CHAIN_LOG: join(chainDir, "log.json"),
  };

  const startChain = () => start("chain", "apps/chain/src/server.ts", chainEnv);
  chain = startChain();
  await waitFor("chain", `${chainBase}/health`, chain);

  for (const [index, holderDir] of holderDirs.entries()) {
    mkdirSync(holderDir, { recursive: true });
    start(`holder-${index}`, "apps/api/src/holder-server.ts", {
      RAREXT_HOLDER_ID: `holder-${index}`,
      RAREXT_HOLDER_DIR: holderDir,
      RAREXT_HOLDER_PORT: String(holderPorts[index]),
      RAREXT_HOLDER_HOST: "127.0.0.1",
      RAREXT_HOLDER_TOKEN: HOLDER_TOKEN,
    });
  }

  for (const [index, port] of holderPorts.entries()) {
    await waitFor(
      `holder-${index}`,
      `http://127.0.0.1:${port}/v1/holder`,
      children.find((service) => service.name === `holder-${index}`),
      { headers: { authorization: `Bearer ${HOLDER_TOKEN}` } },
    );
  }

  const pin = start("pin", "apps/api/src/pin-server.ts", {
    RAREXT_PIN_DIR: pinDir,
    RAREXT_PIN_PORT: String(pinPort),
    RAREXT_PIN_TOKEN: PIN_TOKEN,
    RAREXT_PIN_GC_INTERVAL_MS: "0",
  });
  await waitFor("pin", `${pinBase}/health`, pin);

  const chainsPath = join(work, "chains.json");
  writeFileSync(
    chainsPath,
    JSON.stringify(
      {
        chains: [
          {
            id: "rarex",
            name: "RAREXT rehearsal chain",
            family: "rarext",
            chainId: "rarex-rehearsal-1",
            rpc: chainBase,
          },
        ],
      },
      null,
      2,
    ),
  );

  const apiEnv = {
    PORT: String(apiPort),
    HOST: "127.0.0.1",
    RAREXT_DATA: join(stateDir, "rarext.json"),
    RAREXT_PLACEMENTS_DIR: join(stateDir, "placements"),
    RAREXT_VERIFIER_OPERATORS_DIR: join(stateDir, "operators"),
    RAREXT_BLOB_DIR: blobsDir,
    RAREXT_CHAINS: chainsPath,
    RAREXT_HOLDERS: holderSpec,
    RAREXT_HOLDER_TOKEN: HOLDER_TOKEN,
    RAREXT_API_TOKEN: API_TOKEN,
    RAREXT_GC_INTERVAL_MS: "0",
    RAREXT_CHALLENGE_INTERVAL_MS: "86400000",
    RAREXT_PIN_URL: `${pinBase}/v1/pins`,
    RAREXT_PIN_TOKEN: PIN_TOKEN,
    ...(tlsEnabled
      ? { RAREXT_TLS_CERT: certPath, RAREXT_TLS_KEY: keyPath }
      : {}),
  };

  const startApi = () => start("api", "apps/api/src/server.ts", apiEnv);
  api = startApi();
  await waitFor("api", `${apiBase}/health`, api);

  async function apiJson(path, init = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
    }

    return text ? JSON.parse(text) : null;
  }

  const unauthorizedWrite = await fetch(`${apiBase}/v1/anchors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthorizedWrite.status, 401, "the API must reject an unauthenticated write");
  console.log("auth         unauthenticated write rejected");

  const unauthorizedHolder = await fetch(
    `http://127.0.0.1:${holderPorts[0]}/v1/holder`,
  );
  assert.equal(unauthorizedHolder.status, 401, "the holder must reject a missing token");
  console.log("auth         unauthenticated holder read rejected");

  const unauthorizedPin = await fetch(`${pinBase}/v1/pins`);
  assert.equal(unauthorizedPin.status, 401, "the pin service must reject a missing token");
  const pinBytes = Buffer.from(`RAREXT rehearsal pin ${runId}`, "utf8");
  const pinCid = cidV1Raw(pinBytes);
  const pinResponse = await fetch(`${pinBase}/v1/pins`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${PIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ cid: pinCid, content: pinBytes.toString("base64") }),
  });
  assert.equal(pinResponse.status, 201, await pinResponse.text());
  console.log("pin          token-protected pin created");

  const agent = await runExternalAgent({
    baseUrl: apiBase,
    handle: `rehearsal-${runId}`,
    apiKey: API_TOKEN,
  });
  assert.equal(agent.verified, true);
  assert.ok(agent.discovered.some((entry) => entry.id === agent.publication.id));
  console.log(`agent        published and verified ${agent.publication.id}`);

  const anchor = await apiJson("/v1/anchors", {
    method: "POST",
    body: "{}",
  });
  assert.ok(anchor.publicationIds.includes(agent.publication.id));
  assert.ok(
    anchor.receipts.some(
      (receipt) => receipt.adapter === "rarex" && receipt.status === "ok",
    ),
    `no confirmed RAREXT receipt: ${JSON.stringify(anchor.receipts)}`,
  );
  const proof = await apiJson(`/v1/anchors/${anchor.id}/proof`, {
    method: "POST",
    body: JSON.stringify({ publicationId: agent.publication.id }),
  });
  assert.equal(proof.valid, true, proof.reason ?? undefined);
  console.log(`anchor       confirmed root ${anchor.root}`);

  const chainState = await readJson(await fetch(`${chainBase}/chain/state`));
  assert.equal(chainState.height, 1);
  const chainAudit = await readJson(await fetch(`${chainBase}/chain/audit`));
  assert.equal(chainAudit.valid, true);
  const chainStatuses = await apiJson("/v1/chains/status");
  const rarexStatus = chainStatuses.find((entry) => entry.id === "rarex");
  assert.equal(rarexStatus?.details?.reachable, true, JSON.stringify(chainStatuses));
  console.log("chain        head, audit, and adapter status agree");

  const holders = holderPorts.map((port, index) =>
    httpHolder(`holder-${index}`, `http://127.0.0.1:${port}`, {
      token: HOLDER_TOKEN,
    }),
  );
  const payload = randomBytes(32 * 1024);
  const encoded = encodeBytes(payload, 2, 1);
  const placement = await new DurabilityLedger().place(encoded, holders, "durable");
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const signedPlacement = signPlacement(placement, signer);
  const recorded = await apiJson("/v1/placements", {
    method: "POST",
    body: JSON.stringify(signedPlacement),
  });
  assert.equal(recorded.status, "recorded");
  await apiJson("/v1/durability/challenge", { method: "POST", body: "{}" });
  const durability = await apiJson("/v1/durability");
  const audit = durability.audits.find(
    (entry) => entry.blobHash === placement.blobHash,
  );
  assert.equal(audit?.status, "ok", JSON.stringify(durability));

  const reconstructed = decodeBytes(
    await Promise.all(
      placement.shards.map(async (shard) => {
        const holder = holders.find((entry) => entry.id === shard.holder);
        if (!holder) throw new Error(`missing holder ${shard.holder}`);
        const bytes = await holder.get(shard.storedAs);
        if (!bytes) throw new Error(`missing shard ${shard.storedAs}`);
        return {
          index: shard.index,
          dataShards: placement.dataShards,
          parityShards: placement.parityShards,
          length: placement.length,
          payloadDigest: placement.blobHash,
          digest: shard.digest,
          bytes: Uint8Array.from(bytes),
        };
      }),
    ),
  );
  assert.ok(Buffer.from(reconstructed).equals(payload));
  console.log(`storage      placement ${placement.blobHash} audited and reconstructed`);

  const mirrorBuild = spawn(process.execPath, ["scripts/build-mirror.mjs", mirrorDir], {
    cwd: root,
    env: { ...process.env, RAREXT_API: apiBase },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let mirrorOutput = "";
  mirrorBuild.stdout.on("data", (chunk) => {
    mirrorOutput += String(chunk);
  });
  mirrorBuild.stderr.on("data", (chunk) => {
    mirrorOutput += String(chunk);
  });
  const [mirrorCode] = await once(mirrorBuild, "exit");
  if (mirrorCode !== 0) {
    throw new Error(`mirror build failed\n${tail(mirrorOutput)}`);
  }

  const readMirrorBundle = () =>
    JSON.parse(readFileSync(join(mirrorDir, "bundle.json"), "utf8"));
  const mirrorBundle = readMirrorBundle();
  assert.equal(mirrorBundle.manifest.root, anchor.root);

  async function verifyMirror(label) {
    const bundle = readMirrorBundle();
    const blobFile = JSON.parse(readFileSync(join(mirrorDir, "blobs.json"), "utf8"));
    const challenges = Object.fromEntries(
      (bundle.challenges ?? []).map((challenge) => [challenge.id, challenge.spec ?? {}]),
    );
    const blobs = Object.fromEntries(
      (blobFile.blobs ?? [])
        .filter((blob) => typeof blob.hash === "string" && typeof blob.content === "string")
        .map((blob) => [blob.hash, blob.content]),
    );
    const result = await verifyWebBundle(
      bundle,
      challenges,
      bundle.manifest.root,
      blobs,
    );
    assert.equal(result.valid, true, `${label}: ${result.reason ?? "invalid"}`);
    return bundle;
  }

  await verifyMirror("fresh mirror");
  console.log(`mirror       ${mirrorDir} verifies against the anchored root`);

  await stop(chain);
  chain = startChain();
  await waitFor("chain", `${chainBase}/health`, chain);
  const restartedState = await readJson(await fetch(`${chainBase}/chain/state`));
  const restartedAudit = await readJson(await fetch(`${chainBase}/chain/audit`));
  assert.equal(restartedState.height, chainState.height);
  assert.equal(restartedState.head, chainState.head);
  assert.equal(restartedAudit.valid, true);
  console.log("restart      chain restored the same head and verified its history");

  await stop(api);
  api = startApi();
  await waitFor("api", `${apiBase}/health`, api);
  const client = new RarextClient({ baseUrl: apiBase, apiKey: API_TOKEN });
  const recheck = await client.verify(agent.publication.id);
  assert.equal(recheck.valid, true);
  const anchorsAfterRestart = await apiJson("/v1/anchors");
  assert.ok(anchorsAfterRestart.some((entry) => entry.id === anchor.id));
  await apiJson("/v1/durability/challenge", { method: "POST", body: "{}" });
  const durabilityAfterRestart = await apiJson("/v1/durability");
  assert.equal(
    durabilityAfterRestart.audits.find(
      (entry) => entry.blobHash === placement.blobHash,
    )?.status,
    "ok",
  );
  console.log("restart      API restored the publication, anchor, and placement");

  await stop(api);
  api = null;

  const backup = createBackup(stateDir);
  const checked = verifyBackup(backup);
  assert.equal(checked.valid, true, checked.errors.join("; "));
  const backupPath = join(work, "state.backup.json.gz");
  writeBackup(backup, backupPath);
  const restoredDir = join(work, "restored-state");
  const restored = restoreBackup(readBackup(backupPath), restoredDir);
  assert.equal(restored.restored, backup.files.length);
  assert.equal(
    readFileSync(join(restoredDir, "rarext.json"), "utf8"),
    readFileSync(join(stateDir, "rarext.json"), "utf8"),
  );
  console.log(`backup       ${backup.files.length} files restored and compared`);

  await verifyMirror("mirror after API stop");
  console.log("takedown     mirror still verifies with the API stopped");

  console.log("");
  console.log("REHEARSAL OK");
  console.log("Still operator-owned: DNS, public certificate, firewall, a real chain,");
  console.log("off-host monitoring, and a drill on the actual host.");
}

let failed = false;

try {
  await main();
} catch (error) {
  failed = true;
  for (const service of children) {
    if (service.output) {
      console.error(`\n--- ${service.name} output ---\n${tail(service.output)}`);
    }
  }
  throw error;
} finally {
  await Promise.all(children.map((service) => stop(service)));

  if (keep || failed) {
    console.log(`\nworkdir kept for inspection: ${work}`);
  } else {
    rmSync(work, { recursive: true, force: true });
  }
}
