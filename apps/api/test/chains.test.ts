import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RarextChainAdapter } from "../src/chains/rarext.ts";
import { base58Decode } from "../src/chains/relay.ts";
import { merkleProof, merkleRoot } from "../src/merkle.ts";

const repoRoot = new URL("../../..", import.meta.url).pathname;

async function startChainNode(options: {
  data?: string;
  cleanup?: boolean;
} = {}): Promise<{
  url: string;
  data: string;
  stop: () => Promise<void>;
}> {
  const data = options.data ?? mkdtempSync(join(tmpdir(), "rarext-chain-"));
  const cleanup = options.cleanup ?? true;
  const port = 8790 + Math.floor(Math.random() * 80);

  const child = spawn(process.execPath, ["apps/chain/src/server.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      RAREXT_CHAIN_KEY: join(data, "key.json"),
      RAREXT_CHAIN_LOG: join(data, "log.json"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });

  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) resolve(null);
    });
    setTimeout(() => reject(new Error("the chain node did not start")), 10_000);
  });

  return {
    url: `http://127.0.0.1:${port}`,
    data,
    stop: async () => {
      child.kill("SIGTERM");
      await once(child, "exit");
      if (cleanup) rmSync(data, { recursive: true, force: true });
    },
  };
}

test("the chain node anchors a root and proves it is in a block", async () => {
  const node = await startChainNode();

  try {
    const root = "a".repeat(64);

    const response = await fetch(`${node.url}/chain/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root, publicationIds: ["pub-1"] }),
    });

    assert.equal(response.status, 201);

    const anchored = (await response.json()) as { height: number; hash: string };
    assert.equal(anchored.height, 1);
    assert.equal(anchored.hash.length, 64);

    const blockResponse = await fetch(`${node.url}/chain/blocks/1`);
    assert.equal(blockResponse.status, 200);

    const block = (await blockResponse.json()) as {
      publicationIds: string[];
    };
    assert.deepEqual(block.publicationIds, ["pub-1"]);

    const proofResponse = await fetch(
      `${node.url}/chain/proof?root=${encodeURIComponent(root)}`,
    );
    assert.equal(proofResponse.status, 200);

    const proof = (await proofResponse.json()) as {
      root: string;
      height: number;
      index: number;
      path: { hash: string; side: "left" | "right" }[];
    };

    assert.equal(proof.root, root);
    assert.equal(proof.height, 1);
    assert.equal(proof.index, 0);

    const state = (await (await fetch(`${node.url}/chain/state`)).json()) as {
      chainId: string;
      height: number;
    };

    assert.equal(state.height, 1);
    assert.match(state.chainId, /^rarex-/);

    const chainKey = (await (await fetch(`${node.url}/chain/key`)).json()) as {
      keyId: string;
      publicKey: { kty: string; crv: string };
    };
    assert.match(chainKey.keyId, /^[0-9a-f]{64}$/);
    assert.equal(chainKey.publicKey.kty, "EC");
    assert.equal(chainKey.publicKey.crv, "P-256");

    const audit = (await (await fetch(`${node.url}/chain/audit`)).json()) as {
      valid: boolean;
      height: number;
    };

    assert.equal(audit.valid, true);
    assert.equal(audit.height, 1);
  } finally {
    await node.stop();
  }
});

test("a restart preserves the signed history instead of re-minting it", async () => {
  const data = mkdtempSync(join(tmpdir(), "rarext-chain-"));
  let node = await startChainNode({ data, cleanup: false });

  let head = "";
  let block: unknown;

  try {
    const root = "e".repeat(64);
    const response = await fetch(`${node.url}/chain/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root, publicationIds: ["pub-restart"] }),
    });
    assert.equal(response.status, 201);

    head = ((await (await fetch(`${node.url}/chain/state`)).json()) as {
      head: string;
    }).head;
    block = await (await fetch(`${node.url}/chain/blocks/1`)).json();
  } finally {
    await node.stop();
  }

  node = await startChainNode({ data, cleanup: false });

  try {
    const state = (await (await fetch(`${node.url}/chain/state`)).json()) as {
      height: number;
      head: string;
    };
    assert.equal(state.height, 1);
    assert.equal(state.head, head);

    const reread = await (await fetch(`${node.url}/chain/blocks/1`)).json();
    assert.deepEqual(reread, block);

    const audit = (await (await fetch(`${node.url}/chain/audit`)).json()) as {
      valid: boolean;
    };
    assert.equal(audit.valid, true);
  } finally {
    await node.stop();
    rmSync(data, { recursive: true, force: true });
  }
});

