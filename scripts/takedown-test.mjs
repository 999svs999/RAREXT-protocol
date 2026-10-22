#!/usr/bin/env node
// The takedown test.
//
//   node scripts/takedown-test.mjs
//
// This is the acceptance criterion for the DeWeb claim: the operator goes away,
// and the content survives somewhere else and still checks out.
//
// The test:
//   1. publishes into a live registry, anchors it, and builds a mirror
//   2. stops the registry
//   3. serves the mirror from a plain static file server
//   4. checks the mirror still serves the publications
//   5. checks the bundle still rebuilds the anchored root
//
// If step 4 or 5 fails, the content was only ever in the operator's database.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";

import { canonicalize, leafPayload } from "../packages/core/src/index.ts";

const root = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "rarext-takedown-"));
const mirror = join(work, "mirror");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    ...options,
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function leaf(publication, version) {
  return sha256(canonicalize(leafPayload(publication, version)));
}

function merkleRoot(leaves) {
  if (leaves.length === 0) return "";
  let level = [...leaves];
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(sha256(level[index] + (level[index + 1] ?? level[index])));
    }
    level = next;
  }
  return level[0];
}

let failures = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

let registry;

try {
  console.log("1. starting a registry");

  const port = 8900 + Math.floor(Math.random() * 90);
  const data = join(work, "store.json");

  registry = spawn(
    process.execPath,
    ["apps/api/src/server.ts"],
    {
      cwd: root,
      env: { ...process.env, PORT: String(port), RAREXT_DATA: data },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  await new Promise((resolve, reject) => {
    registry.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) resolve();
    });
    setTimeout(() => reject(new Error("the registry did not start")), 10000);
  });

  const api = `http://127.0.0.1:${port}`;

  const circuit = {
    components: [
      { id: "a", type: "INPUT" },
      { id: "b", type: "INPUT" },
      { id: "n3", type: "NAND", inputs: ["a", "b"] },
      { id: "n1", type: "NAND", inputs: ["a", "n3"] },
      { id: "n2", type: "NAND", inputs: ["b", "n3"] },
      { id: "n4", type: "NAND", inputs: ["n1", "n2"] },
      { id: "n5", type: "NAND", inputs: ["n3", "n3"] },
      { id: "sum", type: "OUTPUT", inputs: ["n4"] },
      { id: "carry", type: "OUTPUT", inputs: ["n5"] },
    ],
  };

  const published = await (
    await fetch(`${api}/v1/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        author: "takedown-test",
        title: "Survives the operator",
        body: "This build has to outlive the server that published it.",
        challengeId: "half-adder",
        artifact: {
          app: "logic",
          kind: "logic.netlist",
          version: 1,
          mediaType: "application/json",
          body: circuit,
        },
      }),
    })
  ).json();

  check("the publication was accepted", Boolean(published.id), JSON.stringify(published).slice(0, 120));

  const anchor = await (
    await fetch(`${api}/v1/anchors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  ).json();

  check("the publication was anchored", Boolean(anchor.root), JSON.stringify(anchor).slice(0, 120));

  console.log("2. building a mirror");

  run("node", ["scripts/build-mirror.mjs", mirror], {
    cwd: root,
    env: { ...process.env, RAREXT_API: api },
  });

  const bundle = JSON.parse(readFileSync(join(mirror, "bundle.json"), "utf8"));

  console.log("3. stopping the registry");

  registry.kill("SIGTERM");
  await new Promise((resolve) => registry.on("exit", resolve));
  registry = null;

  const dead = await fetch(`${api}/health`).then(
    () => false,
    () => true,
  );
  check("the registry is gone", dead);

  console.log("4. serving the mirror from a plain file server");

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const target = join(mirror, normalize(path === "/" ? "/index.html" : path));

    if (!target.startsWith(mirror)) {
      res.writeHead(403).end();
      return;
    }

    try {
      const body = readFileSync(target);
      res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const mirrorUrl = `http://127.0.0.1:${server.address().port}`;

  console.log("5. checking the mirror without the operator");

  const page = await (await fetch(`${mirrorUrl}/`)).text();
  check("the mirror serves the workbench", page.includes("bundle.js"));

  const served = JSON.parse(await (await fetch(`${mirrorUrl}/bundle.json`)).text());
  check(
    "the mirror serves the publication",
    served.publications.some((publication) => publication.id === published.id),
  );

  const leaves = served.publications.map((publication) =>
    leaf(publication, served.manifest.leafVersion),
  );
  const computed = merkleRoot(leaves);

  check(
    "the mirror rebuilds the anchored root",
    computed === served.manifest.root,
    `${computed.slice(0, 12)} != ${served.manifest.root.slice(0, 12)}`,
  );

  check(
    "the root is the one the chain holds",
    served.manifest.root === anchor.root,
  );

  const altered = JSON.parse(JSON.stringify(served));
  altered.publications[0].title = "something else";
  const alteredLeaves = altered.publications.map((publication) =>
    leaf(publication, altered.manifest.leafVersion),
  );
  check(
    "an altered mirror would not verify",
    merkleRoot(alteredLeaves) !== altered.manifest.root,
  );

  server.close();

  console.log(
    failures === 0
      ? "\nthe content outlived the operator"
      : `\n${failures} checks failed`,
  );
} finally {
  if (registry) registry.kill("SIGKILL");
  rmSync(work, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
