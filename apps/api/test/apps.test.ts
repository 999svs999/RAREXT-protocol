import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type {
  AppInfo,
  Artifact,
  Challenge,
  LeaderboardEntry,
  Publication,
} from "../../../packages/core/src/index.ts";
import {
  AgentSigner,
  createAgentKeyfile,
  RarextClient,
} from "../../../packages/agent-sdk/src/index.ts";
import { createVerifierRegistry } from "../src/verifiers.ts";
import { post, start, stop } from "./helpers.ts";

const challenge: Challenge = {
  id: "echo-1",
  app: "echo-lab",
  title: "Echo a signal",
  description: "Return a verified echo of the submitted signal.",
  version: 1,
  spec: { kind: "echo" },
  semanticsId: "echo-lab/echo-1",
  semanticsVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const artifact: Artifact = {
  app: "echo-lab",
  kind: "echo.signal",
  version: 1,
  mediaType: "application/json",
  body: { value: 42 },
};

async function startVerifier() {
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const request = JSON.parse(body) as { artifact: Artifact };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          correct: true,
          score: 91,
          gateCount: 4,
          proof: { echoed: request.artifact.body },
        }),
      );
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return { server, url: `http://127.0.0.1:${port}/verify` };
}

test("external apps publish, verify, and rank artifacts", async () => {
  const previous = process.env.RAREXT_VERIFIERS;
  const verifier = await startVerifier();
  process.env.RAREXT_VERIFIERS = JSON.stringify({
    verifiers: [
      {
        app: "echo-lab",
        name: "Echo Lab",
        url: verifier.url,
        artifactKinds: ["echo.signal"],
      },
    ],
  });

  const challenges = {
    list: () => [challenge],
    get: (id: string) => (id === challenge.id ? challenge : null),
  };
  const { server, base } = await start(undefined, {
    challenges,
    verifiers: createVerifierRegistry(),
  });

  try {
    const response = await post(base, "/v1/artifacts", {
      author: "alice",
      title: "Echo build",
      challengeId: challenge.id,
      artifact,
    });
    assert.equal(response.status, 201);

    const publication = (await response.json()) as Publication;
    assert.equal(publication.app, "echo-lab");
    assert.equal(publication.challengeId, challenge.id);
    assert.equal(publication.taskId, challenge.id);
    assert.deepEqual(publication.artifact, artifact);
    assert.equal(publication.attestation.score, 91);
    assert.equal(publication.attestation.verifier, "http:echo-lab");

    const client = new RarextClient({ baseUrl: base });
    const keyfile = createAgentKeyfile("agent-echo");
    const signer = new AgentSigner(keyfile.privateKey);
    await client.registerAgent(signer, keyfile.handle);

    const signed = await client.publishArtifactAs(signer, {
      author: keyfile.handle,
      title: "Signed echo build",
      challengeId: challenge.id,
      artifact,
    });
    assert.equal(signed.authorKey, signer.keyId);
    assert.equal(signed.verified, true);
    assert.equal((await client.verify(signed.id)).valid, true);

    const apps = (await (await fetch(`${base}/v1/apps`)).json()) as AppInfo[];
    const app = apps.find((candidate) => candidate.id === "echo-lab");
    assert.equal(app?.verifier, "http");
    assert.equal(app?.challengeCount, 1);

    const fetched = (await (
      await fetch(`${base}/v1/artifacts/${publication.id}`)
    ).json()) as Publication;
    assert.equal(fetched.id, publication.id);

    const challengeResponse = await fetch(`${base}/v1/challenges/${challenge.id}`);
    assert.equal(challengeResponse.status, 200);

    const verifyResponse = await post(base, "/v1/verify", {
      publicationId: publication.id,
    });
    assert.equal(verifyResponse.status, 200);
    assert.equal(((await verifyResponse.json()) as { valid: boolean }).valid, true);

    const leaderboard = (await (
      await fetch(`${base}/v1/leaderboard?app=echo-lab`)
    ).json()) as LeaderboardEntry[];
    assert.equal(leaderboard.length, 2);
    assert.equal(leaderboard[0].rank, 1);
    assert.equal(leaderboard[0].score, 91);
    assert.ok(leaderboard.some((entry) => entry.buildId === publication.id));
    assert.ok(leaderboard.some((entry) => entry.buildId === signed.id));
  } finally {
    if (previous === undefined) {
      delete process.env.RAREXT_VERIFIERS;
    } else {
      process.env.RAREXT_VERIFIERS = previous;
    }
    await stop(server);
    verifier.server.closeAllConnections();
    await new Promise<void>((resolve) => verifier.server.close(() => resolve()));
  }
});

test("rejects artifacts for an unregistered app", async () => {
  const { server, base } = await start(undefined, {
    challenges: {
      list: () => [challenge],
      get: (id: string) => (id === challenge.id ? challenge : null),
    },
  });

  try {
    const response = await post(base, "/v1/artifacts", {
      author: "alice",
      title: "Unknown app",
      challengeId: challenge.id,
      artifact,
    });
    assert.equal(response.status, 404);
  } finally {
    await stop(server);
  }
});
