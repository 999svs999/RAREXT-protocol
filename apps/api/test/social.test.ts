import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import type { Circuit, Profile, Publication } from "../../../packages/core/src/index.ts";
import { createApp } from "../src/app.ts";
import { RarextStore } from "../src/store.ts";

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

const inverter: Circuit = {
  components: [
    { id: "a", type: "INPUT" },
    { id: "n", type: "NAND", inputs: ["a", "a"] },
    { id: "sum", type: "OUTPUT", inputs: ["n"] },
  ],
};

async function start() {
  const server = createApp({ store: new RarextStore() });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

test("publish, feed, profile, and verify", async () => {
  const { server, base } = await start();

  try {
    const scoreResponse = await fetch(`${base}/v1/score`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ circuit: halfAdder, taskId: "half-adder" }),
    });

    const score = (await scoreResponse.json()) as { score: number };
    assert.equal(score.score, 1000);

    const publishResponse = await fetch(`${base}/v1/publications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        author: "builder",
        title: "Five-gate half adder",
        body: "Shares the first NAND for sum and carry.",
        taskId: "half-adder",
        circuit: halfAdder,
      }),
    });

    assert.equal(publishResponse.status, 201);
    const publication = (await publishResponse.json()) as Publication;
    assert.equal(publication.attestation.correct, true);
    assert.equal(publication.attestation.score, 1000);
    assert.equal(publication.attestation.traceHash.length, 64);
    assert.equal(publication.parentId, null);

    const feedResponse = await fetch(`${base}/v1/feed`);
    const feed = (await feedResponse.json()) as Publication[];
    assert.equal(feed.length, 1);
    assert.equal(feed[0].id, publication.id);

    const profileResponse = await fetch(`${base}/v1/profiles/builder`);
    const profile = (await profileResponse.json()) as Profile;
    assert.equal(profile.publications, 1);
    assert.equal(profile.bestScore, 1000);

    const verifyResponse = await fetch(`${base}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicationId: publication.id }),
    });

    const verification = (await verifyResponse.json()) as { valid: boolean };
    assert.equal(verification.valid, true);
  } finally {
    server.close();
  }
});

test("rejects a circuit that does not pass the task", async () => {
  const { server, base } = await start();

  try {
    const response = await fetch(`${base}/v1/publications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        author: "builder",
        title: "Not a half adder",
        taskId: "half-adder",
        circuit: inverter,
      }),
    });

    assert.equal(response.status, 422);
  } finally {
    server.close();
  }
});

test("remixes reference a parent publication", async () => {
  const { server, base } = await start();

  try {
    const parentResponse = await fetch(`${base}/v1/publications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        author: "builder",
        title: "Half adder",
        taskId: "half-adder",
        circuit: halfAdder,
      }),
    });

    const parent = (await parentResponse.json()) as Publication;

    const childResponse = await fetch(`${base}/v1/publications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        author: "remixer",
        title: "Half adder remix",
        taskId: "half-adder",
        circuit: halfAdder,
        parentId: parent.id,
      }),
    });

    assert.equal(childResponse.status, 201);
    const child = (await childResponse.json()) as Publication;
    assert.equal(child.parentId, parent.id);

    const remixResponse = await fetch(`${base}/v1/feed?parentId=${parent.id}`);
    const remixes = (await remixResponse.json()) as Publication[];
    assert.equal(remixes.length, 1);
    assert.equal(remixes[0].id, child.id);
  } finally {
    server.close();
  }
});
