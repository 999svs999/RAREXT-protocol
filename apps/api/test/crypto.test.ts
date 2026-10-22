import assert from "node:assert/strict";
import test from "node:test";

import type { Circuit } from "../../../packages/core/src/index.ts";
import {
  AgentSigner,
  createAgentKeyfile,
  generateAgentKeypair,
  RarextClient,
  suiteOf,
} from "../../../packages/agent-sdk/src/index.ts";
import { post, start, stop } from "./helpers.ts";

const HALF_ADDER: Circuit = {
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

test("a post-quantum agent can register, publish, and be verified", async () => {
  const { server, base } = await start();

  try {
    const keypair = generateAgentKeypair("ml-dsa-44");
    assert.equal(suiteOf(keypair.publicKey), "ml-dsa-44");

    const client = new RarextClient({ baseUrl: base });
    const keyfile = createAgentKeyfile("pq-agent", keypair);
    const signer = new AgentSigner(keyfile.privateKey);

    await client.registerAgent(signer, keyfile.handle);

    const identity = (await (
      await fetch(`${base}/v1/identities/${keyfile.handle}`)
    ).json()) as { algorithm: string };

    assert.equal(identity.algorithm, "ml-dsa-44");

    const publication = await client.publishAs(signer, {
      author: keyfile.handle,
      title: "Signed with a post-quantum key",
      body: "The claim does not depend on ECDSA staying unbroken.",
      taskId: "half-adder",
      circuit: HALF_ADDER,
    });

    assert.equal(publication.signatureAlgorithm, "ml-dsa-44");
    assert.equal(publication.attestation.cryptoProfile, "post-quantum");
    assert.equal(publication.attestation.signatureAlgorithm, "ml-dsa-44");

    const verified = await client.verify(publication.id);
    assert.equal(verified.valid, true);
  } finally {
    await stop(server);
  }
});

test("a classical agent still works, and says so", async () => {
  const { server, base } = await start();

  try {
    const client = new RarextClient({ baseUrl: base });
    const keyfile = createAgentKeyfile("classical-agent");
    const signer = new AgentSigner(keyfile.privateKey);

    await client.registerAgent(signer, keyfile.handle);

    const publication = await client.publishAs(signer, {
      author: keyfile.handle,
      title: "Classical",
      body: "A browser can still do this.",
      taskId: "half-adder",
      circuit: HALF_ADDER,
    });

    assert.equal(publication.signatureAlgorithm, "ecdsa-p256");
    assert.equal(publication.attestation.cryptoProfile, "classical");

    const verified = await client.verify(publication.id);
    assert.equal(verified.valid, true);
  } finally {
    await stop(server);
  }
});

test("the registry publishes its crypto policy", async () => {
  const { server, base } = await start();

  try {
    const policy = (await (await fetch(`${base}/v1/crypto`)).json()) as {
      suites: { suite: string; quantumSafe: boolean; profile: string }[];
      defaultSuite: string;
      commitmentHash: string;
    };

    assert.ok(policy.suites.length >= 2);

    const classical = policy.suites.find((suite) => suite.suite === "ecdsa-p256");
    const quantum = policy.suites.find((suite) => suite.suite === "ml-dsa-44");

    assert.equal(classical?.quantumSafe, false);
    assert.equal(classical?.profile, "classical");
    assert.equal(quantum?.quantumSafe, true);
    assert.equal(quantum?.profile, "post-quantum");
    assert.equal(policy.defaultSuite, "ecdsa-p256");
  } finally {
    await stop(server);
  }
});

test("a signature cannot be reinterpreted under a different suite", async () => {
  const { server, base } = await start();

  try {
    const client = new RarextClient({ baseUrl: base });
    const keyfile = createAgentKeyfile("suite-probe");
    const signer = new AgentSigner(keyfile.privateKey);

    await client.registerAgent(signer, keyfile.handle);

    const payload = signer.publicationPayload({
      author: keyfile.handle,
      title: "Suite probe",
      body: "",
      taskId: "half-adder",
      circuit: HALF_ADDER,
    });

    assert.equal(payload.algorithm, "ecdsa-p256");

    // Claiming a different suite changes the signed bytes, so the signature
    // no longer matches what the registry recomputes.
    const response = await post(base, "/v1/publications", {
      payload: { ...payload, algorithm: "ml-dsa-44" },
      signature: signer.sign(payload),
    });

    assert.equal(response.status, 401);
  } finally {
    await stop(server);
  }
});
