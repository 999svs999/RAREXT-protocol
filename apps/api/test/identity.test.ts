import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { randomUUID } from "node:crypto";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type {
  Circuit,
  Identity,
  Profile,
  Publication,
  PublicationPayload,
} from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

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

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });

  return {
    publicJwk: publicKey.export({ format: "jwk" }),
    privateKey,
  };
}

function signedPayload(
  author: string,
  authorKey: string,
  overrides: Partial<PublicationPayload> = {},
): PublicationPayload {
  return {
    kind: "rarext.publication",
    version: 1,
    author,
    authorKey,
    title: "Signed half adder",
    body: "Proves handle ownership.",
    taskId: "half-adder",
    circuit: halfAdder,
    parentId: null,
    createdAt: new Date().toISOString(),
    nonce: randomUUID(),
    ...overrides,
  };
}

function signPayload(payload: PublicationPayload, privateKey: ReturnType<typeof keypair>["privateKey"]) {
  return sign("sha256", Buffer.from(canonicalize(payload)), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64");
}

test("registers a key and verifies a signed publication", async () => {
  const { server, base } = await start();

  try {
    const { publicJwk, privateKey } = keypair();

    const registerResponse = await post(base, "/v1/identities", {
      handle: "alice",
      publicKey: publicJwk,
    });

    assert.equal(registerResponse.status, 201);
    const identity = (await registerResponse.json()) as Identity;
    assert.equal(identity.handle, "alice");
    assert.equal(identity.keyId.length, 64);

    const payload = signedPayload("alice", identity.keyId);
    const response = await post(base, "/v1/publications", {
      payload,
      signature: signPayload(payload, privateKey),
    });

    assert.equal(response.status, 201);
    const publication = (await response.json()) as Publication;
    assert.equal(publication.verified, true);
    assert.equal(publication.authorKey, identity.keyId);
    assert.equal(publication.author, "alice");
    assert.equal(publication.createdAt, payload.createdAt);

    const profileResponse = await fetch(`${base}/v1/profiles/alice`);
    const profile = (await profileResponse.json()) as Profile;
    assert.equal(profile.verified, true);

    const savedIdentity = (await (
      await fetch(`${base}/v1/identities/alice`)
    ).json()) as Identity;
    assert.equal(savedIdentity.keyId, identity.keyId);
  } finally {
    await stop(server);
  }
});

test("rejects tampered payloads, reused nonces, and duplicate handles", async () => {
  const { server, base } = await start();

  try {
    const { publicJwk, privateKey } = keypair();

    assert.equal(
      (await post(base, "/v1/identities", { handle: "alice", publicKey: publicJwk }))
        .status,
      201,
    );

    const identity = (await (
      await fetch(`${base}/v1/identities/alice`)
    ).json()) as Identity;

    const payload = signedPayload("alice", identity.keyId);
    const signature = signPayload(payload, privateKey);

    const tampered = await post(base, "/v1/publications", {
      payload: { ...payload, title: "Tampered" },
      signature,
    });
    assert.equal(tampered.status, 401);

    const first = await post(base, "/v1/publications", { payload, signature });
    assert.equal(first.status, 201);

    const replay = await post(base, "/v1/publications", { payload, signature });
    assert.equal(replay.status, 409);

    const unregistered = signedPayload("mallory", identity.keyId);
    const unregisteredResponse = await post(base, "/v1/publications", {
      payload: unregistered,
      signature: signPayload(unregistered, privateKey),
    });
    assert.equal(unregisteredResponse.status, 401);

    const secondKey = keypair();
    const duplicateHandle = await post(base, "/v1/identities", {
      handle: "alice",
      publicKey: secondKey.publicJwk,
    });
    assert.equal(duplicateHandle.status, 409);

    const unsigned = await post(base, "/v1/publications", {
      author: "alice",
      title: "Impersonation attempt",
      taskId: "half-adder",
      circuit: halfAdder,
    });
    assert.equal(unsigned.status, 401);
  } finally {
    await stop(server);
  }
});
