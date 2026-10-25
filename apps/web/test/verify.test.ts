import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalize,
  generate,
  leafPayload,
  RASTER_RULE,
  renderRaster,
} from "@rarext/core";
import type { Publication } from "@rarext/core";

import { localVerdict, verifyBundle, type Bundle } from "../src/verify.ts";

/**
 * The mirror verifier is what a stranger runs when the operator is gone, so it
 * has to agree with the registry for every tree shape, not just the one the
 * takedown test happens to publish.
 */

function publication(id: string, title = `build ${id}`): Publication {
  return {
    id,
    author: "alice",
    authorKey: "a".repeat(64),
    signatureAlgorithm: "ecdsa-p256",
    title,
    body: "A claim.",
    app: "logic",
    challengeId: "half-adder",
    artifact: {
      app: "logic",
      kind: "logic.netlist",
      version: 1,
      mediaType: "application/json",
      body: { components: [] },
    },
    taskId: "half-adder",
    circuit: { components: [] },
    visibility: "public",
    artifactCommitment: null,
    parentId: null,
    source: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    attestedAt: "2026-01-01T00:00:00.000Z",
    verified: true,
    signature: "c2lnbmF0dXJl",
    nonce: `nonce-${id}`,
    attestation: {
      id: `att-${id}`,
      verifier: "fabric-v0",
      app: "logic",
      challengeId: "half-adder",
      taskId: "half-adder",
      circuitHash: "circuit-hash",
      traceHash: "trace-hash",
      correct: true,
      score: 1000,
      gateCount: 5,
      semanticsId: "logic/half-adder",
      semanticsVersion: 1,
      semanticsHash: "semantics-hash",
      claimKind: "satisfies",
      scope: null,
      verifierHash: "verifier-hash",
      proofKind: "recomputable",
      signatureAlgorithm: "ecdsa-p256",
      cryptoProfile: "classical",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pair(left: string, right: string): string {
  return createHash("sha256").update(left).update(right).digest("hex");
}

function root(leaves: string[]): string {
  if (leaves.length === 0) return hex("");
  if (leaves.length === 1) return leaves[0]!;

  let level = [...leaves];

  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(pair(level[index]!, level[index + 1] ?? level[index]!));
    }
    level = next;
  }

  return level[0]!;
}

function bundle(publications: Publication[], leafVersion = 4): Bundle {
  const leaves = publications.map((entry) =>
    hex(canonicalize(leafPayload(entry, leafVersion))),
  );

  return {
    manifest: {
      root: root(leaves),
      leafVersion,
      publications: publications.map((entry, index) => ({
        id: entry.id,
        leaf: leaves[index]!,
      })),
    },
    publications,
  };
}

test("a one-publication mirror rebuilds the anchored root", async () => {
  const result = await verifyBundle(bundle([publication("p1")]));
  assert.equal(result.valid, true, result.reason ?? "");
});

test("a mirror verifies only against the chain root it was pinned to", async () => {
  const original = bundle([publication("p1"), publication("p2")]);

  const pinned = await verifyBundle(
    original,
    undefined,
    original.manifest.root,
  );
  assert.equal(pinned.valid, true, pinned.reason ?? "");

  const wrong = await verifyBundle(
    original,
    undefined,
    "f".repeat(64),
  );
  assert.equal(wrong.valid, false);
  assert.match(wrong.reason ?? "", /pinned chain root/);
});

test("a two-publication mirror rebuilds the anchored root", async () => {
  const result = await verifyBundle(
    bundle([publication("p1"), publication("p2")]),
  );
  assert.equal(result.valid, true, result.reason ?? "");
});

test("a many-publication mirror rebuilds the anchored root", async () => {
  const entries = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"].map((id) =>
    publication(id),
  );

  const result = await verifyBundle(bundle(entries));
  assert.equal(result.valid, true, result.reason ?? "");
});

test("a mirror that changes a publication is not accepted", async () => {
  const original = bundle([publication("p1"), publication("p2")]);
  const tampered: Bundle = {
    manifest: original.manifest,
    publications: [original.publications[0]!, publication("p2", "something else")],
  };

  const result = await verifyBundle(tampered);
  assert.equal(result.valid, false);
  assert.match(result.reason ?? "", /do not rebuild|does not match/);
});

test("a mirror that claims a leaf it does not contain is not accepted", async () => {
  const original = bundle([publication("p1"), publication("p2")]);
  const tampered: Bundle = {
    manifest: {
      ...original.manifest,
      publications: [
        original.manifest.publications[0]!,
        { id: "p2", leaf: "0".repeat(64) },
      ],
    },
    publications: original.publications,
  };

  const result = await verifyBundle(tampered);
  assert.equal(result.valid, false);
});

test("the verifier honours the leaf version an old anchor was made with", async () => {
  const result = await verifyBundle(
    bundle([publication("p1"), publication("p2")], 2),
  );
  assert.equal(result.valid, true, result.reason ?? "");
});

