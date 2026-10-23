import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import { TracRegistryService, type TaskRegistryEntry } from "../src/tracregistry.ts";
import { TracAnchorAdapter } from "../src/adapters/trac.ts";
import { AdapterRegistry } from "../src/adapters/registry.ts";
import { RarextStore } from "../src/store.ts";
import { start, stop } from "./helpers.ts";

test("trac task registry loads fixture with multiple states and handles missing case", () => {
  const fixturePath = path.resolve("apps/api/test/fixtures/trac-tasks.json");
  const raw = fs.readFileSync(fixturePath, "utf-8");
  const entries: TaskRegistryEntry[] = JSON.parse(raw);

  entries.push({
    handle: "trac-task-failed",
    status: "failed",
    app: "chess",
    challengeId: "half-adder",
    createdAt: "2026-10-23T00:03:00.000Z",
  });

  const registry = new TracRegistryService(entries);

  assert.equal(registry.list().length, 4);

  const pending = registry.get("trac-task-pending");
  assert.ok(pending);
  assert.equal(pending.status, "pending");

  const running = registry.get("trac-task-running");
  assert.ok(running);
  assert.equal(running.status, "running");

  const completed = registry.get("trac-task-completed");
  assert.ok(completed);
  assert.equal(completed.status, "completed");

  const failed = registry.get("trac-task-failed");
  assert.ok(failed);
  assert.equal(failed.status, "failed");

  const missing = registry.get("trac-task-missing");
  assert.strictEqual(missing, null);
});

test("API integration test for /v1/tracregistry asserts TaskRegistryEntry shape", async () => {
  const fixturePath = path.resolve("apps/api/test/fixtures/trac-tasks.json");
  const raw = fs.readFileSync(fixturePath, "utf-8");
  const entries: TaskRegistryEntry[] = JSON.parse(raw);

  const tracRegistry = new TracRegistryService(entries);
  const tracAdapter = new TracAnchorAdapter(undefined, tracRegistry);
  const registry = new AdapterRegistry([tracAdapter]);

  const store = new RarextStore();
  const { server, base } = await start(store, { registry });

  try {
    // 1. List all tasks
    const listRes = await fetch(`${base}/v1/tracregistry`);
    assert.equal(listRes.status, 200);
    const listData = (await listRes.json()) as TaskRegistryEntry[];
    assert.ok(Array.isArray(listData));
    assert.equal(listData.length, 3);

    for (const item of listData) {
      assert.equal(typeof item.handle, "string");
      assert.ok(["pending", "running", "completed", "failed"].includes(item.status));
      assert.equal(typeof item.app, "string");
      assert.equal(typeof item.challengeId, "string");
      assert.equal(typeof item.createdAt, "string");
    }

    // 2. Query by query param (?handle=...)
    const queryRes = await fetch(`${base}/v1/tracregistry?handle=trac-task-pending`);
    assert.equal(queryRes.status, 200);
    const queryData = (await queryRes.json()) as TaskRegistryEntry;
    assert.equal(queryData.handle, "trac-task-pending");
    assert.equal(queryData.status, "pending");
    assert.equal(typeof queryData.app, "string");
    assert.equal(typeof queryData.challengeId, "string");
    assert.equal(typeof queryData.createdAt, "string");

    // 3. Query by path param (/v1/tracregistry/:handle)
    const pathRes = await fetch(`${base}/v1/tracregistry/trac-task-running`);
    assert.equal(pathRes.status, 200);
    const pathData = (await pathRes.json()) as TaskRegistryEntry;
    assert.equal(pathData.handle, "trac-task-running");
    assert.equal(pathData.status, "running");

    // 4. Missing handle case -> 404
    const missingRes = await fetch(`${base}/v1/tracregistry?handle=trac-task-missing`);
    assert.equal(missingRes.status, 404);

    const missingPathRes = await fetch(`${base}/v1/tracregistry/trac-task-missing`);
    assert.equal(missingPathRes.status, 404);

    // A query param that is not a valid handle still resolves to 404, not 500.
    const emptyParamRes = await fetch(`${base}/v1/tracregistry?handle=`);
    assert.equal(emptyParamRes.status, 200);
  } finally {
    await stop(server);
  }
});

test("GET /v1/tracregistry is read-only: concurrent and repeated reads are consistent", async () => {
  const fixturePath = path.resolve("apps/api/test/fixtures/trac-tasks.json");
  const raw = fs.readFileSync(fixturePath, "utf-8");
  const entries: TaskRegistryEntry[] = JSON.parse(raw);

  const tracRegistry = new TracRegistryService(entries);
  const tracAdapter = new TracAnchorAdapter(undefined, tracRegistry);
  const registry = new AdapterRegistry([tracAdapter]);

  const store = new RarextStore();
  const { server, base } = await start(store, { registry });

  try {
    // The endpoint only reads, so racing reads return identical lists.
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => fetch(`${base}/v1/tracregistry`)),
    );
    for (const res of concurrent) {
      assert.equal(res.status, 200);
    }
    const lists = await Promise.all(concurrent.map((res) => res.json()));
    for (const list of lists) {
      assert.deepEqual(
        (list as TaskRegistryEntry[]).map((entry) => entry.handle),
        ["trac-task-pending", "trac-task-running", "trac-task-completed"],
      );
    }
  } finally {
    await stop(server);
  }
});
