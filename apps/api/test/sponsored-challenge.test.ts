import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type { Challenge, JsonWebKey } from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";
import { createVerifierRegistry } from "../src/verifiers.ts";
import { generate } from "../src/generative.ts";
import { createSponsorRegistry, verifyChallengeSponsorship } from "../src/sponsorship.ts";
import { RarextStore } from "../src/store.ts";

const halfAdder = {
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

function memberKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });

  return {
    publicKey: publicKey.export({ format: "jwk" }) as JsonWebKey,
    privateKey,
  };
}

function sponsorshipPayload(
  member: string,
  overrides: Record<string, unknown> = {},
) {
  const createdAt = new Date().toISOString();

  return {
    kind: "rarext.challenge-sponsorship.v1",
    version: 1,
    member,
    createdAt,
    nonce: randomUUID(),
    challenge: {
      id: "sponsored-half-adder",
      app: "logic",
      title: "Community half adder",
      description: "A sponsored challenge from a known community member.",
      version: 1,
      spec: halfAdder,
      semanticsId: "logic/half-adder",
      semanticsVersion: 1,
      createdAt,
    },
    ...overrides,
  };
}

function signedRequest(
  payload: Record<string, unknown>,
  privateKey: ReturnType<typeof memberKeypair>["privateKey"],
) {
  return {
    payload,
    signature: sign("sha256", Buffer.from(canonicalize(payload)), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64"),
  };
}

async function startEventReceiver() {
  const events: Array<Record<string, unknown>> = [];
  const headers: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    headers.push(String(req.headers["x-rarext-event"] ?? ""));
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        events.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        events.push({ invalid: true });
      }
      res.writeHead(204);
      res.end();
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    events,
    headers,
    url: `http://127.0.0.1:${port}/events`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("stores a signed sponsored challenge and exposes it through the API", async () => {
  const { publicKey, privateKey } = memberKeypair();
  const sponsors = createSponsorRegistry([
    { handle: "alice", community: "trac", publicKey },
  ]);
  const events: Array<Record<string, unknown>> = [];
  const { server, base } = await start(undefined, {
    sponsors,
    onChallengeEvent: (event) => {
      events.push(event as unknown as Record<string, unknown>);
    },
  });

  try {
    const payload = sponsorshipPayload("alice");
    const response = await post(base, "/v1/challenges/sponsored", signedRequest(payload, privateKey));

    assert.equal(response.status, 201);
    const challenge = (await response.json()) as Challenge;
    assert.equal(challenge.id, "sponsored-half-adder");
    assert.equal(challenge.status, "sponsored");
    assert.equal(challenge.sponsor, "alice");
    assert.equal(challenge.title, "Community half adder");

    const listResponse = await fetch(`${base}/v1/challenges`);
    assert.equal(listResponse.status, 200);
    const list = (await listResponse.json()) as Challenge[];
    const listed = list.find((item) => item.id === "sponsored-half-adder");
    assert.equal(listed?.status, "sponsored");
    assert.equal(listed?.sponsor, "alice");

    const singleResponse = await fetch(`${base}/v1/challenges/sponsored-half-adder`);
    assert.equal(singleResponse.status, 200);
    const single = (await singleResponse.json()) as Challenge;
    assert.equal(single.status, "sponsored");
    assert.equal(single.sponsor, "alice");

    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "rarext.challenge.v1");
    assert.equal(events[0]!.version, 1);
    assert.equal(events[0]!.challengeId, "sponsored-half-adder");
    assert.equal(events[0]!.status, "sponsored");
    assert.equal(events[0]!.member, "alice");
    assert.equal(events[0]!.community, "trac");
    assert.equal((events[0]!.challenge as Challenge).status, "sponsored");
  } finally {
    await stop(server);
  }
});

test("delivers rarext.challenge.v1 to a configured webhook", async () => {
  const { publicKey, privateKey } = memberKeypair();
  const receiver = await startEventReceiver();
  const sponsors = createSponsorRegistry([
    { handle: "alice", community: "trac", publicKey },
  ]);
  const { server, base } = await start(undefined, {
    sponsors,
    challengeEventUrl: receiver.url,
  });

  try {
    const payload = sponsorshipPayload("alice");
    const response = await post(base, "/v1/challenges/sponsored", signedRequest(payload, privateKey));
    assert.equal(response.status, 201);
    assert.equal(receiver.events.length, 1);
    assert.equal(receiver.headers[0], "rarext.challenge.v1");

    const event = receiver.events[0]!;
    assert.equal(event.kind, "rarext.challenge.v1");
    assert.equal(event.challengeId, "sponsored-half-adder");
    assert.equal(event.status, "sponsored");
    assert.equal(event.member, "alice");
    assert.equal((event.challenge as Challenge).sponsor, "alice");
  } finally {
    await stop(server);
    await receiver.close();
  }
});

