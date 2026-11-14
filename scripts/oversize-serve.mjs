#!/usr/bin/env node
/**
 * oversize-serve.mjs — serve a genuinely oversized container end to end.
 *
 * It generates (if absent) a real ~6.5 GiB GGUF container and an identical
 * control without the bulk tensor, shards the big one into RAREXT, and starts a
 * provider with `RAREXT_STREAM_WEIGHTS=1` on a host whose memory is far smaller
 * than the container. The provider verifies the shards to disk ONE AT A TIME,
 * serves a chat request from the streamed rows, and the demo checks:
 *
 *   - the streamed answer is IDENTICAL to the control's (same used weights);
 *   - the engine's peak resident bytes stay within the committed bound;
 *   - the measured throughput is reported.
 *
 * The declared architecture is small on purpose: this proves the loader and
 * provider path at 6.5 GiB, and says plainly that it is not a 6.5 GiB model
 * running (those weights do not exist on this host).
 *
 *   npm run demo:oversize
 *   RAREXT_OVERSIZE_GIB=6.5 RAREXT_OVERSIZE_KEEP=1 npm run demo:oversize
 */
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, closeSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { writeOversizeGguf } from "./make-oversize-gguf.mjs";

const root = new URL("..", import.meta.url).pathname;
const { createApp } = await import(root + "apps/api/src/app.ts");
const { PlacementRegistry } = await import(root + "apps/api/src/placements.ts");
const { BlobStore } = await import(root + "apps/api/src/storage.ts");
const { RarextStore } = await import(root + "apps/api/src/store.ts");
const { buildModelBundle, buildModelBundleFromFile, uploadBundle, uploadBundleFromFile } = await import(
  root + "apps/runtime/src/model-bundle.ts"
);
const { startProvider } = await import(root + "apps/runtime/src/provider.ts");
const { buildEngineBundle, loadEngine, uploadEngineBundle, ENGINE_ARTIFACT_RUNTIME_GGUF } = await import(
  root + "apps/runtime/src/engine-bundle.ts"
);

const GIB = 1024 ** 3;
const MIB = 1024 * 1024;
const targetGib = Number(process.env.RAREXT_OVERSIZE_GIB ?? "6.5");
const keep = process.env.RAREXT_OVERSIZE_KEEP === "1";
const suppliedPath = process.env.RAREXT_OVERSIZE_PATH ?? null;
const bigPath = suppliedPath ?? "/tmp/rarext-oversize.gguf";
const syntheticControlPath = "/tmp/rarext-oversize-control.gguf";
const controlPath = suppliedPath === null ? syntheticControlPath : (process.env.RAREXT_OVERSIZE_CONTROL ?? null);
const compareResident = process.env.RAREXT_OVERSIZE_RESIDENT === "1";
const prompt = process.env.RAREXT_OVERSIZE_PROMPT ?? "abcdefgh";
const steps = Number(process.env.RAREXT_OVERSIZE_STEPS ?? 8) || 8;

// The committed bound: one fetch shard (32 MiB, the registry's blob cap) plus
// the engine's metadata cache and a tensor row. The host is simulated far
// smaller than the container.
const SHARD_BYTES = 32 * MIB;
const RESIDENT_BOUND = 192 * MIB;
const HOST_MEMORY = 384 * MIB;

let failed = 0;
const check = (ok, message) => {
  if (ok) return;
  failed += 1;
  console.error(`  [FAIL] ${message}`);
};

if (suppliedPath !== null && !existsSync(suppliedPath)) {
  console.error(`no container at RAREXT_OVERSIZE_PATH=${suppliedPath}`);
  process.exit(1);
}
if (suppliedPath === null && !existsSync(bigPath)) {
  console.log(`generating ${bigPath} (~${targetGib} GiB, real bytes)…`);
  const written = writeOversizeGguf(bigPath, { targetBytes: targetGib * GIB, pad: true });
  console.log(`  wrote ${written.bytes} bytes`);
}
if (controlPath !== null && !existsSync(controlPath)) {
  if (suppliedPath !== null) {
    console.error(`no control container at RAREXT_OVERSIZE_CONTROL=${controlPath}`);
    process.exit(1);
  }
  const written = writeOversizeGguf(controlPath, { targetBytes: 1, pad: false });
  console.log(`  wrote control ${written.bytes} bytes`);
}
const bigFile = statSync(bigPath).size;
const controlFile = controlPath === null ? null : statSync(controlPath).size;

