import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { cidV1Raw } from "./adapters/content.ts";

const MAX_CONTENT = 32 * 1024 * 1024;
const CID_PATTERN = /^b[a-z2-7]{20,200}$/;

export interface PinRecord {
  cid: string;
  bytes: number;
  root: string | null;
  publicationIds: string[];
  pinnedAt: string;
}

export interface PinInput {
  cid: string;
  content: Uint8Array;
  root?: string | null;
  publicationIds?: string[];
}

/**
 * A small pinning service for the content adapter: it accepts the bundle bytes,
 * checks that the claimed CID is the CID of those bytes, and stores them under
 * that name. No daemon, no network dependency; a directory and an HTTP surface.
 */
export class PinStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
  }

  private paths(cid: string): { content: string; metadata: string } {
    if (!CID_PATTERN.test(cid)) throw new Error("cid is not a base32 CIDv1");
    return {
      content: join(this.directory, `${cid}.bin`),
      metadata: join(this.directory, `${cid}.json`),
    };
  }

  put(input: PinInput): PinRecord {
    if (!CID_PATTERN.test(input.cid)) throw new Error("cid is not a base32 CIDv1");
    if (input.content.length === 0) throw new Error("content must not be empty");
    if (input.content.length > MAX_CONTENT) throw new Error("content is too large");

    const computed = cidV1Raw(input.content);
    if (computed !== input.cid) throw new Error("cid does not match the content");

    const paths = this.paths(input.cid);
    const existing = this.get(input.cid);
    if (existing) return existing;

    const record: PinRecord = {
      cid: input.cid,
      bytes: input.content.length,
      root: input.root ?? null,
      publicationIds: input.publicationIds ?? [],
      pinnedAt: new Date().toISOString(),
    };
    const temporary = `${paths.content}.${randomUUID()}.tmp`;

    writeFileSync(temporary, input.content);
    renameSync(temporary, paths.content);
    writeFileSync(paths.metadata, `${JSON.stringify(record, null, 2)}\n`);

    return record;
  }

  get(cid: string): PinRecord | null {
    const paths = this.paths(cid);

    if (!existsSync(paths.metadata) || !existsSync(paths.content)) return null;

    return JSON.parse(readFileSync(paths.metadata, "utf8")) as PinRecord;
  }

  content(cid: string): Uint8Array | null {
    const paths = this.paths(cid);
    return existsSync(paths.content) ? new Uint8Array(readFileSync(paths.content)) : null;
  }

  has(cid: string): boolean {
    return this.get(cid) !== null;
  }

  list(): PinRecord[] {
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(this.directory, name), "utf8")) as PinRecord;
        } catch {
          return null;
        }
      })
      .filter((record): record is PinRecord => record !== null)
      .sort((left, right) => right.pinnedAt.localeCompare(left.pinnedAt));
  }

  remove(cid: string): boolean {
    const paths = this.paths(cid);

    if (!existsSync(paths.metadata) && !existsSync(paths.content)) return false;

    rmSync(paths.metadata, { force: true });
    rmSync(paths.content, { force: true });
    return true;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_CONTENT * 2) throw new Error("request body is too large");
    chunks.push(chunk as Buffer);
  }

  const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }

  return value as Record<string, unknown>;
}

export function createPinServer(store: PinStore) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        send(res, 200, { ok: true, pins: store.list().length });
        return;
      }

      if (url.pathname === "/v1/pins") {
        if (req.method === "GET") {
          send(res, 200, store.list());
          return;
        }

        if (req.method === "POST") {
          const body = await readBody(req);
          const cid = body.cid;
          const content = body.content;

          if (typeof cid !== "string" || typeof content !== "string") {
            send(res, 400, { error: "cid and base64 content are required" });
            return;
          }

          try {
            const record = store.put({
              cid,
              content: Uint8Array.from(Buffer.from(content, "base64")),
              root: typeof body.root === "string" ? body.root : null,
              publicationIds: Array.isArray(body.publicationIds)
                ? body.publicationIds.filter((value): value is string => typeof value === "string")
                : [],
            });

            send(res, 201, { ...record, reference: `pin:${record.cid}` });
          } catch (error) {
            send(res, 400, { error: error instanceof Error ? error.message : "pin refused" });
          }
          return;
        }

        send(res, 405, { error: "method not allowed" });
        return;
      }

      const parts = url.pathname.split("/").filter(Boolean);

      if (parts[0] === "v1" && parts[1] === "pins" && parts[2]) {
        const cid = parts[2];

        if (req.method === "GET") {
          const record = store.get(cid);
          const content = store.content(cid);

          if (!record || !content) {
            send(res, 404, { error: "pin not found" });
            return;
          }

          send(res, 200, { ...record, content: Buffer.from(content).toString("base64") });
          return;
        }

        if (req.method === "DELETE") {
          if (store.remove(cid)) {
            res.writeHead(204).end();
          } else {
            send(res, 404, { error: "pin not found" });
          }
          return;
        }
      }

      send(res, 404, { error: "not found" });
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : "bad request" });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.env.RAREXT_PIN_DIR ?? ".data/pins";
  const port = Number(process.env.RAREXT_PIN_PORT ?? "9700");
  const store = new PinStore(directory);
  const server = createPinServer(store);

  server.listen(port, "127.0.0.1", () => {
    console.log(`pinning service on http://127.0.0.1:${port} (${directory})`);
  });
}