test("the registry adapter confirms an anchor by reading the block back", async () => {
  const node = await startChainNode();

  try {
    const adapter = new RarextChainAdapter({
      id: "rarex",
      name: "RAREXT chain",
      family: "rarext",
      chainId: "rarex-test-1",
      rpc: node.url,
    });

    const root = "b".repeat(64);
    const receipt = await adapter.anchor(root, ["pub-1"]);

    assert.equal(receipt.status, "ok");
    assert.equal(receipt.confirmed, true);
    assert.equal(receipt.height, 1);
    assert.equal(receipt.family, "rarext");

    // A root the chain never saw is not confirmed.
    const stranger = await adapter.anchor("c".repeat(64), ["pub-2"]);
    assert.equal(stranger.confirmed, true, "it was anchored, so the chain has it");

    const proof = await adapter.proof(root);
    assert.ok(proof);
    assert.equal(proof.root, root);
  } finally {
    await node.stop();
  }
});

test("the adapter rejects an inclusion proof the block does not support", async () => {
  const roots = ["a".repeat(64), "b".repeat(64)];
  const block = {
    height: 1,
    hash: "d".repeat(64),
    prevHash: "0".repeat(64),
    timestamp: "2026-01-01T00:00:00.000Z",
    roots,
    root: merkleRoot(roots),
    signer: "s".repeat(64),
    signature: "c2ln",
  };
  const path = merkleProof(roots, 0).map((hash) => ({
    hash,
    side: "right" as const,
  }));
  path[0]!.hash = "0".repeat(64);

  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);

    if (url.includes("/chain/proof")) {
      return new Response(
        JSON.stringify({
          root: roots[0],
          height: block.height,
          blockHash: block.hash,
          index: 0,
          path,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.endsWith(`/chain/blocks/${block.height}`)) {
      return new Response(JSON.stringify(block), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  };

  const adapter = new RarextChainAdapter(
    {
      id: "rarex",
      name: "RAREXT chain",
      family: "rarext",
      chainId: "rarex-test-1",
      rpc: "http://node.test",
    },
    fakeFetch,
  );

  assert.equal(await adapter.proof(roots[0]!), null);
});

test("a chain that is not configured is skipped, not failed", async () => {
  const adapter = new RarextChainAdapter({
    id: "rarex",
    name: "RAREXT chain",
    family: "rarext",
  });

  const receipt = await adapter.anchor("d".repeat(64), []);

  assert.equal(receipt.status, "skipped");
  assert.equal(receipt.confirmed, false);
  assert.match(receipt.error ?? "", /not configured/);
});

test("base58 decodes what it should", () => {
  assert.equal(
    Buffer.from(base58Decode("StV1DL6CwTryKyV") ?? []).toString("utf8"),
    "hello world",
  );
  assert.equal(base58Decode("0OIl"), null);
});

test("the adapter confirms a block that holds more than one root", async () => {
  const roots = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
  const block = {
    height: 7,
    hash: "d".repeat(64),
    prevHash: "0".repeat(64),
    timestamp: "2026-01-01T00:00:00.000Z",
    roots,
    root: merkleRoot(roots),
    signer: "s".repeat(64),
    signature: "c2ln",
  };

  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);

    if (url.endsWith("/chain/anchor")) {
      return new Response(
        JSON.stringify({ height: block.height, hash: block.hash }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.endsWith(`/chain/blocks/${block.height}`)) {
      return new Response(JSON.stringify(block), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  };

  const adapter = new RarextChainAdapter(
    {
      id: "rarex",
      name: "RAREXT chain",
      family: "rarext",
      chainId: "rarex-test-1",
      rpc: "http://node.test",
    },
    fakeFetch,
  );

  const receipt = await adapter.anchor(roots[1]!, ["pub-1"]);

  assert.equal(receipt.confirmed, true, receipt.error ?? "");
  assert.equal(receipt.status, "ok");
});

test("the adapter refuses a block whose root does not cover its roots", async () => {
  const roots = ["a".repeat(64), "b".repeat(64)];
  const block = {
    height: 8,
    hash: "e".repeat(64),
    prevHash: "0".repeat(64),
    timestamp: "2026-01-01T00:00:00.000Z",
    roots,
    root: "f".repeat(64),
    signer: "s".repeat(64),
    signature: "c2ln",
  };

  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);

    if (url.endsWith("/chain/anchor")) {
      return new Response(
        JSON.stringify({ height: block.height, hash: block.hash }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.endsWith(`/chain/blocks/${block.height}`)) {
      return new Response(JSON.stringify(block), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  };

  const adapter = new RarextChainAdapter(
    {
      id: "rarex",
      name: "RAREXT chain",
      family: "rarext",
      chainId: "rarex-test-1",
      rpc: "http://node.test",
    },
    fakeFetch,
  );

  const receipt = await adapter.anchor(roots[0]!, ["pub-1"]);

  assert.equal(receipt.confirmed, false);
  assert.equal(receipt.status, "skipped");
});
