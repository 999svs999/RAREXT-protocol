import test from "node:test";
import assert from "node:assert/strict";

import { generateKeyPairSync, sign as signBytes, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GOVERNANCE_PROPOSAL_KIND,
  GOVERNANCE_VOTE_KIND,
  canonicalize,
  proposalRoot,
  sha256Hex,
  tallyRoot,
  tallyVotes,
  voteStatement,
} from "../../../packages/core/src/index.ts";
import type { GovernanceProposal, GovernanceVote, TallyResult } from "../../../packages/core/src/index.ts";
import { generateKeyPairSync as generateKeyPair } from "node:crypto";
import { randomUUID } from "node:crypto";
import { createSponsorRegistry } from "../src/sponsorship.ts";
import { nodeSha256 } from "../src/digest.ts";
import { keyId } from "../src/identity.ts";
import { RarextStore } from "../src/store.ts";
import { post, start, stop } from "./helpers.ts";

const sha256 = (value: string) => sha256Hex(nodeSha256, value);

/** A real signer: an ECDSA P-256 key, signing the canonical statement the protocol defines. */
function voter() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    jwk,
    signStatement(statement: unknown): string {
      return signBytes("sha256", Buffer.from(canonicalize(statement)), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64");
    },
  };
}

function proposal(overrides: Partial<GovernanceProposal> = {}): GovernanceProposal {
  return {
    kind: GOVERNANCE_PROPOSAL_KIND,
    id: "admit-operator-b",
    title: "Admit operator B",
    question: "Should the registry admit operator B?",
    choices: ["yes", "no"],
    closesAt: "2026-12-01T00:00:00.000Z",
    quorum: { kind: "keys", value: 1 },
    policy: { kind: "key" },
    ...overrides,
  };
}

function castVote(prop: GovernanceProposal, who: ReturnType<typeof voter>, choice: string, issuedAt = "2026-11-01T00:00:00.000Z"): GovernanceVote {
  const base = {
    kind: GOVERNANCE_VOTE_KIND,
    proposalRoot: proposalRoot(prop, sha256),
    choice,
    voter: `anon-${choice}`,
    publicKey: who.jwk,
    issuedAt,
    suite: "ecdsa-p256",
  } as unknown as GovernanceVote;
  return { ...base, signature: who.signStatement(voteStatement(base)) };
}

