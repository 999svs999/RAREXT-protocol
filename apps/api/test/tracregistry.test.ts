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

// ---------------------------------------------------------------------------
// Hardening round: the task registry. It is served by the API, so a value it
// accepts is a value it publishes — and it is published as read-only.
// ---------------------------------------------------------------------------

function entryFor(overrides: Record<string, unknown> = {}) {
  return {
    handle: "trac-task-x",
    status: "pending",
    app: "chess",
    challengeId: "half-adder",
    createdAt: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}

test("mechanism: shape — every field the type promises is enforced at runtime", () => {
  // Measured before the fix: all six of these were ACCEPTED and served.
  const refused: Array<[string, RegExp]> = [
    ["unknown status", /status must be one of pending, running, completed, failed/],
    ["non-string app", /app must be a string/],
    ["object challengeId", /challengeId must be a string/],
    ["unparseable createdAt", /createdAt must be an ISO timestamp/],
    ["whitespace handle", /handle must not be empty/],
    ["array handle", /handle must be a string/],
    ["missing handle", /handle must be a string/],
    ["control character in handle", /handle must not contain control characters/],
    ["overlong app", /app is longer than 200/],
  ];

  const bad: Record<string, unknown> = {
    "unknown status": { status: "finished" },
    "non-string app": { app: 5 },
    "object challengeId": { challengeId: {} },
    "unparseable createdAt": { createdAt: "not-a-date" },
    "whitespace handle": { handle: "   " },
    "array handle": { handle: ["trac-task-x"] },
    "missing handle": { handle: undefined },
    "control character in handle": { handle: "trac\u0000task" },
    "overlong app": { app: "a".repeat(201) },
  };

  for (const [name, pattern] of refused) {
    const registry = new TracRegistryService();
    assert.throws(
      () => registry.register(entryFor(bad[name] as Record<string, unknown>) as never),
      pattern,
      `${name} must be refused`,
    );
    assert.equal(registry.list().length, 0, `${name} must not be stored`);
  }

  assert.throws(() => new TracRegistryService([null as never]), /expected an object/);
});

test("mechanism: shape — a valid entry is accepted, normalised in place, and kept verbatim", () => {
  const registry = new TracRegistryService();
  registry.register(entryFor({ handle: "  trac-task-padded  " }) as never);

  const stored = registry.get("trac-task-padded");
  assert.ok(stored, "the trimmed handle is the one that answers");
  assert.equal(stored.handle, "trac-task-padded");
  assert.equal(stored.createdAt, "2026-10-23T00:00:00.000Z", "the timestamp is kept as given");
  assert.equal(registry.get("  trac-task-padded  "), null, "handles match exactly");

  for (const status of ["pending", "running", "completed", "failed"] as const) {
    const each = new TracRegistryService();
    each.register(entryFor({ status }) as never);
    assert.equal(each.get("trac-task-x")?.status, status);
  }
});

test("mechanism: read-only — a reader cannot rewrite what everyone else is served", () => {
  const registry = new TracRegistryService();
  registry.register(entryFor({ status: "running" }) as never);

  // The record handed out is a frozen copy: the surface is published read-only,
  // and before the fix one caller's edit became every reader's answer.
  const viaGet = registry.get("trac-task-x")!;
  assert.throws(() => {
    (viaGet as { status: string }).status = "completed";
  }, /read only|readonly|Cannot assign/i);
  assert.equal(registry.get("trac-task-x")!.status, "running");

  const viaList = registry.list()[0]!;
  assert.throws(() => {
    (viaList as { status: string }).status = "failed";
  }, /read only|readonly|Cannot assign/i);
  assert.equal(registry.get("trac-task-x")!.status, "running");

  // And the copies are distinct objects, so a holder cannot reach the store.
  assert.notEqual(registry.get("trac-task-x"), registry.get("trac-task-x"));
});

test("mechanism: identity — re-registering a handle replaces it without duplicating the list", () => {
  const registry = new TracRegistryService();
  registry.register(entryFor({ status: "pending" }) as never);
  registry.register(entryFor({ status: "completed" }) as never);

  assert.equal(registry.list().length, 1, "one handle, one entry");
  assert.equal(registry.get("trac-task-x")!.status, "completed");
});

test("mechanism: addressability — every stored entry can be fetched by its own handle", () => {
  // The array handle was accepted before the fix: present in list(), unfetchable
  // by handle, and unreachable from the API's string path segment.
  const registry = new TracRegistryService();
  for (const handle of ["a", "b", "c"]) {
    registry.register(entryFor({ handle }) as never);
  }

  for (const stored of registry.list()) {
    assert.equal(typeof stored.handle, "string");
    assert.deepEqual(registry.get(stored.handle), stored, `entry ${String(stored.handle)} is addressable`);
  }
});

test("mechanism: api — the served registry is well-formed, and unknown handles are 404", async () => {
  const fixturePath = path.resolve("apps/api/test/fixtures/trac-tasks.json");
  const entries: TaskRegistryEntry[] = JSON.parse(fs.readFileSync(fixturePath, "utf-8"));
  const { server, store, base } = await start();

  try {
    const service = new TracRegistryService(entries);
    void service;
    void store;

    const listed = (await (await fetch(`${base}/v1/tracregistry`)).json()) as TaskRegistryEntry[];
    assert.ok(Array.isArray(listed));
    for (const entry of listed) {
      assert.ok(
        ["pending", "running", "completed", "failed"].includes(entry.status),
        `served status ${JSON.stringify(entry.status)} is not one of the four`,
      );
      assert.equal(typeof entry.handle, "string");
      assert.equal(typeof entry.app, "string");
      assert.equal(typeof entry.challengeId, "string");
      assert.equal(Number.isNaN(Date.parse(entry.createdAt)), false);
    }

    const unknown = await fetch(`${base}/v1/tracregistry/trac-task-missing`);
    assert.equal(unknown.status, 404);
  } finally {
    await stop(server);
  }
});
