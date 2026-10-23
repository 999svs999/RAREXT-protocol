import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AgentSigner, generateAgentKeypair } from "../packages/agent-sdk/src/index.ts";
import { PlacementRegistry, signPlacement, verifyPlacement } from "../apps/api/src/placements.ts";
import { encodeFileToShards } from "../apps/api/src/erasure-stream.ts";

import { createHolderServer } from "../apps/api/src/holder-server.ts";
import { createPinServer, PinStore } from "../apps/api/src/pin-server.ts";
import { DurabilityLedger, httpHolder } from "../apps/api/src/durability.ts";
import { encodeBytes, decodeBytes } from "../apps/api/src/erasure.ts";
import {
  decryptSealedPayload,
  encryptSealedPayload,
  sealedEnvelope,
  sealedMetadata,
} from "../apps/api/src/sealed-encryption.ts";

const PLAINTEXT_MARKER = Buffer.from("RAREXT-SEALED-PLAINTEXT-MARKER-DO-NOT-STORE:", "utf8");

function countMarker(bytes, marker) {
  let count = 0;
  let offset = bytes.indexOf(marker);
  while (offset !== -1) {
    count += 1;
    offset = bytes.indexOf(marker, offset + 1);
  }
  return count;
}

function scanDirectory(directory) {
  let files = 0;
  let bytes = 0;
  let markerHits = 0;
  let hashMismatches = 0;

  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    const name = entry.name;

    if (!/^[0-9a-f]{64}$/.test(name)) continue;

    const content = readFileSync(path);
    const hash = createHash("sha256").update(content).digest("hex");

    files += 1;
    bytes += content.length;
    markerHits += countMarker(content, PLAINTEXT_MARKER);
    if (hash !== name) hashMismatches += 1;
  }

  return { files, bytes, markerHits, hashMismatches };
}