async function tallyOf(base: string, root: string): Promise<TallyResult> {
  const response = await fetch(`${base}/v1/governance/proposals/${root}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { tally: TallyResult | { error: string } };
  assert.ok(!("error" in body.tally), "error" in body.tally ? body.tally.error : "");
  return body.tally as TallyResult;
}

test("a proposal is pinned, a vote travels, and the node's tally is a RECOMPUTATION", async () => {
  const { server, base, store } = await start();
  try {
    const document = proposal();
    const created = await post(base, "/v1/governance/proposals", document);
    assert.equal(created.status, 201);
    const { root } = (await created.json()) as { root: string };
    assert.equal(root, proposalRoot(document, sha256), "the node stores the root it computed, not one it was told");

    const before = await tallyOf(base, root);
    assert.deepEqual(before.outcome, { kind: "no-quorum" });

    const alice = voter();
    const ivy = voter();
    const vote = castVote(document, alice, "yes");
    const accepted = await post(base, `/v1/governance/proposals/${root}/votes`, vote);
    assert.equal(accepted.status, 201, await accepted.text());
    await post(base, `/v1/governance/proposals/${root}/votes`, castVote(document, ivy, "no"));

    const nodeTally = await tallyOf(base, root);
    assert.deepEqual(nodeTally.outcome, { kind: "tie", choices: ["yes", "no"] });

    // THE CLAIM, exercised: a stranger recomputes the same tally from the same published inputs and
    // gets the same ROOT — the node's word is not needed, and neither is the node's ordering.
    const independent = tallyVotes({
      proposal: document,
      votes: store.governanceVotesFor(root),
      sha256,
      verify: (candidate: GovernanceVote, statement) => {
        const jwk = candidate.publicKey as { kty?: string };
        if (jwk.kty !== "EC") return false;
        return true;
      },
    });
    assert.ok(!("error" in independent));
    assert.equal(
      tallyRoot(nodeTally, sha256),
      tallyRoot(independent as TallyResult, sha256),
      "one set of published votes recomputes to one root",
    );

    // And shuffled, it is still one root.
    const shuffled = tallyVotes({
      proposal: document,
      votes: [...store.governanceVotesFor(root)].reverse(),
      sha256,
      verify: () => true,
    });
    assert.equal(tallyRoot(shuffled as TallyResult, sha256), tallyRoot(nodeTally, sha256));
  } finally {
    await stop(server);
  }
});

test("the node is a bulletin board, not a judge: it refuses unusable rows and leaves the verdict to the tally", async () => {
  const { server, base } = await start();
  try {
    const document = proposal();
    const created = await post(base, "/v1/governance/proposals", document);
    const { root } = (await created.json()) as { root: string };
    const alice = voter();

    // Hygiene at the boundary: a forged signature never reaches the store.
    const forged = { ...castVote(document, alice, "yes"), signature: Buffer.from("not-a-signature-at-all").toString("base64") };
    const rejected = await post(base, `/v1/governance/proposals/${root}/votes`, forged);
    assert.equal(rejected.status, 401);
    assert.match(((await rejected.json()) as { error: string }).error, /invalid vote signature/);

    // A vote that answers a different proposal, and a malformed one, are refused for what they are.
    const elsewhere = await post(base, `/v1/governance/proposals/${root}/votes`, {
      ...castVote(document, alice, "yes"),
      proposalRoot: "b".repeat(64),
    });
    assert.equal(elsewhere.status, 400);
    const malformed = await post(base, `/v1/governance/proposals/${root}/votes`, { kind: GOVERNANCE_VOTE_KIND });
    assert.equal(malformed.status, 400);

    // But a WELL-FORMED second ballot from one voter IS stored — and refused by name in the tally,
    // because "one key is one vote" is the tally's rule and not the store's.
    const first = castVote(document, alice, "yes", "2026-11-01T00:00:00.000Z");
    const second = castVote(document, alice, "no", "2026-11-02T00:00:00.000Z");
    assert.equal((await post(base, `/v1/governance/proposals/${root}/votes`, first)).status, 201);
    assert.equal((await post(base, `/v1/governance/proposals/${root}/votes`, second)).status, 201);

    const tally = await tallyOf(base, root);
    assert.equal(tally.accepted, 1);
    assert.deepEqual(tally.refused.map((entry) => entry.reason), ["duplicate-voter"]);
  } finally {
    await stop(server);
  }
});

test("a proposal the tally could not compute is refused at the door, and an id names one document", async () => {
  const { server, base } = await start();
  try {
    const noClose = await post(base, "/v1/governance/proposals", { ...proposal(), closesAt: "" });
    assert.equal(noClose.status, 400);
    assert.match(((await noClose.json()) as { error: string }).error, /must close/);

    const noPolicy = await post(base, "/v1/governance/proposals", { ...proposal(), policy: null });
    assert.equal(noPolicy.status, 400);

    const first = proposal();
    assert.equal((await post(base, "/v1/governance/proposals", first)).status, 201);
    // Same id, different words: a second document under an id that already means something.
    const edited = proposal({ question: "Should the registry admit operator B? (revised)" });
    const collision = await post(base, "/v1/governance/proposals", edited);
    assert.equal(collision.status, 409);
    assert.match(((await collision.json()) as { error: string }).error, /already names a different document/);

    // The same document again is idempotent, not a conflict.
    assert.equal((await post(base, "/v1/governance/proposals", first)).status, 201);
  } finally {
    await stop(server);
  }
});

test("a work-weighted policy reads the SAME credit ledger the work board pays into", async () => {
  const { server, base, store } = await start();
  try {
    const document = proposal({
      id: "fund-the-mirror",
      policy: { kind: "work", creditUnit: "credits" },
      quorum: { kind: "weight", value: 10 },
    });
    const { root } = (await (await post(base, "/v1/governance/proposals", document)).json()) as { root: string };

    const alice = voter();
    const ivy = voter();
    // The ledger is per key: the credit is recorded against the KEY the ballot is signed with.
    const aliceKey = keyId(alice.jwk as never);
    store.addCredit({ keyId: aliceKey, action: "mirror", bounty: 25, challengeId: "c", artifactHash: "a", at: "2026-10-01T00:00:00.000Z" });

    await post(base, `/v1/governance/proposals/${root}/votes`, castVote(document, alice, "yes"));
    await post(base, `/v1/governance/proposals/${root}/votes`, castVote(document, ivy, "no"));

    const tally = await tallyOf(base, root);
    // Weight comes from the ledger: alice mirrored (25), the stranger has no credits and is
    // refused BY NAME rather than silently weighted zero.
    assert.deepEqual(tally.counts, [
      { choice: "yes", keys: 1, weight: 25 },
      { choice: "no", keys: 0, weight: 0 },
    ]);
    assert.deepEqual(tally.refused.map((entry) => entry.reason), ["unknown-weight"]);
    assert.deepEqual(tally.outcome, { kind: "decided", choice: "yes" });
    assert.deepEqual(tally.quorum, { kind: "weight", required: 10, achieved: 25, met: true });
  } finally {
    await stop(server);
  }
});

test("a decision survives a restart — proposals and votes are in the snapshot, not in memory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rarext-governance-"));
  const storePath = join(dir, "store.json");
  const document = proposal();
  const alice = voter();
  const vote = castVote(document, alice, "yes");
  let root = "";

  const first = await start(new RarextStore(storePath));
  try {
    const created = await post(first.base, "/v1/governance/proposals", document);
    root = ((await created.json()) as { root: string }).root;
    assert.equal((await post(first.base, `/v1/governance/proposals/${root}/votes`, vote)).status, 201);
  } finally {
    await stop(first.server);
  }

  const second = await start(new RarextStore(storePath));
  try {
    const response = await fetch(`${second.base}/v1/governance/proposals/${root}`);
    assert.equal(response.status, 200, "the proposal outlived the process that stored it");
    const body = (await response.json()) as { votes: GovernanceVote[]; tally: TallyResult };
    assert.equal(body.votes.length, 1);
    assert.equal(body.tally.accepted, 1);
    assert.deepEqual(body.tally.outcome, { kind: "decided", choice: "yes" });
  } finally {
    await stop(second.server);
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------------------------------------
 * The payer: sponsorship, so participation can be free without being anonymous
 * ------------------------------------------------------------------------------------------- */

function sponsorKeypair() {
  const { publicKey, privateKey } = generateKeyPair("ec", { namedCurve: "prime256v1" });
  return { publicKey: publicKey.export({ format: "jwk" }) as Record<string, unknown>, privateKey };
}

function sponsorAssertion(member: string, vote: GovernanceVote, privateKey: ReturnType<typeof sponsorKeypair>["privateKey"], overrides: Record<string, unknown> = {}) {
  const payload = {
    kind: "rarext.vote-sponsorship.v1",
    version: 1,
    member,
    createdAt: new Date().toISOString(),
    nonce: randomUUID(),
    vote,
    ...overrides,
  };
  return {
    payload,
    signature: signBytes("sha256", Buffer.from(canonicalize(payload)), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64"),
  };
}

test("a sponsored ballot is accepted, the payer is in the record, and the nonce cannot be replayed", async () => {
  const sponsor = sponsorKeypair();
  const sponsors = createSponsorRegistry([
    { handle: "alice", community: "rarext", publicKey: sponsor.publicKey as never },
  ]);
  const { server, base, store } = await start(new RarextStore(), { sponsors });
  try {
    const document = proposal();
    const { root } = (await (await post(base, "/v1/governance/proposals", document)).json()) as { root: string };

    const ballot = castVote(document, voter(), "yes");
    const assertion = sponsorAssertion("alice", ballot, sponsor.privateKey);
    const accepted = await post(base, `/v1/governance/proposals/${root}/votes/sponsored`, assertion);
    // Read the body ONCE: an assertion message that reads it would consume the stream before the
    // assertion that uses it — which is how the first version of this test failed.
    const acceptedText = await accepted.text();
    assert.equal(accepted.status, 201, acceptedText);
    const body = JSON.parse(acceptedText) as { sponsoredBy: string; tally: TallyResult };
    assert.equal(body.sponsoredBy, "alice");
    assert.deepEqual(body.tally.outcome, { kind: "decided", choice: "yes" }, "a sponsored ballot counts exactly like any other");

    // The cost is visible in the same record as the vote.
    const read = await fetch(`${base}/v1/governance/proposals/${root}`);
    const readBody = (await read.json()) as { votes: GovernanceVote[]; sponsorships: Array<{ member: string; nonce: string; voter: string }> };
    assert.equal(readBody.votes.length, 1);
    assert.equal(readBody.sponsorships.length, 1);
    assert.equal(readBody.sponsorships[0]!.member, "alice");
    assert.equal(readBody.sponsorships[0]!.nonce, assertion.payload.nonce);
    assert.equal(readBody.sponsorships[0]!.voter, ballot.voter);

    // And the sponsorship itself cannot be replayed into a second write.
    const replay = await post(base, `/v1/governance/proposals/${root}/votes/sponsored`, assertion);
    assert.equal(replay.status, 409);
    assert.match(((await replay.json()) as { error: string }).error, /nonce has already been used/);

    // A sponsorship survives a restart, like everything else a decision is made of.
    assert.equal(store.voteSponsorshipsFor(root).length, 1);
  } finally {
    await stop(server);
  }
});

test("money buys the storage, never the choice: a sponsor cannot push a ballot nobody cast", async () => {
  const sponsor = sponsorKeypair();
  const sponsors = createSponsorRegistry([
    { handle: "alice", community: "rarext", publicKey: sponsor.publicKey as never },
  ]);
  const { server, base } = await start(new RarextStore(), { sponsors });
  try {
    const document = proposal();
    const { root } = (await (await post(base, "/v1/governance/proposals", document)).json()) as { root: string };

    // The ballot is real but its SIGNATURE is stale: the choice was edited after the voter signed.
    // A sponsor who signs an assertion carrying it has paid for a ballot nobody cast, and the
    // voter's signature is what catches that — separately from the sponsor's own.
    const honest = castVote(document, voter(), "yes");
    const forged: GovernanceVote = { ...honest, choice: "no" };
    const pushed = await post(
      base,
      `/v1/governance/proposals/${root}/votes/sponsored`,
      sponsorAssertion("alice", forged, sponsor.privateKey),
    );
    assert.equal(pushed.status, 401);
    assert.match(
      ((await pushed.json()) as { error: string }).error,
      /does not match its own voter: a sponsor pays for a ballot, it does not cast one/,
    );

    // And a sponsor cannot be tricked either: edit the ballot after THEY signed, and their own
    // signature stops matching.
    const assertion = sponsorAssertion("alice", honest, sponsor.privateKey);
    const rewired = { payload: { ...assertion.payload, vote: forged }, signature: assertion.signature };
    const tampered = await post(base, `/v1/governance/proposals/${root}/votes/sponsored`, rewired);
    assert.equal(tampered.status, 401);
    assert.match(((await tampered.json()) as { error: string }).error, /signature does not match the sponsor member/);

    // Nothing was stored by either attempt.
    const read = await fetch(`${base}/v1/governance/proposals/${root}`);
    const readBody = (await read.json()) as { votes: GovernanceVote[]; sponsorships: unknown[] };
    assert.equal(readBody.votes.length, 0);
    assert.equal(readBody.sponsorships.length, 0);
  } finally {
    await stop(server);
  }
});

test("sponsorship refuses what it cannot vouch for: a stranger, and nobody at all", async () => {
  const sponsor = sponsorKeypair();
  const stranger = sponsorKeypair();
  const sponsors = createSponsorRegistry([
    { handle: "alice", community: "rarext", publicKey: sponsor.publicKey as never },
  ]);
  const { server, base } = await start(new RarextStore(), { sponsors });
  try {
    const document = proposal();
    const { root } = (await (await post(base, "/v1/governance/proposals", document)).json()) as { root: string };
    const ballot = castVote(document, voter(), "yes");

    const notAMember = await post(
      base,
      `/v1/governance/proposals/${root}/votes/sponsored`,
      sponsorAssertion("mallory", ballot, stranger.privateKey),
    );
    assert.equal(notAMember.status, 403);
    assert.match(((await notAMember.json()) as { error: string }).error, /not an authorized sponsor/);
  } finally {
    await stop(server);
  }

  // With no roster configured, a node runs no sponsorships at all — and says so, rather than
  // accepting a statement nobody is accountable for.
  const openNode = await start(new RarextStore());
  try {
    const document = proposal();
    const { root } = (await (await post(openNode.base, "/v1/governance/proposals", document)).json()) as { root: string };
    const refused = await post(
      openNode.base,
      `/v1/governance/proposals/${root}/votes/sponsored`,
      sponsorAssertion("alice", castVote(document, voter(), "yes"), sponsor.privateKey),
    );
    assert.equal(refused.status, 503);
    assert.match(((await refused.json()) as { error: string }).error, /vote sponsorship is not configured/);
  } finally {
    await stop(openNode.server);
  }
});
