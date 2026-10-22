import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { canonicalize } from "../../../packages/core/src/index.ts";
import type {
  AdapterInfo,
  Anchor,
  Circuit,
  Identity,
  IdentityLink,
  IdentityLinkPayload,
  Publication,
  SourceResolution,
} from "../../../packages/core/src/index.ts";
import { RarextStore } from "../src/store.ts";
import { post, start, stop } from "./helpers.ts";

const halfAdder: Circuit = {
  components: [
    { id: "a", type: "INPUT" },
    { id: "b", type: "INPUT" },
    { id: "n1", type: "NAND", inputs: ["a", "b"] },
    { id: "n2", type: "NAND", inputs: ["a", "n1"] },
    { id: "n3", type: "NAND", inputs: ["b", "n1"] },
    { id: "xor", type: "NAND", inputs: ["n2", "n3"] },
    { id: "n5", type: "NAND", inputs: ["n1", "n1"] },
    { id: "sum", type: "OUTPUT", inputs: ["xor"] },
    { id: "carry", type: "OUTPUT", inputs: ["n5"] },
  ],
};

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function text(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

async function publish(base: string, author: string): Promise<Publication> {
  const response = await post(base, "/v1/publications", {
    author,
    title: `${author} build`,
    taskId: "half-adder",
    circuit: halfAdder,
  });

  assert.equal(response.status, 201);
  return (await response.json()) as Publication;
}

test("lists adapters and records local anchor receipts", async () => {
  const saved = process.env.TRAC_ANCHOR_URL;
  delete process.env.TRAC_ANCHOR_URL;
  const { server, base } = await start();

  try {
    const adapters = (await (await fetch(`${base}/v1/adapters`)).json()) as AdapterInfo[];
    assert.deepEqual(
      adapters.map((adapter) => adapter.id),
      ["local", "trac", "tapeout", "github"],
    );

    const trac = adapters.find((adapter) => adapter.id === "trac");
    assert.equal(trac?.configured, false);
    assert.ok(trac?.capabilities.includes("anchor"));

    const status = (await (
      await fetch(`${base}/v1/adapters/github`)
    ).json()) as AdapterInfo & { details: Record<string, unknown> };
    assert.equal(status.configured, true);
    assert.equal(status.details.rateLimit, "public");

    await publish(base, "alice");
    const anchorResponse = await post(base, "/v1/anchors", {});
    const anchor = (await anchorResponse.json()) as Anchor;
    const local = anchor.receipts.find((receipt) => receipt.adapter === "local");

    assert.equal(local?.status, "ok");
    assert.equal(anchor.adapter, "local");
    assert.match(local?.reference ?? "", /^local:/);
  } finally {
    await stop(server);
    restoreEnv("TRAC_ANCHOR_URL", saved);
  }
});

test("announces anchors to a configured Trac webhook", async () => {
  const saved = process.env.TRAC_ANCHOR_URL;
  let received = "";
  const trac = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      received = body;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("trac:accepted");
    });
  });

  trac.listen(0, "127.0.0.1");
  await once(trac, "listening");
  const { port } = trac.address() as AddressInfo;
  process.env.TRAC_ANCHOR_URL = `http://127.0.0.1:${port}/anchor`;

  const { server, base } = await start();

  try {
    await publish(base, "alice");
    const response = await post(base, "/v1/anchors", {});
    const anchor = (await response.json()) as Anchor;
    const receipt = anchor.receipts.find((item) => item.adapter === "trac");

    assert.equal(receipt?.status, "ok");
    assert.equal(receipt?.reference, "trac:accepted");
    assert.equal(anchor.adapter, "trac");
    assert.equal(anchor.reference, "trac:accepted");
    assert.match(received, /rarext\.anchor\.v1/);
    assert.match(received, /publicationIds/);
  } finally {
    await stop(server);
    trac.closeAllConnections();
    trac.close();
    restoreEnv("TRAC_ANCHOR_URL", saved);
  }
});

