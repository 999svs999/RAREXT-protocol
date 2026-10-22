import test from "node:test";
import assert from "node:assert/strict";

import type {
  BuildLineage,
  BuildSummary,
  Circuit,
  Publication,
} from "../../../packages/core/src/index.ts";
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

const slowHalfAdder: Circuit = {
  components: [
    ...halfAdder.components.filter((component) => component.id !== "sum"),
    { id: "sum0", type: "NAND", inputs: ["xor", "xor"] },
    { id: "sum1", type: "NAND", inputs: ["sum0", "sum0"] },
    { id: "sum", type: "OUTPUT", inputs: ["sum1"] },
  ],
};

async function publish(
  base: string,
  author: string,
  title: string,
  circuit: Circuit,
  parentId: string | null = null,
  source: Publication["source"] = null,
): Promise<Publication> {
  const response = await post(base, "/v1/publications", {
    author,
    title,
    taskId: "half-adder",
    circuit,
    parentId,
    source,
  });

  assert.equal(response.status, 201);
  return (await response.json()) as Publication;
}

test("search builds by filters, sort, reuse, and pagination", async () => {
  const { server, base } = await start();

  try {
    const root = await publish(base, "alice", "Root build", halfAdder, null, {
      kind: "github",
      repo: "alice/machines",
      url: "https://github.com/alice/machines",
      ref: "main",
      path: "half-adder.json",
      commit: "a".repeat(40),
      license: "MIT",
    });
    const child = await publish(base, "bob", "Child build", slowHalfAdder, root.id);
    const grandchild = await publish(base, "carol", "Grandchild build", halfAdder, child.id);
    const other = await publish(base, "alice", "Other root", slowHalfAdder);

    const all = (await (await fetch(`${base}/v1/builds?taskId=half-adder`)).json()) as BuildSummary[];
    assert.equal(all.length, 4);

    const rootSummary = all.find((build) => build.id === root.id);
    assert.equal(rootSummary?.reuses, 1);
    assert.equal(all.find((build) => build.id === child.id)?.reuses, 1);
    assert.equal(all.find((build) => build.id === grandchild.id)?.reuses, 0);

    const efficient = (await (
      await fetch(`${base}/v1/builds?maxGates=5&sort=gates`)
    ).json()) as BuildSummary[];
    assert.equal(efficient.length, 2);
    assert.ok(efficient.every((build) => build.attestation.gateCount === 5));

    const highScore = (await (
      await fetch(`${base}/v1/builds?minScore=900`)
    ).json()) as BuildSummary[];
    assert.equal(highScore.length, 2);

    const byAlice = (await (
      await fetch(`${base}/v1/builds?author=alice`)
    ).json()) as BuildSummary[];
    assert.equal(byAlice.length, 2);

    const roots = (await (
      await fetch(`${base}/v1/builds?root=true`)
    ).json()) as BuildSummary[];
    assert.equal(roots.length, 2);
    assert.ok(roots.every((build) => build.parentId === null));

    const children = (await (
      await fetch(`${base}/v1/builds?parentId=${child.id}`)
    ).json()) as BuildSummary[];
    assert.deepEqual(children.map((build) => build.id), [grandchild.id]);

    const fromGitHub = (await (
      await fetch(`${base}/v1/builds?source=github`)
    ).json()) as BuildSummary[];
    assert.deepEqual(fromGitHub.map((build) => build.id), [root.id]);

    const mostReused = (await (
      await fetch(`${base}/v1/builds?sort=reuses`)
    ).json()) as BuildSummary[];
    assert.equal(mostReused[0].reuses, 1);

    const page = (await (
      await fetch(`${base}/v1/builds?limit=1&offset=1`)
    ).json()) as BuildSummary[];
    assert.equal(page.length, 1);

    const one = (await (
      await fetch(`${base}/v1/builds/${root.id}`)
    ).json()) as BuildSummary;
    assert.equal(one.id, root.id);
    assert.equal(one.reuses, 1);

    const status = await fetch(`${base}/v1/builds?sort=nope`);
    assert.equal(status.status, 400);
    assert.equal((await fetch(`${base}/v1/builds/missing`)).status, 404);
    assert.equal((await fetch(`${base}/v1/builds/${root.id}/lineage`)).status, 200);
    assert.equal((await fetch(`${base}/v1/builds/missing/lineage`)).status, 404);

    assert.equal(other.parentId, null);
  } finally {
    await stop(server);
  }
});

test("lineage returns ancestors from root to parent and all descendants", async () => {
  const { server, base } = await start();

  try {
    const root = await publish(base, "alice", "Root", halfAdder);
    const child = await publish(base, "bob", "Child", slowHalfAdder, root.id);
    const grandchild = await publish(base, "carol", "Grandchild", halfAdder, child.id);

    const middle = (await (
      await fetch(`${base}/v1/builds/${child.id}/lineage`)
    ).json()) as BuildLineage;
    assert.equal(middle.build.id, child.id);
    assert.deepEqual(middle.ancestors.map((build) => build.id), [root.id]);
    assert.deepEqual(middle.descendants.map((build) => build.id), [grandchild.id]);

    const grand = (await (
      await fetch(`${base}/v1/builds/${grandchild.id}/lineage`)
    ).json()) as BuildLineage;
    assert.deepEqual(grand.ancestors.map((build) => build.id), [root.id, child.id]);
    assert.deepEqual(grand.descendants, []);

    const top = (await (
      await fetch(`${base}/v1/builds/${root.id}/lineage`)
    ).json()) as BuildLineage;
    assert.deepEqual(top.ancestors, []);
    assert.deepEqual(
      top.descendants.map((build) => build.id),
      [child.id, grandchild.id],
    );
  } finally {
    await stop(server);
  }
});
