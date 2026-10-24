import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
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
} from "../src/backup.ts";

function fixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "source", "placements"), { recursive: true });
  writeFileSync(join(root, "source", "rarext.json"), '{"version":1}\n');
  writeFileSync(join(root, "source", "placements", "a.json"), '{"blobHash":"aa"}\n');
  return root;
}

test("a truncated archive is refused and a version mismatch never restores", () => {
  const root = fixture("rarext-backup-fault-");
  const archive = join(root, "backup.json.gz");

  try {
    writeBackup(createBackup(join(root, "source")), archive);

    const complete = readFileSync(archive);
    truncateSync(archive, Math.max(1, Math.floor(complete.length / 2)));
    assert.throws(() => readBackup(archive));

    const bundle = createBackup(join(root, "source"));
    const wrongVersion = { ...bundle, version: 2 };
    assert.equal(verifyBackup(wrongVersion).valid, false);
    assert.match(verifyBackup(wrongVersion).errors.join("; "), /version/);
    assert.throws(() => restoreBackup(wrongVersion, join(root, "out")), /not valid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restore that fails while staging leaves the target untouched", () => {
  const root = fixture("rarext-backup-stage-");
  const target = join(root, "restore");

  try {
    const bundle = createBackup(join(root, "source"));
    mkdirSync(target);
    // A file where the restore needs a directory makes the first mkdir fail.
    writeFileSync(join(target, "placements"), "not a directory");

    assert.throws(() => restoreBackup(bundle, target, { force: true }));

    assert.deepEqual(readdirSync(target), ["placements"], "no partial file was committed");
    assert.equal(readFileSync(join(target, "placements"), "utf8"), "not a directory");
    assert.deepEqual(
      readdirSync(target).filter((name) => name.endsWith(".tmp")),
      [],
      "staged temps are cleaned up",
    );
    assert.ok(!readdirSync(target).includes(".rarext-restore.lock"), "the lock is released");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale restore lock blocks a second restore until it is removed", () => {
  const root = fixture("rarext-backup-lock-");
  const target = join(root, "restore");

  try {
    const bundle = createBackup(join(root, "source"));
    mkdirSync(target);
    writeFileSync(join(target, ".rarext-restore.lock"), "1234 0\n");

    assert.throws(() => restoreBackup(bundle, target), /already in progress/);

    rmSync(join(target, ".rarext-restore.lock"));
    const result = restoreBackup(bundle, target);
    assert.equal(result.restored, bundle.files.length);
    assert.ok(!readdirSync(target).includes(".rarext-restore.lock"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restore refuses to write through a pre-existing symlink", () => {
  const root = fixture("rarext-backup-symlink-");
  const target = join(root, "restore");
  const outside = join(root, "outside");

  try {
    const bundle = createBackup(join(root, "source"));
    const escaped = {
      ...bundle,
      files: [
        ...bundle.files,
        {
          path: "link/secret.json",
          sha256: bundle.files[0]!.sha256,
          size: bundle.files[0]!.size,
          content: bundle.files[0]!.content,
        },
      ],
    };
    // Re-seal the manifest so verification accepts the added file.
    escaped.digest = backupDigest(escaped);

    mkdirSync(target);
    mkdirSync(outside);
    symlinkSync(outside, join(target, "link"));
    writeFileSync(join(target, "placeholder"), "x");

    assert.throws(
      () => restoreBackup(escaped, target, { force: true }),
      /symlink/,
    );
    assert.deepEqual(readdirSync(outside), [], "nothing was written outside the target");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent backup writes leave one valid archive and no temp files", async () => {
  const root = fixture("rarext-backup-write-");
  const archive = join(root, "backup.json.gz");

  try {
    const first = createBackup(join(root, "source"), { label: "first" });
    const second = createBackup(join(root, "source"), { label: "second" });

    const results = await Promise.allSettled([
      Promise.resolve().then(() => writeBackup(first, archive)),
      Promise.resolve().then(() => writeBackup(second, archive)),
    ]);

    assert.ok(results.every((result) => result.status === "fulfilled"));
    const written = readBackup(archive);
    assert.ok(written.label === "first" || written.label === "second");
    assert.equal(verifyBackup(written).valid, true);
    assert.deepEqual(
      readdirSync(root).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
