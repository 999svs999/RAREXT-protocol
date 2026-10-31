import test from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  RAREXT_SITE_BINDING_PATH,
  parseSiteBindingDocument,
  verifySiteBinding,
} from "../../../packages/core/src/index.ts";
import { readSiteBinding } from "../../../packages/agent-sdk/src/index.ts";
import { anchorPending } from "../src/anchorer.ts";
import { RarextStore } from "../src/store.ts";
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

/** A node with one anchored batch, which is what a node that has something to say looks like. */
async function anchoredNode() {
  const dir = mkdtempSync(join(tmpdir(), "rarext-node-binding-"));
  const store = new RarextStore(join(dir, "store.json"));
  const { server, base } = await start(store);
  const published = await post(base, "/v1/publications", {
    author: "alice",
    title: "alice half adder",
    taskId: "half-adder",
    circuit: halfAdder,
  });
  assert.equal(published.status, 201);
  const anchor = await anchorPending(store);
  assert.ok(anchor, "the batch anchored");
  return { dir, store, server, base, anchor };
}

async function withRegistryId<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  const previous = process.env.RAREXT_REGISTRY_ID;
  if (value === undefined) delete process.env.RAREXT_REGISTRY_ID;
  else process.env.RAREXT_REGISTRY_ID = value;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.RAREXT_REGISTRY_ID;
    else process.env.RAREXT_REGISTRY_ID = previous;
  }
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [new URL("../../../scripts/site-binding.mjs", import.meta.url).pathname, ...args], {
      cwd: new URL("../../..", import.meta.url).pathname,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("a node that names its registry serves a binding computed from the root it anchored", async () => {
  const node = await anchoredNode();
  try {
    await withRegistryId("rarext", async () => {
      const response = await fetch(`${node.base}${RAREXT_SITE_BINDING_PATH}`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as { registry: string; root: string; bundle: string; issuedAt: string };

      // The statement is the SAME shape a static site publishes, parsed by the same rule.
      const parsed = parseSiteBindingDocument(JSON.stringify(body), { host: "127.0.0.1" });
      assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
      if (!parsed.ok) return;

      // And it is true against this node's own record, not by assertion: the root it states is
      // the root it anchored.
      assert.equal(parsed.binding.root, node.anchor.root);
      assert.equal(parsed.binding.registry, "rarext");
      assert.equal(parsed.binding.issuedAt, node.anchor.createdAt);
      assert.match(String(parsed.binding.bundle), /^http:\/\/127\.0\.0\.1:\d+\/v1\/bundles\/latest$/);

      const verdict = verifySiteBinding(parsed.binding, { pinnedRoot: node.store.listAnchors()[0]!.root, expectedRegistry: "rarext" });
      assert.equal(verdict.ok, true, verdict.ok ? "" : verdict.reason);
    });
  } finally {
    await stop(node.server);
    rmSync(node.dir, { recursive: true, force: true });
  }
});

test("a client reads the node exactly as it reads any site — and one command reaches a verdict", async () => {
  const node = await anchoredNode();
  try {
    await withRegistryId("rarext", async () => {
      // The reader, pointed at a node instead of a static tree. No special path, no API client.
      const read = await readSiteBinding(node.base, {
        allowPrivate: true,
        resolveTxt: async () => {
          const error = new Error("no record") as Error & { code: string };
          error.code = "ENOTFOUND";
          throw error;
        },
      });
      assert.equal(read.file, "served");
      assert.equal(read.parse.ok, true);
      if (!read.parse.ok) return;

      // And the CLI, as an operator would run it.
      const joined = await runCli([node.base, "--registry", "rarext", "--root", node.anchor.root, "--allow-private"]);
      assert.equal(joined.code, 0, joined.stderr);
      assert.match(joined.stdout, /JOINED: this site serves rarext at the pinned root/);

      const wrong = await runCli([node.base, "--root", "b".repeat(64), "--allow-private"]);
      assert.equal(wrong.code, 1);
      assert.match(wrong.stderr, /root-mismatch/);
    });
  } finally {
    await stop(node.server);
    rmSync(node.dir, { recursive: true, force: true });
  }
});

test("a node that has anchored nothing refuses to state a root rather than inventing one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rarext-node-empty-"));
  const store = new RarextStore(join(dir, "store.json"));
  const { server, base } = await start(store);
  try {
    await withRegistryId("rarext", async () => {
      const response = await fetch(`${base}${RAREXT_SITE_BINDING_PATH}`);
      assert.equal(response.status, 404);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /anchored nothing yet/);
    });
  } finally {
    await stop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a node that serves no named registry publishes no binding, and says which setting names one", async () => {
  const node = await anchoredNode();
  try {
    await withRegistryId(undefined, async () => {
      const response = await fetch(`${node.base}${RAREXT_SITE_BINDING_PATH}`);
      assert.equal(response.status, 404);
      const body = (await response.json()) as { error: string };
      assert.match(body.error, /RAREXT_REGISTRY_ID/);

      // A blank setting is the same as none: an empty name is not a name.
      process.env.RAREXT_REGISTRY_ID = "   ";
      const blank = await fetch(`${node.base}${RAREXT_SITE_BINDING_PATH}`);
      assert.equal(blank.status, 404);
    });
  } finally {
    await stop(node.server);
    rmSync(node.dir, { recursive: true, force: true });
  }
});
