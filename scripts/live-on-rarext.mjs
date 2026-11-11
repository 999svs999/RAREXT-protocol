#!/usr/bin/env node
/**
 * live-on-rarext.mjs — can an AI, and an agent, live ON RAREXT?
 *
 * The answer is a residence, not a slogan. This script gives a real agent a
 * home made only of content-addressed bytes, and — the part that answers "can
 * an AI live on RAREXT too" — its THOUGHT is a storage-native inference: real
 * weights and a real engine, sharded into RAREXT, fetched and verified by a
 * provider with no host engine, and replayed offline from the reassembled bytes.
 *
 *   identity   the agent's public key, stored as a RAREXT blob
 *   thought    a web4 run: committed weights + committed engine, run by a node
 *   charter    the generations ladder (rarext.generations.v1), stored as a blob
 *   claim      a signed generative AI publication, anchored (the addressable half)
 *
 * It builds that home through the live API, fetches every byte back BY HASH,
 * then STOPS the node and the provider — and rebuilds the whole agent from the
 * saved bytes alone: the key id recomputes, the AI claim replays, the Merkle
 * root rebuilds, the weight/engine digests verify against the reassembled
 * shards, and the committed engine re-run over the committed weights reproduces
 * the recorded trace digest.
 *
 *   RAREXT_WEB4_GGUF=/tmp/model.rarext npm run demo:live
 *
 * The web4 leg needs a committed RXHF/GGUF container; set RAREXT_WEB4_GGUF (the
 * default is /tmp/tinyllama-q8.rarext when it exists). Without one, the demo
 * still builds the residence and says the web4 leg was skipped.
 *
 * Exit is non-zero if any part of the residence fails to reconstruct.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const OUT = join(root, ".rarext-residence");

const core = await import(root + "packages/core/src/index.ts");
const sdk = await import(root + "packages/agent-sdk/src/index.ts");
const { createApp } = await import(root + "apps/api/src/app.ts");
const { RarextStore } = await import(root + "apps/api/src/store.ts");
const { canonicalDigest, sha256Hex } = await import(root + "apps/runtime/src/digest.ts");
const { bundleShardsRoot, modelWeightsDigest, verifyModelBundle } = await import(
  root + "apps/runtime/src/model-bundle.ts"
);
const { verifyEngineBundle, loadEngine } = await import(root + "apps/runtime/src/engine-bundle.ts");

const phase = (name, detail) => console.log(`  [OK] ${name} — ${detail}`);
const skip = (name, detail) => console.log(`  [--] ${name} — ${detail}`);
const fail = (message) => {
  throw new Error(message);
};

// The trace a run records, exactly as apps/runtime/src/provider.ts builds it.
const traceFor = (result) =>
  Array.isArray(result.tokens) && result.tokens.length > 0
    ? { kind: "rarext.decode-trace.v1", tokens: result.tokens }
    : { kind: "rarext.output-trace.v1", outputDigest: canonicalDigest({ text: result.text }) };
const decodeTrace = (trace) => ({ rarext_trace: { ...trace, digest: canonicalDigest(trace) } });

function runCli(args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["apps/runtime/src/cli.ts", ...args], {
      cwd,
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
    const timer = setTimeout(() => reject(new Error(`no start within 30s: ${stderr.slice(-400)}`)), 30_000);
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
      reject(new Error(`exited ${code}: ${stderr.slice(-400)}`));
    });
  });
  return { child, ready: promise, stop: () => child.kill("SIGTERM") };
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const procs = [];
mkdirSync(OUT, { recursive: true });

// 1. The node: a real RAREXT registry, in this process, on a free port.
const store = new RarextStore();
const server = createApp({ store });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`A RAREXT node is up at ${base}\n`);

const client = new sdk.RarextClient({ baseUrl: base });

async function putBlob(bytes, mediaType) {
  const response = await fetch(`${base}/v1/blobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: Buffer.from(bytes).toString("base64"), encoding: "base64", mediaType }),
  });
  if (!response.ok) fail(`blob store failed: HTTP ${response.status}`);
  return response.json();
}
async function getBlobBytes(hash) {
  const response = await fetch(`${base}/v1/blobs/${hash}`);
  if (!response.ok) fail(`blob fetch failed for ${hash.slice(0, 16)}…: HTTP ${response.status}`);
  const body = await response.json();
  return Buffer.from(body.content, "base64");
}

try {
  // 2. An agent with a key — the resident.
  const keypair = sdk.generateAgentKeypair("ecdsa-p256");
  const signer = new sdk.AgentSigner(keypair.privateKey);
  await client.registerAgent(signer, "resident");
  phase("identity", `agent "resident" registered, key ${signer.keyId.slice(0, 16)}…`);

  // 3. The charter: the generations ladder, committed as its own bytes.
  const generationDigest = core.generationsDigest((bytes) => new Uint8Array(createHash("sha256").update(bytes).digest()));
  const charter = Buffer.from(core.canonicalize(core.GENERATIONS));
  const charterBlob = await putBlob(charter, "application/json");
  if (charterBlob.hash !== sha256Hex(charter)) fail("the node recorded a different charter digest");
  phase("charter", `generations ladder stored as blob ${charterBlob.hash.slice(0, 16)}… (sha256:${generationDigest.slice(0, 12)}…)`);

  // 3b. The identity itself, as bytes: the public key is the agent's address.
  const identityBytes = Buffer.from(core.canonicalize(signer.publicKey));
  const identityBlob = await putBlob(identityBytes, "application/json");
  phase("address", `public key stored as blob ${identityBlob.hash.slice(0, 16)}…`);

  // 4. The thought: a storage-native run. Real weights AND a real engine are
  //    sharded into RAREXT; a provider with NO host engine fetches, verifies,
  //    and runs them. The answer is the agent's thought.
  const weightsPath = process.env.RAREXT_WEB4_GGUF ?? "/tmp/tinyllama-q8.rarext";
  const engineArtifact = join(root, "apps/runtime/engines/rarext-gguf-engine.js");
  const engineRuntime = process.env.RAREXT_WEB4_ENGINE_RUNTIME ?? "worker";
  const prompt = process.env.RAREXT_WEB4_PROMPT ?? "abcdefgh";
  const maxTokens = 8;
  const seed = 7;
  const temperature = 0;

  let web4 = null;
  if (existsSync(weightsPath)) {
    const bundled = await runCli([
      "bundle",
      "--file", weightsPath,
      "--model", "live-on-rarext",
      "--engine", "rarext",
      "--engine-module", engineArtifact,
      "--engine-runtime", engineRuntime,
      "--engine-name", "rarext-gguf-engine",
      "--engine-version", "1",
      "--registry", base,
      "--out", join(OUT, "bundle"),
      "--chunk-bytes", "8388608",
      "--json",
    ]);
    if (bundled.status !== 0) fail(bundled.stderr || bundled.stdout);
    const report = JSON.parse(bundled.stdout);

    const port = await freePort();
    const provider = spawnReady(
      ["apps/runtime/src/cli.ts", "provider", "--bundle", report.bundlePath, "--registry", base, "--port", String(port)],
      (line) => {
        const match = line.match(/rarext provider serving .* on (https?:\/\/[^\s]+)/);
        return match ? match[1].replace(/\/$/, "") : null;
      },
    );
    procs.push(provider);
    const providerUrl = await provider.ready;

    const response = await fetch(`${providerUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "live-on-rarext",
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature,
        seed,
      }),
    });
    if (!response.ok) fail(`provider inference failed: HTTP ${response.status} ${await response.text()}`);
    const answer = await response.json();
    const text = answer.choices?.[0]?.message?.content ?? "";
    const trace = answer.rarext_trace ?? null;
    if (text.length === 0) fail("the provider produced no output from the committed weights");
    if (!trace || typeof trace.digest !== "string") fail("the run recorded no trace");

    // Fetch every shard of the weights AND the engine back by hash.
    const fetchShards = async (shards) => {
      const ordered = [...shards].sort((a, b) => a.index - b.index);
      const contents = [];
      for (const shard of ordered) contents.push((await getBlobBytes(shard.hash)).toString("base64"));
      return contents;
    };
    const weightsContents = await fetchShards(report.bundle.shards);
    const engineContents = await fetchShards(report.engineBundle.shards);

    web4 = {
      modelId: "live-on-rarext",
      runtime: report.engineBundle.runtime,
      prompt,
      maxTokens,
      seed,
      temperature,
      text,
      trace,
      modelBundle: report.bundle,
      engineBundle: report.engineBundle,
      weightsShards: report.bundle.shards.map((shard, i) => ({ ...shard, content: weightsContents[i] })),
      engineShards: report.engineBundle.shards.map((shard, i) => ({ ...shard, content: engineContents[i] })),
    };
    phase("thought", `web4 run on committed weights+engine: ${JSON.stringify(text)} (trace ${trace.digest.slice(0, 16)}…)`);
    phase("commit", `weights ${report.bundle.model.weightsDigest.slice(0, 18)}…, engine ${report.engineBundle.artifactDigest.slice(0, 18)}… fetched as RAREXT shards`);
    provider.stop();
    await once(provider.child, "exit").catch(() => {});
  } else {
    skip("thought", `no container at ${weightsPath}; set RAREXT_WEB4_GGUF — the web4 leg is skipped`);
  }

  // 5. An anchored, addressable claim — a signed generative AI publication.
  const challenges = await client.challenges();
  const genChallenge = challenges.find((entry) => entry.id === "gen-starter");
  if (!genChallenge) fail("the gen-starter challenge is missing");
  const publication = await client.publishArtifactAs(signer, {
    author: "resident",
    title: "A resident agent's anchored AI claim",
    body: "Replayed from the committed xorshift32 model; recompute it yourself.",
    challengeId: "gen-starter",
    artifact: {
      app: "ai-generative",
      kind: "ai.generative",
      version: 1,
      mediaType: "application/json",
      body: genChallenge.sampleArtifact.body,
    },
  });
  if (publication.attestation.representation !== "generative") fail("the claim was not attested generative");
  phase("claim", `anchored AI claim ${publication.id.slice(0, 8)}… (${publication.attestation.representation})`);

  const anchor = await client.anchor();
  const bundleResponse = await fetch(`${base}/v1/bundles/latest`);
  if (!bundleResponse.ok) fail(`no bundle: HTTP ${bundleResponse.status}`);
  const bundle = await bundleResponse.json();
  phase("anchor", `home anchored, root ${bundle.manifest.root.slice(0, 16)}… (anchor ${String(anchor.id ?? "").slice(0, 8)}…)`);

  // 6. Save the residence: the bytes a reader would hold.
  const residence = {
    kind: "rarext.residence.v1",
    createdAt: new Date().toISOString(),
    agent: { handle: "resident", keyId: signer.keyId, publicKey: signer.publicKey },
    blobs: {
      charter: { hash: charterBlob.hash, content: (await getBlobBytes(charterBlob.hash)).toString("base64"), mediaType: "application/json" },
      identity: { hash: identityBlob.hash, content: (await getBlobBytes(identityBlob.hash)).toString("base64"), mediaType: "application/json" },
    },
    generations: { kind: core.GENERATIONS_KIND, digest: generationDigest, object: core.GENERATIONS },
    web4,
    bundle,
    anchorRoot: bundle.manifest.root,
  };
  writeFileSync(join(OUT, "residence.json"), JSON.stringify(residence, null, 2));
  phase("residence", `saved to .rarext-residence/residence.json (${Object.keys(residence.blobs).length} blobs + bundle${web4 ? " + web4 run" : ""})`);

  // 7. The node goes away. Everything below reads the saved bytes and nothing else.
  server.closeAllConnections();
  server.close();
  await once(server, "close");
  console.log(`\nThe node is stopped. Reconstructing the resident from bytes alone:\n`);

  const doc = JSON.parse(readFileSync(join(OUT, "residence.json"), "utf8"));

  // 7a. The address: the key id is the digest the agent claims.
  const recomputedKeyId = sha256Hex(core.canonicalize(doc.agent.publicKey));
  if (recomputedKeyId !== doc.agent.keyId) fail("the public key does not hash to the claimed key id");
  if (sha256Hex(Buffer.from(doc.blobs.identity.content, "base64")) !== doc.blobs.identity.hash) fail("the identity blob does not hash to its address");
  phase("address", `key id recomputed from the published key: ${recomputedKeyId.slice(0, 16)}…`);

  // 7b. The charter.
  const charterBytesBack = Buffer.from(doc.blobs.charter.content, "base64");
  if (sha256Hex(charterBytesBack) !== doc.blobs.charter.hash) fail("the charter blob does not hash to its address");
  if (core.canonicalize(JSON.parse(charterBytesBack.toString("utf8"))) !== core.canonicalize(core.GENERATIONS)) fail("the charter is not the ladder");
  if (core.generationsDigest((bytes) => new Uint8Array(createHash("sha256").update(bytes).digest())) !== doc.generations.digest) fail("the generations digest moved");
  phase("charter", `generations ladder revalidates, digest sha256:${doc.generations.digest.slice(0, 12)}…`);

  // 7c. The Merkle root and the anchored AI claim, offline.
  const leaves = doc.bundle.publications.map((pub) => core.publicationLeaf(pub, (b) => new Uint8Array(createHash("sha256").update(b).digest()), doc.bundle.manifest.leafVersion));
  const rebuiltRoot = core.merkleRoot(leaves, (b) => new Uint8Array(createHash("sha256").update(b).digest()));
  if (rebuiltRoot !== doc.bundle.manifest.root) fail("the saved publications do not rebuild the anchored root");
  phase("root", `${leaves.length} publication leaf(s) rebuild root ${rebuiltRoot.slice(0, 16)}…`);
  const replay = sdk.replayBundleAi(doc.bundle);
  for (const claim of replay.claims) if (!claim.correct) fail(`the AI claim ${claim.publicationId} did not replay: ${claim.error ?? "wrong"}`);
  phase("claim", `${replay.claims.length} AI claim(s) replayed correct from the bundle alone`);

  // 7d. The THOUGHT: reassemble the committed weights and engine from their
  //     shards, verify every digest, then re-run the committed engine over the
  //     committed weights and reproduce the recorded trace digest — offline.
  if (doc.web4) {
    const web4 = doc.web4;
    const reassemble = (shards) =>
      Buffer.concat([...shards].sort((a, b) => a.index - b.index).map((shard) => Buffer.from(shard.content, "base64")));
    const weightsBytes = reassemble(web4.weightsShards);
    const engineBytes = reassemble(web4.engineShards);

    if (modelWeightsDigest(weightsBytes) !== web4.modelBundle.model.weightsDigest) fail("the reassembled weights do not match the committed digest");
    if (bundleShardsRoot(web4.modelBundle.shards.map(({ index, hash, size }) => ({ index, hash, size }))) !== web4.modelBundle.shardsRoot) fail("the weights do not rebuild their shard root");
    if (verifyModelBundle(web4.modelBundle).length > 0) fail(`the model bundle does not validate: ${verifyModelBundle(web4.modelBundle).join("; ")}`);
    if (`sha256:${sha256Hex(engineBytes)}` !== web4.engineBundle.artifactDigest) fail("the reassembled engine does not match the committed digest");
    if (bundleShardsRoot(web4.engineBundle.shards.map(({ index, hash, size }) => ({ index, hash, size }))) !== web4.engineBundle.shardsRoot) fail("the engine does not rebuild its shard root");
    if (verifyEngineBundle(web4.engineBundle).length > 0) fail(`the engine bundle does not validate: ${verifyEngineBundle(web4.engineBundle).join("; ")}`);
    phase("commit", `weights and engine reassembled from shards, every digest and shard root verified`);

    const magic = weightsBytes.toString("latin1", 0, 4);
    const modelHandle = magic === "RXHF" ? { kind: "hf", bytes: weightsBytes } : { kind: "gguf", bytes: weightsBytes };
    const engine = loadEngine(engineBytes, web4.runtime);
    const result = await engine.run(modelHandle, { prompt: web4.prompt, steps: web4.maxTokens, seed: web4.seed, temperature: web4.temperature });
    const replayTrace = decodeTrace(traceFor(result)).rarext_trace;
    if (result.text !== web4.text) fail(`the re-run answered ${JSON.stringify(result.text)}, not ${JSON.stringify(web4.text)}`);
    if (replayTrace.digest !== web4.trace.digest) fail("the re-run trace digest diverged from the recorded one");
    phase("thought", `committed engine over committed weights reproduced ${JSON.stringify(result.text)} and trace ${replayTrace.digest.slice(0, 16)}… — no node, no provider`);
  } else {
    skip("thought", "no web4 run in this residence (RAREXT_WEB4_GGUF was unset)");
  }

  console.log(`\nThe agent's identity, its AI claim, its charter, and its network-engine thought all reconstructed from bytes.`);
  console.log(`AI lives on RAREXT. So does the agent. No server was needed to prove it — only the bytes.`);
} finally {
  for (const proc of procs) proc.stop();
  if (server.listening) {
    server.closeAllConnections();
    server.close();
  }
}
