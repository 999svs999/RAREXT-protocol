import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalize, leafPayload } from "../../../packages/core/src/index.ts";
import type { Publication } from "../../../packages/core/src/index.ts";

import { start, stop } from "../../api/test/helpers.ts";
import { checkCopy, describeVerdict, resolveInput } from "../src/verify-page.ts";
import type { Bundle } from "../src/verify.ts";

/**
 * The verifier a non-engineer uses. These tests hold two lines: the page is
 * served and reachable, and its arithmetic turns into the right sentence.
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

const hexOf = (value: string): string => createHash("sha256").update(value).digest("hex");
const pair = (left: string, right: string): string =>
  createHash("sha256").update(left).update(right).digest("hex");
function root(leaves: string[]): string {
  if (leaves.length === 0) return hexOf("");
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

function bundle(publications: Publication[]): Bundle {
  const leaves = publications.map((entry) => hexOf(canonicalize(leafPayload(entry, 4))));
  return {
    manifest: {
      root: root(leaves),
      leafVersion: 4,
      publications: publications.map((entry, index) => ({ id: entry.id, leaf: leaves[index]! })),
    },
    publications,
  };
}

test("a pasted reference is understood, and a bad one is explained", () => {
  const bare = resolveInput("a".repeat(64), "https://ai.example.com/verify.html");
  assert.equal(bare.ok, true);
  if (bare.ok) {
    assert.equal(bare.resolved.pinnedRoot, "a".repeat(64));
    assert.ok(bare.resolved.candidates.includes("./bundle.json"));
  }

  const link = resolveInput(`rarext:node.example.com/copies@${"b".repeat(64)}`, "https://ai.example.com/verify.html");
  assert.equal(link.ok, true);
  if (link.ok) {
    assert.equal(link.resolved.pinnedRoot, "b".repeat(64));
    assert.equal(link.resolved.candidates[0], "https://node.example.com/copies/bundle.json");
  }

  const url = resolveInput("https://mirror.example.org/registry/?root=" + "c".repeat(64), "https://ai.example.com/verify.html");
  assert.equal(url.ok, true);
  if (url.ok) {
    assert.equal(url.resolved.pinnedRoot, "c".repeat(64));
    assert.equal(url.resolved.candidates[0], "https://mirror.example.org/registry/bundle.json");
  }

  // The refusals are the help: each says what to paste instead.
  const empty = resolveInput("   ", "https://ai.example.com/verify.html");
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.reason, /Paste a RAREXT link/);

  const garbage = resolveInput("hello world", "https://ai.example.com/verify.html");
  assert.equal(garbage.ok, false);
  if (!garbage.ok) assert.match(garbage.reason, /not something we can check/);

  const badRef = resolveInput("rarext:node.example.com/copies", "https://ai.example.com/verify.html");
  assert.equal(badRef.ok, false);
  if (!badRef.ok) assert.match(badRef.reason, /carries the root it commits to/);
});

test("an honest copy reads as honest, an altered one does not", async () => {
  const good = bundle([publication("p1"), publication("p2")]);
  const goodFetch = (async () =>
    new Response(JSON.stringify(good), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

  const honest = await checkCopy({ pinnedRoot: null, candidates: ["./bundle.json"], understood: "" }, goodFetch);
  assert.equal(honest.verdict.tone, "ok");
  assert.match(honest.verdict.headline, /honest/i);
  assert.equal(honest.publications, 2);
  assert.ok(honest.verdict.facts.some((fact) => fact.value === good.manifest.root));

  // Tamper with the contents after the root was computed: the copy claims a code
  // its own bytes do not rebuild.
  const tampered = JSON.parse(JSON.stringify(good)) as Bundle;
  tampered.publications[0]!.title = "edited after the fact";
  const tamperedFetch = (async () =>
    new Response(JSON.stringify(tampered), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const altered = await checkCopy({ pinnedRoot: null, candidates: ["./bundle.json"], understood: "" }, tamperedFetch);
  assert.equal(altered.verdict.tone, "bad");
  assert.match(altered.verdict.headline, /altered/i);

  // A self-consistent copy that is not the object the link named is a different
  // answer, and says so.
  const wrongPin = await checkCopy(
    { pinnedRoot: "f".repeat(64), candidates: ["./bundle.json"], understood: "" },
    goodFetch,
  );
  assert.equal(wrongPin.verdict.tone, "bad");
  assert.match(wrongPin.verdict.headline, /different object/i);

  // Nothing reachable is not the same as a failed check, and never says "bad".
  const missing = (async () => new Response("nope", { status: 404 })) as typeof fetch;
  const unreachable = await checkCopy({ pinnedRoot: null, candidates: ["./bundle.json"], understood: "" }, missing);
  assert.equal(unreachable.verdict.tone, "unreachable");
  assert.match(unreachable.verdict.headline, /could not check/i);
  assert.ok(unreachable.verdict.facts.some((fact) => /404/.test(fact.value)));
});

test("describeVerdict keeps the arithmetic out of the headline", () => {
  const honest = describeVerdict(
    { valid: true, root: "a".repeat(64), computedRoot: "a".repeat(64), publications: 1, reason: null, aiClaims: [] },
    null,
    1,
    "./bundle.json",
    [],
  );
  assert.equal(honest.tone, "ok");
  assert.equal(honest.facts.find((fact) => fact.label === "Items checked")?.value, "1");
});

test("the verify page is served, reachable, and safe", async () => {
  const { server, base } = await start();
  try {
    const page = await fetch(`${base}/verify.html`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();

    // The one-flow affordances a person needs.
    assert.match(html, /id="check-input"/);
    assert.match(html, /id="check-run"/);
    assert.match(html, /id="verdict"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /id="verdict-sentence"/);
    assert.match(html, /src="\.\/verify-page\.js"/);

    // The page builds DOM with textContent; it must not inject HTML strings.
    assert.doesNotMatch(html, /innerHTML/);

    // Its script is actually served (a page whose bundle 404s is inert), and the
    // bundle carries the verifier, not a stub.
    const script = await fetch(`${base}/verify-page.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    const bundleSource = await script.text();
    assert.match(bundleSource, /readCapped/);
    assert.match(bundleSource, /This copy is honest/);

    // And it is reachable from the surfaces a person actually lands on.
    const home = await (await fetch(`${base}/`)).text();
    assert.match(home, /href="\/verify\.html"|href="\.\/verify\.html"/);
    const ai = await (await fetch(`${base}/ai.html`)).text();
    assert.match(ai, /href="\.\/verify\.html"/);
  } finally {
    await stop(server);
  }
});
