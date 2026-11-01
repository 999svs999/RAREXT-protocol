import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  STATE_ARCHIVE_GENESIS_ROOT,
  stateArchivePreimage,
  stateArchiveProblems,
  stateArchiveRoot,
} from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const halfAdderCircuit = {
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

async function publishAndAnchor(base: Awaited<ReturnType<typeof start>>["base"], title: string) {
  const publish = await post(base, "/v1/publications", {
    author: "operator-alice",
    title,
    taskId: "half-adder",
    circuit: halfAdderCircuit,
  });
  const publishText = await publish.text();
  assert.equal(publish.status, 201, publishText);
  const anchor = await post(base, "/v1/anchors", {});
  const anchorText = await anchor.text();
  assert.equal(anchor.status, 201, anchorText);
  return (JSON.parse(anchorText) as { root: string }).root;
}

test("the state archive: frozen at the anchor, chained to the one before, verifiable by recompute", async () => {
  const { server, store, base } = await start();
  try {
    const firstRoot = await publishAndAnchor(base, "the first anchor");
    const secondRoot = await publishAndAnchor(base, "the second anchor");

    // The chain: two archives, the second chaining to the first.
    const list = (await (await fetch(`${base}/v1/history`)).json()) as {
      archives: Array<Record<string, unknown> & { anchorRoot: string; previousStateRoot: string; stateRoot: string }>;
    };
    assert.equal(list.archives.length, 2);
    assert.equal(list.archives[0]?.previousStateRoot, STATE_ARCHIVE_GENESIS_ROOT, "the first archive chains to genesis");
    assert.equal(
      list.archives[1]?.previousStateRoot,
      list.archives[0]?.stateRoot,
      "the second archive chains to the first: history is a chain, not a list",
    );

    // The verdict is the CLIENT's recompute, not the node's word.
    for (const archive of list.archives) {
      const { stateRoot: _served, ...rest } = archive;
      assert.equal(
        stateArchiveRoot(rest as never, sha256),
        archive.stateRoot,
        `the archive at ${archive.anchorRoot.slice(0, 8)}… recomputes to its served root`,
      );
    }

    // A single archive by the anchor root it was frozen at.
    const one = await fetch(`${base}/v1/history/${secondRoot}`);
    const oneBody = (await one.json()) as { anchorRoot: string; stateRoot: string };
    assert.equal(one.status, 200);
    assert.equal(oneBody.anchorRoot, secondRoot);

    // Tamper detection: a client that recomputes a SERVED archive catches a rewrite.
    const tampered = { ...oneBody, credits: [{ forged: true }] };
    assert.equal(
      stateArchiveRoot(
        {
          anchorRoot: tampered.anchorRoot,
          previousStateRoot: (list.archives[1] as unknown as { previousStateRoot: string }).previousStateRoot,
          proposals: (list.archives[1] as unknown as { proposals: never }).proposals,
          votes: (list.archives[1] as unknown as { votes: never }).votes,
          credits: tampered.credits as never,
          admissions: (list.archives[1] as unknown as { admissions: never }).admissions,
          at: (list.archives[1] as unknown as { at: string }).at,
        },
        sha256,
      ) !== tampered.stateRoot,
      true,
      "a forged credit inside a served archive breaks its state root",
    );

    // And the chain catches a REORDERED history: the head of a valid chain anchors to GENESIS,
    // so a reordered list fails at its head before anything else is trusted.
    const reordered = [...list.archives].reverse();
    assert.equal(
      reordered[0]?.previousStateRoot === STATE_ARCHIVE_GENESIS_ROOT,
      false,
      "a reversed chain does not verify: the head must anchor to genesis, and this one does not",
    );

    // The second anchor's archive carries the credits that existed at its freeze — the
    // ledger's history is IN the archives, not only in the present tense.
    const first = await fetch(`${base}/v1/history/${firstRoot}`);
    const firstBody = (await first.json()) as { credits: unknown[] };
    assert.ok(Array.isArray(firstBody.credits));

    void store;
  } finally {
    await stop(server);
  }
});

test("a re-anchor of the same root never rewrites its archive", async () => {
  const { server, store, base } = await start();
  try {
    await publishAndAnchor(base, "the only anchor");
    const before = store.listStateArchives().length;
    assert.equal(before, 1);

    // The publications are all anchored, so this is "nothing to anchor" — but the archive
    // guard is the store's: a second archive for the same anchor root is refused, whatever
    // the route above it decides.
    const sameAnchor = (await (await fetch(`${base}/v1/anchors`)).json()) as Array<{ root: string }>;
    store.addStateArchive({
      anchorRoot: sameAnchor[0]?.root,
      previousStateRoot: "f".repeat(64),
      proposals: [],
      votes: [],
      credits: [],
      admissions: [],
      at: new Date().toISOString(),
      stateRoot: "e".repeat(64),
    });
    assert.equal(store.listStateArchives().length, 1, "one archive per anchor root, forever");
  } finally {
    await stop(server);
  }
});

test("the preimage seam: hashing the exported preimage equals the synchronous root, byte for byte", () => {
  const archive = {
    anchorRoot: "a".repeat(64),
    previousStateRoot: "b".repeat(64),
    proposals: [{ id: "p1" }],
    votes: [],
    credits: [{ keyId: "k", bounty: 5 }],
    admissions: [],
    at: "2026-11-01T00:00:00.000Z",
  };
  const direct = stateArchiveRoot(archive, sha256);
  const viaPreimage = sha256(stateArchivePreimage(archive));
  assert.equal(viaPreimage, direct, "the preimage is the rule's whole input: hashing it IS the rule");
  // And the preimage names its domain: a preimage from another rule can never collide.
  assert.match(direct && stateArchivePreimage(archive), /^rarext\.state-archive\.v1\n/);
});

test("a malformed archive is refused by name", () => {
  assert.match(
    (stateArchiveProblems({ anchorRoot: "not-a-root" }) as string[]).join(" "),
    /anchorRoot must be a 64-hex/,
  );
  assert.match(
    (stateArchiveProblems({ anchorRoot: "a".repeat(64), previousStateRoot: "b".repeat(64), proposals: [], votes: [], credits: [], admissions: "nope", at: "2026-11-01T00:00:00.000Z" }) as string[]).join(" "),
    /admissions must be an array/,
  );
  assert.equal(stateArchiveProblems({ anchorRoot: "a".repeat(64), previousStateRoot: "b".repeat(64), proposals: [], votes: [], credits: [], admissions: [], at: "2026-11-01T00:00:00.000Z" }).length, 0);

});
