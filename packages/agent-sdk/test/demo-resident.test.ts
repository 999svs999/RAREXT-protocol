import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cidV1Raw, verifyBundle, type Bundle } from "../src/index.ts";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const script = join(repo, "scripts", "demo-resident.mjs");
const committedPath = join(repo, "site", "registry", "bundle.json");

function runDemo(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * A served tree shaped like the published one: seed.json names the bundle and
 * its mirror as paths relative to the seed, both copies are the committed
 * bundle's exact bytes, and the seed pins its root and CID. `tamper` rewrites
 * a title in both copies while the seed still pins the honest bytes, which is
 * exactly the case the demo must refuse by name.
 */
async function makeTree(tamper: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "rarext-resident-"));
  const originalBytes = await readFile(committedPath);
  const committed = JSON.parse(originalBytes.toString("utf8")) as Bundle;
  const verification = verifyBundle(committed);
  assert.equal(verification.valid, true, verification.reason ?? undefined);

  let served = originalBytes;
  if (tamper) {
    const altered = structuredClone(committed);
    altered.publications = altered.publications.map((publication, index) =>
      index === 0 ? { ...publication, title: "an altered title" } : publication,
    );
    served = Buffer.from(JSON.stringify(altered), "utf8");
  }

  await writeFile(join(directory, "bundle.json"), served);
  await mkdir(join(directory, "mirror"));
  await writeFile(join(directory, "mirror", "bundle.json"), served);
  await writeFile(
    join(directory, "seed.json"),
    JSON.stringify(
      {
        version: 1,
        bundle: "bundle.json",
        bundleRoot: verification.computedRoot,
        bundleCid: cidV1Raw(originalBytes),
        mirrors: [{ bundle: "mirror/bundle.json", root: verification.computedRoot }],
      },
      null,
      2,
    ),
  );

  return { directory, root: verification.computedRoot!, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("the resident demo verifies a local copy and replays both AI claims true", { timeout: 60_000 }, async () => {
  const tree = await makeTree(false);
  try {
    const result = await runDemo(["--local", tree.directory]);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.code, 0, output);

    assert.match(output, /Served from http:\/\/127\.0\.0\.1:\d+\/bundle\.json/);
    assert.equal(
      (output.match(/correct: true/g) ?? []).length,
      2,
      "both AI claims must print a true verdict",
    );
    assert.match(output, /representation: generative/);
    assert.match(output, /representation: bounded/);
    assert.match(output, /modelDigest [0-9a-f]{64}/);
    assert.match(output, /metricName|maxAbsError/);
    assert.ok(output.includes(tree.root), "the output names the verified root");
    assert.match(output, /DEMO PASSED/);
  } finally {
    await tree.cleanup();
  }
});

test("the resident demo refuses a tampered tree and names the refusal", { timeout: 60_000 }, async () => {
  const tree = await makeTree(true);
  try {
    const result = await runDemo(["--local", tree.directory]);
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.code, 0, "a tampered mirror must not exit zero");
    assert.match(output, /refused .* — .*the seed pins/);
    assert.match(output, /no candidate rebuilt the pinned root/);
    assert.match(output, /DEMO FAILED/);
    assert.doesNotMatch(output, /DEMO PASSED/);
  } finally {
    await tree.cleanup();
  }
});
