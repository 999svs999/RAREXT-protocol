import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

import {
  GOVERNANCE_ADMISSION_KIND,
  GOVERNANCE_PROPOSAL_KIND,
  GOVERNANCE_VOTE_KIND,
  canonicalize,
  parseRegistrySeedList,
  voteStatement,
} from "../../../packages/core/src/index.ts";
import type { GovernanceProposal, GovernanceVote } from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const randomish = () => `${Date.now()}-${Math.random()}`;

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

function admissionFixture(payOn = "admit", id = `peer-${sha256(randomish()).slice(0, 8)}`) {
  return {
    kind: GOVERNANCE_ADMISSION_KIND,
    registry: {
      id,
      url: "https://new-operator.example.com",
      operator: "new-operator",
      chains: ["rarex"],
      note: "A second operator's node, asking to join.",
    },
    issuedAt: new Date().toISOString(),
    payOn,
  };
}

function proposalFixture(closesAt: string, choices = ["admit", "reject"]): GovernanceProposal {
  return {
    kind: GOVERNANCE_PROPOSAL_KIND,
    id: `prop-${sha256(randomish()).slice(0, 12)}`,
    title: "Admit a new registry",
    question: "Should new-operator's node join the federation's list?",
    choices,
    closesAt,
    quorum: { kind: "keys", value: 1 },
    policy: { kind: "key" },
  };
}

function castVote(prop: GovernanceProposal, root: string, who: ReturnType<typeof voter>, choice: string, issuedAt: string): GovernanceVote {
  const base = {
    kind: GOVERNANCE_VOTE_KIND,
    proposalRoot: root,
    choice,
    voter: `anon-${sha256(canonicalize(who.jwk)).slice(0, 8)}`,
    publicKey: who.jwk,
    issuedAt,
    suite: "ecdsa-p256",
  } as unknown as GovernanceVote;
  return { ...base, signature: who.signStatement(voteStatement(base)) };
}

test("the join request: proposed, decided by the tally, applied exactly once, served as a registry list", async () => {
  const closesAt = new Date(Date.now() - 5_000).toISOString();
  const document = proposalFixture(closesAt);
  const { server, base } = await start();
  try {
    const created = await post(base, "/v1/governance/proposals", document);
    const createdBody = await created.text();
    assert.equal(created.status, 201, createdBody);
    const { root } = JSON.parse(createdBody) as { root: string };

    // Execute with nothing attached: refused by name.
    const nothing = await post(base, `/v1/governance/proposals/${root}/execute`, {});
    assert.equal(nothing.status, 404);
    assert.match(((await nothing.json()) as { error: string }).error, /neither a budget nor an admission/);

    // The request, attached to the proposal it belongs to.
    const admission = admissionFixture();
    const attached = await post(base, `/v1/governance/proposals/${root}/admission`, admission);
    const attachedBody = await attached.text();
    assert.equal(attached.status, 201, attachedBody);

    // A second request for the same decision is refused: a decision admits once.
    const again = await post(base, `/v1/governance/proposals/${root}/admission`, admissionFixture());
    assert.equal(again.status, 409);

    // A payOn the proposal does not offer is refused at attach time, not at execute time.
    const other = proposalFixture(new Date(Date.now() - 5_000).toISOString(), ["yes", "no"]);
    const otherCreated = await post(base, "/v1/governance/proposals", other);
    const otherRoot = (JSON.parse(await otherCreated.text()) as { root: string }).root;
    const mismatched = await post(base, `/v1/governance/proposals/${otherRoot}/admission`, admissionFixture("admit"));
    assert.equal(mismatched.status, 400);
    assert.match(((await mismatched.json()) as { error: string }).error, /not a choice this proposal offers/);

    // The vote decides; execute applies.
    const voter1 = voter();
    const voted = await post(
      base,
      `/v1/governance/proposals/${root}/votes`,
      castVote(document, root, voter1, "admit", new Date(Date.parse(closesAt) - 60_000).toISOString()),
    );
    assert.equal(voted.status, 201, await voted.text());

    const executed = await post(base, `/v1/governance/proposals/${root}/execute`, {});
    const executedBody = await executed.text();
    assert.equal(executed.status, 201, executedBody);
    const applied = JSON.parse(executedBody) as { admitted: { id: string; url: string } };
    assert.equal(applied.admitted.url, "https://new-operator.example.com");

    // Applying again is refused: the same decision is never applied twice.
    const replay = await post(base, `/v1/governance/proposals/${root}/execute`, {});
    assert.equal(replay.status, 409);
    assert.match(((await replay.json()) as { error: string }).error, /never applied twice/);

    // And the list the node serves is a registry list in the seed's own shape,
    // parseable by the SAME rule that reads the published seed.
    const list = await fetch(`${base}/v1/registries`);
    const listBody = (await list.json()) as { registries: Array<Record<string, unknown>> };
    const parsed = parseRegistrySeedList(listBody);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.id, admission.registry.id);
    assert.equal(parsed[0]?.url, "https://new-operator.example.com");
    assert.equal(listBody.registries[0]?.admittedByProposal, root, "the decision that admitted it travels with it");
  } finally {
    await stop(server);
  }
});

