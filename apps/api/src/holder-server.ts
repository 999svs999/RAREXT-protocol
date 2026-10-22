import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import { respondToChallenge } from "./durability.ts";
import { BlobStore } from "./storage.ts";

const MAX_BODY = 32 * 1024 * 1024;

export interface HolderServerOptions {
  id: string;
  directory: string;
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  type = "application/json",
): void {
  const payload =
    type === "application/json" ? JSON.stringify(body) : (body as Buffer);

  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_BODY) throw new Error("request body is too large");

    chunks.push(chunk as Buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = text ? JSON.parse(text) : {};

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be an object");
  }

  return parsed as Record<string, unknown>;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * A minimal HTTP holder: it stores shard bytes, answers nonce-bound leaf
 * challenges, and never learns which blob a shard belongs to.
 */
export function createHolderServer(options: HolderServerOptions) {
  const store = new BlobStore(options.directory);

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://holder");
      const parts = url.pathname.split("/").filter(Boolean);

      if (req.method === "GET" && url.pathname === "/v1/holder") {
        const shards = store.list();

        send(res, 200, {
          id: options.id,
          version: 1,
          shards: shards.length,
          bytes: shards.reduce((sum, shard) => sum + shard.size, 0),
        });
        return;
      }

      if (url.pathname === "/v1/holder/shards") {
        if (req.method === "GET") {
          send(res, 200, {
            id: options.id,
            shards: store.list().map((shard) => ({
              storedAs: shard.hash,
              size: shard.size,
              createdAt: shard.createdAt,
            })),
          });
          return;
        }

        if (req.method === "POST") {
          const body = await readJson(req);
          const content = body.content;

          if (typeof content !== "string" || content.length === 0) {
            send(res, 400, { error: "content must be base64 text" });
            return;
          }

          const bytes = Buffer.from(content, "base64");
          if (bytes.length === 0) {
            send(res, 400, { error: "content decoded to zero bytes" });
            return;
          }

          const record = store.put(bytes);
          send(res, 201, { storedAs: record.hash, size: record.size });
          return;
        }
      }

      if (parts.length === 4 && parts[0] === "v1" && parts[1] === "holder" && parts[2] === "shards") {
        const hash = parts[3]!;

        if (req.method === "HEAD") {
          res.writeHead(isHash(hash) && store.has(hash) ? 200 : 404);
          res.end();
          return;
        }

        if (req.method === "GET") {
          const found = isHash(hash) ? store.get(hash) : null;

          if (!found) {
            send(res, 404, { error: "unknown shard" });
            return;
          }

          send(res, 200, {
            storedAs: found.record.hash,
            size: found.record.size,
            content: found.bytes.toString("base64"),
          });
          return;
        }

        if (req.method === "DELETE") {
          res.writeHead(isHash(hash) && store.remove(hash) ? 204 : 404);
          res.end();
          return;
        }
      }

      if (req.method === "POST" && url.pathname === "/v1/holder/challenge") {
        const body = await readJson(req);
        const storedAs = body.storedAs;
        const leafIndex = body.leafIndex;
        const nonce = body.nonce;

        if (!isHash(storedAs) || !Number.isInteger(leafIndex) || (leafIndex as number) < 0 || typeof nonce !== "string") {
          send(res, 400, { error: "storedAs, leafIndex, and nonce are required" });
          return;
        }

        const found = store.get(storedAs);
        if (!found) {
          send(res, 404, { error: "unknown shard" });
          return;
        }

        const response = respondToChallenge(
          found.bytes,
          leafIndex as number,
          nonce,
        );

        if (!response) {
          send(res, 404, { error: "leaf index is out of range" });
          return;
        }

        send(res, 200, response);
        return;
      }

      send(res, 404, { error: "not found" });
    } catch (error) {
      send(res, 400, {
        error: error instanceof Error ? error.message : "bad request",
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const id = process.env.RAREXT_HOLDER_ID ?? `holder-${randomUUID().slice(0, 8)}`;
  const directory = process.env.RAREXT_HOLDER_DIR ?? ".data/holder";
  const port = Number(process.env.RAREXT_HOLDER_PORT ?? 9600);
  const host = process.env.RAREXT_HOLDER_HOST ?? "127.0.0.1";

  createHolderServer({ id, directory }).listen(port, host, () => {
    console.log(`RAREXT holder ${id} listening on http://${host}:${port}`);
  });
}
