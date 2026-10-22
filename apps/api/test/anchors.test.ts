import test from "node:test";
import assert from "node:assert/strict";

import type { Anchor, Circuit, Publication } from "../../../packages/core/src/index.ts";
import { post, start, stop } from "./helpers.ts";

const halfAdder: Circuit = {
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

async function publish(base: string, author: string): Promise<Publication> {
  const response = await post(base, "/v1/publications", {
    author,
    title: `${author} half adder`,
    taskId: "half-adder",
    circuit: halfAdder,
  });

  assert.equal(response.status, 201);
  return (await response.json()) as Publication;
}

test("anchors publications and returns verifiable Merkle proofs", async () => {
  const { server, base } = await start();

  try {
    const first = await publish(base, "alice");
    const second = await publish(base, "bob");

    const anchorResponse = await post(base, "/v1/anchors", {});
    assert.equal(anchorResponse.status, 201);
    const anchor = (await anchorResponse.json()) as Anchor;
    assert.equal(anchor.leafCount, 2);
    assert.deepEqual(anchor.publicationIds, [first.id, second.id]);
    assert.equal(anchor.root.length, 64);

    const proofResponse = await post(base, `/v1/anchors/${anchor.id}/proof`, {
      publicationId: second.id,
    });
    assert.equal(proofResponse.status, 200);
    const proof = (await proofResponse.json()) as { valid: boolean; proof: string[] };
    assert.equal(proof.valid, true);
    assert.equal(proof.proof.length, 1);

    const list = (await (await fetch(`${base}/v1/anchors`)).json()) as Anchor[];
    assert.equal(list.length, 1);

    const again = await post(base, "/v1/anchors", {});
    assert.equal(again.status, 409);
  } finally {
    await stop(server);
  }
});

test("pagination returns stable windows", async () => {
  const { server, base } = await start();

  try {
    for (let index = 0; index < 5; index += 1) {
      await publish(base, `builder${index}`);
    }

    const first = (await (
      await fetch(`${base}/v1/feed?limit=2&offset=0`)
    ).json()) as Publication[];
    const second = (await (
      await fetch(`${base}/v1/feed?limit=2&offset=2`)
    ).json()) as Publication[];

    assert.equal(first.length, 2);
    assert.equal(second.length, 2);
    assert.notEqual(first[0].id, second[0].id);
    assert.equal(new Set([...first, ...second].map((item) => item.id)).size, 4);
  } finally {
    await stop(server);
  }
});