async function runScenario({ sealed }) {
  const root = mkdtempSync(join(tmpdir(), sealed ? "rarext-net-sealed-" : "rarext-net-"));
  console.log(`[RAREXT Net] ${sealed ? "Sealed" : "Open"} scenario in ${root}...`);

  const directories = new Map([
    ["holder-0", join(root, "h0")],
    ["holder-1", join(root, "h1")],
    ["holder-2", join(root, "h2")],
  ]);
  const s0 = createHolderServer({ id: "holder-0", directory: directories.get("holder-0") });
  const s1 = createHolderServer({ id: "holder-1", directory: directories.get("holder-1") });
  const s2 = createHolderServer({ id: "holder-2", directory: directories.get("holder-2") });
  const pinStore = new PinStore(join(root, "pins"));
  const pinServer = createPinServer(pinStore, { token: "pin-token" });

  s0.listen(0, "127.0.0.1");
  s1.listen(0, "127.0.0.1");
  s2.listen(0, "127.0.0.1");
  pinServer.listen(0, "127.0.0.1");

  await Promise.all([
    once(s0, "listening"),
    once(s1, "listening"),
    once(s2, "listening"),
    once(pinServer, "listening"),
  ]);

  const p0 = s0.address().port;
  const p1 = s1.address().port;
  const p2 = s2.address().port;
  const pinPort = pinServer.address().port;

  console.log(`[RAREXT Net] Holder 0 listening on http://127.0.0.1:${p0}`);
  console.log(`[RAREXT Net] Holder 1 listening on http://127.0.0.1:${p1}`);
  console.log(`[RAREXT Net] Holder 2 listening on http://127.0.0.1:${p2}`);
  console.log(`[RAREXT Net] Pin service listening on http://127.0.0.1:${pinPort}`);

  const h0 = httpHolder("holder-0", `http://127.0.0.1:${p0}`);
  const h1 = httpHolder("holder-1", `http://127.0.0.1:${p1}`);
  const h2 = httpHolder("holder-2", `http://127.0.0.1:${p2}`);
  const holders = [h0, h1, h2];

  try {
    const plaintext = Buffer.concat([
      PLAINTEXT_MARKER,
      randomBytes(64 * 1024 - PLAINTEXT_MARKER.length),
    ]);
    const secret = "demo-sealed-secret-not-a-real-key";
    let payload = plaintext;
    let envelope = null;

    if (sealed) {
      const sealedPayload = encryptSealedPayload(plaintext, secret);
      payload = Buffer.from(sealedPayload.ciphertextBytes);
      envelope = sealedPayload.envelope;
      console.log(
        `[RAREXT Net] Encrypted ${plaintext.length} plaintext bytes to ${payload.length} ciphertext bytes ` +
          `(${envelope ? "aes-256-gcm, hkdf-sha256" : ""}) before erasure coding.`,
      );
    } else {
      console.log("[RAREXT Net] Storing 64 KiB test payload across holders (k=2, m=1)...");
    }

    const ledger = new DurabilityLedger();
    const encoded = encodeBytes(payload, 2, 1);
    const placement = await ledger.place(
      encoded,
      holders,
      "durable",
      sealed && envelope ? { sealed: sealedMetadata(envelope) } : {},
    );
    console.log(`[RAREXT Net] Placed blob ${placement.blobHash} across ${placement.shards.length} shards.`);

    if (sealed) {
      for (const [holder, directory] of directories) {
        const scan = scanDirectory(directory);
        console.log(
          `[RAREXT Net] ${holder} directory: ${scan.files} shard file(s), ${scan.bytes} bytes, ` +
            `${scan.markerHits} plaintext-marker hits, ${scan.hashMismatches} hash mismatches`,
        );

        if (scan.markerHits !== 0 || scan.hashMismatches !== 0) {
          throw new Error(`${holder} stored plaintext or corrupt shard bytes`);
        }
      }
    }

    console.log("[RAREXT Net] Running challenge and audit...");
    await ledger.challenge(placement.blobHash, holders);
    const audit1 = ledger.audit(placement.blobHash);
    console.log(`[RAREXT Net] Audit status: ${audit1.status} (live: ${audit1.live}/${audit1.required})`);

    console.log("[RAREXT Net] Simulating failure: shutting down Holder 1...");
    s1.closeAllConnections();
    await new Promise((resolve) => s1.close(resolve));

    await ledger.challenge(placement.blobHash, holders);
    const audit2 = ledger.audit(placement.blobHash);
    console.log(`[RAREXT Net] Audit status after failure: ${audit2.status}`);

    console.log("[RAREXT Net] Provisioning spare Holder 3 and triggering repair...");
    directories.set("holder-3", join(root, "h3"));
    const s3 = createHolderServer({ id: "holder-3", directory: directories.get("holder-3") });
    s3.listen(0, "127.0.0.1");
    await once(s3, "listening");
    const p3 = s3.address().port;
    const h3 = httpHolder("holder-3", `http://127.0.0.1:${p3}`);

    try {
      const repairHolders = [h0, h2, h3];
      const repaired = await ledger.repair(placement.blobHash, repairHolders);
      console.log(`[RAREXT Net] Repair complete. Filled ${repaired.filled} shard(s).`);

      if (sealed) {
        const scan = scanDirectory(directories.get("holder-3"));
        console.log(
          `[RAREXT Net] holder-3 directory after repair: ${scan.files} shard file(s), ` +
            `${scan.markerHits} plaintext-marker hits, ${scan.hashMismatches} hash mismatches`,
        );

        if (scan.markerHits !== 0 || scan.hashMismatches !== 0) {
          throw new Error("holder-3 stored plaintext or corrupt shard bytes");
        }
      }

      await ledger.challenge(placement.blobHash, repairHolders);
      const audit3 = ledger.audit(placement.blobHash);
      console.log(`[RAREXT Net] Audit status after repair: ${audit3.status}`);

      console.log("[RAREXT Net] Retrieving and verifying byte-exact payload reconstruction...");
      const survivorShards = await Promise.all(
        repaired.placement.shards.map(async (shard) => {
          const holder = repairHolders.find((h) => h.id === shard.holder);
          const foundBytes = await holder.get(shard.storedAs);
          if (!foundBytes) throw new Error(`missing shard on ${shard.holder}`);
          return {
            index: shard.index,
            dataShards: repaired.placement.dataShards,
            parityShards: repaired.placement.parityShards,
            length: repaired.placement.length,
            payloadDigest: repaired.placement.blobHash,
            digest: shard.digest,
            bytes: Uint8Array.from(foundBytes),
          };
        }),
      );

      const decoded = decodeBytes(survivorShards);

      if (sealed && envelope) {
        const decrypted = decryptSealedPayload(
          sealedEnvelope(placement.sealed, decoded),
          secret,
        );

        if (Buffer.from(decrypted).equals(plaintext)) {
          console.log(
            `[RAREXT Net] SUCCESS: decrypted ${decrypted.length} bytes match the original plaintext byte-for-byte!`,
          );
        } else {
          throw new Error("Decrypted payload mismatch!");
        }
      } else if (Buffer.from(decoded).equals(payload)) {
        console.log("[RAREXT Net] SUCCESS: Decoded payload matches original byte-for-byte!");
      } else {
        throw new Error("Payload mismatch!");
      }
    } finally {
      s3.closeAllConnections();
      await new Promise((resolve) => s3.close(resolve));
    }
  } finally {
    s0.closeAllConnections();
    s2.closeAllConnections();
    pinServer.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => s0.close(resolve)),
      new Promise((resolve) => s2.close(resolve)),
      new Promise((resolve) => pinServer.close(resolve)),
    ]);
    rmSync(root, { recursive: true, force: true });
    console.log(`[RAREXT Net] ${sealed ? "Sealed" : "Open"} scenario stopped and cleaned up.`);
  }
}

