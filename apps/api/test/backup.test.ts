import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  backupDigest,
  createBackup,
  readBackup,
  restoreBackup,
  verifyBackup,
  writeBackup,
  type BackupBundle,
} from "../src/backup.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rarext-backup-"));

  mkdirSync(join(root, "placements"));
  mkdirSync(join(root, "verifier-operators"));
  writeFileSync(join(root, "rarext.json"), '{"version":1,"publications":[]}\n');
  writeFileSync(join(root, "placements", "a.json"), '{"blobHash":"aa"}\n');
  writeFileSync(join(root, "verifier-operators", "b.json"), '{"keyId":"bb"}\n');
  writeFileSync(join(root, "rarext.json.123.tmp"), "not a backup");

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a data directory round-trips through create, verify, and restore", () => {
  const { root, cleanup } = fixture();
  const out = join(root, "..", `${Date.now()}-backup.json.gz`);

  try {
    const bundle = createBackup(root, {
      label: "test",
      now: () => new Date("2026-10-23T12:00:00.000Z"),
    });

    assert.equal(bundle.createdAt, "2026-10-23T12:00:00.000Z");
    assert.deepEqual(
      bundle.files.map((file) => file.path),
      ["placements/a.json", "rarext.json", "verifier-operators/b.json"],
    );
    assert.equal(verifyBackup(bundle).valid, true);
    assert.equal(verifyBackup(bundle).files, 3);

    const reversed = { ...bundle, files: [...bundle.files].reverse() };

    assert.equal(verifyBackup(reversed).valid, true, "file order is not part of the digest");

    writeBackup(bundle, out);

    const read = readBackup(out);

    assert.deepEqual(read, bundle);
    const bytes = read.files.reduce((total, file) => total + file.size, 0);

    assert.equal(verifyBackup(read).bytes, bytes);

    const target = join(root, "restored");

    assert.deepEqual(restoreBackup(read, target), { restored: 3, bytes });
    assert.equal(
      readFileSync(join(target, "rarext.json"), "utf8"),
      '{"version":1,"publications":[]}\n',
    );
    assert.equal(
      readFileSync(join(target, "placements", "a.json"), "utf8"),
      '{"blobHash":"aa"}\n',
    );
    assert.throws(() => readFileSync(join(target, "rarext.json.123.tmp")));
    assert.throws(() => restoreBackup(read, target), /not empty/);
    assert.equal(restoreBackup(read, target, { force: true }).restored, 3);
  } finally {
    rmSync(out, { force: true });
    cleanup();
  }
});

test("a modified file, digest, or path is refused", () => {
  const { root, cleanup } = fixture();

  try {
    const bundle = createBackup(root);

    const content = structuredClone(bundle);
    content.files[0]!.content = Buffer.alloc(content.files[0]!.size, "x").toString("base64");

    assert.equal(verifyBackup(content).valid, false);
    assert.match(verifyBackup(content).errors.join("; "), /does not match its digest/);

    const size = structuredClone(bundle);
    size.files[0]!.size += 1;

    assert.equal(verifyBackup(size).valid, false);
    assert.match(verifyBackup(size).errors.join("; "), /bytes, expected/);

    const digest = structuredClone(bundle);
    digest.digest = "0".repeat(64);

    assert.equal(verifyBackup(digest).valid, false);
    assert.match(verifyBackup(digest).errors.join("; "), /digest does not match/);

    const traversal = structuredClone(bundle);
    traversal.files[0]!.path = "../outside.json";
    traversal.digest = backupDigest(traversal);

    assert.equal(verifyBackup(traversal).valid, false);
    assert.match(verifyBackup(traversal).errors.join("; "), /safe relative path/);
    assert.throws(() => restoreBackup(traversal, join(root, "restored")), /not valid/);

    const duplicate = structuredClone(bundle);
    duplicate.files[1]!.path = duplicate.files[0]!.path;
    duplicate.digest = backupDigest(duplicate);

    assert.equal(verifyBackup(duplicate).valid, false);
    assert.match(verifyBackup(duplicate).errors.join("; "), /repeats/);

    assert.equal(verifyBackup(null).valid, false);
    assert.equal(verifyBackup({ kind: "rarext.backup" }).valid, false);
  } finally {
    cleanup();
  }
});

test("create refuses a missing directory and accepts an empty one", () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-backup-empty-"));

  try {
    assert.throws(() => createBackup(join(root, "missing")), /not a directory/);

    const bundle = createBackup(root);

    assert.equal(bundle.files.length, 0);
    assert.equal(verifyBackup(bundle).valid, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI creates, verifies, and restores the same bundle", () => {
  const { root, cleanup } = fixture();
  const out = join(root, "..", `${Date.now()}-cli.json.gz`);
  const target = join(root, "..", `${Date.now()}-cli-restore`);

  try {
    const run = (...args: string[]) =>
      execFileSync(process.execPath, ["scripts/backup.mjs", ...args], {
        cwd: join(import.meta.dirname, "..", "..", ".."),
        encoding: "utf8",
      });

    assert.match(
      run("create", "--data", root, "--out", out, "--label", "cli"),
      /backed up 3 file\(s\)/,
    );
    assert.match(run("verify", "--file", out), /valid: 3 file\(s\)/);
    assert.match(
      run("restore", "--file", out, "--data", target),
      /restored 3 file\(s\)/,
    );
    assert.equal(readFileSync(join(target, "rarext.json"), "utf8"), '{"version":1,"publications":[]}\n');
  } finally {
    rmSync(out, { force: true });
    rmSync(target, { recursive: true, force: true });
    cleanup();
  }
});

function structuredClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test("an invalid bundle is never written", () => {
  const bundle = createBackup(mkdtempSync(join(tmpdir(), "rarext-backup-write-"))) as BackupBundle;

  assert.throws(
    () => writeBackup({ ...bundle, digest: "f".repeat(64) }, join(tmpdir(), "nope.json.gz")),
    /refusing to write/,
  );
});
