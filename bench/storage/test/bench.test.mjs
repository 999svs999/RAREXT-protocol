import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateCorpus } from "../corpus.mjs";
import { erasureRunner, zstdRunner } from "../methods.mjs";
import { runBenchmark } from "../run.mjs";

function temp() {
  const root = mkdtempSync(join(tmpdir(), "rarext-bench-test-"));

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function hasCommand(command) {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function fakeRunner(overrides = {}) {
  return {
    id: "fake",
    label: "fake codec",
    kind: "classical",
    declaresExact: true,
    decoderBytes: null,
    async run() {
      return {
        slice: "all files",
        inputBytes: 1000,
        storedBytes: 500,
        referenceDigest: "a".repeat(64),
        reconstructedDigest: "a".repeat(64),
        exact: true,
        errorRatio: 0,
        psnr: null,
        verifyMs: 1,
        decodeMs: 2,
        encodeMs: 3,
        decoderBytes: null,
        notes: "",
        ...overrides,
      };
    },
  };
}

test("the generated corpus is deterministic and hash-locked", () => {
  const first = temp();
  const second = temp();

  try {
    const a = generateCorpus(first.root, { scale: 0.001 });
    const b = generateCorpus(second.root, { scale: 0.001 });

    assert.equal(a.digest, b.digest);
    assert.deepEqual(
      a.slices.map((slice) => slice.sha256),
      b.slices.map((slice) => slice.sha256),
    );
    assert.ok(a.slices.some((slice) => slice.modality === "video"));
    assert.ok(a.slices.some((slice) => slice.modality === "photo"));
    assert.ok(a.slices.some((slice) => slice.modality === "audio"));
    assert.ok(a.slices.some((slice) => slice.modality === "text"));
    assert.ok(a.slices.some((slice) => slice.modality === "code"));
    assert.ok(a.slices.some((slice) => slice.modality === "3d"));
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test("a learned codec must declare its decoder size and total includes it", async () => {
  const { root, cleanup } = temp();

  try {
    const manifest = generateCorpus(join(root, "corpus"), { scale: 0.001 });
    const learned = {
      ...fakeRunner({ exact: false, errorRatio: 0.25, reconstructedDigest: "b".repeat(64) }),
      id: "learned",
      label: "learned",
      kind: "learned",
      declaresExact: false,
      decoderBytes: 4 * 1024 * 1024,
    };

    const { report, markdown } = await runBenchmark({
      root: join(root, "corpus"),
      manifest,
      runners: [learned],
    });

    assert.equal(report.rows[0].classification, "bounded");
    assert.equal(report.rows[0].decoderBytes, 4 * 1024 * 1024);
    assert.equal(report.rows[0].totalBytes, 500 + 4 * 1024 * 1024);
    assert.match(markdown, /no — bounded/);
    assert.match(markdown, /4\.00 MiB/);

    await assert.rejects(
      runBenchmark({
        root: join(root, "corpus"),
        manifest,
        runners: [{ ...learned, decoderBytes: null }],
      }),
      /decoder size/,
    );
  } finally {
    cleanup();
  }
});

test("a declared-lossless mismatch is labelled bounded, never exact", async () => {
  const { root, cleanup } = temp();

  try {
    const manifest = generateCorpus(join(root, "corpus"), { scale: 0.001 });
    const { report, markdown } = await runBenchmark({
      root: join(root, "corpus"),
      manifest,
      runners: [
        fakeRunner(),
        fakeRunner({
          exact: false,
          errorRatio: 0.125,
          psnr: 31.5,
          reconstructedDigest: "c".repeat(64),
        }),
      ],
      maxMinutes: 0.0001,
    });

    assert.equal(report.rows[0].classification, "exact");
    assert.equal(report.rows[1].classification, "bounded");
    assert.match(report.rows[1].notes, /declared lossless but the decoded digest differs/);
    assert.match(report.rows[1].notes, /PSNR 31.50 dB/);
    assert.match(markdown, /no — bounded/);
    assert.equal(report.budget.passed, false);
  } finally {
    cleanup();
  }
});

test("the shipped zstd and erasure paths are exact on the corpus", { skip: !hasCommand("zstd") }, async () => {
  const { root, cleanup } = temp();

  try {
    const manifest = generateCorpus(join(root, "corpus"), { scale: 0.001 });
    const { report } = await runBenchmark({
      root: join(root, "corpus"),
      manifest,
      runners: [zstdRunner(), erasureRunner()],
      maxMinutes: 5,
    });

    for (const row of report.rows) {
      assert.equal(row.skipped, undefined);
      assert.equal(row.classification, "exact", row.method);
      assert.equal(row.exact, true);
      assert.ok(row.storedBytes > 0);
      assert.equal(row.totalBytes, row.storedBytes);
    }

    assert.ok(report.rows[0].storedBytes < report.rows[0].inputBytes);
    assert.ok(report.rows[1].storedBytes > report.rows[1].inputBytes);
  } finally {
    cleanup();
  }
});
