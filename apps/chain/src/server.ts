#!/usr/bin/env node
// The RAREXT chain node.
//
//   node apps/chain/src/server.ts
//
// Endpoints:
//   POST /chain/anchor   { root, publicationIds } -> { height, hash }
//   GET  /chain/head     the current head
//   GET  /chain/state    { chainId, height, head }
//   GET  /chain/proof?root=...   an inclusion proof for a root
//   GET  /chain/blocks/:height
//   GET  /chain/audit    a walk of the whole history
//   GET  /health
//
// The node is a notary with a chain's interface. It signs every block with its
// key and links the blocks by hash, so the history is verifiable without
// trusting the node. A consensus network implements the same interface.

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { AnchorChain, generateChainKey, type ChainKey } from "./chain.ts";

const PORT = Number(process.env.PORT ?? 8790);
const HOST = process.env.HOST ?? "127.0.0.1";
const CHAIN_ID = process.env.RAREXT_CHAIN_ID ?? "rarex-mainnet-1";
const KEY_PATH = process.env.RAREXT_CHAIN_KEY ?? ".data/chain-key.json";
const LOG_PATH = process.env.RAREXT_CHAIN_LOG ?? ".data/chain-log.json";

function loadKey(): ChainKey {
  if (existsSync(KEY_PATH)) {
    return JSON.parse(readFileSync(KEY_PATH, "utf8")) as ChainKey;
  }

  const key = generateChainKey();
  mkdirSync(dirname(KEY_PATH), { recursive: true });
  writeFileSync(KEY_PATH, JSON.stringify(key, null, 2), { mode: 0o600 });
  return key;
}

function loadChain(key: ChainKey): AnchorChain {
  const chain = new AnchorChain(CHAIN_ID, key);

  if (existsSync(LOG_PATH)) {
    const saved = JSON.parse(readFileSync(LOG_PATH, "utf8")) as {
      blocks?: { roots: string[] }[];
    };

    for (const block of saved.blocks ?? []) {
      chain.append(block.roots);
    }
  }

  return chain;
}

const key = loadKey();
const chain = loadChain(key);

function persist(): void {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  writeFileSync(
    LOG_PATH,
    JSON.stringify({ chainId: CHAIN_ID, blocks: chain.list() }, null, 2),
  );
}

function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  const send = (status: number, value: unknown) => {
    const payload = JSON.stringify(value);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  };

  if (req.method === "GET" && path === "/health") {
    send(200, { ok: true, chain: CHAIN_ID, ...chain.state() });
    return;
  }

  if (req.method === "GET" && path === "/chain/state") {
    send(200, chain.state());
    return;
  }

  if (req.method === "GET" && path === "/chain/head") {
    send(200, chain.head());
    return;
  }

  if (req.method === "GET" && path === "/chain/audit") {
    send(200, chain.audit());
    return;
  }

  if (req.method === "GET" && path === "/chain/proof") {
    const root = url.searchParams.get("root");

    if (!root) {
      send(400, { error: "root is required" });
      return;
    }

    const proof = chain.proof(root);

    if (!proof) {
      send(404, { error: "root is not in this chain" });
      return;
    }

    send(200, proof);
    return;
  }

  if (req.method === "GET" && path.startsWith("/chain/blocks/")) {
    const height = Number(path.slice("/chain/blocks/".length));
    const block = chain.block(height);

    if (!block) {
      send(404, { error: "block not found" });
      return;
    }

    send(200, block);
    return;
  }

  if (req.method === "POST" && path === "/chain/anchor") {
    try {
      const body = (await readJson(req)) as { root?: string; publicationIds?: string[] };

      if (typeof body.root !== "string" || !/^[0-9a-f]{64}$/.test(body.root)) {
        send(400, { error: "root must be a sha256 hex digest" });
        return;
      }

      const block = chain.append([body.root]);
      persist();

      send(201, {
        height: block.height,
        hash: block.hash,
        root: block.root,
        chainId: CHAIN_ID,
        publicationIds: body.publicationIds ?? [],
      });
    } catch (error) {
      send(400, {
        error: error instanceof Error ? error.message : "could not anchor",
      });
    }
    return;
  }

  send(404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(
    `RAREXT chain node listening on http://${HOST}:${PORT} (${CHAIN_ID}, height ${chain.height})`,
  );
});
