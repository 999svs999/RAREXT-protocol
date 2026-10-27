import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { cidV1Raw, pinBundle } from "../src/adapters/content.ts";
import { checkPin } from "../../../scripts/verify-seed-mirrors.mjs";

/**
 * The pins path end to end, through the REAL service and the REAL client.
 *
 * The publish-side client and the live checker were each tested against test
 * doubles; the service they actually talk to (`npm run pin` →
 * apps/api/src/pin-server.ts, documented in docs/OPERATIONS.md) had no test
 * that drove it with the client. This does: spawn the documented command, pin
 * the live bundle's bytes with `pinBundle`, read the reference back, hash it,
 * and then prove the checker catches a store that has been altered.
 *
 * It also holds the doc's claim to the code: `npm run pin` must exist and must
 * point at that server.
 */

const REPO = new URL("../../..", import.meta.url);
const SERVER_ENTRY = "apps/api/src/pin-server.ts";

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Every file under a directory tree, so a stored pin is found by content, not by an assumed layout. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

async function withPinService<T>(body: (base: string, dir: string) => Promise<T>): Promise<T> {
  const pkg = JSON.parse(readFileSync(new URL("package.json", REPO), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    pkg.scripts.pin,
    `node ${SERVER_ENTRY}`,
    "docs/OPERATIONS.md says `npm run pin` starts the reference service; the script must point at it",
  );

  const dir = mkdtempSync(join(tmpdir(), "rarext-pins-"));
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO,
    env: {
      ...process.env,
      RAREXT_PIN_PORT: String(port),
      RAREXT_PIN_DIR: dir,
      RAREXT_PIN_GC_INTERVAL_MS: "0",
      // The stall bound under test, in the server the test spawns.
      RAREXT_PIN_BODY_STALL_MS: "400",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const base = `http://127.0.0.1:${port}`;
  let announced = false;
  try {
    // The documented command must announce itself before anything is sent.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("the pin service did not announce itself within 20s")),
        20_000,
      );
      child.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString("utf8").includes("pinning service on")) {
          announced = true;
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code) => {
        if (announced) return;
        clearTimeout(timer);
        reject(new Error(`the pin service exited early with code ${code}`));
      });
    });

    return await body(base, dir);
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) {
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    }
  }
}

test("a stalled or short body is refused instead of wedging a pin write", async () => {
  await withPinService(async (base) => {
    const port = Number(new URL(base).port);

    // A client that declares a length, sends a fragment, and then holds the
    // socket open. Before the shared reader, this wedged the handler: the
    // async iteration waited for bytes that never came. The inactivity bound
    // now refuses it, and the connection is ended rather than held.
    const refused = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          "POST /v1/pins HTTP/1.1\r\n" +
            `host: 127.0.0.1:${port}\r\n` +
            "content-type: application/json\r\n" +
            "content-length: 200\r\n\r\n" +
            '{"cid":"bafkrei"',
        );
      });
      let seen = "";
      const timer = setTimeout(() => reject(new Error("the connection was neither answered nor closed")), 6000);
      socket.on("data", (chunk) => {
        seen += chunk.toString("utf8");
      });
      socket.on("close", () => {
        clearTimeout(timer);
        resolve(seen);
      });
      socket.on("error", () => {
        clearTimeout(timer);
        resolve(seen || "socket error");
      });
    });

    // Either a refusal naming the mismatch, or a closed connection — never a
    // held-open request. Both are honest; a hang is not.
    assert.match(refused, /(received \d+ bytes, content-length declares 200)|socket error|^$/);

    // And the service is still healthy and serving afterwards.
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  });
});

test("a pin served as raw bytes still verifies — the decoder reads both shapes", async () => {
  // The other honest way to serve a pin: a static copy at a URL, raw bytes.
  const bundle = readFileSync(new URL("../../../site/registry/bundle.json", import.meta.url));
  const cid = cidV1Raw(bundle);

  const server = createServer((request, response) => {
    if (request.url === `/${cid}`) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(bundle);
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  try {
    const base = `http://127.0.0.1:${port}`;
    const seed = {
      bundle: "https://999svs999.github.io/RAREXT-protocol/registry/bundle.json",
      bundleRoot: "793915a94988fdc2a756e531a3c7fc2f6f44fcaae6c13a91a5c97c8ab8878497",
      bundleCid: cid,
      pins: [{ cid, service: base, reference: `${base}/${cid}` }],
    };
    const ok = await checkPin(seed.pins[0], seed);
    assert.equal(ok.ok, true, JSON.stringify(ok));

    // A static pin whose bytes no longer hash to the CID is still refused.
    const stale = { ...seed, pins: [{ cid, service: base, reference: `${base}/missing` }] };
    const bad = await checkPin(stale.pins[0], stale);
    assert.equal(bad.ok, false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the real pin service, driven by the real client, pins the live bundle and verifies", async () => {
  await withPinService(async (base, dir) => {
    const bundle = readFileSync(new URL("../../../site/registry/bundle.json", import.meta.url));
    const seed = JSON.parse(
      readFileSync(new URL("../../../site/registry/seed.json", import.meta.url), "utf8"),
    ) as { bundleCid: string; bundleRoot: string };
    const cid = cidV1Raw(bundle);
    assert.equal(cid, seed.bundleCid, "the fixture is the published bundle");

    // The client the publish flow uses, pointed at the service the doc names.
    const result = await pinBundle(bundle, { serviceUrl: `${base}/v1/pins` });
    assert.equal(result.cid, cid);
    assert.equal(result.service, `${base}/v1/pins`);
    // The real service answers 201 with a scheme-less reference; the client
    // records it as-is and the checker resolves it through the service.
    assert.equal(result.reference, `pin:${cid}`);

    // The pin resolves to the CONTENT, and the content hashes to the CID. The
    // service serves a JSON envelope (base64 content), so reading it as raw
    // bytes would hash the envelope — the defect this test exists to catch.
    const envelope = (await (await fetch(`${base}/v1/pins/${cid}`)).json()) as { content: string };
    assert.equal(cidV1Raw(new Uint8Array(Buffer.from(envelope.content, "base64"))), cid);

    // And the live checker agrees, given a seed carrying that pin.
    const carrying = {
      bundle: "https://999svs999.github.io/RAREXT-protocol/registry/bundle.json",
      bundleRoot: seed.bundleRoot,
      bundleCid: seed.bundleCid,
      pins: [{ cid, service: `${base}/v1/pins`, reference: result.reference }],
    };
    const ok = await checkPin(carrying.pins[0], carrying);
    assert.equal(ok.ok, true, JSON.stringify(ok));

    // TAMPER the store: the disk changes under a pin whose CID still claims the
    // old bytes. The checker hashes what it is served, so this is caught rather
    // than trusted — and the file is found by CONTENT, not by an assumed layout.
    const contentFile = walk(dir).find((path) => {
      try {
        return statSync(path).isFile() && cidV1Raw(readFileSync(path)) === cid;
      } catch {
        return false;
      }
    });
    assert.ok(contentFile, "the pinned bytes are somewhere under the pin directory");
    writeFileSync(contentFile, Buffer.from("rewritten under the pin\n", "utf8"));

    const bad = await checkPin(carrying.pins[0], carrying);
    assert.equal(bad.ok, false, "a store that no longer holds the pinned bytes must fail the check");
    assert.match(String(bad.reason), new RegExp(cid.slice(0, 12)));
  });
});
