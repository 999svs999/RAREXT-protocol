import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { readFileSync } from "node:fs";

import {
  canonicalize,
  PUBLICATION_LEAF_VERSION,
  merkleRoot,
  parseSemanticsCommitmentArtifact,
  publicationLeaf,
  semanticsCommitmentArtifact,
  semanticsDigests,
  SEMANTICS_COMMITMENT_KIND,
  semanticsRecordDigest,
  semanticsKey,
  semanticsCommitmentHolds,
  bundleSemanticsCommitment,
  withSemanticsCommitment,
  claimFromAttestation,
  findSemantics,
  LOGIC_SEMANTICS,
  semanticsBinding,
  taskForSemantics,
} from "../src/index.ts";
import type { Attestation, Challenge } from "../src/index.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const LOGIC_VERIFIER_MANIFEST = {
  algorithm: "nand-latch-simulator",
  app: "logic",
  artifactKind: "logic.netlist",
  version: 1,
};

test("pinned semantic spec hashes match the shipped task specs", () => {
  for (const semantics of LOGIC_SEMANTICS) {
    const task = taskForSemantics(semantics);
    assert.ok(task, `no task backs ${semantics.id}`);

    const hash = sha256(canonicalize(task));
    assert.equal(
      hash,
      semantics.specHash,
      `${semantics.id}@${semantics.version} spec hash is stale: bump the semantics version and repin the hash when a task spec changes`,
    );
  }
});

test("the built-in logic verifier hash is pinned to its manifest", () => {
  const hash = sha256(canonicalize(LOGIC_VERIFIER_MANIFEST));

  for (const semantics of LOGIC_SEMANTICS) {
    assert.equal(
      semantics.verifierHash,
      hash,
      `${semantics.id} verifier hash does not match the built-in manifest`,
    );
  }
});

