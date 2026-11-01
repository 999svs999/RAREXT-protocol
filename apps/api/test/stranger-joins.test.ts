import assert from "node:assert/strict";
import test from "node:test";
import { execSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import { join } from "node:path";

import {
  GOVERNANCE_ADMISSION_KIND,
  GOVERNANCE_PROPOSAL_KIND,
  GOVERNANCE_VOTE_KIND,
  canonicalize,
  voteStatement,
} from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const script = join(repoRoot, "scripts", "become-a-node.mjs");

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

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

function castVote(prop: any, root: string, who: ReturnType<typeof voter>, choice: string, issuedAt: string) {
  const base = {
    kind: GOVERNANCE_VOTE_KIND,
    proposalRoot: root,
    choice,
    voter: `anon-${sha256(canonicalize(who.jwk)).slice(0, 8)}`,
    publicKey: who.jwk,
    issuedAt,
    suite: "ecdsa-p256",
  } as unknown as Parameters<typeof voteStatement>[0];
  return { ...base, signature: who.signStatement(voteStatement(base)) };
}

test("the stranger's path: become-a-node prints admission, governance applies it", async () => {
  // Node A: a node already in the federation
  const { server, base } = await start();
  try {
    // Node B becomes a node via the one-command path, capture its admission report
    const out = execSync([script, "--json", "--operator", "stranger-node"].join(" "), {})
      .toString();
    let report: { admission: { kind: string; registry: { id: string; url: string; operator: string; chains: string[]; note: string }; issuedAt: string; payOn: string }; origin: string; anchorRoot: string } | null = null;
    try {
      report = JSON.parse(out);
    } catch {
      assert.fail("become-a-node did not print valid JSON");
    }
    assert.ok(report, "report present");
    assert.equal(report.admission.kind, GOVERNANCE_ADMISSION_KIND, "the printed document is an admission");

    // Node A creates a proposal carrying that admission
    const closesAt = new Date(Date.now() - 5_000).toISOString();
    const proposal = {
      kind: GOVERNANCE_PROPOSAL_KIND,
      id: `prop-${sha256(report.admission.registry.id).slice(0, 12)}`,
      title: "Admit a stranger's node",
      question: `Should ${report.admission.registry.operator}'s node (${report.origin}) join the federation's list?`,
      choices: ["admit", "reject"],
      closesAt,
      quorum: { kind: "keys", value: 1 },
      policy: { kind: "key" },
    };
    const created = await post(base, "/v1/governance/proposals", proposal);
    const createdBody = await created.text();
    assert.equal(created.status, 201, createdBody);
    const { root } = JSON.parse(createdBody) as { root: string };

    // Attach the stranger's admission document
    const attached = await post(base, `/v1/governance/proposals/${root}/admission`, report.admission);
    assert.equal(attached.status, 201, await attached.text());

    // Vote: a participant in the federation votes "admit"
    const voter1 = voter();
    const voted = await post(
      base,
      `/v1/governance/proposals/${root}/votes`,
      castVote(proposal, root, voter1, "admit", new Date(Date.parse(closesAt) - 60_000).toISOString())
    );
    assert.equal(voted.status, 201, await voted.text());

    // Execute
    const executed = await post(base, `/v1/governance/proposals/${root}/execute`, {});
    assert.equal(executed.status, 201, await executed.text());

    // The list grew: A's registry list now names the stranger, carrying the proposal that did it.
    const registries = (
      await (await fetch(`${base}/v1/registries`)).json()
    ) as { registries: Array<{ id: string; url: string; admittedByProposal?: string }> };
    const admitted = registries.registries.find(
      (entry) => entry.id === report.admission.registry.id
    );
    assert.ok(admitted, `the stranger is not in the list: ${registries.registries.map((e) => e.id).join(", ")}`);
    assert.equal(admitted?.url, report.admission.registry.url);
    assert.equal(admitted?.admittedByProposal, root, "the entry names the decision that admitted it");
  } finally {
    await stop(server);
  }
});
