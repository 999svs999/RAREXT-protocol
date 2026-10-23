import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { verifyBundle, type Bundle } from "../src/bundle.ts";

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
    const bundle = (await (await fetch(`${base}/registry/bundle.json`)).json()) as Bundle;
    const seed = (await (await fetch(`${base}/registry/seed.json`)).json()) as {
      bundle: string;
      bundleRoot: string;
      mirrors: { bundle: string; root: string }[];
    };

    const verification = verifyBundle(bundle);
    assert.equal(verification.valid, true, verification.reason ?? undefined);
    assert.equal(verification.computedRoot, bundle.manifest.root);
    assert.equal(seed.bundleRoot, bundle.manifest.root);
    assert.equal(seed.bundle, "https://999svs999.github.io/RAREXT-protocol/registry/bundle.json");
    assert.ok(seed.mirrors.some((mirror) => mirror.bundle === seed.bundle && mirror.root === seed.bundleRoot));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
