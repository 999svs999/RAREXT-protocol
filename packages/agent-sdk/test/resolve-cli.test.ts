import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { creditRoot, publicationRoot } from "../../core/src/index.ts";

const committed = readFileSync(new URL("../../../site/registry/bundle.json", import.meta.url), "utf8");
const seed = JSON.parse(readFileSync(new URL("../../../site/registry/seed.json", import.meta.url), "utf8")) as {
  bundleRoot: string;
};
const ROOT = seed.bundleRoot;
const CLI = new URL("../../../scripts/resolve.mjs", import.meta.url).pathname;

async function serve(bytes: string | Uint8Array, mediaType = "application/json") {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": mediaType });
    response.end(bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/bundle.json`,
    host: `127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: new URL("../../..", import.meta.url).pathname });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the resolve CLI verifies a reference, and its exit code is the verdict", async () => {
  const origin = await serve(committed);
  try {
    const ok = await runCli([`rarext:${origin.host}/bundle.json@${ROOT}`, "--scheme", "http"]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /reference rarext:127\.0\.0\.1:\d+\/bundle\.json@/);
    assert.match(ok.stdout, /VERIFIED: /);
    assert.match(ok.stdout, new RegExp(ROOT));

    const json = await runCli([`rarext:${origin.host}/bundle.json@${ROOT}`, "--scheme", "http", "--json"]);
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout) as { resolved: { root: string; source: string }; error: null; attempts: unknown[] };
    assert.equal(parsed.resolved.root, ROOT);
    assert.equal(parsed.resolved.source, origin.url);
    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.attempts, [], "a copy that verified on the first try accumulated no refusals");
  } finally {
    await origin.close();
  }
});

test("a wrong root is refused with BOTH roots named, and a bare root with no candidates says why", async () => {
  const origin = await serve(committed);
  try {
    const wrong = await runCli([
      `rarext:${origin.host}/bundle.json@${"c".repeat(64)}`,
      "--scheme",
      "http",
      "--json",
    ]);
    assert.equal(wrong.code, 1);
    const parsed = JSON.parse(wrong.stdout) as { resolved: null; error: string; attempts: Array<{ url: string; reason: string }> };
    assert.equal(parsed.resolved, null);
    assert.match(parsed.error, /no candidate rebuilt the pinned root/);
    assert.match(parsed.error, /reading the same candidates as records and as bytes found none/);
    // THREE attempts for ONE candidate: a reference does not say what it names, so a bundle, a
    // record and the bytes are all tried and all reported — "not a bundle" is not "not there".
    assert.equal(parsed.attempts.length, 3);
    // The evidence says what was rebuilt and what was pinned, so a reader can see the difference.
    assert.match(parsed.attempts[0]!.reason, new RegExp(ROOT));
    assert.match(parsed.attempts[0]!.reason, /c{16}/);
    // The record reading refuses by recomputation, and the byte reading by digest — different
    // questions, so they get different answers rather than one merged "nope". The record refusal
    // still says what the document WAS, so a reader can tell "wrong root" from "not a record".
    assert.match(parsed.attempts[1]!.reason, /as a publication it is [0-9a-f]{16}/);
    assert.match(parsed.attempts[1]!.reason, /no record rule rebuilds this document/);
    assert.match(parsed.attempts[2]!.reason, /its bytes hash to [0-9a-f]{16}/);
    assert.match(parsed.attempts[2]!.reason, /not the pinned c{16}/);
  } finally {
    await origin.close();
  }

  const bare = await runCli([`rarext:${ROOT}`]);
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /says what to look for, not where/);
});

test("the CLI refuses what is not a reference, and a usage it cannot honour", async () => {
  const notOne = await runCli(["https://example.com/registry/bundle.json"]);
  assert.equal(notOne.code, 1);
  assert.match(notOne.stderr, /NOT A RAREXT REFERENCE/);

  const usage = await runCli([]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /usage: node scripts\/resolve\.mjs/);

  const badScheme = await runCli([`rarext:${ROOT}`, "--scheme", "rarext"]);
  assert.equal(badScheme.code, 2);
  assert.match(badScheme.stderr, /a reference resolves over http or https/);
});

