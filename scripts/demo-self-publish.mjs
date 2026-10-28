#!/usr/bin/env node
/**
 * demo-self-publish.mjs — "AI lives on RAREXT", as a runnable fact.
 *
 * The resident demo REPLAYS the world's claims. This one MAKES them: an agent
 * with no server, no operator and no registry runs a circuit AND a generation,
 * attests each run as itself, signs the records with its own key, assembles
 * bundles, and then proves the artifacts are portable — the signatures verify
 * against the agent's own public key, the bundles that come back off the wire
 * re-verify, and the AI claim replays correct from the bytes alone.
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

import { readFileSync } from "node:fs";

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

// The same agent, its own generation: not a circuit this time but an AI output.
// The committed model, seed and challenge are the ones the PUBLISHED bundle was
// generated with, so the run can be compared against the world's — and the claim
// it makes can be replayed by a stranger holding only the bytes.
const registry = JSON.parse(readFileSync(new URL("../site/registry/bundle.json", import.meta.url), "utf8"));
const published = registry.publications.find((entry) => entry.app === "ai-generative");
const challenge = registry.challenges.find((entry) => entry.id === "gen-starter");
const semantics = registry.semantics.filter((entry) => entry.id === "ai-generative/gen-starter");

const generated = sdk.selfPublishGenerative(signer, {
  author: "resident",
  title: "The starter model, run and attested here",
  body: "Generated on this node from the committed model — no API, no registry.",
  model: published.artifact.body.model,
  seed: published.artifact.body.seed,
  challenge,
  semantics,
  binding: { id: "ai-generative/gen-starter", version: 1, claimKind: "generative" },
});

check(
  "the agent's own run reproduces the PUBLISHED output",
  generated.publication.artifact.body.output === published.artifact.body.output,
  `${generated.attestation.gateCount} steps, ${generated.publication.artifact.body.output.length} tokens`,
);
check(
  "the generation is signed by the agent, over this payload",
  sdk.verifyPayload(signer.publicKey, generated.payload, generated.publication.signature, signer.suite),
  `rule ${generated.attestation.verifier}`,
);
const generatedVerdict = sdk.verifyBundle(generated.bundle);
check("the generative bundle verifies", generatedVerdict.valid === true, generatedVerdict.reason ?? "valid");
const replayed = sdk.replayBundleAi(JSON.parse(JSON.stringify(generated.bundle)));
check(
  "the AI claim replays CORRECT from the bundle alone",
  replayed.claims.length === 1 && replayed.claims[0].correct === true,
  `${replayed.claims[0]?.representation ?? "none"} · root ${replayed.root?.slice(0, 16)}…`,
);
check(
  "the replay is tied to the bundle's own root",
  replayed.root === generated.bundle.manifest.root,
  replayed.root?.slice(0, 16),
);

// And the representation real model classes take: a LOSSY reconstruction, where
// the claim is a distance rather than an exact match. The same agent computes the
// metric on its own node — and the demo also checks the negative, because a
// promise about a bound is only worth something if breaking it is caught.
const boundedPublished = registry.publications.find((entry) => entry.app === "ai-bounded");
const boundedChallenge = registry.challenges.find((entry) => entry.id === boundedPublished.challengeId);
const boundedSemantics = registry.semantics.filter((entry) => entry.id.startsWith("ai-bounded/"));
const boundedBinding = { id: `ai-bounded/${boundedChallenge.id}`, version: 1, claimKind: "bounded" };

const bounded = sdk.selfPublishBounded(signer, {
  author: "resident",
  title: "A quantized reconstruction, attested here",
  body: "Within the committed bound, measured on this node.",
  values: [...boundedPublished.artifact.body.values],
  challenge: boundedChallenge,
  semantics: boundedSemantics,
  binding: boundedBinding,
});

const boundedVerdict = sdk.verifyBundle(bounded.bundle);
check("the bounded bundle verifies", boundedVerdict.valid === true, boundedVerdict.reason ?? "valid");
const boundedReplay = sdk.replayBundleAi(JSON.parse(JSON.stringify(bounded.bundle)));
check(
  "the distance claim replays CORRECT from the bundle alone",
  boundedReplay.claims.length === 1 && boundedReplay.claims[0].correct === true,
  `${bounded.attestation.metricName} = ${bounded.attestation.metricValue} (bound ${boundedChallenge.spec.bound})`,
);

// The negative: push the reconstruction past its promised distance. The claim is
// now false, and no signature or attestation can make it true.
const boundValue = boundedChallenge.spec.bound ?? 0;
const outside = sdk.selfPublishBounded(signer, {
  author: "resident",
  title: "outside the bound",
  values: boundedPublished.artifact.body.values.map((value) => value + boundValue + 4),
  challenge: boundedChallenge,
  semantics: boundedSemantics,
  binding: boundedBinding,
});
const outsideReplay = sdk.replayBundleAi(JSON.parse(JSON.stringify(outside.bundle)));
check(
  "a reconstruction OUTSIDE the bound is refused",
  outsideReplay.claims.length === 1 && outsideReplay.claims[0].correct === false,
  `${outside.attestation.metricName} = ${outside.attestation.metricValue} > ${boundValue}`,
);

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