test("rejects unknown members, bad signatures, stale proofs, and replays", async () => {
  const alice = memberKeypair();
  const bob = memberKeypair();
  const sponsors = createSponsorRegistry([
    { handle: "alice", community: "trac", publicKey: alice.publicKey },
  ]);
  const { server, base } = await start(undefined, { sponsors });

  try {
    const unknown = sponsorshipPayload("bob");
    assert.equal(
      (await post(base, "/v1/challenges/sponsored", signedRequest(unknown, bob.privateKey))).status,
      403,
    );

    const forged = sponsorshipPayload("alice");
    assert.equal(
      (await post(base, "/v1/challenges/sponsored", signedRequest(forged, bob.privateKey))).status,
      401,
    );

    const stale = sponsorshipPayload("alice", {
      createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    });
    assert.equal(
      (await post(base, "/v1/challenges/sponsored", signedRequest(stale, alice.privateKey))).status,
      400,
    );

    const accepted = sponsorshipPayload("alice");
    const acceptedRequest = signedRequest(accepted, alice.privateKey);
    assert.equal((await post(base, "/v1/challenges/sponsored", acceptedRequest)).status, 201);
    assert.equal((await post(base, "/v1/challenges/sponsored", acceptedRequest)).status, 409);
  } finally {
    await stop(server);
  }
});

test("reports sponsorship unavailable when no member roster is configured", async () => {
  const { privateKey } = memberKeypair();
  const { server, base } = await start(undefined, {
    sponsors: createSponsorRegistry([]),
  });

  try {
    const payload = sponsorshipPayload("alice");
    const response = await post(base, "/v1/challenges/sponsored", signedRequest(payload, privateKey));
    assert.equal(response.status, 503);
  } finally {
    await stop(server);
  }
});

test("a community member can sponsor an AI challenge and it verifies with the built-in verifier", async () => {
  const { publicKey, privateKey } = memberKeypair();
  const sponsors = createSponsorRegistry([
    { handle: "alice", community: "trac", publicKey },
  ]);

  const createdAt = new Date().toISOString();
  const payload = sponsorshipPayload("alice", {
    challenge: {
      id: "sponsored-gen",
      app: "ai-generative",
      title: "Community generative challenge",
      description: "A member-sponsored replay challenge for a committed model.",
      version: 1,
      spec: { steps: 16 },
      semanticsId: "sponsored-gen",
      semanticsVersion: 1,
      createdAt,
    },
  });

  const result = verifyChallengeSponsorship(signedRequest(payload, privateKey), sponsors);
  assert.ok(!("error" in result));
  assert.equal(result.challenge.id, "sponsored-gen");
  assert.equal(result.challenge.app, "ai-generative");
  assert.equal(result.challenge.status, "sponsored");
  assert.equal(result.challenge.sponsor, "alice");

  // The built-in AI verifier accepts publications against the sponsored
  // challenge with no extra configuration: the spec is the contract.
  const model = {
    kind: "xorshift32" as const,
    params: { a: 13, b: 17, c: 5 },
    vocab: ["a", "b", "c", "d"],
  };
  const registry = createVerifierRegistry(fetch, null);
  const attestation = await registry.verify(
    {
      app: "ai-generative",
      kind: "ai.generative",
      version: 1,
      mediaType: "application/json",
      body: { model, seed: 42, output: generate(model, 42, 16) },
    },
    result.challenge,
  );

  assert.equal(attestation.correct, true);
  assert.equal(attestation.representation, "generative");
  assert.equal(attestation.challengeId, "sponsored-gen");
});

test("a created challenge survives a restart of the deployment", async () => {
  const storePath = join(mkdtempSync(join(tmpdir(), "rarext-durable-")), "rarext.json");
  const { publicKey, privateKey } = memberKeypair();
  const sponsors = createSponsorRegistry([
    { handle: "alice", community: "trac", publicKey },
  ]);
  const payload = sponsorshipPayload("alice");
  const signed = signedRequest(payload, privateKey);
  const events: Array<Record<string, unknown>> = [];

  // First deployment: the challenge is created and persisted to the store's snapshot.
  const first = await start(new RarextStore(storePath), {
    sponsors,
    onChallengeEvent: (event) => {
      events.push(event as unknown as Record<string, unknown>);
    },
  });
  const created = await post(first.base, "/v1/challenges/sponsored", signed);
  assert.equal(created.status, 201);
  await stop(first.server);

  // The RESTART: a fresh app instance on the same store path. The snapshot is the only
  // thing that carries over, so the challenge must come back from it — and so must the
  // anti-replay state the creation consumed.
  const second = await start(new RarextStore(storePath), {
    sponsors,
    onChallengeEvent: (event) => {
      events.push(event as unknown as Record<string, unknown>);
    },
  });
  try {
    const listResponse = await fetch(`${second.base}/v1/challenges`);
    const list = (await listResponse.json()) as Challenge[];
    const restored = list.find((item) => item.id === "sponsored-half-adder");
    assert.ok(restored, "the challenge created before the restart is listed after it");
    assert.equal(restored?.status, "sponsored");
    assert.equal(restored?.sponsor, "alice");

    const replay = await post(second.base, "/v1/challenges/sponsored", signed);
    assert.equal(replay.status, 409, "a replayed sponsorship is refused after a restart");
  } finally {
    await stop(second.server);
    rmSync(join(storePath, ".."), { recursive: true, force: true });
  }
});
