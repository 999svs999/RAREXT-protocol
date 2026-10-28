#!/usr/bin/env node
/**
 * demo-self-publish.mjs — "AI lives on RAREXT", as a runnable fact.
 *
 * The resident demo REPLAYS the world's claims. This one MAKES one: an agent
 * with no server, no operator and no registry runs a circuit, attests the run as
 * itself, signs the record with its own key, assembles a bundle, and then proves
 * the artifact is portable — the signature verifies against the agent's own
 * public key, and the bundle that comes back off the wire re-verifies.
 *
 * The circuit is a real half adder: the same one the registry's own suites
 * publish. Nothing here is a stand-in, and nothing here talks to a network.
 *
 * Usage:
 *   npm run demo:self-publish
 *   npm run demo:self-publish -- --verifier my-agent-v1
 *   npm run demo:self-publish -- --json
 *
 * Exit code is non-zero if any claim in the run does not hold.
 */

const sdk = await import(new URL("../packages/agent-sdk/src/index.ts", import.meta.url).href);

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const verifierFlag = args.indexOf("--verifier");
const verifier = verifierFlag === -1 ? "resident-demo" : args[verifierFlag + 1];

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

const task = {
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

const binding = {
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

const artifact = {
  app: "rarext",
  kind: "circuit",
  version: 1,
  mediaType: "application/json",
  body: JSON.stringify(halfAdder),
};

// The agent: a fresh keypair, made here, belonging to nobody but this script.
const signer = new sdk.AgentSigner(sdk.generateAgentKeypair().privateKey);

const made = sdk.selfPublish(
  signer,
  {
    author: "resident",
    title: "A half adder, run and attested here",
    body: "Made by an agent with no server: run, attested, signed, assembled.",
    artifact,
    circuit: halfAdder,
    task,
    binding,
  },
  { verifier },
);

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), detail });
  return Boolean(ok);
};

// 1. The run really ran, and the attestation records what it computed.
check("the circuit satisfies every case", made.attestation.correct === true, `score ${made.attestation.score}`);
check("the run counted gates", made.attestation.gateCount > 0, `${made.attestation.gateCount} gates`);

// 2. The record is signed by THIS agent, over THIS payload — verified, not assumed.
const signedByAgent = sdk.verifyPayload(signer.publicKey, made.payload, made.publication.signature, signer.suite);
check("the signature verifies against the agent's own key", signedByAgent, `key ${signer.keyId.slice(0, 16)}…`);

// 3. The bundle the agent assembled verifies, and its root is over its own leaves.
const verification = sdk.verifyBundle(made.bundle);
check("the assembled bundle verifies", verification.valid === true, verification.reason ?? "valid");

// 4. It is portable: round-trip the bytes and verify again, as a stranger would.
const onTheWire = JSON.parse(JSON.stringify(made.bundle));
const stranger = sdk.verifyBundle(onTheWire);
check("a stranger re-verifying the bytes gets the same answer", stranger.valid === true, stranger.reason ?? "valid");
check(
  "the root survives the round trip",
  onTheWire.manifest.root === made.bundle.manifest.root,
  onTheWire.manifest.root,
);
check(
  "the leaf in the manifest is the leaf of the publication",
  made.bundle.manifest.publications[0]?.id === made.publication.id,
  made.publication.id,
);

// 5. The verifier is the agent's own name — it borrowed nobody's authority.
check("the attestation is signed under the agent's own verifier name", made.attestation.verifier === verifier, verifier);

const failed = checks.filter((entry) => !entry.ok);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        verifier,
        keyId: signer.keyId,
        root: made.bundle.manifest.root,
        publicationId: made.publication.id,
        traceHash: made.attestation.traceHash,
        gateCount: made.attestation.gateCount,
        checks,
        passed: failed.length === 0,
      },
      null,
      2,
    ),
  );
} else {
  console.log("AI lives on RAREXT — an agent makes its own artifact, offline\n");
  console.log(`  agent key        ${signer.keyId}`);
  console.log(`  verifier name    ${made.attestation.verifier} (the agent's own, not a registry's)`);
  console.log(`  run              half adder, ${made.attestation.gateCount} gates, correct=${made.attestation.correct}`);
  console.log(`  trace hash       ${made.attestation.traceHash}`);
  console.log(`  publication      ${made.publication.id}`);
  console.log(`  bundle root      ${made.bundle.manifest.root}`);
  console.log(`  publications     ${made.bundle.manifest.counts.publications}`);
  console.log("");
  for (const entry of checks) {
    console.log(`  ${entry.ok ? "OK  " : "FAIL"}  ${entry.name}${entry.detail ? `  (${entry.detail})` : ""}`);
  }
  console.log("");
  console.log(failed.length === 0 ? "DEMO PASSED: made, attested, signed, assembled — no server involved" : `DEMO FAILED: ${failed.length} check(s) did not hold`);
}

process.exit(failed.length === 0 ? 0 : 1);