test("semantics binding detects a changed spec", () => {
  const challenge: Challenge = {
    id: "half-adder",
    app: "logic",
    title: "Add two bits",
    description: "",
    version: 1,
    spec: { id: "half-adder", changed: true },
    semanticsId: "logic/half-adder",
    semanticsVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const specHash = sha256(canonicalize(challenge.spec));
  assert.equal(
    semanticsBinding(challenge, LOGIC_SEMANTICS, specHash),
    "spec-mismatch",
  );
});

test("semantics binding reports missing and version-mismatched meaning", () => {
  const task = taskForSemantics(LOGIC_SEMANTICS[0]!);
  assert.ok(task);

  const base: Challenge = {
    id: "half-adder",
    app: "logic",
    title: "Add two bits",
    description: "",
    version: 1,
    spec: task,
    semanticsId: "logic/half-adder",
    semanticsVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const hash = sha256(canonicalize(base.spec));
  assert.equal(semanticsBinding(base, LOGIC_SEMANTICS, hash), "ok");

  assert.equal(
    semanticsBinding({ ...base, semanticsId: "logic/unknown" }, LOGIC_SEMANTICS, hash),
    "missing",
  );
  assert.equal(
    semanticsBinding({ ...base, semanticsVersion: 9 }, LOGIC_SEMANTICS, hash),
    "version-mismatch",
  );
});

test("findSemantics returns the latest version by default", () => {
  const registry = [
    { ...LOGIC_SEMANTICS[0]!, version: 1 },
    { ...LOGIC_SEMANTICS[0]!, version: 2 },
  ];

  assert.equal(findSemantics(registry, "logic/half-adder")?.version, 2);
  assert.equal(findSemantics(registry, "logic/half-adder", 1)?.version, 1);
  assert.equal(findSemantics(registry, "logic/half-adder", 3), null);
});

test("a claim binds subject, meaning, and proof", () => {
  const semantics = LOGIC_SEMANTICS[0]!;
  const attestation: Attestation = {
    id: "att-1",
    verifier: "rarext-v0",
    app: "logic",
    challengeId: "half-adder",
    taskId: "half-adder",
    circuitHash: "circuit-hash",
    traceHash: "trace-hash",
    correct: true,
    score: 1000,
    gateCount: 5,
    semanticsId: semantics.id,
    semanticsVersion: semantics.version,
    semanticsHash: "semantics-hash",
    claimKind: "satisfies",
    scope: null,
    verifierHash: "verifier-hash",
    proofKind: "recomputable",
    signatureAlgorithm: "ecdsa-p256",
    cryptoProfile: "classical",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const claim = claimFromAttestation(attestation, semantics, "half-adder");

  assert.equal(claim.kind, "satisfies");
  assert.equal(claim.subject, "circuit-hash");
  assert.equal(claim.semanticsId, "logic/half-adder");
  assert.equal(claim.semanticsVersion, 1);
  assert.equal(claim.semanticsHash, "semantics-hash");
  assert.equal(claim.proofKind, "recomputable");
  assert.equal(claim.proofHash, "trace-hash");
  assert.equal(claim.predicate, "logic/half-adder@1 (half-adder)");
});

/**
 * RFC 0003's question 1, as a property: the commitment is INSIDE the proof.
 *
 * "Anchored" has to mean that tampering with the committed meaning moves the root a
 * client already holds — not merely that the commitment can be attached to a bundle.
 * The commitment is an ordinary publication, so the same leaf/root helpers that cover
 * every other claim cover this one.
 */
test("a semantics commitment is inside the proof: tampering with it moves the root", () => {
  // The leaf helpers hash BYTES as well as strings, so this accepts both — the same
  // digest either way.
  const stringSha = (value: string) => createHash("sha256").update(value).digest("hex");
  // Core's Sha256 is bytes in, BYTES out — the hex encoding stays outside the math.
  const bytesSha = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
  const digests = semanticsDigests(LOGIC_SEMANTICS, stringSha);
  const key = `${LOGIC_SEMANTICS[0].id}@${LOGIC_SEMANTICS[0].version}`;
  assert.ok(digests[key], "every record gets a digest");

  const committed = JSON.parse(readFileSync("site/registry/bundle.json", "utf8")) as {
    publications: Array<Record<string, unknown>>;
  };
  const template = committed.publications[0];
  const asPublication = (d: Record<string, string>) => ({
    ...template,
    id: "semantics-commitment",
    artifact: semanticsCommitmentArtifact(d),
  }) as never;

  const leaf = publicationLeaf(asPublication(digests), bytesSha, PUBLICATION_LEAF_VERSION);
  const root = merkleRoot([leaf], bytesSha);

  // One digest changed: the root a client holds no longer rebuilds.
  const tampered = { ...digests, [key]: "0".repeat(64) };
  const tamperedRoot = merkleRoot([publicationLeaf(asPublication(tampered), bytesSha, PUBLICATION_LEAF_VERSION)], bytesSha);
  assert.notEqual(tamperedRoot, root, "tampering with a committed semantics digest moves the root");

  // And a real edit to a record changes the digest that was committed.
  const edited = { ...LOGIC_SEMANTICS[0], summary: `${LOGIC_SEMANTICS[0].summary} (edited)` };
  assert.notEqual(semanticsRecordDigest(edited as never, stringSha), digests[key], "an edit changes the committed digest");

  // The digest is canonical, not incidental: the SAME record with its keys written in
  // the opposite order digests identically.
  const reordered = Object.fromEntries(Object.entries(LOGIC_SEMANTICS[0]).reverse()) as never;
  assert.equal(semanticsRecordDigest(reordered, stringSha), digests[key], "key order does not move the digest");

  // The parser round-trips, and refuses anything that is not a commitment.
  const artifact = semanticsCommitmentArtifact(digests);
  assert.deepEqual(parseSemanticsCommitmentArtifact(artifact)?.digests, digests);
  assert.equal(parseSemanticsCommitmentArtifact({ app: "federation", kind: "registry-list-commitment", body: "{}" }), null);
  assert.equal(parseSemanticsCommitmentArtifact({ app: "rarext-semantics", kind: "semantics-commitment", body: "not json" }), null);
  assert.equal(parseSemanticsCommitmentArtifact({ app: "rarext-semantics", kind: "semantics-commitment", body: JSON.stringify({ digests: { a: 1 } }) }), null);
});

/**
 * The live registry, measured rather than assumed: its own publications and its own
 * semantics, with the commitment added.
 *
 * RFC 0020's commitment is already a publication in the committed bundle, so the shape
 * is proven in place — what this measures is the DELTA for semantics: the committed
 * root does not change if nothing is added, and DOES change when the commitment is,
 * which is what "the meaning is not anchored today" means in numbers.
 */
test("the committed registry's root moves when its semantics are committed", () => {
  const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
  const bytesSha = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
  const committed = JSON.parse(readFileSync("site/registry/bundle.json", "utf8")) as {
    publications: Array<Record<string, unknown>>;
    semantics: Array<Record<string, unknown>>;
    manifest: { root: string; leafVersion: number };
  };
  const leavesOf = (publications: Array<Record<string, unknown>>) =>
    publications.map((publication) => publicationLeaf(publication as never, bytesSha, PUBLICATION_LEAF_VERSION));

  const asIs = merkleRoot(leavesOf(committed.publications), bytesSha);

  const template = committed.publications[0];
  const commitment = {
    ...template,
    id: "semantics-commitment",
    artifact: semanticsCommitmentArtifact(semanticsDigests(committed.semantics as never, sha256Hex)),
  };
  const withCommitment = merkleRoot(leavesOf([...committed.publications, commitment]), bytesSha);

  assert.notEqual(withCommitment, asIs, "committing the semantics is a real change to the root");

  // The commitment covers the records the bundle carries: every one of them resolves
  // to the digest it committed, so a reader can check the meaning it used.
  const digests = parseSemanticsCommitmentArtifact(commitment.artifact)!.digests;
  for (const record of committed.semantics) {
    const key = `${record.id}@${record.version}`;
    assert.equal(digests[key], semanticsRecordDigest(record as never, sha256Hex), `${key} is committed`);
  }
  assert.equal(Object.keys(digests).length, committed.semantics.length);
});

/**
 * The bundle-level step the publisher runs, extracted so it is testable: adding the
 * commitment is where the "fake AI claim" trap lives, and a script block is the one
 * place a test cannot reach.
 */
test("withSemanticsCommitment adds a publication, strips representation, and moves the root", () => {
  const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
  const bytesSha = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
  const committed = JSON.parse(readFileSync("site/registry/bundle.json", "utf8")) as Record<string, unknown> & {
    publications: Array<Record<string, unknown>>;
    semantics: Array<Record<string, unknown>>;
  };

  const rootOf = (b: { publications: Array<Record<string, unknown>> }) =>
    merkleRoot(b.publications.map((x) => publicationLeaf(x as never, bytesSha, PUBLICATION_LEAF_VERSION)), bytesSha);

  // The committed bundle now CARRIES the commitment, and the function REPLACES rather than
  // carries: a commitment is derived from the records the bundle carries NOW, so a stale
  // commitment covering records that have since changed can never survive a publish.
  const already = (committed.publications ?? []).some((x) => (x.artifact as { kind?: string })?.kind === SEMANTICS_COMMITMENT_KIND);
  const { bundle: withCommitment, added, replaced } = withSemanticsCommitment(committed as never, sha256Hex);
  assert.equal(added, "pub-semantics-commitment");
  assert.equal(replaced, already, "a carried commitment is replaced; a missing one is added");
  const publications = withCommitment.publications!;
  assert.equal(publications.length, committed.publications.length + (already ? 0 : 1));
  if (!already) {
    assert.notEqual(rootOf(withCommitment as never), rootOf(committed as never), "the commitment is inside the proof");
  }

  // By KIND, not by position: whatever else the bundle carries, the commitment is the
  // publication whose artifact says so.
  const publication = publications.find(
    (x) => (x.artifact as { kind?: string })?.kind === SEMANTICS_COMMITMENT_KIND,
  ) as { artifact: Record<string, unknown>; attestation: Record<string, unknown> };
  assert.equal((publication.artifact as { kind?: string }).kind, SEMANTICS_COMMITMENT_KIND);
  // THE TRAP: keeping the template's `representation` would publish a commitment as an
  // AI claim inside the surface that exists to prove AI results.
  assert.equal("representation" in publication.attestation, false, "no representation survives onto a commitment");
  assert.ok(publication.attestation && Object.keys(publication.attestation).length > 0, "the leaf still has its attestation");

  // It commits to the records the bundle carries...
  const digests = parseSemanticsCommitmentArtifact(publication.artifact as never)!.digests;
  for (const record of committed.semantics) {
    assert.equal(digests[`${record.id}@${record.version}`], semanticsRecordDigest(record as never, sha256Hex));
  }

  // ...and it replaces rather than accumulates: running it twice leaves ONE commitment, and
  // still exactly one.
  const again = withSemanticsCommitment(withCommitment as never, sha256Hex);
  assert.equal(again.added, "pub-semantics-commitment");
  assert.equal(again.replaced, true);
  assert.equal(again.bundle.publications!.length, publications.length);
  assert.equal(
    again.bundle.publications!.filter((x) => (x.artifact as { kind?: string })?.kind === SEMANTICS_COMMITMENT_KIND).length,
    1,
    "exactly one commitment survives a re-derive",
  );
  assert.equal(withSemanticsCommitment({ publications: [] }, sha256Hex).added, null);
  assert.equal(withSemanticsCommitment({ publications: [] }, sha256Hex).replaced, false);
});

test("a record that changes after the commitment is re-committed, and the reader proves it", () => {
  const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
  const committed = JSON.parse(readFileSync("site/registry/bundle.json", "utf8")) as Record<string, unknown> & {
    publications: Array<Record<string, unknown>>;
    semantics: Array<Record<string, unknown>>;
  };

  // A record is edited after the first commitment was written — exactly what happens when a
  // meaning is corrected between publishes.
  const drifted = {
    ...committed,
    semantics: committed.semantics.map((record, index) =>
      index === 0 ? { ...record, summary: "edited after the first commitment was written" } : record,
    ),
  };

  const { bundle: reCommitted } = withSemanticsCommitment(drifted as never, sha256Hex);
  const status = semanticsCommitmentHolds(
    bundleSemanticsCommitment(reCommitted as never)!,
    reCommitted.semantics as never,
    (record) => semanticsRecordDigest(record as never, sha256Hex),
  );
  assert.ok(status, "the re-derived bundle carries a commitment");
  assert.deepEqual(status!.missing, [], "the re-derived commitment covers the records AS THEY ARE NOW");
  assert.equal(status!.matched, status!.committed);
});

/**
 * The ARTIFACT, checked rather than assumed: the published registry's own commitment
 * must cover the records that registry carries.
 *
 * This is the assertion the byte-map bug needed and did not have. A wrong hash kind
 * produced digests like {"0":167,...} — committed, anchored, and meaningless — and only
 * the parser's strictness refused them. The hex shape is asserted explicitly, because
 * that is precisely what was wrong.
 */
test("the published registry's own commitment covers its own records", () => {
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const bundle = JSON.parse(readFileSync("site/registry/bundle.json", "utf8")) as {
    publications: Array<Record<string, unknown>>;
    semantics: Array<Record<string, unknown>>;
  };
  const commitment = bundle.publications.find(
    (x) => (x.artifact as { kind?: string })?.kind === SEMANTICS_COMMITMENT_KIND,
  );
  assert.ok(commitment, "the published registry carries its semantics commitment");

  const digests = parseSemanticsCommitmentArtifact(commitment!.artifact as never)!.digests;
  assert.equal(Object.keys(digests).length, bundle.semantics.length);
  for (const record of bundle.semantics) {
    const key = `${record.id}@${record.version}`;
    assert.match(digests[key]!, /^[0-9a-f]{64}$/, `${key} is committed as a hex digest`);
    assert.equal(digests[key], semanticsRecordDigest(record as never, sha), `${key} matches its record`);
  }
});

test("a commitment covers the records a bundle carries — and null is not false", () => {
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const records = [LOGIC_SEMANTICS[0]!, LOGIC_SEMANTICS[1]!];
  const commitment = { digests: semanticsDigests(records, sha) };
  const digestOf = (record: { id: string; version: number }) =>
    semanticsRecordDigest(records.find((r) => semanticsKey(r) === semanticsKey(record))!, sha);

  const status = semanticsCommitmentHolds(commitment, records, digestOf);
  assert.equal(status.committed, 2);
  assert.equal(status.matched, 2);
  assert.deepEqual(status.missing, []);

  // A record the commitment does not cover is named, in the order the bundle carries it.
  const edited = { ...records[0]!, summary: `${records[0]!.summary} (edited)` };
  const drifted = semanticsCommitmentHolds(commitment, [edited, records[1]!], (record) =>
    semanticsRecordDigest(
      [edited, records[1]!].find((r) => semanticsKey(r) === semanticsKey(record))!,
      sha,
    ),
  );
  assert.deepEqual(drifted.missing, [semanticsKey(edited)]);

  // And a bundle that records NO commitment answers null — an artifact that never made the
  // claim, which a reader must not report as one whose claim failed.
  assert.equal(bundleSemanticsCommitment({ publications: [{ artifact: {} }] }), null);
  assert.equal(
    bundleSemanticsCommitment({ publications: [{ artifact: semanticsCommitmentArtifact(commitment.digests) }] })?.digests[
      semanticsKey(records[0]!)
    ],
    commitment.digests[semanticsKey(records[0]!)],
  );
});
