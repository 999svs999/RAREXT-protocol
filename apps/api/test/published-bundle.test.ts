import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { verifyBundle, type Bundle } from "../src/bundle.ts";
import { cidV1Raw } from "../src/adapters/content.ts";

const site = fileURLToPath(new URL("../../../site", import.meta.url));

test("the published registry bundle is readable over HTTP and verifies", { timeout: 30_000 }, async () => {
  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0];
    const files: Record<string, string> = {
      "/registry/bundle.json": `${site}/registry/bundle.json`,
      "/registry/seed.json": `${site}/registry/seed.json`,
    };
    const file = path ? files[path] : undefined;

    if (!file) {
      response.writeHead(404);
      response.end();
      return;
    }

    const body = readFileSync(file);
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(body.length),
    });
    response.end(body);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  try {
    const base = `http://127.0.0.1:${port}`;
    const bundleResponse = await fetch(`${base}/registry/bundle.json`);
    const bundleBytes = new Uint8Array(await bundleResponse.arrayBuffer());
    const bundle = JSON.parse(new TextDecoder().decode(bundleBytes)) as Bundle;
    const seed = (await (await fetch(`${base}/registry/seed.json`)).json()) as {
      bundle: string;
      bundleRoot: string;
      bundleCid?: string;
      mirrors: { bundle: string; root: string }[];
    };

    const verification = verifyBundle(bundle);
    assert.equal(verification.valid, true, verification.reason ?? undefined);
    assert.equal(verification.computedRoot, bundle.manifest.root);
    assert.equal(seed.bundleRoot, bundle.manifest.root);
    assert.equal(seed.bundle, "https://999svs999.github.io/RAREXT-protocol/registry/bundle.json");
    // The seed pins the bundle's content address over the exact published
    // bytes; a mirror pointer is a hash, not just a URL.
    assert.ok(typeof seed.bundleCid === "string" && seed.bundleCid.length > 0, "the seed must pin a bundleCid");
    assert.equal(cidV1Raw(bundleBytes), seed.bundleCid, "the served bytes must hash to the seed's pin");
    // A mirror entry must be a genuinely separate location that pins the same
    // root, and there must be at least one. This assertion previously required
    // mirror.bundle === seed.bundle — it ENCODED the duplication that made
    // "find mirrors" meaningless, and it stayed green for exactly as long as
    // the seed named one location twice. A test can hold a bug in place as
    // firmly as it can catch one.
    assert.ok(
      seed.mirrors.length >= 1,
      "the seed must name at least one mirror",
    );
    for (const mirror of seed.mirrors) {
      assert.equal(mirror.root, seed.bundleRoot, `mirror ${mirror.bundle} must pin the seed's root`);
      assert.notEqual(mirror.bundle, seed.bundle, `mirror ${mirror.bundle} merely repeats the seed's own location`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
