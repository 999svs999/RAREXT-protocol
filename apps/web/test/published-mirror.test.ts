import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  verifyBundle,
  type Bundle,
  type ChallengeIndex,
} from "../src/verify.ts";
import {
  startMirrorGate,
  type MirrorBundle,
  type MirrorGateOutcome,
} from "../src/mirror.ts";
import { bundleJson, bundleScript } from "../../../scripts/mirror-artifacts.mjs";
import {
  canonicalize,
  leafPayload,
} from "../../../packages/core/src/index.ts";

const site = fileURLToPath(new URL("../../../site/registry", import.meta.url));

function read<T>(name: string): T {
  return JSON.parse(readFileSync(`${site}/${name}`, "utf8")) as T;
}

test("the published mirror verifies against its pinned root and media", async () => {
  const bundle = read<Bundle>("bundle.json");
  const mirror = read<Bundle>("mirror/bundle.json");
  const blobFile = read<{ blobs: { hash: string; content: string }[] }>(
    "mirror/blobs.json",
  );
  const seed = read<{
    bundleRoot: string;
    mirrors: { root: string }[];
  }>("seed.json");

  assert.equal(bundle.manifest.leafVersion, 4);
  assert.equal(mirror.manifest.root, bundle.manifest.root);
  assert.equal(seed.bundleRoot, bundle.manifest.root);
  assert.ok(seed.mirrors.every((entry) => entry.root === bundle.manifest.root));

  const challenges = Object.fromEntries(
    (bundle.challenges ?? []).map((challenge) => [challenge.id, challenge.spec ?? {}]),
  ) as ChallengeIndex;
  const media = Object.fromEntries(
    blobFile.blobs
      .filter((blob) => typeof blob.hash === "string" && typeof blob.content === "string")
      .map((blob) => [blob.hash, blob.content]),
  );

  const result = await verifyBundle(
    bundle,
    challenges,
    bundle.manifest.root,
    media,
  );

  assert.equal(result.valid, true, result.reason ?? undefined);

  const ai = result.aiClaims.filter((claim) => claim.representation);
  assert.equal(ai.length, 2);

  const renditions = new Map(
    ai.map((claim) => [claim.representation, claim.media]),
  );
  for (const representation of ["generative", "bounded"] as const) {
    const media = renditions.get(representation);
    assert.ok(media, `${representation} rendition is missing`);
    assert.equal(media.matches, true);
    assert.equal(media.blobMatches, true);
  }
});

// The workbench's reads must be gated on the same verification the verifier
// page performs. These tests drive the same gate (apps/web/src/mirror.ts)
// against a mirror served over plain HTTP, with the bundle tampered the way a
// compromised mirror would tamper it.

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

interface MirrorServer {
  base: string;
  close(): Promise<void>;
}

function serveMirror(dir: string): Promise<MirrorServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://mirror.invalid");
      const file = join(dir, url.pathname);
      try {
        const bytes = readFileSync(file);
        response.writeHead(200, {
          "content-type": MIME[extname(file)] ?? "application/octet-stream",
        });
        response.end(bytes);
      } catch {
        response.writeHead(404);
        response.end();
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((resolveClose) => {
            server.closeAllConnections();
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return "";
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(
        sha256Hex(level[index]! + (level[index + 1] ?? level[index]!)),
      );
    }
    level = next;
  }
  return level[0]!;
}

/**
 * What a competent tamperer would do: change a publication AND rewrite the
 * manifest so the copy still verifies internally. Only the pinned root —
 * here, the seed's bundleRoot — separates it from an honest bundle.
 */
function recomputeRoot(bundle: MirrorBundle): void {
  const leaves = bundle.publications.map((publication) =>
    sha256Hex(
      canonicalize(leafPayload(publication, bundle.manifest.leafVersion)),
    ),
  );
  bundle.manifest.publications = bundle.publications.map((publication, index) => ({
    id: publication.id,
    leaf: leaves[index]!,
  }));
  bundle.manifest.root = merkleRoot(leaves);
}

interface MirrorTree {
  dir: string;
  close: () => Promise<void>;
  base: string;
}

async function buildMirror(bundle: MirrorBundle, seed: {
  bundleRoot: string;
} | null): Promise<MirrorTree> {
  const work = mkdtempSync(join(tmpdir(), "rarext-workbench-"));
  const dir = join(work, "mirror");
  mkdirSync(dir, { recursive: true });

  for (const name of ["index.html", "styles.css", "favicon.svg"]) {
    cpSync(join(fileURLToPath(new URL("../public", import.meta.url)), name), join(dir, name));
  }
  writeFileSync(join(dir, "bundle.json"), bundleJson(bundle));
  writeFileSync(join(dir, "bundle.js"), bundleScript(bundle));
  if (seed) {
    writeFileSync(join(dir, "seed.json"), JSON.stringify(seed));
  }

  const server = await serveMirror(dir);
  return {
    dir,
    base: server.base,
    close: async () => {
      await server.close();
      rmSync(work, { recursive: true, force: true });
    },
  };
}

async function feedFromHttp(base: string, path = "/v1/feed?limit=10&offset=0"): Promise<number> {
  const response = await fetch(`${base}${path}`);
  await response.arrayBuffer();
  return response.status;
}

