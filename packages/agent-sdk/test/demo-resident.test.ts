import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cidV1Raw, verifyBundle, type Bundle } from "../src/index.ts";
import {
  DAY,
  announcementSigner,
  iso,
  signedAnnouncement,
} from "./announcement-fixtures.ts";

const ANNOUNCER = "operator-alice";

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

/**
 * A tree whose SEED'S OWN COPY fails, so only the announcement can produce a
 * verified candidate — and whose keys are published as documents, because that
 * is what a resident with no server has to resolve them from. The record names
 * tree-relative paths, exactly as the seed does.
 */
async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  return port;
}

async function makeAnnouncementTree({ revoke }: { revoke: boolean }) {
  const directory = await mkdtemp(join(tmpdir(), "rarext-announce-"));
  // The record is SIGNED over the URLs it names, so the tree has to know the
  // origin before it writes them — hence the pinned port.
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const originalBytes = await readFile(committedPath);
  const committed = JSON.parse(originalBytes.toString("utf8")) as Bundle;
  const verification = verifyBundle(committed);
  assert.equal(verification.valid, true, verification.reason ?? undefined);
  const root = verification.computedRoot!;
  const cid = cidV1Raw(originalBytes);

  // The seed's own copy is TAMPERED; the announced mirror is honest.
  const altered = structuredClone(committed);
  altered.publications = altered.publications.map((publication, index) =>
    index === 0 ? { ...publication, title: "an altered title" } : publication,
  );
  await writeFile(join(directory, "bundle.json"), Buffer.from(JSON.stringify(altered), "utf8"));
  await mkdir(join(directory, "announced"));
  await writeFile(join(directory, "announced", "bundle.json"), originalBytes);

  const signer = announcementSigner();
  const record = signedAnnouncement(signer, {
    handle: ANNOUNCER,
    bundle: `${origin}/bundle.json`,
    mirror: `${origin}/announced/bundle.json`,
    bundleRoot: root,
  });

  await writeFile(join(directory, "announcements.json"), JSON.stringify([record]));
  await mkdir(join(directory, "identities"));
  await writeFile(
    join(directory, "identities", `${ANNOUNCER}.json`),
    JSON.stringify({
      handle: ANNOUNCER,
      keyId: signer.keyId,
      algorithm: signer.suite,
      publicKey: signer.publicKey,
      createdAt: iso(-400 * DAY),
    }),
  );
  await writeFile(join(directory, "identities", `${ANNOUNCER}.rotations.json`), "[]");
  await writeFile(
    join(directory, "revocations.json"),
    JSON.stringify(
      revoke
        ? [{ id: "rev-1", kind: "capability", target: signer.keyId, reason: "key compromised" }]
        : [],
    ),
  );
  await writeFile(
    join(directory, "seed.json"),
    JSON.stringify(
      {
        version: 1,
        bundle: `${origin}/bundle.json`,
        bundleRoot: root,
        bundleCid: cid,
        announcers: [ANNOUNCER],
        announcements: [`${origin}/announcements.json`],
      },
      null,
      2,
    ),
  );

  return {
    directory,
    port,
    root,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("the resident demo believes an announcement it resolved from published documents", { timeout: 60_000 }, async () => {
  const tree = await makeAnnouncementTree({ revoke: false });
  try {
    const result = await runDemo(["--local", tree.directory, "--port", String(tree.port)]);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.code, 0, output);

    assert.match(output, /folding 1 announcement document\(s\) through published identity documents/);
    assert.match(output, /announcement accepted .* — mirror .*announced\/bundle\.json/);
    // The seed's own copy cannot serve this, so the mirror that answered proves
    // the announcement was BELIEVED rather than merely seen.
    assert.match(output, /refused .*bundle\.json — .*the seed pins/);
    assert.match(output, /Served from http:\/\/127\.0\.0\.1:\d+\/announced\/bundle\.json/);
    assert.match(output, /DEMO PASSED/);
  } finally {
    await tree.cleanup();
  }
});

test("the same run refuses the announcement when the published key is revoked", { timeout: 60_000 }, async () => {
  const tree = await makeAnnouncementTree({ revoke: true });
  try {
    const result = await runDemo(["--local", tree.directory, "--port", String(tree.port)]);
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.code, 0, "a revoked key must not produce a passing run");
    assert.match(output, /announcement refused .* — .*revok/i);
    assert.match(output, /DEMO FAILED/);
    assert.doesNotMatch(output, /DEMO PASSED/);
  } finally {
    await tree.cleanup();
  }
});
