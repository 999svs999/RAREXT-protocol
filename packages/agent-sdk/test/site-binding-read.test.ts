import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { readFileSync } from "node:fs";

import { RAREXT_SITE_BINDING_PATH, verifySiteBinding } from "../../core/src/index.ts";
import { readSiteBinding } from "../src/index.ts";

// The root the deployed registry actually pins, read from the committed seed — so this suite
// exercises the reader against the real deployment's root rather than a literal typed here.
// The length is asserted below: a truncated literal parsed as an invalid root, and the reader
// (correctly) refused it, which is exactly how a hand-typed digest wastes an afternoon.
const committedSeed = JSON.parse(readFileSync(new URL("../../../site/registry/seed.json", import.meta.url), "utf8")) as {
  bundleRoot: string;
};
const ROOT = committedSeed.bundleRoot;
const OTHER = "b".repeat(64);

/** A site: it serves one path, and answers everything else however the case asks. */
async function site(pages: Record<string, { status: number; body: string }>) {
  const server = createServer((request, response) => {
    const page = pages[request.url ?? "/"];
    if (!page) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(page.status, { "content-type": "application/json" });
    response.end(page.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const noRecord = async () => {
  const error = new Error("no such record") as Error & { code: string };
  error.code = "ENOTFOUND";
  throw error;
};

test("the fixture is the real pinned root, and it is a root", () => {
  assert.equal(ROOT.length, 64, "the seed's bundleRoot must be a 64-hex digest");
  assert.match(ROOT, /^[0-9a-f]{64}$/);
});

test("a site that serves the file is read, and its statement becomes a binding", async () => {
  const server = await site({
    [RAREXT_SITE_BINDING_PATH]: { status: 200, body: JSON.stringify({ registry: "rarext", root: ROOT }) },
  });
  try {
    const read = await readSiteBinding(server.origin, { resolveTxt: noRecord, allowPrivate: true });
    assert.equal(read.file, "served");
    assert.equal(read.txt, "absent");
    assert.equal(read.parse.ok, true);
    if (!read.parse.ok) return;
    assert.equal(read.parse.binding.root, ROOT);
    assert.equal(read.host, "127.0.0.1");
    // and the rule from core decides, not the reader
    assert.equal(verifySiteBinding(read.parse.binding, { pinnedRoot: ROOT, expectedRegistry: "rarext" }).ok, true);
    assert.equal(verifySiteBinding(read.parse.binding, { pinnedRoot: OTHER }).ok, false);
  } finally {
    await server.close();
  }
});

test("a site that controls only its name still joins: the record carrier alone is enough", async () => {
  const server = await site({});
  try {
    const read = await readSiteBinding(server.origin, {
      resolveTxt: async (name) => {
        assert.equal(name, "_rarext.127.0.0.1");
        return [[`registry=rarext; root=${ROOT}`]];
      },
      allowPrivate: true,
    });
    assert.equal(read.file, "absent");
    assert.equal(read.txt, "served");
    assert.equal(read.parse.ok, true);
    if (!read.parse.ok) return;
    assert.equal(read.parse.binding.carrier, "dns-txt");
    assert.equal(read.parse.binding.root, ROOT);
  } finally {
    await server.close();
  }
});

test("a TXT record split into chunks is one statement, joined where the chunking lives", async () => {
  const server = await site({});
  try {
    const read = await readSiteBinding(server.origin, {
      resolveTxt: async () => [["registry=rarext; ", `root=${ROOT}`]],
      allowPrivate: true,
    });
    assert.equal(read.parse.ok, true, "chunk splitting is a transport fact, not a different statement");
    if (!read.parse.ok) return;
    assert.equal(read.parse.binding.root, ROOT);
  } finally {
    await server.close();
  }
});

test("both carriers, agreeing — and disagreeing, which is reported rather than averaged", async () => {
  const agree = await site({
    [RAREXT_SITE_BINDING_PATH]: { status: 200, body: JSON.stringify({ registry: "rarext", root: ROOT }) },
  });
  try {
    const read = await readSiteBinding(agree.origin, { resolveTxt: async () => [[`registry=rarext; root=${ROOT}`]], allowPrivate: true });
    assert.equal(read.parse.ok, true);
    assert.equal(read.file, "served");
    assert.equal(read.txt, "served");
  } finally {
    await agree.close();
  }

  const disagree = await site({
    [RAREXT_SITE_BINDING_PATH]: { status: 200, body: JSON.stringify({ registry: "rarext", root: ROOT }) },
  });
  try {
    const read = await readSiteBinding(disagree.origin, { resolveTxt: async () => [[`registry=rarext; root=${OTHER}`]], allowPrivate: true });
    assert.equal(read.parse.ok, false);
    if (read.parse.ok) return;
    assert.match(read.parse.reason, /file and its name record disagree/);
  } finally {
    await disagree.close();
  }
});

test("a site that published nothing is reported as having published nothing, by carrier", async () => {
  const server = await site({});
  try {
    const read = await readSiteBinding(server.origin, { resolveTxt: noRecord, allowPrivate: true });
    assert.equal(read.file, "absent");
    assert.equal(read.txt, "absent");
    assert.equal(read.parse.ok, false);
    if (!read.parse.ok) assert.match(read.parse.reason, /no site binding was served/);
    // Both carriers are named in the notes, so an operator knows where to look.
    assert.equal(read.notes.length, 2);
    assert.match(read.notes.join(" "), /404/);
    assert.match(read.notes.join(" "), /ENOTFOUND/);
  } finally {
    await server.close();
  }
});

test("a server error is UNREACHABLE, not absence — and a policy refusal is neither", async () => {
  const broken = await site({ [RAREXT_SITE_BINDING_PATH]: { status: 500, body: "boom" } });
  try {
    const read = await readSiteBinding(broken.origin, { resolveTxt: noRecord, allowPrivate: true });
    assert.equal(read.file, "unreachable");
    assert.match(read.notes.join(" "), /HTTP 500/);
  } finally {
    await broken.close();
  }

  // The same site, read WITHOUT the loopback allowance: the client declined to look, and
  // saying "absent" would send an operator to debug a site that was never contacted.
  const guarded = await site({ [RAREXT_SITE_BINDING_PATH]: { status: 200, body: JSON.stringify({ registry: "rarext", root: ROOT }) } });
  try {
    const read = await readSiteBinding(guarded.origin, { resolveTxt: noRecord });
    assert.equal(read.file, "refused");
    assert.notEqual(read.file, "absent");
    assert.match(read.notes.join(" "), /private|not fetchable|scheme/i);
  } finally {
    await guarded.close();
  }
});

test("a resolver that fails for another reason is unreachable, and never silently absent", async () => {
  const server = await site({});
  try {
    const read = await readSiteBinding(server.origin, {
      resolveTxt: async () => {
        throw new Error("resolver exploded");
      },
      allowPrivate: true,
    });
    assert.equal(read.txt, "unreachable");
    assert.match(read.notes.join(" "), /resolver exploded/);
  } finally {
    await server.close();
  }
});
