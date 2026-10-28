import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

import type { AttestationBinding, Circuit, Task } from "@rarext/core";
import { merkleRoot, publicationLeaf } from "@rarext/core";
import { AgentSigner, generateAgentKeypair, selfPublish, verifyBundle } from "../src/index.ts";

/**
 * Make AND prove, with no server: an agent attests a run it performed itself,
 * signs the record, and assembles a bundle anybody can verify.
 *
 * The fixture is a real half adder — the same circuit the registry's own suites
 * publish — so the run being attested is a run of something, not a stand-in.
 */

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

const halfAdderTask: Task = {
  id: "half-adder",
  title: "Half adder",
  description: "sum and carry from two bits",
  inputs: ["a", "b"],
  outputs: ["sum", "carry"],
  cases: [
    { inputs: { a: 0, b: 0 }, outputs: { sum: 0, carry: 0 } },
    { inputs: { a: 0, b: 1 }, outputs: { sum: 1, carry: 0 } },
    { inputs: { a: 1, b: 0 }, outputs: { sum: 1, carry: 0 } },
    { inputs: { a: 1, b: 1 }, outputs: { sum: 0, carry: 1 } },
  ],
  referenceGateCount: 3,
};

const binding: AttestationBinding = {
  semanticsId: "half-adder/v1",
  semanticsVersion: 1,
  semanticsHash: "0".repeat(64),
  claimKind: "satisfies",
  scope: null,
  verifierHash: "1".repeat(64),
  proofKind: "recomputable",
  signatureAlgorithm: "ecdsa-p256",
  cryptoProfile: "classical",
};

const artifact = { app: "rarext", kind: "circuit", version: 1, mediaType: "application/json", body: "{}" };

test("a resident attests, signs and assembles its own verifiable bundle", async () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const { attestation, publication, bundle } = selfPublish(signer, {
    author: "resident",
    title: "A half adder, run here",
    artifact,
    circuit: halfAdder,
    task: halfAdderTask,
    binding,
    createdAt: "2026-10-28T00:00:00.000Z",
  });

  const verification = verifyBundle(bundle);
  assert.equal(verification.valid, true, verification.reason ?? undefined);

  // The run was really run: a correct half adder scores, and the attestation
  // records the arithmetic it did rather than accepting a claim about it.
  assert.equal(attestation.correct, true, "the circuit satisfies every case");
  assert.ok(attestation.gateCount > 0, "and the run counted gates");

  // The record is signed by the agent's own key, over the payload it submitted.
  assert.equal(publication.authorKey, signer.keyId);
  assert.equal(publication.signatureAlgorithm, signer.suite);
  assert.ok(publication.signature && publication.signature.length > 0);
  assert.equal(publication.attestation?.id, attestation.id, "the bundle carries THIS agent's attestation");
  assert.equal(publication.verification, "recomputed");

  // And the bundle's root is the Merkle root over its own leaves — recomputed
  // here, with the test's own hash, so this asserts the arithmetic rather than
  // echoing a field the builder produced.
  const sha256 = (bytes: Uint8Array): Uint8Array =>
    new Uint8Array(createHash("sha256").update(bytes).digest());
  const leaves = [publicationLeaf(publication, sha256, bundle.manifest.leafVersion)];
  assert.equal(bundle.manifest.root, merkleRoot(leaves, sha256), "the root is over these leaves");
  assert.equal(bundle.manifest.publications.length, 1);
  assert.equal(bundle.manifest.publications[0]!.id, publication.id);
  assert.equal(bundle.manifest.publications[0]!.leaf, leaves[0], "and the manifest lists the leaf itself");
});

test("the verifier is named by the caller: an agent attesting as itself says so", async () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const mine = selfPublish(signer, {
    author: "resident",
    title: "named",
    artifact,
    circuit: halfAdder,
    task: halfAdderTask,
    binding,
    createdAt: "2026-10-28T00:00:00.000Z",
  }, { verifier: "my-agent-v1" });
  assert.equal(mine.attestation.verifier, "my-agent-v1");

  const theirs = selfPublish(signer, {
    author: "resident",
    title: "unnamed",
    artifact,
    circuit: halfAdder,
    task: halfAdderTask,
    binding,
    createdAt: "2026-10-28T00:00:00.000Z",
  });
  assert.equal(theirs.attestation.verifier, "resident", "and the default claims no registry's name");
});

test("the same run attests the same trace, and a different circuit does not", async () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const run = (circuit: Circuit) =>
    selfPublish(signer, {
      author: "resident",
      title: "trace",
      artifact,
      circuit,
      task: halfAdderTask,
      binding,
      createdAt: "2026-10-28T00:00:00.000Z",
    });

  const first = run(halfAdder);
  const again = run(halfAdder);
  assert.equal(
    first.attestation.traceHash,
    again.attestation.traceHash,
    "the trace hash is a function of the run, not of when or where it happened",
  );
  assert.notEqual(first.attestation.id, again.attestation.id, "while the ids differ");

  const different: Circuit = {
    components: [
      ...halfAdder.components,
      { id: "extra", type: "NAND", inputs: ["a", "b"] },
    ],
  };
  assert.notEqual(
    run(different).attestation.traceHash,
    first.attestation.traceHash,
    "a different circuit is a different run",
  );
});

test("a bundle whose publication changed after signing no longer matches its root", async () => {
  const signer = new AgentSigner(generateAgentKeypair().privateKey);
  const { publication, bundle } = selfPublish(signer, {
    author: "resident",
    title: "tamper",
    artifact,
    circuit: halfAdder,
    task: halfAdderTask,
    binding,
    createdAt: "2026-10-28T00:00:00.000Z",
  });

  const tampered = { ...publication, title: `${publication.title} (altered)` };
  const rebuilt = { ...bundle, publications: [tampered] };
  const verification = verifyBundle(rebuilt);
  assert.equal(verification.valid, false, "the manifest no longer describes these publications");
  assert.match(String(verification.reason), /do not rebuild the anchored root|manifest/);
});