test("resolves a commit-pinned GitHub circuit and stores source provenance", async () => {
  const requestFetch = (async (input: string | URL | Request) => {
    const url = String(input);

    if (url === "https://api.github.com/repos/alice/machines") {
      return json({
        name: "machines",
        full_name: "alice/machines",
        html_url: "https://github.com/alice/machines",
        description: "Open hardware puzzles",
        default_branch: "main",
        stargazers_count: 42,
        license: { spdx_id: "MIT" },
      });
    }

    if (url === "https://api.github.com/repos/alice/machines/commits/main") {
      return json({ sha: "abc123" });
    }

    if (
      url ===
      "https://raw.githubusercontent.com/alice/machines/abc123/circuits/half.json"
    ) {
      return text(JSON.stringify(halfAdder));
    }

    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const { server, base } = await start(new RarextStore(), { fetch: requestFetch });

  try {
    const response = await post(base, "/v1/sources/github/resolve", {
      repo: "alice/machines",
      path: "circuits/half.json",
      taskId: "half-adder",
    });

    assert.equal(response.status, 200);
    const source = (await response.json()) as SourceResolution;
    assert.equal(source.source.commit, "abc123");
    assert.equal(source.source.license, "MIT");
    assert.equal(source.stars, 42);
    assert.equal(source.circuitHash?.length, 64);
    assert.equal(source.score?.score, 1000);

    const pinnedOnly = await post(base, "/v1/sources/github/resolve", {
      repo: "alice/machines",
      path: null,
      ref: null,
      taskId: null,
    });
    assert.equal(pinnedOnly.status, 200);
    const pinnedSource = (await pinnedOnly.json()) as SourceResolution;
    assert.equal(pinnedSource.circuit, null);
    assert.equal(pinnedSource.source.commit, "abc123");

    const publishResponse = await post(base, "/v1/publications", {
      author: "alice",
      title: "Imported from GitHub",
      taskId: "half-adder",
      circuit: source.circuit,
      source: source.source,
    });

    assert.equal(publishResponse.status, 201);
    const publication = (await publishResponse.json()) as Publication;
    assert.equal(publication.source?.repo, "alice/machines");
    assert.equal(publication.source?.commit, "abc123");
  } finally {
    await stop(server);
  }
});

test("verifies a signed GitHub identity link through a public proof", async () => {
  const proof = `rarext.identity-link.v1
handle=alice
network=github
externalId=alice
nonce=link-nonce-123`;

  const requestFetch = (async (input: string | URL | Request) => {
    const url = String(input);

    if (url === "https://gist.githubusercontent.com/alice/gist1/raw/proof.txt") {
      return text(proof);
    }

    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const directory = mkdtempSync(join(tmpdir(), "rarext-links-"));
  const file = join(directory, "store.json");
  const { server, base } = await start(new RarextStore(file), { fetch: requestFetch });

  try {
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const publicJwk = publicKey.export({ format: "jwk" });

    const register = await post(base, "/v1/identities", {
      handle: "alice",
      publicKey: publicJwk,
    });
    assert.equal(register.status, 201);
    const identity = (await register.json()) as Identity;

    const payload: IdentityLinkPayload = {
      kind: "rarext.identity-link",
      version: 1,
      handle: "alice",
      keyId: identity.keyId,
      network: "github",
      externalId: "alice",
      proofUrl: "https://gist.githubusercontent.com/alice/gist1/raw/proof.txt",
      createdAt: new Date().toISOString(),
      nonce: "link-nonce-123",
    };
    const signature = sign("sha256", Buffer.from(canonicalize(payload)), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64");

    const linked = await post(base, "/v1/identity-links", { payload, signature });
    assert.equal(linked.status, 201);
    const link = (await linked.json()) as IdentityLink;
    assert.equal(link.verified, true);
    assert.equal(link.network, "github");
    assert.equal(link.externalId, "alice");

    const listed = (await (
      await fetch(`${base}/v1/identity-links/alice`)
    ).json()) as IdentityLink[];
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, link.id);

    const wrongOwner: IdentityLinkPayload = {
      ...payload,
      externalId: "bob",
      nonce: "link-nonce-456",
    };
    const wrongSignature = sign("sha256", Buffer.from(canonicalize(wrongOwner)), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64");

    const rejected = await post(base, "/v1/identity-links", {
      payload: wrongOwner,
      signature: wrongSignature,
    });
    assert.equal(rejected.status, 422);

    const reloaded = new RarextStore(file);
    assert.equal(reloaded.listIdentityLinks("alice").length, 1);
    assert.equal(reloaded.identityLinkCount(), 1);
  } finally {
    await stop(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unsigned publications cannot bypass source URL validation", async () => {
  const { server, base } = await start();

  try {
    const response = await post(base, "/v1/publications", {
      author: "alice",
      title: "Bad source",
      taskId: "half-adder",
      circuit: halfAdder,
      source: {
        kind: "github",
        repo: "alice/machines",
        url: "http://example.com/repo",
        ref: null,
        path: null,
        commit: null,
        license: null,
      },
    });

    assert.equal(response.status, 400);
  } finally {
    await stop(server);
  }
});