test("the CLI says WHICH reading answered: a blob is named by the sha256 of its bytes, and its bytes are a length, not a dump", async () => {
  const bytes = Buffer.from("an image, a model file, a tarball — the CLI does not care, and says so", "utf8");
  const root = createHash("sha256").update(bytes).digest("hex");
  const origin = await serve(bytes, "image/png");
  try {
    const human = await runCli([`rarext:${origin.host}/bundle.json@${root}`, "--scheme", "http"]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /VERIFIED: /);
    assert.match(human.stdout, /a blob of \d+ bytes \(image\/png\), by the sha256 of its bytes/);

    const json = await runCli([`rarext:${origin.host}/bundle.json@${root}`, "--scheme", "http", "--json"]);
    assert.equal(json.code, 0, json.stderr);
    const parsed = JSON.parse(json.stdout) as {
      resolved: { kind: string; root: string; bytes: number; mediaType: string };
    };
    assert.equal(parsed.resolved.kind, "blob");
    assert.equal(parsed.resolved.root, root);
    assert.equal(parsed.resolved.mediaType, "image/png");
    // A LENGTH: a JSON dump of a model file would help nobody, and a caller who wants the object
    // fetches it themselves.
    assert.equal(parsed.resolved.bytes, bytes.length);
    assert.ok(json.stdout.length < 4096, "the object's bytes never enter the output");
  } finally {
    await origin.close();
  }
});

test("the CLI names a RECORD: the storage economy's entries are addressable by the root they rebuild to", async () => {
  const record = (JSON.parse(committed) as { publications: Array<Record<string, unknown>> }).publications[0]!;
  const hash = (value: string | Uint8Array) =>
    createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");
  const root = publicationRoot(record as never, hash);

  const origin = await serve(JSON.stringify({ ...record, root }), "application/json");
  try {
    const human = await runCli([`rarext:${origin.host}/bundle.json@${root}`, "--scheme", "http"]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /a published record by .+, by the root the record rebuilds to/);

    const json = await runCli([`rarext:${origin.host}/bundle.json@${root}`, "--scheme", "http", "--json"]);
    const parsed = JSON.parse(json.stdout) as {
      resolved: { kind: string; root: string; record: { id: string; author: string; title: string } };
    };
    assert.equal(parsed.resolved.kind, "publication");
    assert.equal(parsed.resolved.root, root);
    assert.equal(parsed.resolved.record.id, record.id);
    assert.ok(parsed.resolved.record.author, "who published it travels with the answer");
  } finally {
    await origin.close();
  }
});

test("the CLI names an ANCHOR: the protocol's trust root is addressable by the root the anchor rebuilds to", async () => {
  const anchor = {
    id: "minted-label",
    root: "a".repeat(64),
    publicationIds: ["p1", "p2"],
    leafCount: 2,
    leafVersion: 2,
    createdAt: "2026-11-01T00:00:00.000Z",
    adapter: "eip-3009-anchor",
    reference: "0xabc",
    receipts: [{ adapter: "eip-3009-anchor", status: "ok" }],
  };
  const hash = (value: string | Uint8Array) =>
    createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");
  const { anchorRoot } = await import("../../core/src/index.ts");
  const root = anchorRoot(anchor as never, hash);

  const origin = await serve(JSON.stringify({ ...anchor, durabilityNote: "attached, not part of it" }), "application/json");
  try {
    const human = await runCli([`rarext:${origin.host}/anchor.json@${root}`, "--scheme", "http"]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /an anchor of 2 publication\(s\) via eip-3009-anchor \(0xabc\), by the root the anchor rebuilds to/);

    const json = await runCli([`rarext:${origin.host}/anchor.json@${root}`, "--scheme", "http", "--json"]);
    const parsed = JSON.parse(json.stdout) as {
      resolved: { kind: string; record: { anchoredRoot: string; adapter: string; reference: string } };
    };
    assert.equal(parsed.resolved.kind, "anchor");
    assert.equal(parsed.resolved.record.anchoredRoot, anchor.root);
    assert.equal(parsed.resolved.record.adapter, "eip-3009-anchor");
  } finally {
    await origin.close();
  }
});

