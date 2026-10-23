import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type {
  Anchor,
  Circuit,
  JsonWebKey,
  Publication,
} from "../../../packages/core/src/index.ts";

import {
  CONSENSUS_CHAIN_ID,
  CONSENSUS_PROOF_KIND,
  CONSENSUS_STATE_KIND,
  CONSENSUS_VALIDATION_KIND,
  parseSettlementMinimum,
  settlementGate,
  type ConsensusAnchorProof,
  type ConsensusState,
  type ConsensusValidation,
} from "../src/consensus.ts";
import { RarextStore } from "../src/store.ts";
import { post, start, stop } from "./helpers.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/consensus-settlement.json", import.meta.url),
    "utf8",
  ),
) as {
  minimum: number;
  scenarios: {
    name: string;
    volume: number;
    status: string;
    valid: boolean;
    remainingToExceed: number;
  }[];
};

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

async function publish(base: string, author: string): Promise<Publication> {
  const response = await post(base, "/v1/publications", {
    author,
    title: `${author} half adder`,
    taskId: "half-adder",
    circuit: halfAdder,
  });

  assert.equal(response.status, 201);
  return (await response.json()) as Publication;
}

async function anchor(base: string): Promise<Anchor> {
  const response = await post(base, "/v1/anchors", {});
  assert.equal(response.status, 201);
  return (await response.json()) as Anchor;
}

function proofFor(
  state: ConsensusState,
  anchor: Anchor,
): ConsensusAnchorProof {
  return {
    kind: CONSENSUS_PROOF_KIND,
    version: 1,
    chainId: state.chainId,
    height: state.head.height,
    head: state.head.hash,
    stateRoot: state.stateRoot,
    anchorId: anchor.id,
    root: anchor.root,
    issuedAt: "2026-10-23T12:00:00.000Z",
  };
}

function signatureFor(proof: ConsensusAnchorProof): {
  publicKey: JsonWebKey;
  signature: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });

  const signature = sign(
    "sha256",
    Buffer.from(canonicalize(proof)),
    { key: privateKey, dsaEncoding: "ieee-p1363" },
  ).toString("base64");

  return {
    publicKey: publicKey.export({ format: "jwk" }) as JsonWebKey,
    signature,
  };
}

test("the settlement fixture keeps below, at, and above distinct", () => {
  for (const scenario of fixture.scenarios) {
    const gate = settlementGate(scenario.volume, fixture.minimum);

    assert.equal(gate.status, scenario.status, scenario.name);
    assert.equal(gate.valid, scenario.valid, scenario.name);
    assert.equal(
      gate.remainingToExceed,
      scenario.remainingToExceed,
      scenario.name,
    );
    assert.equal(gate.productionDataPending, true);
    assert.equal(gate.liveGating, false);
  }
});

test("an unset settlement minimum never validates", () => {
  const gate = settlementGate(1_000_000, null);

  assert.equal(gate.status, "unconfigured");
  assert.equal(gate.valid, false);
  assert.equal(gate.minimum, null);
  assert.equal(parseSettlementMinimum(undefined), null);
  assert.equal(parseSettlementMinimum(""), null);
  assert.equal(parseSettlementMinimum("10"), 10);
  assert.throws(() => parseSettlementMinimum("-1"), /non-negative integer/);
  assert.throws(() => parseSettlementMinimum("1.5"), /non-negative integer/);
});

