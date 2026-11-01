import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

import {
  GOVERNANCE_PROPOSAL_KIND,
  GOVERNANCE_VOTE_KIND,
  canonicalize,
  voteStatement,
} from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A registered voter: the rail keys weight and duplication on the SIGNING key. */
function registerVoter(store: Awaited<ReturnType<typeof start>>["store"], handle: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  const keyId = sha256(canonicalize(jwk));
  store.addIdentity({
    handle,
    displayName: handle,
    keyId,
    publicKey: jwk,
    algorithm: "ecdsa-p256",
    createdAt: new Date().toISOString(),
    links: [],
    verified: true,
  } as never);
  return {
    keyId,
    jwk,
    signStatement(statement: unknown): string {
      return signBytes("sha256", Buffer.from(canonicalize(statement)), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
    },
  };
}

function proposal(id: string, closesAt: string, policy: Record<string, unknown> = { kind: "key" }) {
  return {
    kind: GOVERNANCE_PROPOSAL_KIND,
    id,
    title: "A decision",
    question: "Should this be done?",
    choices: ["yes", "no"],
    closesAt,
    quorum: { kind: "keys", value: 1 },
    policy,
  };
}

interface Eligibility {
  keyId: string;
  eligible: boolean;
  reason: string | null;
  alreadyVoted: boolean;
  weight: number;
  quorumStillNeeded: number | null;
}

test("a voter's standing, read BEFORE acting: the rail answers instead of refusing", async () => {
  const { server, store, base } = await start();
  try {
    const voter = registerVoter(store, "would-be-voter");
    const openAt = new Date(Date.now() + 3_600_000).toISOString();

    // A live decision: an eligible key learns its weight and what is still needed.
    const live = proposal("standing-open", openAt);
    const created = await post(base, "/v1/governance/proposals", live);
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    const root = (JSON.parse(createdText) as { root: string }).root;

    const before = (await (await fetch(`${base}/v1/governance/proposals/${root}?keyId=${voter.keyId}`)).json()) as { eligibility: Eligibility };
    assert.equal(before.eligibility.eligible, true, "an unvoted key under a key policy may vote");
    assert.equal(before.eligibility.reason, null);
    assert.equal(before.eligibility.alreadyVoted, false);
    assert.equal(before.eligibility.weight, 1, "under a key policy a ballot weighs one");
    assert.equal(before.eligibility.quorumStillNeeded, 1, "the decision still needs one key");

    // The standing rides on the AGENDA too, so a stranger can survey and act in one pass.
    const agenda = (await (await fetch(`${base}/v1/governance/open?keyId=${voter.keyId}`)).json()) as {
      open: Array<{ root: string; eligibility?: Eligibility }>;
    };
    const entry = agenda.open.find((item) => item.root === root);
    assert.ok(entry?.eligibility, "the agenda entry carries the key's own standing");
    assert.equal(entry?.eligibility?.eligible, true);

    // Without keyId: no standing is claimed, because there is no key to compute one for.
    const anonymous = (await (await fetch(`${base}/v1/governance/proposals/${root}`)).json()) as { eligibility?: Eligibility };
    assert.equal(anonymous.eligibility, undefined, "no key, no standing — the node does not guess");

    // After voting: the same read says so, and says why.
    const vote = {
      kind: GOVERNANCE_VOTE_KIND,
      proposalRoot: root,
      choice: "yes",
      voter: `anon-${sha256(canonicalize(voter.jwk)).slice(0, 8)}`,
      publicKey: voter.jwk,
      issuedAt: new Date().toISOString(),
      suite: "ecdsa-p256",
    } as unknown as Parameters<typeof voteStatement>[0];
    const voted = await post(base, `/v1/governance/proposals/${root}/votes`, { ...vote, signature: voter.signStatement(voteStatement(vote)) });
    assert.equal(voted.status, 201, await voted.text());

    const after = (await (await fetch(`${base}/v1/governance/proposals/${root}?keyId=${voter.keyId}`)).json()) as { eligibility: Eligibility };
    assert.equal(after.eligibility.eligible, false);
    assert.equal(after.eligibility.alreadyVoted, true);
    assert.match(after.eligibility.reason ?? "", /already voted/);
    assert.equal(after.eligibility.quorumStillNeeded, 0, "the quorum is now met");

    // A CLOSED window: ineligible, and the reason is the window, not the key.
    const shut = new Date(Date.now() - 5_000).toISOString();
    const closedCreated = await post(base, "/v1/governance/proposals", proposal("standing-closed", shut));
    const closedRoot = (JSON.parse(await closedCreated.text()) as { root: string }).root;
    const closed = (await (await fetch(`${base}/v1/governance/proposals/${closedRoot}?keyId=${voter.keyId}`)).json()) as { eligibility: Eligibility };
    assert.equal(closed.eligibility.eligible, false);
    assert.match(closed.eligibility.reason ?? "", /window has closed/);

    // A WORK policy: a key with no credits holds no weight, and the read says so up front.
    const weighted = await post(base, "/v1/governance/proposals", proposal("standing-work", openAt, { kind: "work", creditUnit: "credit" }));
    const weightedRoot = (JSON.parse(await weighted.text()) as { root: string }).root;
    const unweighted = (await (await fetch(`${base}/v1/governance/proposals/${weightedRoot}?keyId=${voter.keyId}`)).json()) as { eligibility: Eligibility };
    assert.equal(unweighted.eligibility.weight, 0, "no credits under a work policy is no weight");
    assert.equal(unweighted.eligibility.eligible, false);
    assert.match(unweighted.eligibility.reason ?? "", /no weight/);
  } finally {
    await stop(server);
  }
});
