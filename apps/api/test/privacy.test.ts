import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type { JsonWebKey, Publication } from "../../../packages/core/src/index.ts";
import { encodeCapability } from "../src/capabilities.ts";
import { post, start, stop } from "./helpers.ts";

const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const publicJwk = pair.publicKey.export({ format: "jwk" }) as JsonWebKey;
const privateJwk = pair.privateKey.export({ format: "jwk" }) as JsonWebKey;

const circuit = {
  components: [
    { id: "a", type: "INPUT" },
    { id: "b", type: "INPUT" },
    { id: "n3", type: "NAND", inputs: ["a", "b"] },
    { id: "n1", type: "NAND", inputs: ["a", "n3"] },
    { id: "n2", type: "NAND", inputs: ["b", "n3"] },
    { id: "n4", type: "NAND", inputs: ["n1", "n2"] },
    { id: "n5", type: "NAND", inputs: ["n3", "n3"] },
    { id: "sum", type: "OUTPUT", inputs: ["n4"] },
    { id: "carry", type: "OUTPUT", inputs: ["n5"] },
  ],
};

function signPayload(payload: unknown): string {
  return sign(
    "sha256",
    Buffer.from(canonicalize(payload), "utf8"),
    { key: privateJwk, format: "jwk", dsaEncoding: "ieee-p1363" },
  ).toString("base64");
}

let registeredKey: JsonWebKey = publicJwk;

async function register(base: string, handle: string): Promise<string> {
  const response = await post(base, "/v1/identities", {
    handle,
    publicKey: publicJwk,
  });

  assert.equal(response.status, 201);

  const identity = (await response.json()) as {
    keyId: string;
    publicKey: JsonWebKey;
  };

  // The registry normalises the key it stores, so signatures have to be made
  // with the key it actually holds.
  registeredKey = identity.publicKey;

  return identity.keyId;
}

test("an unlisted publication is not in the feed and needs a capability", async () => {
  const { server, base } = await start();

  try {
    const keyId = await register(base, "cap-holder");

    const payload = {
      kind: "rarext.publication",
      version: 1,
      author: "cap-holder",
      authorKey: keyId,
      title: "Not for the feed",
      body: "unlisted work",
      app: "logic",
      challengeId: "half-adder",
      taskId: "half-adder",
      artifact: {
        app: "logic",
        kind: "logic.netlist",
        version: 1,
        mediaType: "application/json",
        body: circuit,
      },
      visibility: "unlisted",
      parentId: null,
      source: null,
      createdAt: new Date().toISOString(),
      nonce: "nonce-unlisted-1",
    };

    const published = await post(base, "/v1/publications", {
      payload,
      signature: signPayload(payload),
    });

    assert.equal(
      published.status,
      201,
      `publish failed: ${await published.clone().text()}`,
    );

    const publication = (await published.json()) as Publication;
    assert.equal(publication.visibility, "unlisted");

    const feed = (await (await fetch(`${base}/v1/feed`)).json()) as Publication[];
    assert.equal(
      feed.some((item) => item.id === publication.id),
      false,
      "an unlisted publication must not be listed",
    );

    const hidden = await fetch(`${base}/v1/publications/${publication.id}`);
    assert.equal(hidden.status, 404, "without a capability it does not exist");

    const grant = {
      artifactId: publication.id,
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      nonce: "grant-1",
      grantee: null,
    };

    const capability = encodeCapability({
      grant,
      signature: signPayload(grant),
    });

    const opened = await fetch(
      `${base}/v1/publications/${publication.id}?capability=${encodeURIComponent(capability)}`,
    );
    assert.equal(opened.status, 200, "the author's capability opens it");

    const wrong = encodeCapability({
      grant: { ...grant, artifactId: "something-else" },
      signature: signPayload({ ...grant, artifactId: "something-else" }),
    });

    const refused = await fetch(
      `${base}/v1/publications/${publication.id}?capability=${encodeURIComponent(wrong)}`,
    );
    assert.equal(refused.status, 403);
  } finally {
    await stop(server);
  }
});

test("a sealed publication stores a commitment and never the body", async () => {
  const { server, base } = await start();

  try {
    const keyId = await register(base, "seal-holder");

    const commitment = "a".repeat(64);

    const payload = {
      kind: "rarext.publication",
      version: 1,
      author: "seal-holder",
      authorKey: keyId,
      title: "Confidential",
      body: "the body never reaches the registry",
      app: "logic",
      challengeId: "half-adder",
      taskId: "half-adder",
      artifact: {
        app: "logic",
        kind: "logic.netlist",
        version: 1,
        mediaType: "application/json",
        body: null,
      },
      visibility: "sealed",
      artifactCommitment: commitment,
      attestation: {
        id: "att-sealed-1",
        verifier: "author",
        app: "logic",
        challengeId: "half-adder",
        taskId: "half-adder",
        circuitHash: commitment,
        traceHash: "b".repeat(64),
        correct: true,
        score: 1000,
        gateCount: 9,
        semanticsId: "logic/half-adder",
        semanticsVersion: 1,
        semanticsHash: "c".repeat(64),
        claimKind: "satisfies",
        scope: null,
        verifierHash: "d".repeat(64),
        proofKind: "salted",
        createdAt: new Date().toISOString(),
      },
      parentId: null,
      source: null,
      createdAt: new Date().toISOString(),
      nonce: "nonce-sealed-1",
    };

    const published = await post(base, "/v1/publications", {
      payload,
      signature: signPayload(payload),
    });

    assert.equal(
      published.status,
      201,
      `publish failed: ${await published.clone().text()}`,
    );

    const publication = (await published.json()) as Publication;
    assert.equal(publication.visibility, "sealed");
    assert.equal(publication.artifactCommitment, commitment);
    assert.equal(publication.artifact.body, null, "the body is not stored");
    assert.equal(publication.attestation.proofKind, "salted");

    const stored = JSON.stringify(publication);
    assert.equal(
      stored.includes("half-adder"),
      true,
      "the challenge is still named",
    );
    assert.equal(
      stored.includes("the body never reaches the registry"),
      true,
      "the title and note are the author's words, not the artifact",
    );
  } finally {
    await stop(server);
  }
});

test("a sealed publication without an attestation is refused", async () => {
  const { server, base } = await start();

  try {
    const keyId = await register(base, "seal-no-attestation");

    const payload = {
      kind: "rarext.publication",
      version: 1,
      author: "seal-no-attestation",
      authorKey: keyId,
      title: "Confidential without proof",
      body: "",
      app: "logic",
      challengeId: "half-adder",
      taskId: "half-adder",
      artifact: {
        app: "logic",
        kind: "logic.netlist",
        version: 1,
        mediaType: "application/json",
        body: null,
      },
      visibility: "sealed",
      artifactCommitment: "e".repeat(64),
      parentId: null,
      source: null,
      createdAt: new Date().toISOString(),
      nonce: "nonce-sealed-2",
    };

    const published = await post(base, "/v1/publications", {
      payload,
      signature: signPayload(payload),
    });

    assert.equal(published.status, 422);
  } finally {
    await stop(server);
  }
});
