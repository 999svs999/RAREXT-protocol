import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type {
  Anchor,
  Circuit,
  Identity,
  Publication,
  PublicationPayload,
} from "../../../packages/core/src/index.ts";
import { BlobStore } from "../src/storage.ts";
import { RarextStore } from "../src/store.ts";
import { post, start, stop } from "./helpers.ts";

function scratch(prefix: string): string {
  const base = join(process.cwd(), ".data");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

const halfAdder: Circuit = {
  components: [
    { id: "a", type: "INPUT" },
    { id: "b", type: "INPUT" },
    { id: "n1", type: "NAND", inputs: ["a", "b"] },
    { id: "n2", type: "NAND", inputs: ["a", "n1"] },
    { id: "n3", type: "NAND", inputs: ["b", "n1"] },
    { id: "xor", type: "NAND", inputs: ["n2", "n3"] },
    { id: "n5", type: "NAND", inputs: ["n1", "n1"] },
    { id: "sum", type: "OUTPUT", inputs: ["xor"] },
    { id: "carry", type: "OUTPUT", inputs: ["n5"] },
  ],
};

test("publications, identities, and anchors survive a restart", async () => {
  const dir = scratch("rarext-store-");
  const file = join(dir, "store.json");

  try {
    const firstStore = new RarextStore(file);
    const first = await start(firstStore);

    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const publicJwk = publicKey.export({ format: "jwk" });

    const identityResponse = await post(first.base, "/v1/identities", {
      handle: "alice",
      publicKey: publicJwk,
    });
    assert.equal(identityResponse.status, 201);
    const identity = (await identityResponse.json()) as Identity;

    const payload: PublicationPayload = {
      kind: "rarext.publication",
      version: 1,
      author: "alice",
      authorKey: identity.keyId,
      title: "Persisted signed half adder",
      body: "",
      taskId: "half-adder",
      circuit: halfAdder,
      parentId: null,
      createdAt: new Date().toISOString(),
      nonce: randomUUID(),
    };
    const signature = sign("sha256", Buffer.from(canonicalize(payload)), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64");

    const publishResponse = await post(first.base, "/v1/publications", {
      payload,
      signature,
    });
    assert.equal(publishResponse.status, 201);
    const publication = (await publishResponse.json()) as Publication;
    assert.equal(publication.verified, true);

    const anchorResponse = await post(first.base, "/v1/anchors", {});
    assert.equal(anchorResponse.status, 201);
    const anchor = (await anchorResponse.json()) as Anchor;

    await stop(first.server);

    const secondStore = new RarextStore(file);
    assert.equal(secondStore.count(), 1);
    assert.equal(secondStore.identityCount(), 1);
    assert.equal(secondStore.anchorCount(), 1);
    assert.equal(secondStore.pendingPublications().length, 0);

    const persistedIdentity = secondStore.getIdentity("alice") as Identity | null;
    assert.equal(persistedIdentity?.handle, "alice");
    assert.equal(persistedIdentity?.keyId, identity.keyId);

    const second = await start(secondStore);

    const feed = (await (await fetch(`${second.base}/v1/feed`)).json()) as Publication[];
    assert.equal(feed.length, 1);
    assert.equal(feed[0].id, publication.id);
    assert.equal(feed[0].verified, true);
    assert.equal(feed[0].authorKey, persistedIdentity?.keyId);

    const replay = await post(second.base, "/v1/publications", { payload, signature });
    assert.equal(replay.status, 409);

    const proofResponse = await post(second.base, `/v1/anchors/${anchor.id}/proof`, {
      publicationId: publication.id,
    });
    assert.equal(proofResponse.status, 200);
    assert.equal(((await proofResponse.json()) as { valid: boolean }).valid, true);

    await stop(second.server);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a blob store survives restart and rejects truncated or corrupt bytes", () => {
  const dir = scratch("round7-persistence-");

  try {
    const payload = randomBytes(4096);
    const first = new BlobStore(dir);
    const record = first.put(payload, { mediaType: "application/octet-stream" });

    const restarted = new BlobStore(dir);
    const found = restarted.get(record.hash);
    assert.ok(found);
    assert.deepEqual(found.bytes, payload);

    const path = join(dir, record.hash);

    writeFileSync(path, payload.subarray(0, payload.length - 1));
    assert.equal(new BlobStore(dir).get(record.hash), null);

    const corrupt = Uint8Array.from(payload);
    corrupt[0] ^= 0xff;
    writeFileSync(path, corrupt);
    assert.equal(new BlobStore(dir).get(record.hash), null);
    assert.equal(new BlobStore(dir).list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