test("the CLI names a RECEIPT: what was earned, by whom, for what", async () => {
  const record = {
    keyId: "worker-key",
    action: "verify",
    bounty: 12,
    challengeId: "gen-starter",
    artifactHash: "c".repeat(64),
    at: "2026-11-01T00:00:00.000Z",
  };
  const hash = (value: string | Uint8Array) =>
    createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");
  const root = creditRoot(record, hash);

  const origin = await serve(JSON.stringify({ ...record, root }), "application/json");
  try {
    const human = await runCli([`rarext:${origin.host}/receipt.json@${root}`, "--scheme", "http"]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(
      human.stdout,
      /a credit of 12 credit\(s\) to worker-key for verify on gen-starter, by the root the receipt rebuilds to/,
    );

    const json = await runCli([`rarext:${origin.host}/receipt.json@${root}`, "--scheme", "http", "--json"]);
    const parsed = JSON.parse(json.stdout) as {
      resolved: { kind: string; record: { action: string; bounty: number; at: string } };
    };
    assert.equal(parsed.resolved.kind, "credit");
    assert.equal(parsed.resolved.record.bounty, 12);
    assert.ok(parsed.resolved.record.at, "when it was earned travels with the answer");
    // The machine contract is not prose: whatever the resolver prints must be an
    // INSTANCE of the published schema, validated against the file itself — not
    // against a copy of its rules in this test.
    const schema = readSchema();
    validateAgainstSchema(JSON.parse(json.stdout), schema, schema);
  } finally {
    await origin.close();
  }
});

test("a failed resolution is a schema-valid outcome document too", { timeout: 60_000 }, async () => {
  // The committed bytes themselves — NOT JSON.stringify(committed), which would
  // serve a quoted string and make the bundle reading malformed instead of the
  // answered-but-wrong copy this fixture exists to exercise.
  const origin = await serve(committed, "application/json");
  try {
    const wrongRoot = "1".repeat(64);
    const result = await runCli([`rarext:${origin.host}/bundle.json@${wrongRoot}`, "--scheme", "http", "--json"]);
    assert.equal(result.code, 1, "nothing verified, so the exit is 1");
    const parsed = JSON.parse(result.stdout) as { resolved: null; error: string; attempts: Array<{ kind: string }> };
    assert.equal(parsed.resolved, null);
    assert.ok(parsed.error, "the failure names itself");
    assert.ok(parsed.attempts.length >= 1, "the refusal kept its evidence");
    assert.ok(parsed.attempts.every((a) => a.kind === "mismatch"), "an answered-but-wrong copy is a mismatch");
    const schema = readSchema();
    validateAgainstSchema(parsed, schema, schema);
  } finally {
    await origin.close();
  }
});

/** The published schema, read from the tree it ships in. */
function readSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL("../../../site/schema/resolve-outcome.schema.json", import.meta.url), "utf8"));
}

/**
 * A structural validator for the slice of JSON Schema the outcome document uses:
 * required fields, additionalProperties, type unions, enums, patterns, and the
 * conditional requirements (blob carries bytes+mediaType; a record kind carries
 * record). Hand-rolled on purpose — the native path has zero installs, and a
 * dependency-free validator is the honest size of the schema's own features.
 */
function validateAgainstSchema(outcome: unknown, schema: any, root: any = schema, path = "outcome"): void {
  if (schema.$ref) {
    const target = schema.$ref.split("/").slice(1).reduce((acc: any, key: string) => acc[key], root);
    return validateAgainstSchema(outcome, target, root, path);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch: any) => {
      try {
        validateAgainstSchema(outcome, branch, root, path);
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(matches.length, 1, `${path}: matches ${matches.length} of the oneOf branches, expected exactly 1`);
    return;
  }
  if (schema.allOf) {
    for (const branch of schema.allOf) validateAgainstSchema(outcome, branch, root, path);
    const rest = { ...schema, allOf: undefined };
    return validateAgainstSchema(outcome, rest, root, path);
  }
  if (schema.if) {
    const holds = (() => {
      try {
        validateAgainstSchema(outcome, schema.if, root, path);
        return true;
      } catch {
        return false;
      }
    })();
    if (holds && schema.then) validateAgainstSchema(outcome, schema.then, root, path);
    return;
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length) {
    const actual = outcome === null ? "null" : Array.isArray(outcome) ? "array" : typeof outcome;
    assert.ok(
      types.includes(actual) || (types.includes("integer") && actual === "number" && Number.isInteger(outcome)),
      `${path}: ${actual} is not one of ${types.join("|")}`,
    );
  }
  if (schema.pattern && typeof outcome === "string") {
    assert.match(outcome, new RegExp(schema.pattern), `${path}: pattern ${schema.pattern}`);
  }
  if (schema.enum) {
    assert.ok(schema.enum.includes(outcome), `${path}: ${JSON.stringify(outcome)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if ("const" in schema) {
    assert.deepEqual(outcome, schema.const, `${path}: ${JSON.stringify(outcome)} is not the const ${JSON.stringify(schema.const)}`);
  }
  if (typeof outcome === "object" && outcome !== null && !Array.isArray(outcome)) {
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      assert.ok(name in outcome, `${path}: missing required "${name}"`);
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(outcome)) {
        assert.ok(name in properties, `${path}: "${name}" is not in the schema`);
      }
    }
    for (const [name, value] of Object.entries(outcome)) {
      if (properties[name]) validateAgainstSchema(value, properties[name], root, `${path}.${name}`);
    }
  }
  if (Array.isArray(outcome) && schema.items) {
    for (const [index, value] of outcome.entries()) validateAgainstSchema(value, schema.items, root, `${path}[${index}]`);
  }
}