function aiPublication(id: string): Publication {
  const base = publication(id);

  return {
    ...base,
    app: "ai-bounded",
    challengeId: "bounded-starter",
    artifact: {
      app: "ai-bounded",
      kind: "ai.bounded",
      version: 1,
      mediaType: "application/json",
      body: { values: [12, 22, 32, 42, 200, 255, 0, 130] },
    },
    attestation: {
      ...base.attestation,
      app: "ai-bounded",
      challengeId: "bounded-starter",
      representation: "bounded",
      metricName: "maxAbsError",
      metricValue: 2,
    },
  };
}

test("the verifier surfaces the AI representation evidence leaf v4 commits", async () => {
  const result = await verifyBundle(bundle([aiPublication("ai-1")]));

  assert.equal(result.valid, true, result.reason ?? "");
  assert.equal(result.aiClaims.length, 1);

  const claim = result.aiClaims[0]!;
  assert.equal(claim.publicationId, "ai-1");
  assert.equal(claim.representation, "bounded");
  assert.equal(claim.correct, true);
  assert.equal(claim.metricName, "maxAbsError");
  assert.equal(claim.metricValue, 2);
  assert.equal(claim.bound, null);
  assert.equal(claim.withinBound, null);
});

test("with a challenge index the verifier checks the bound itself", async () => {
  const challenges = {
    "bounded-starter": { bound: 4 },
  };

  const result = await verifyBundle(bundle([aiPublication("ai-1")]), challenges);
  const claim = result.aiClaims[0]!;

  assert.equal(claim.bound, 4);
  assert.equal(claim.withinBound, true);
});

test("an over-bound committed metric is reported as violating the bound", async () => {
  const over = aiPublication("ai-2");
  over.attestation = { ...over.attestation, metricValue: 10 };

  const result = await verifyBundle(bundle([over]), {
    "bounded-starter": { bound: 4 },
  });

  const claim = result.aiClaims[0]!;
  assert.equal(claim.metricValue, 10);
  assert.equal(claim.withinBound, false);
});

test("pre-v4 leaves do not surface uncommitted AI fields", async () => {
  const result = await verifyBundle(bundle([aiPublication("ai-v3")], 3), {
    "bounded-starter": {
      metric: "maxAbsError",
      bound: 4,
      reference: [10, 20, 30, 40, 200, 255, 0, 128],
    },
  });

  assert.equal(result.valid, true, result.reason ?? "");
  const claim = result.aiClaims[0]!;
  assert.equal(claim.representation, null);
  assert.equal(claim.correct, false);
  assert.equal(claim.metricName, null);
  assert.equal(claim.metricValue, null);
  assert.equal(claim.withinBound, null);
  assert.equal(claim.local, null);
});

test("legacy publications surface as representation null", async () => {
  const result = await verifyBundle(
    bundle([publication("p1"), aiPublication("ai-1")]),
  );

  const legacy = result.aiClaims.find((claim) => claim.publicationId === "p1")!;
  assert.equal(legacy.representation, null);
  assert.equal(legacy.metricName, null);
  assert.equal(legacy.withinBound, null);
});

function mediaPublication(id: string): {
  publication: Publication;
  blob: string;
} {
  const model = {
    kind: "xorshift32" as const,
    params: { a: 13, b: 17, c: 5 },
    vocab: ["a", "b", "c", "d"],
  };
  const seed = 42;
  const size = 4;
  const output = generate(model, seed, 16);
  const raster = renderRaster(model, seed, size);
  const rasterDigest = createHash("sha256").update(raster).digest("hex");
  const blobBytes = Buffer.from("a png-shaped rendition");
  const blob = createHash("sha256").update(blobBytes).digest("hex");

  const pub = aiPublication(id);
  pub.app = "ai-generative";
  pub.challengeId = "gen-starter";
  pub.artifact = {
    app: "ai-generative",
    kind: "ai.generative",
    version: 1,
    mediaType: "application/json",
    body: {
      model,
      seed,
      output,
      media: {
        mediaType: "image/png",
        rule: RASTER_RULE,
        blob,
        raster: rasterDigest,
        size,
        bytes: blobBytes.length,
      },
    },
  };
  pub.attestation = {
    ...pub.attestation,
    app: "ai-generative",
    challengeId: "gen-starter",
    representation: "generative",
    metricName: undefined,
    metricValue: undefined,
  } as typeof pub.attestation;

  return { publication: pub, blob: blobBytes.toString("base64") };
}