test("a rejected admission changes nothing, and says so", async () => {
  const closesAt = new Date(Date.now() - 5_000).toISOString();
  const document = proposalFixture(closesAt);
  const { server, base } = await start();
  try {
    const createdBody = await (await post(base, "/v1/governance/proposals", document)).text();
    const { root } = JSON.parse(createdBody) as { root: string };
    const admission = admissionFixture("admit");
    assert.equal((await post(base, `/v1/governance/proposals/${root}/admission`, admission)).status, 201);

    const voter1 = voter();
    const voted = await post(
      base,
      `/v1/governance/proposals/${root}/votes`,
      castVote(document, root, voter1, "reject", new Date(Date.parse(closesAt) - 60_000).toISOString()),
    );
    assert.equal(voted.status, 201, await voted.text());

    const executed = await post(base, `/v1/governance/proposals/${root}/execute`, {});
    assert.equal(executed.status, 409);
    const body = (await executed.json()) as { error: string };
    assert.match(body.error, /the decision was "reject", not the "admit" the admission named/);
    assert.equal(((await (await fetch(`${base}/v1/registries`)).json()) as { registries: unknown[] }).registries.length, 0);
  } finally {
    await stop(server);
  }
});

test("the same registry id cannot be admitted twice, by two decisions", async () => {
  const closesAt = new Date(Date.now() - 5_000).toISOString();
  const sharedId = `peer-${sha256(randomish()).slice(0, 8)}`;
  const first = proposalFixture(closesAt);
  const second = proposalFixture(closesAt);
  const { server, base } = await start();
  try {
    const rootA = (JSON.parse(await (await post(base, "/v1/governance/proposals", first)).text()) as { root?: string })["root"] as string;
    const rootB = (JSON.parse(await (await post(base, "/v1/governance/proposals", second)).text()) as { root?: string })["root"] as string;

    const admission = admissionFixture("admit", sharedId);
    assert.equal((await post(base, `/v1/governance/proposals/${rootA}/admission`, admission)).status, 201);
    // A SECOND proposal carrying the same id is refused at attach time — the
    // ambiguity never gets as far as a decision.
    const twin = await post(base, `/v1/governance/proposals/${rootB}/admission`, admissionFixture("admit", sharedId));
    assert.equal(twin.status, 409);
    assert.match(((await twin.json()) as { error: string }).error, /one open decision per registry/);

    const voter1 = voter();
    await post(base, `/v1/governance/proposals/${rootA}/votes`, castVote(first, rootA, voter1, "admit", new Date(Date.parse(closesAt) - 60_000).toISOString()));
    const executed = await post(base, `/v1/governance/proposals/${rootA}/execute`, {});
    assert.equal(executed.status, 201, await executed.text());
    assert.equal(((await (await fetch(`${base}/v1/registries`)).json()) as { registries: unknown[] }).registries.length, 1);
  } finally {
    await stop(server);
  }
});

test("a malformed admission is refused by name, and nothing is stored", async () => {
  const closesAt = new Date(Date.now() - 5_000).toISOString();
  const document = proposalFixture(closesAt);
  const { server, base } = await start();
  try {
    const createdBody = await (await post(base, "/v1/governance/proposals", document)).text();
    const { root } = JSON.parse(createdBody) as { root: string };

    const bad = admissionFixture();
    (bad.registry as { url: string }).url = "not-a-url";
    const refused = await post(base, `/v1/governance/proposals/${root}/admission`, bad);
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /url does not parse/);

    const wrongKind = { ...admissionFixture(), kind: "someone-elses-join-request" };
    const kindRefused = await post(base, `/v1/governance/proposals/${root}/admission`, wrongKind);
    assert.equal(kindRefused.status, 400);
    assert.match(((await kindRefused.json()) as { error: string }).error, /rarext.registry-admission.v1/);

    // And the proposal still carries nothing: a refusal leaves no document behind.
    const executed = await post(base, `/v1/governance/proposals/${root}/execute`, {});
    assert.equal(executed.status, 404);
  } finally {
    await stop(server);
  }
});

test("a decision's attachments are VISIBLE: a voter can read what would be admitted", async () => {
  const closesAt = new Date(Date.now() - 5_000).toISOString();
  const document = proposalFixture(closesAt);
  const { server, base } = await start();
  try {
    const created = await post(base, "/v1/governance/proposals", document);
    const createdBody = await created.text();
    assert.equal(created.status, 201, createdBody);
    const { root } = JSON.parse(createdBody) as { root: string };

    // Before an attachment: nothing to see, and the view says so rather than omitting the field.
    const bare = (await (await fetch(`${base}/v1/governance/proposals/${root}`)).json()) as {
      admission: unknown | null;
      budget: unknown | null;
    };
    assert.equal(bare.admission, null);
    assert.equal(bare.budget, null);

    const admission = admissionFixture();
    assert.equal((await post(base, `/v1/governance/proposals/${root}/admission`, admission)).status, 201);

    // After: the voter reads the exact document the decision would apply — url, operator, chains.
    const view = (await (await fetch(`${base}/v1/governance/proposals/${root}`)).json()) as {
      admission: { kind: string; registry: { id: string; url: string; operator: string; chains: string[] }; payOn: string } | null;
      budget: unknown | null;
    };
    assert.ok(view.admission, "the attached admission is served — deciding blind is not deciding");
    assert.equal(view.admission?.kind, GOVERNANCE_ADMISSION_KIND);
    assert.equal(view.admission?.registry.id, admission.registry.id);
    assert.equal(view.admission?.registry.url, admission.registry.url);
    assert.equal(view.admission?.registry.operator, admission.registry.operator);
    assert.deepEqual(view.admission?.registry.chains, admission.registry.chains);
    assert.equal(view.admission?.payOn, admission.payOn);
  } finally {
    await stop(server);
  }
});
