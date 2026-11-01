import assert from "node:assert/strict";
import test from "node:test";

import { post, start, stop } from "./helpers.ts";

const halfAdder = {
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

interface NodesView {
  self: { registry: string | null; origin: string; binding: string; anchoredRoot: string | null; chain: string[] };
  known: Array<{ id: string; url: string; operator: string; source: string; admittedByProposal?: string }>;
  at: string;
}

test("discovery: this node names itself and every peer it knows, with provenance", async () => {
  process.env.RAREXT_REGISTRY_ID = "rarext";
  const { server, store, base } = await start();
  try {
    // A fresh node: no root committed yet, and the peers it knows come from the seed it carries.
    const fresh = (await (await fetch(`${base}/v1/nodes`)).json()) as NodesView;
    assert.equal(fresh.self.registry, "rarext", "the node names the registry it serves");
    assert.match(fresh.self.origin, /^https?:\/\//);
    assert.equal(fresh.self.binding, "/.well-known/rarext.json");
    assert.equal(fresh.self.anchoredRoot, null, "nothing committed yet, and the view says so rather than inventing one");
    assert.ok(fresh.known.length > 0, "the seed it carries is the peers it knows");
    for (const peer of fresh.known) {
      assert.equal(peer.source, "seed", "inherited knowledge is labelled as such");
      assert.match(peer.url, /^https?:\/\//, "a peer has an address a client can walk");
    }

    // A peer the node's OWN rail admitted is a different claim, and says which decision made it.
    const admittedEntry = {
      id: "peer-from-decision",
      url: "https://peer.example.com",
      operator: "peer-operator",
      chains: ["rarex"],
      note: "admitted by the 民主 rail",
    };
    store.applyRegistryAdmission("a".repeat(64), new Date().toISOString(), admittedEntry as never);

    // A peer the seed ALSO lists must not be reported twice: one id, one entry, the older
    // knowledge (the seed) keeping the label.
    const seededId = fresh.known[0]!.id;
    store.applyRegistryAdmission("b".repeat(64), new Date().toISOString(), {
      id: seededId,
      url: "https://duplicate.example.com",
      operator: "duplicate",
      chains: ["rarex"],
      note: "already known from the seed",
    } as never);

    // And a real commitment moves the node's own anchor into the view.
    const publish = await post(base, "/v1/publications", {
      author: "operator-alice",
      title: "the root the discovery view reports",
      taskId: "half-adder",
      circuit: halfAdder,
    });
    assert.equal(publish.status, 201, await publish.text());
    const anchor = await post(base, "/v1/anchors", {});
    const anchorText = await anchor.text();
    assert.equal(anchor.status, 201, anchorText);
    const root = (JSON.parse(anchorText) as { root: string }).root;

    const grown = (await (await fetch(`${base}/v1/nodes`)).json()) as NodesView;
    assert.equal(grown.self.anchoredRoot, root, "the node reports the root it committed");

    const admitted = grown.known.find((peer) => peer.id === "peer-from-decision");
    assert.ok(admitted, "the admitted peer is known");
    assert.equal(admitted?.source, "admission", "and its provenance is the decision, not the seed");
    assert.equal(admitted?.admittedByProposal, "a".repeat(64), "it names the decision that admitted it");

    const duplicates = grown.known.filter((peer) => peer.id === seededId);
    assert.equal(duplicates.length, 1, "one id, one entry — a peer known twice is still one peer");
    assert.equal(duplicates[0]?.source, "seed", "the earlier knowledge keeps the label");
  } finally {
    delete process.env.RAREXT_REGISTRY_ID;
    await stop(server);
  }
});