test("the browser re-derives an AI rendition and checks the blob bytes", async () => {
  const { publication: pub, blob } = mediaPublication("media-1");
  const body = pub.artifact.body as { media: { blob: string } };

  const result = await verifyBundle(
    bundle([pub]),
    { "gen-starter": { steps: 16 } },
    undefined,
    { [body.media.blob]: blob },
  );

  const claim = result.aiClaims[0]!;
  assert.ok(claim.media);
  assert.equal(claim.media.matches, true);
  assert.equal(claim.media.blobMatches, true);
  assert.equal(claim.media.reDerived, claim.media.raster);

  const substituted = await verifyBundle(
    bundle([pub]),
    { "gen-starter": { steps: 16 } },
    undefined,
    { [body.media.blob]: Buffer.from("different bytes").toString("base64") },
  );
  assert.equal(substituted.aiClaims[0]!.media?.blobMatches, false);
});

test("a rendition whose raster was changed fails the local derivation", async () => {
  const { publication: pub } = mediaPublication("media-2");
  const body = pub.artifact.body as { media: { raster: string } };
  body.media.raster = "0".repeat(64);

  const result = await verifyBundle(bundle([pub]), {
    "gen-starter": { steps: 16 },
  });

  assert.equal(result.aiClaims[0]!.media?.matches, false);
});

test("pre-v4 leaves do not treat media fields as committed evidence", async () => {
  const { publication: pub, blob } = mediaPublication("media-v3");
  const body = pub.artifact.body as { media: { blob: string } };

  const result = await verifyBundle(
    bundle([pub], 3),
    { "gen-starter": { steps: 16 } },
    undefined,
    { [body.media.blob]: blob },
  );

  assert.equal(result.aiClaims[0]!.media, null);
});

test("the browser replays a generative claim itself when given the steps", async () => {
  const model = {
    kind: "xorshift32" as const,
    params: { a: 13, b: 17, c: 5 },
    vocab: ["a", "b", "c", "d"],
  };
  const output = generate(model, 42, 16);
  const pub = aiPublication("gen-1");
  pub.app = "ai-generative";
  pub.challengeId = "gen-starter";
  pub.artifact = {
    app: "ai-generative",
    kind: "ai.generative",
    version: 1,
    mediaType: "application/json",
    body: { model, seed: 42, output },
  };
  pub.attestation = {
    ...pub.attestation,
    app: "ai-generative",
    challengeId: "gen-starter",
    representation: "generative",
    metricName: undefined,
    metricValue: undefined,
  } as typeof pub.attestation;

  const result = await verifyBundle(bundle([pub]), {
    "gen-starter": { steps: 16 },
  });
  const claim = result.aiClaims[0]!;
  assert.equal(claim.representation, "generative");
  assert.deepEqual(claim.local, { correct: true });

  const tampered = { ...pub };
  tampered.artifact = {
    ...pub.artifact,
    body: { model, seed: 42, output: output.slice(0, -1) + (output.endsWith("a") ? "b" : "a") },
  };
  const bad = await verifyBundle(bundle([tampered]), {
    "gen-starter": { steps: 16 },
  });
  assert.deepEqual(bad.aiClaims[0]!.local, { correct: false });
});

test("the browser recomputes a bounded metric from the raw reconstruction", async () => {
  const pub = aiPublication("ai-1");
  const reference = [10, 20, 30, 40, 200, 255, 0, 128];

  const result = await verifyBundle(bundle([pub]), {
    "bounded-starter": {
      metric: "maxAbsError",
      bound: 4,
      reference,
    },
  });
  const claim = result.aiClaims[0]!;
  assert.equal(claim.representation, "bounded");
  assert.deepEqual(claim.local, { correct: true, metricValue: 2 });
});

test("a locally recomputed metric that disagrees with the attestation is exposed", async () => {
  const pub = aiPublication("ai-3");
  pub.attestation = { ...pub.attestation, metricValue: 9 };
  const reference = [10, 20, 30, 40, 200, 255, 0, 128];

  const result = await verifyBundle(bundle([pub]), {
    "bounded-starter": {
      metric: "maxAbsError",
      bound: 4,
      reference,
    },
  });
  const claim = result.aiClaims[0]!;

  // The local check verifies the ARTIFACT: the reconstruction really is
  // within bound (metric 2 of 4), so local.correct is true. The fraud shows
  // in the comparison: the attestation committed metricValue 9 for an
  // artifact whose true metric is 2. Reader-side, local.metricValue !==
  // claim.metricValue is the tamper signal — no trust in the mirror or the
  // attestation required.
  assert.deepEqual(claim.local, { correct: true, metricValue: 2 });
  assert.equal(claim.metricValue, 9);
  assert.notEqual(claim.local!.metricValue, claim.metricValue);
  assert.equal(claim.withinBound, false);
});

test("a local AI failure overrides a server pass", () => {
  assert.equal(localVerdict(true, null), true);
  assert.equal(localVerdict(true, { correct: true }), true);
  assert.equal(localVerdict(true, { correct: false }), false);
  assert.equal(localVerdict(false, { correct: true }), false);
});

test("without a usable spec the local check stays null, not a guess", async () => {
  const result = await verifyBundle(bundle([aiPublication("ai-1")]));
  assert.equal(result.aiClaims[0]!.local, null);
});
