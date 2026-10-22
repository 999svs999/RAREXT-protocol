import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgentSigner,
  generateAgentKeypair,
} from "../../../packages/agent-sdk/src/index.ts";
import {
  DurabilityLedger,
  directoryHolder,
  httpHolder,
  respondToChallenge,
  verifyChallengeResponse,
  type DurabilityHolder,
} from "../src/durability.ts";
import { encodeBytes } from "../src/erasure.ts";
import { createHolderServer } from "../src/holder-server.ts";
import { createPinServer, PinStore } from "../src/pin-server.ts";
import { signPlacement } from "../src/placements.ts";
import { cidV1Raw } from "../src/adapters/content.ts";
import { sha256Bytes } from "../src/storage.ts";

function setup(count: number) {
  const root = mkdtempSync(join(tmpdir(), "rarext-security-"));
  const holders = Array.from({ length: count }, (_, index) =>
    directoryHolder(`holder-${index}`, join(root, `holder-${index}`)),
  );

  return { root, holders, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("a holder cannot replay a proof or answer a leaf that was not requested", async () => {
  const { holders, cleanup } = setup(2);

  try {
    const payload = randomBytes(16 * 1024);
    const ledger = new DurabilityLedger({ random: () => 0 });
    const placement = await ledger.place(encodeBytes(payload, 1, 1), holders, "durable");
    const shard = placement.shards[0]!;
    const honest = holders.find((holder) => holder.id === shard.holder)!;
    const bytes = Uint8Array.from((await honest.get(shard.storedAs))!);
    const stale = respondToChallenge(bytes, 0, "stale-nonce")!;

    // Replaying an old nonce must fail even when the leaf and proof are valid.
    const replayer: DurabilityHolder = { ...honest, respond: async () => stale };
    const replayOutcome = await ledger.challenge(
      placement.blobHash,
      holders.map((candidate) => (candidate.id === shard.holder ? replayer : candidate)),
    );
    assert.equal(replayOutcome.find((outcome) => outcome.index === 0)!.reason, "bad-proof");

    // Answering a different leaf than the challenge asked for must also fail.
    const mover: DurabilityHolder = {
      ...honest,
      respond: async (challenge) => respondToChallenge(bytes, 1, challenge.nonce),
    };
    const movedOutcome = await ledger.challenge(
      placement.blobHash,
      holders.map((candidate) => (candidate.id === shard.holder ? mover : candidate)),
    );
    assert.equal(movedOutcome.find((outcome) => outcome.index === 0)!.reason, "bad-proof");

    assert.equal(verifyChallengeResponse(shard, stale, {
      storedAs: shard.storedAs,
      leafIndex: 0,
      nonce: "different-nonce",
    }), false);

    const overlength = { ...stale, proof: [...stale.proof, "a".repeat(64)] };
    assert.equal(verifyChallengeResponse(shard, overlength), false);
  } finally {
    cleanup();
  }
});

test("httpHolder rejects a lying shard body instead of accepting unverified bytes", async () => {
  const expected = sha256Bytes(Buffer.from("real shard"));
  const lie = Buffer.from("not the shard").toString("base64");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ storedAs: expected, content: lie }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const holder = httpHolder("liar", `http://127.0.0.1:${port}`);

  try {
    await assert.rejects(() => holder.get(expected), /do not match/);
  } finally {
    await close(server);
  }
});

test("httpHolder rejects a holder that returns a non-hash storedAs", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ storedAs: "not-a-hash" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const holder = httpHolder("liar", `http://127.0.0.1:${port}`);

  try {
    await assert.rejects(() => holder.put(Buffer.from("bytes")), /invalid storedAs/);
  } finally {
    await close(server);
  }
});

