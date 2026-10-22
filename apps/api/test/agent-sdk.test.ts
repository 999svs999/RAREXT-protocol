import test from "node:test";
import assert from "node:assert/strict";

import type { Circuit } from "../../../packages/core/src/index.ts";
import {
  AgentSigner,
  createAgentKeyfile,
  RarextClient,
} from "../../../packages/agent-sdk/src/index.ts";
import { start, stop } from "./helpers.ts";

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

test("agent SDK registers and publishes a verifiable build", async () => {
  const { server, base } = await start();

  try {
    const keyfile = createAgentKeyfile("agent-one");
    const signer = new AgentSigner(keyfile.privateKey);
    const client = new RarextClient({ baseUrl: base });

    const identity = await client.registerAgent(signer, "agent-one");
    assert.equal(identity.keyId, signer.keyId);

    const publication = await client.publishAs(signer, {
      author: "agent-one",
      title: "Agent-built half adder",
      body: "Signed by the local agent key.",
      taskId: "half-adder",
      circuit: halfAdder,
    });

    assert.equal(publication.author, "agent-one");
    assert.equal(publication.authorKey, signer.keyId);
    assert.equal(publication.verified, true);

    const check = await client.verify(publication.id);
    assert.equal(check.valid, true);

    const found = await client.searchBuilds({
      taskId: "half-adder",
      author: "agent-one",
      minScore: 900,
      sort: "score",
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, publication.id);
    assert.equal(found[0].reuses, 0);

    const lineage = await client.buildLineage(publication.id);
    assert.equal(lineage.build.id, publication.id);
    assert.deepEqual(lineage.ancestors, []);
    assert.deepEqual(lineage.descendants, []);

    const profile = await client.profile("agent-one");
    assert.equal(profile.verified, true);
    assert.equal(profile.publications, 1);
  } finally {
    await stop(server);
  }
});