async function runStreamedScenario() {
  const root = mkdtempSync(join(tmpdir(), "rarext-net-streamed-"));
  console.log(`[RAREXT Net] Streamed scenario in ${root}...`);

  const directories = new Map([
    ["holder-0", join(root, "h0")],
    ["holder-1", join(root, "h1")],
    ["holder-2", join(root, "h2")],
  ]);
  const servers = [...directories].map(([id, directory]) => createHolderServer({ id, directory }));

  for (const server of servers) server.listen(0, "127.0.0.1");
  await Promise.all(servers.map((server) => once(server, "listening")));

  const urls = servers.map((server) => `http://127.0.0.1:${server.address().port}`);
  const holders = urls.map((url, index) => httpHolder(`holder-${index}`, url));

  for (const [index, url] of urls.entries()) {
    console.log(`[RAREXT Net] holder-${index} listening on ${url}`);
  }

  try {
    const payload = Buffer.concat([
      PLAINTEXT_MARKER,
      randomBytes(8 * 1024 * 1024 - PLAINTEXT_MARKER.length),
    ]);
    const inputPath = join(root, "payload.bin");
    writeFileSync(inputPath, payload);

    const streamed = encodeFileToShards({
      inputPath,
      outputDir: join(root, "shards"),
      dataShards: 2,
      parityShards: 1,
      chunkBytes: 1024 * 1024,
    });
    console.log(
      `[RAREXT Net] Encoded ${payload.length} bytes into ${streamed.shards.length} shard files ` +
        `of ${streamed.shards[0].bytes} bytes each (${streamed.chunks} chunk(s), 2+1).`,
    );

    const ledger = new DurabilityLedger();
    const placed = await ledger.placeStreamed(streamed, holders, "durable");
    const signer = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
    const signed = signPlacement(placed, signer);
    const registry = new PlacementRegistry(join(root, "placements"));
    const registration = registry.put(signed);
    console.log(
      `[RAREXT Net] Signed streamed placement registered: status ${registration.status}, ` +
        `sequence ${signed.record.sequence}, verified=${verifyPlacement(signed).ok}.`,
    );

    const restored = new PlacementRegistry(join(root, "placements")).get(placed.blobHash);
    if (!restored) throw new Error("the signed streamed placement was not reloaded from disk");
    const reloaded = new DurabilityLedger();
    reloaded.adopt(structuredClone(restored.record.placement));
    console.log("[RAREXT Net] Reloaded the signed placement from a fresh registry and ledger.");

    console.log("[RAREXT Net] Running challenge and audit...");
    await reloaded.challenge(placed.blobHash, holders);
    const audit1 = reloaded.audit(placed.blobHash);
    console.log(`[RAREXT Net] Audit status: ${audit1.status} (live: ${audit1.live}/${audit1.required})`);

    console.log("[RAREXT Net] Simulating failure: shutting down Holder 1...");
    servers[1].closeAllConnections();
    await new Promise((resolve) => servers[1].close(resolve));

    await reloaded.challenge(placed.blobHash, holders);
    const audit2 = reloaded.audit(placed.blobHash);
    console.log(`[RAREXT Net] Audit status after failure: ${audit2.status}`);

    console.log("[RAREXT Net] Provisioning spare Holder 3 and repairing the streamed shard...");
    directories.set("holder-3", join(root, "h3"));
    const s3 = createHolderServer({ id: "holder-3", directory: directories.get("holder-3") });
    s3.listen(0, "127.0.0.1");
    await once(s3, "listening");
    const h3 = httpHolder("holder-3", `http://127.0.0.1:${s3.address().port}`);
    const repairHolders = [holders[0], holders[2], h3];

    try {
      const repaired = await reloaded.repair(placed.blobHash, repairHolders);
      console.log(
        `[RAREXT Net] Streamed repair filled ${repaired.filled} shard(s), ` +
          `read ${repaired.readBytes} bytes, wrote ${repaired.writtenBytes} bytes.`,
      );

      await reloaded.challenge(placed.blobHash, repairHolders);
      const audit3 = reloaded.audit(placed.blobHash);
      console.log(`[RAREXT Net] Audit status after repair: ${audit3.status}`);

      console.log("[RAREXT Net] Retrieving any k streamed shards over raw HTTP...");
      const outputPath = join(root, "retrieved.bin");
      const result = await reloaded.retrieveStreamed(repaired.placement, outputPath, repairHolders);
      const bytes = readFileSync(outputPath);

      if (result.sha256 === streamed.payloadDigest && bytes.equals(payload)) {
        console.log(
          `[RAREXT Net] SUCCESS: ${result.downloaded} streamed shards reconstructed ` +
            `${bytes.length} bytes byte-for-byte.`,
        );
      } else {
        throw new Error("streamed payload mismatch");
      }
    } finally {
      s3.closeAllConnections();
      await new Promise((resolve) => s3.close(resolve));
    }
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    rmSync(root, { recursive: true, force: true });
    console.log("[RAREXT Net] Streamed scenario stopped and cleaned up.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runScenario({ sealed: false })
    .then(() => runScenario({ sealed: true }))
    .then(() => runStreamedScenario())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