test("a holder token protects reads, deletes, and challenge answers", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-holder-token-"));
  const token = "correct horse battery staple";
  const servers = Array.from({ length: 2 }, (_, index) => {
    const server = createHolderServer({
      id: `holder-${index}`,
      directory: join(root, `holder-${index}`),
      token,
    });
    return server;
  });
  const bases = servers.map((server) => {
    server.listen(0, "127.0.0.1");
    return server;
  });

  try {
    await Promise.all(bases.map((server) => once(server, "listening")));
    const base = `http://127.0.0.1:${(bases[0]!.address() as AddressInfo).port}`;

    assert.equal((await fetch(`${base}/v1/holder`)).status, 401);
    assert.equal(
      (await fetch(`${base}/v1/holder`, {
        headers: { authorization: `Bearer ${token}` },
      })).status,
      200,
    );

    const holders = bases.map((server, index) =>
      httpHolder(
        `holder-${index}`,
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        { token },
      ),
    );
    const ledger = new DurabilityLedger();
    const placement = await ledger.place(
      encodeBytes(randomBytes(8192), 1, 1),
      holders,
      "durable",
    );
    const outcomes = await ledger.challenge(placement.blobHash, holders);

    assert.ok(outcomes.every((outcome) => outcome.ok));
    const storedAs = placement.shards[0]!.storedAs;
    const url = `http://127.0.0.1:${(bases[0]!.address() as AddressInfo).port}/v1/holder/shards/${storedAs}`;

    assert.equal((await fetch(url, { method: "DELETE" })).status, 401);
    assert.equal(
      (await fetch(url, { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).status,
      204,
    );
  } finally {
    await Promise.all(bases.map(close));
    rmSync(root, { recursive: true, force: true });
  }
});

test("the holder refuses an unbounded challenge nonce", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-holder-nonce-"));
  const server = createHolderServer({ id: "holder-0", directory: join(root, "holder-0") });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const stored = await (await fetch(`${base}/v1/holder/shards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: Buffer.from("shard").toString("base64") }),
    })).json() as { storedAs: string };

    const response = await fetch(`${base}/v1/holder/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storedAs: stored.storedAs, leafIndex: 0, nonce: "x".repeat(500) }),
    });

    assert.equal(response.status, 400);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("pin metadata and content are tamper-evident", () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-pin-security-"));
  const directory = join(root, "pins");
  const store = new PinStore(directory);
  const content = Buffer.from("pinned bytes");
  const cid = cidV1Raw(content);

  try {
    store.put({ cid, content, publicationIds: ["pub-1"] });
    writeFileSync(join(directory, `${cid}.bin`), Buffer.from("tampered bytes"));

    assert.throws(() => store.get(cid), /pin metadata size|does not match its cid/);
    assert.throws(() => store.content(cid), /pin metadata size|does not match its cid/);
    assert.deepEqual(store.list(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the pin service can require a bearer token and refuses bad metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-pin-token-"));
  const store = new PinStore(join(root, "pins"));
  const token = "pin-secret";
  const server = createPinServer(store, { token });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const content = Buffer.from("bundle");
  const cid = cidV1Raw(content);

  try {
    assert.equal((await fetch(`${base}/v1/pins`)).status, 401);
    const created = await fetch(`${base}/v1/pins`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        cid,
        content: content.toString("base64"),
        publicationIds: Array.from({ length: 101 }, (_, index) => `pub-${index}`),
      }),
    });
    assert.equal(created.status, 400);

    const good = await fetch(`${base}/v1/pins`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ cid, content: content.toString("base64") }),
    });
    assert.equal(good.status, 201);

    assert.equal((await fetch(`${base}/v1/pins/${cid}`, { method: "DELETE" })).status, 401);
    assert.equal(
      (await fetch(`${base}/v1/pins/${cid}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      })).status,
      204,
    );
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a signed placement refuses co-location, impossible lengths, and oversized claims", async () => {
  const { holders, cleanup } = setup(4);

  try {
    const place = async () => {
      const ledger = new DurabilityLedger();
      return ledger.place(encodeBytes(randomBytes(8192), 2, 1), holders, "pinned");
    };
    const placement = await place();
    const signer = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);

    const sameHolder = structuredClone(placement);
    sameHolder.shards[1]!.holder = sameHolder.shards[0]!.holder;
    assert.throws(() => signPlacement(sameHolder, signer), /share a holder/);

    const hugeLength = structuredClone(placement);
    hugeLength.length = Number.MAX_SAFE_INTEGER;
    assert.throws(() => signPlacement(hugeLength, signer), /payload length/);

    const hugeShard = structuredClone(placement);
    hugeShard.shards[0]!.size = 5 * 1024 * 1024 * 1024;
    assert.throws(() => signPlacement(hugeShard, signer), /shard size/);

    const wrongLeaves = structuredClone(placement);
    wrongLeaves.shards[0]!.leaves = 1_000_000;
    assert.throws(() => signPlacement(wrongLeaves, signer), /leaves/);

    const malformed = { record: { placement: { shards: [null] } }, signature: "AA" };
    assert.throws(() => signPlacement(malformed as never, signer));
  } finally {
    cleanup();
  }
});