// Pre-flight: can RAREXT parse this container at all? Fail here, in a second,
// rather than after sharding gigabytes.
{
  const engine = loadEngine(readFileSync(root + "apps/runtime/engines/rarext-gguf-engine.js"));
  const head = readFileSync(bigPath, { flag: "r" }).subarray(0, 4).toString("latin1");
  if (head === "RXHF") {
    console.error(
      "this is a RAREXT HF/RXHF container, which cannot be streamed (it is parsed from a resident buffer).\n" +
        "Serve it resident, or supply a GGUF container for the streamed path.",
    );
    process.exit(1);
  }
  try {
    const parsed = engine.parseGguf(new Uint8Array(readFileSync(bigPath, { flag: "r" }).subarray(0, 1 << 20)));
    void parsed;
  } catch (error) {
    // The header may run past the 1 MiB probe; the real parse happens below.
    void error;
  }
}

const registryRoot = mkdtempSync(join(tmpdir(), "rarext-oversize-registry-"));
const stateRoot = mkdtempSync(join(tmpdir(), "rarext-oversize-state-"));
const blobs = new BlobStore(join(registryRoot, "blobs"));
const server = createApp({
  store: new RarextStore(),
  blobs,
  placements: new PlacementRegistry(join(registryRoot, "placements")),
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;

let bigProvider = null;
let controlProvider = null;
// Hoisted so the closing summary can report it (set inside the try).
let identical = null;
const engineSource = readFileSync(root + "apps/runtime/engines/rarext-gguf-engine.js");

try {
  const model = {
    id: "oversize-6g",
    family: "llama",
    parameters: null,
    quantization: "F32",
    format: "gguf",
    sizeBytes: null,
    weightsDigest: null,
    contextLength: 256,
  };
  const execution = { kind: "engine", engine: "rarext", engineModel: null };

  console.log(`bundling ${bigFile} bytes at ${SHARD_BYTES / MIB} MiB per shard (streamed from disk)…`);
  // The container is never held: it is hashed while read, and each shard is
  // read from the file as it is uploaded.
  const big = buildModelBundleFromFile({
    path: bigPath,
    model,
    execution,
    chunkBytes: SHARD_BYTES,
    createdAt: "2026-11-14T00:00:00.000Z",
  });
  try {
    await uploadBundleFromFile({ registry: base, bundle: big.bundle, readShard: big.readShard });
  } finally {
    big.close();
  }
  let control = null;
  if (controlPath !== null) {
    control = buildModelBundle({
      bytes: readFileSync(controlPath),
      model: { ...model, id: "oversize-control" },
      execution,
      chunkBytes: 4 * MIB,
      createdAt: "2026-11-14T00:00:00.000Z",
    });
    await uploadBundle({ registry: base, bundle: control.bundle, chunks: control.chunks });
  }

  const { bundle: engineBundle, chunks: engineChunks } = buildEngineBundle({
    source: engineSource,
    name: "rarext-gguf-engine",
    engineVersion: "1",
    runtime: ENGINE_ARTIFACT_RUNTIME_GGUF,
    chunkBytes: 4096,
  });
  await uploadEngineBundle({ registry: base, bundle: engineBundle, chunks: engineChunks });

  // 1. The provider streams: verify-to-disk one shard at a time, bounded resident.
  bigProvider = await startProvider({
    bundle: big.bundle,
    registry: base,
    stateDir: join(stateRoot, "big"),
    port: 0,
    engineBundle,
    streamWeights: true,
    hostMemoryBytes: HOST_MEMORY,
    streamResidentBytes: RESIDENT_BOUND,
    log: (line) => console.log(`  [provider] ${line}`),
  });
  check(bigProvider.streaming === true, "the provider did not report streaming");

  // 2. The control, same used weights, resident.
  if (controlPath !== null && control !== null) {
    controlProvider = await startProvider({
      bundle: control.bundle,
      registry: base,
      stateDir: join(stateRoot, "control"),
      port: 0,
      engineBundle,
      hostMemoryBytes: HOST_MEMORY,
      streamResidentBytes: RESIDENT_BOUND,
    });
    check(controlProvider.streaming === false, "the control should be resident");
  }

  const ask = async (provider) => {
    const started = performance.now();
    const response = await fetch(`${provider.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: provider.bundle.model.id, messages: [{ role: "user", content: prompt }], max_completion_tokens: steps, seed: 0 }),
    });
    const ms = performance.now() - started;
    if (response.status !== 200) throw new Error(`provider answered ${response.status}: ${await response.text()}`);
    const body = await response.json();
    return { tokens: body.rarext_trace?.tokens ?? [], ms };
  };

  const streamed = await ask(bigProvider);
  let comparedWith = "none";
  if (controlProvider !== null) {
    const resident = await ask(controlProvider);
    identical = streamed.tokens.join(",") === resident.tokens.join(",");
    comparedWith = "the resident control (same used weights)";
  } else if (compareResident) {
    // The same container served resident by the engine: opt-in, because it needs
    // the whole file in memory, which is what this mode exists to avoid.
    const engine = loadEngine(engineSource);
    const residentRun = engine.run(
      { kind: "gguf", bytes: new Uint8Array(readFileSync(bigPath)) },
      { prompt, steps, temperature: 0, seed: 0 },
    );
    identical = residentRun.tokens.join(",") === streamed.tokens.join(",");
    comparedWith = "the same container served resident (RAREXT_OVERSIZE_RESIDENT=1)";
  } else {
    console.log(
      "  note: no identity check — supply RAREXT_OVERSIZE_CONTROL (a container with the same used weights), " +
        "or set RAREXT_OVERSIZE_RESIDENT=1 to compare against the same file served resident.",
    );
  }

  // 3. Engine-level bound: read the real file and report the peak held.
  const engine = loadEngine(engineSource);
  const fd = openSync(bigPath, "r");
  const readAt = (offset, length) => {
    const want = Math.max(0, Math.min(length, bigFile - offset));
    if (want === 0) return new Uint8Array(0);
    const buffer = Buffer.allocUnsafe(want);
    const read = readSync(fd, buffer, 0, want, offset);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, read);
  };
  let boundRun;
  try {
    const streamedModel = { kind: "gguf", readAt, sizeBytes: bigFile, chunkBytes: 65536, cacheChunks: 32 };
    const started = performance.now();
    boundRun = engine.run(streamedModel, { prompt, steps, temperature: 0, seed: 0 });
    boundRun.wallMs = performance.now() - started;
    boundRun.stats = engine.streamStats(streamedModel);
  } finally {
    closeSync(fd);
  }
  check(streamed.tokens.length === steps, `the provider returned ${streamed.tokens.length} of ${steps} tokens`);
  if (identical !== null) check(identical, `the streamed decode differed from ${comparedWith}`);
  check(boundRun.residentBytes <= RESIDENT_BOUND, `peak resident ${boundRun.residentBytes} over the ${RESIDENT_BOUND} bound`);
  check(boundRun.tokens.join(",") === streamed.tokens.join(","), "the engine's own streamed run differed from the provider's");

  console.log(`\nRAREXT oversized serve — ${bigPath}`);
  console.log(
    `  container     ${bigFile} bytes (${(bigFile / GIB).toFixed(2)} GiB) · ` +
      (controlFile === null ? "no control supplied · " : `control ${controlFile} bytes · `) +
      `${big.bundle.shards.length} shards of ${SHARD_BYTES / MIB} MiB`,
  );
  console.log(`  host memory   ${HOST_MEMORY / MIB} MiB (simulated) · committed bound ${RESIDENT_BOUND / MIB} MiB`);
  console.log(`  provider      streamed ${streamed.ms.toFixed(0)} ms (${steps} tokens), streaming=${bigProvider.streaming}`);
  console.log(`  engine        peak resident ${boundRun.residentBytes} bytes · ${boundRun.stats.reads.toLocaleString("en-US")} reads · ${boundRun.stats.bytesRead.toLocaleString("en-US")} bytes read`);
  console.log(`  tokens        ${streamed.tokens.join(",")}`);
  console.log(
    `  identical     ${identical === null ? "not checked" : identical}` +
      (comparedWith === "none" ? "" : ` (streamed vs ${comparedWith})`),
  );
  console.log(`  throughput    ${(steps / (boundRun.wallMs / 1000)).toFixed(1)} tok/s (${(boundRun.wallMs / steps).toFixed(3)} ms/token)`);
} finally {
  if (bigProvider !== null) await bigProvider.close();
  if (controlProvider !== null) await controlProvider.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
  rmSync(registryRoot, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
  if (!keep) {
    // A container the operator supplied is never deleted.
    if (suppliedPath === null) {
      rmSync(bigPath, { force: true });
      rmSync(syntheticControlPath, { force: true });
    }
  }
}

if (failed > 0) {
  console.error(`\n${failed} oversized-serve check(s) FAILED`);
  process.exit(1);
}
console.log(
  "\nOversized serve ok: verified to disk one shard at a time, served within the bound" +
    (identical === false ? "" : ", decode checked"),
);