test("the consensus state and signed proof read the anchor audit trail", async () => {
  const store = new RarextStore();
  const { server, base } = await start(store, {
    consensus: { settlementMinimum: 1 },
  });

  try {
    await publish(base, "alice");
    const first = await anchor(base);
    const firstState = (await (
      await fetch(`${base}/v1/consensus/state`)
    ).json()) as ConsensusState;
    const firstProof = proofFor(firstState, first);
    await publish(base, "bob");
    const second = await anchor(base);

    const stateResponse = await fetch(`${base}/v1/consensus/state`);
    assert.equal(stateResponse.status, 200);
    const state = (await stateResponse.json()) as ConsensusState;

    assert.equal(state.kind, CONSENSUS_STATE_KIND);
    assert.equal(state.version, 1);
    assert.equal(state.chainId, CONSENSUS_CHAIN_ID);
    assert.equal(state.head.height, 2);
    assert.equal(state.head.hash.length, 64);
    assert.equal(state.stateRoot.length, 64);
    assert.equal(state.audit.source, "anchor-audit-trail");
    assert.equal(state.audit.anchors, 2);
    assert.equal(state.audit.publications, 2);
    assert.equal(state.settlement.volume, 2);
    assert.equal(state.settlement.minimum, 1);
    assert.equal(state.settlement.status, "above-threshold");
    assert.equal(state.settlement.valid, true);
    assert.equal(state.settlement.liveGating, false);

    const proof = proofFor(state, second);
    const signed = signatureFor(proof);
    const validationResponse = await post(base, "/v1/consensus/validate", {
      proof,
      publicKey: signed.publicKey,
      signature: signed.signature,
    });
    assert.equal(validationResponse.status, 200);
    const validation = (await validationResponse.json()) as ConsensusValidation;

    assert.equal(validation.kind, CONSENSUS_VALIDATION_KIND);
    assert.equal(validation.valid, true, validation.reason ?? "");
    assert.equal(validation.reason, null);
    assert.equal(validation.signature.valid, true);
    assert.equal(validation.anchor.found, true);
    assert.equal(validation.anchor.matches, true);
    assert.equal(validation.chain.headMatches, true);
    assert.equal(validation.chain.anchorIncluded, true);
    assert.equal(validation.chain.currentHeight, 2);
    assert.equal(validation.chain.currentHead, state.head.hash);
    assert.equal(validation.settlement.status, "above-threshold");

    // A proof at height 1 remains valid after height 2 is anchored.
    const firstSigned = signatureFor(firstProof);
    const historicalResponse = await post(base, "/v1/consensus/validate", {
      proof: firstProof,
      publicKey: firstSigned.publicKey,
      signature: firstSigned.signature,
    });
    const historical =
      (await historicalResponse.json()) as ConsensusValidation;
    assert.equal(historicalResponse.status, 200);
    assert.equal(historical.valid, true, historical.reason ?? "");
    assert.equal(historical.chain.height, 1);
    assert.equal(historical.chain.headMatches, true);
    assert.equal(historical.chain.currentHeight, 2);

    const tamperedResponse = await post(base, "/v1/consensus/validate", {
      proof,
      publicKey: signed.publicKey,
      signature: "not-a-signature",
    });
    const tampered = (await tamperedResponse.json()) as ConsensusValidation;
    assert.equal(tamperedResponse.status, 200);
    assert.equal(tampered.valid, false);
    assert.equal(tampered.reason, "signature-invalid");
  } finally {
    await stop(server);
  }
});

test("the endpoint keeps an at-threshold settlement invalid", async () => {
  const store = new RarextStore();
  const { server, base } = await start(store, {
    consensus: { settlementMinimum: 1 },
  });

  try {
    await publish(base, "alice");
    const anchorRecord = await anchor(base);
    const state = (await (
      await fetch(`${base}/v1/consensus/state`)
    ).json()) as ConsensusState;
    assert.equal(state.settlement.status, "at-threshold");
    assert.equal(state.settlement.valid, false);

    const proof = proofFor(state, anchorRecord);
    const signed = signatureFor(proof);
    const response = await post(base, "/v1/consensus/validate", {
      proof,
      publicKey: signed.publicKey,
      signature: signed.signature,
    });
    const validation = (await response.json()) as ConsensusValidation;

    assert.equal(response.status, 200);
    assert.equal(validation.valid, false);
    assert.equal(validation.reason, "settlement-at-threshold");
    assert.equal(validation.signature.valid, true);
    assert.equal(validation.anchor.found, true);
    assert.equal(validation.chain.headMatches, true);
  } finally {
    await stop(server);
  }
});

test("a signed proof for an unknown anchor is not valid", async () => {
  const store = new RarextStore();
  const { server, base } = await start(store, {
    consensus: { settlementMinimum: 0 },
  });

  try {
    await publish(base, "alice");
    await anchor(base);

    const state = (await (
      await fetch(`${base}/v1/consensus/state`)
    ).json()) as ConsensusState;
    const proof = {
      ...proofFor(state, store.listAnchors()[0]!),
      anchorId: "missing-anchor",
    };
    const signed = signatureFor(proof);
    const response = await post(base, "/v1/consensus/validate", {
      proof,
      publicKey: signed.publicKey,
      signature: signed.signature,
    });
    const validation = (await response.json()) as ConsensusValidation;

    assert.equal(response.status, 200);
    assert.equal(validation.valid, false);
    assert.equal(validation.reason, "anchor-not-found");
    assert.equal(validation.anchor.found, false);
  } finally {
    await stop(server);
  }
});