test("the mirror workbench answers its reads from a bundle that verifies against the pinned root", async () => {
  const bundle = read<MirrorBundle>("mirror/bundle.json");
  const tree = await buildMirror(bundle, { bundleRoot: bundle.manifest.root });

  try {
    const response = await fetch(`${tree.base}/bundle.json`);
    const served = JSON.parse(await response.text()) as MirrorBundle;

    // ?root= wins, exactly as the verifier page takes the pin from ?root=.
    const gate = startMirrorGate(served, {
      requestedRoot: bundle.manifest.root,
      seedUrls: [],
    });
    const outcome = await gate.ready;
    assert.equal(outcome.kind, "verified");
    assert.equal(outcome.pinSource, "?root=");
    assert.equal(outcome.pinnedRoot, bundle.manifest.root);

    // Feed reads answer from the bundle, sorted newest first.
    const expected = [...bundle.publications]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 10);
    assert.deepEqual(gate.read("/v1/feed?limit=10&offset=0"), expected);
    assert.deepEqual(gate.read("/v1/challenges"), bundle.challenges);
    assert.deepEqual(gate.read("/v1/semantics"), bundle.semantics);
  } finally {
    await tree.close();
  }
});

test("the mirror workbench still answers when only the seed's pin is reachable", async () => {
  const bundle = read<MirrorBundle>("mirror/bundle.json");
  const tree = await buildMirror(bundle, { bundleRoot: bundle.manifest.root });

  try {
    const response = await fetch(`${tree.base}/bundle.json`);
    const served = JSON.parse(await response.text()) as MirrorBundle;

    // No ?root= this time; the seed supplies the pin instead.
    const pinned = startMirrorGate(served, {
      seedUrls: [`${tree.base}/seed.json`],
    });
    const outcome = await pinned.ready;
    assert.equal(outcome.kind, "verified");
    assert.equal(outcome.pinSource, `${tree.base}/seed.json`);
    assert.ok(pinned.read("/v1/feed?limit=10&offset=0"));

    // And when a mirror reaches no seed and gets no ?root=, the workbench
    // verifies internal consistency only — the verifier page's rule — and
    // still answers, visibly, without pretending to be pinned.
    const unpinned = startMirrorGate(served, { seedUrls: [] });
    const unpinnedOutcome: MirrorGateOutcome = await unpinned.ready;
    assert.equal(unpinnedOutcome.kind, "verified-unpinned");
    assert.equal(unpinnedOutcome.pinnedRoot, null);
    assert.deepEqual(unpinned.read("/v1/feed?limit=10&offset=0"), 
      [...bundle.publications]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 10));
  } finally {
    await tree.close();
  }
});

test("a tampered mirror's workbench refuses reads and its page carries the refusal", async () => {
  const bundle = read<MirrorBundle>("mirror/bundle.json");
  const pinnedRoot = bundle.manifest.root;
  const tampered = JSON.parse(JSON.stringify(bundle)) as MirrorBundle;
  tampered.publications[0]!.title = `${tampered.publications[0]!.title} (altered)`;

  const tree = await buildMirror(tampered, { bundleRoot: pinnedRoot });

  try {
    const response = await fetch(`${tree.base}/bundle.js`);
    const inline = JSON.parse(
      (await response.text())
        .replace("window.__RAREXT_BUNDLE__ = ", "")
        .replace(/;\n$/, ""),
    ) as MirrorBundle;
    assert.equal(inline.publications[0]!.title.endsWith("(altered)"), true);

    // With the ?root= pin the tampered in-line bundle is refused.
    const gate = startMirrorGate(inline, {
      requestedRoot: pinnedRoot,
      seedUrls: [],
    });
    const outcome = await gate.ready;
    assert.equal(outcome.kind, "refused");
    assert.ok(gate.read("/v1/feed?limit=10&offset=0") === null);
    assert.ok(gate.read("/v1/challenges") === null);

    // And with the seed reachable the refusal is the same — not a fallback to
    // trusting whatever bytes were shipped.
    const seeded = startMirrorGate(inline, {
      seedUrls: [`${tree.base}/seed.json`],
    });
    const seededOutcome = await seeded.ready;
    assert.equal(seededOutcome.kind, "refused");
    assert.ok(seeded.read("/v1/feed?limit=10&offset=0") === null);

    // The read paths fall through to the network. On a static mirror there is
    // no /v1/feed: a 404, the honest empty state.
    assert.equal(await feedFromHttp(tree.base), 404);

    // The served page carries the refusal banner markup the workbench fills
    // in — pinned root, computed root, and why they disagree.
    const page = await (await fetch(`${tree.base}/index.html`)).text();
    assert.ok(page.includes('id="mirror-refusal"'));
    assert.ok(page.includes('data-refusal="pinned"'));
    assert.ok(page.includes('data-refusal="computed"'));
    assert.ok(page.includes('data-refusal="reason"'));
  } finally {
    await tree.close();
  }
});

test("a tampered mirror that rebuilds its own root is still caught by the seed's pin", async () => {
  const bundle = read<MirrorBundle>("mirror/bundle.json");
  const honestRoot = bundle.manifest.root;
  const retampered = JSON.parse(JSON.stringify(bundle)) as MirrorBundle;
  retampered.publications[0]!.title = `${retampered.publications[0]!.title} (altered)`;
  recomputeRoot(retampered);
  assert.equal(retampered.manifest.root === honestRoot, false);

  // The seed pins the ROOT THE CHAIN HOLDS, not whatever the local root says.
  const tree = await buildMirror(retampered, { bundleRoot: honestRoot });

  try {
    const response = await fetch(`${tree.base}/bundle.json`);
    const served = JSON.parse(await response.text()) as MirrorBundle;
    const gate = startMirrorGate(served, {
      seedUrls: [`${tree.base}/seed.json`],
    });
    const outcome = await gate.ready;
    assert.equal(outcome.kind, "refused");
    assert.equal(
      outcome.reason,
      "the bundle root does not match the pinned chain root",
    );
    assert.equal(outcome.pinnedRoot, honestRoot);
    assert.equal(outcome.computedRoot, retampered.manifest.root);
    assert.ok(gate.read("/v1/feed?limit=10&offset=0") === null);
  } finally {
    await tree.close();
  }
});
