import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

import {
  GOVERNANCE_ADMISSION_KIND,
  GOVERNANCE_PROPOSAL_KIND,
  GOVERNANCE_VOTE_KIND,
  canonicalize,
  voteStatement,
} from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function voterInWindow() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  return {
    jwk,
    signStatement(statement: unknown): string {
      return signBytes("sha256", Buffer.from(canonicalize(statement)), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
    },
  };
}

function proposal(id: string, closesAt: string, title = "A decision") {
  return {
    kind: GOVERNANCE_PROPOSAL_KIND,
    id,
    title,
    question: "Should this be done?",
    choices: ["yes", "no"],
    closesAt,
    quorum: { kind: "keys", value: 1 },
    policy: { kind: "key" },
  };
}

test("what needs deciding: open windows only, with attachments and the tally so far", async () => {
  const { server, base } = await start();
  try {
    // A fresh node has no agenda, and says so.
    const empty = (await (await fetch(`${base}/v1/governance/open`)).json()) as { open: unknown[] };
    assert.deepEqual(empty.open, []);

    const openAt = new Date(Date.now() + 3_600_000).toISOString();
    const closedAt = new Date(Date.now() - 5_000).toISOString();

    // An open decision that CARRIES something: the voter must see what it would do.
    const openDocument = proposal("open-one", openAt, "Admit a peer");
    const openCreated = await post(base, "/v1/governance/proposals", openDocument);
    const openCreatedText = await openCreated.text();
    assert.equal(openCreated.status, 201, openCreatedText);
    const openRoot = (JSON.parse(openCreatedText) as { root: string }).root;

    const admission = {
      kind: GOVERNANCE_ADMISSION_KIND,
      registry: { id: "peer-open", url: "https://peer.example.com", operator: "peer-op", chains: ["rarex"] },
      issuedAt: new Date().toISOString(),
      payOn: "yes",
    };
    assert.equal((await post(base, `/v1/governance/proposals/${openRoot}/admission`, admission)).status, 201);

    // A CLOSED decision: still stored, still readable by root — and absent from the agenda.
    const closedCreated = await post(base, "/v1/governance/proposals", proposal("closed-one", closedAt, "An old question"));
    assert.equal(closedCreated.status, 201);

    const agenda = (await (await fetch(`${base}/v1/governance/open`)).json()) as {
      open: Array<{
        root: string;
        proposal: { id: string; closesAt: string };
        closesAt: string;
        admission: { registry: { url: string } } | null;
        budget: unknown | null;
        votes: number;
        tally: unknown;
      }>;
    };
    assert.equal(agenda.open.length, 1, "only the open window is on the agenda");
    const item = agenda.open[0]!;
    assert.equal(item.proposal.id, "open-one");
    assert.equal(item.closesAt, openAt, "the voter sees when the window shuts");
    assert.ok(item.admission, "and WHAT the decision would do");
    assert.equal(item.admission?.registry.url, "https://peer.example.com");
    assert.equal(item.budget, null, "no money is attached");
    assert.equal(item.votes, 0, "nobody has voted yet");
    assert.ok(item.tally, "the tally so far rides along");

    // A vote moves the count the agenda reports.
    const who = voterInWindow();
    const vote = {
      kind: GOVERNANCE_VOTE_KIND,
      proposalRoot: openRoot,
      choice: "yes",
      voter: `anon-${sha256(canonicalize(who.jwk)).slice(0, 8)}`,
      publicKey: who.jwk,
      issuedAt: new Date().toISOString(),
      suite: "ecdsa-p256",
    } as unknown as Parameters<typeof voteStatement>[0];
    const voted = await post(base, `/v1/governance/proposals/${openRoot}/votes`, {
      ...vote,
      signature: who.signStatement(voteStatement(vote)),
    });
    assert.equal(voted.status, 201, await voted.text());

    const after = (await (await fetch(`${base}/v1/governance/open`)).json()) as { open: Array<{ votes: number }> };
    assert.equal(after.open[0]?.votes, 1, "the agenda counts the ballot");
  } finally {
    await stop(server);
  }
});
