import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentSigner,
  RarextClient,
  generateAgentKeypair,
} from "../../../packages/agent-sdk/src/index.ts";
import { runExternalAgent } from "../../../examples/external-agent/agent.ts";
import { RarextStore } from "../src/store.ts";
import { start, stop } from "./helpers.ts";

test("an external agent registers, publishes, verifies, and discovers over HTTP", async () => {
  const app = await start(new RarextStore(), { apiToken: "agent-secret" });

  try {
    const result = await runExternalAgent({
      baseUrl: app.base,
      handle: "remote-builder",
      apiKey: "agent-secret",
    });

    assert.equal(result.verified, true);
    assert.equal(result.identityKeyId, result.signer.keyId);
    assert.equal(result.publication.author, "remote-builder");
    assert.equal(result.publication.authorKey, result.signer.keyId);
    assert.ok(result.discovered.some((entry) => entry.id === result.publication.id));
    assert.ok(result.tasks > 0);
    assert.ok(result.apps > 0);
  } finally {
    await stop(app.server);
  }
});

test("without the write token an external agent can read but not publish", async () => {
  const app = await start(new RarextStore(), { apiToken: "agent-secret" });

  try {
    const anonymous = new RarextClient({ baseUrl: app.base });

    const challenges = await anonymous.challenges();
    assert.ok(challenges.length > 0);

    await assert.rejects(
      runExternalAgent({ baseUrl: app.base, handle: "anonymous-builder" }),
      /unauthorized/,
    );

    const wrong = new RarextClient({ baseUrl: app.base, apiKey: "wrong" });
    const signer = new AgentSigner(generateAgentKeypair().privateKey);
    await assert.rejects(wrong.registerAgent(signer, "anonymous-builder"), /unauthorized/);
  } finally {
    await stop(app.server);
  }
});

test("two external agents get independent identities on one node", async () => {
  const app = await start();

  try {
    const [left, right] = await Promise.all([
      runExternalAgent({ baseUrl: app.base, handle: "agent-left" }),
      runExternalAgent({ baseUrl: app.base, handle: "agent-right" }),
    ]);

    assert.notEqual(left.identityKeyId, right.identityKeyId);
    assert.notEqual(left.publication.id, right.publication.id);
    assert.equal(left.publication.author, "agent-left");
    assert.equal(right.publication.author, "agent-right");

    const feed = await new RarextClient({ baseUrl: app.base }).feed({ limit: 10 });
    assert.ok(feed.some((entry) => entry.id === left.publication.id));
    assert.ok(feed.some((entry) => entry.id === right.publication.id));
  } finally {
    await stop(app.server);
  }
});
