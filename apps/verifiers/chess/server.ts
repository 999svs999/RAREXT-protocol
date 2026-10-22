#!/usr/bin/env node
// The chess verifier service.
//
//   node apps/verifiers/chess/server.ts
//
// It runs the *built* module, the same bytes the registry serves by hash and the
// same bytes a browser imports, so the server, the registry, and a phone all
// reach the same verdict from the same code.
//
// Endpoints:
//   POST /chess/verify
//   GET  /health

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = join(here, "dist", "chess.mjs");

if (!existsSync(modulePath)) {
  console.error("the chess module is not built. run: npm run build:verifiers");
  process.exit(1);
}

const module = (await import(modulePath)) as {
  verify(artifact: unknown, challenge: unknown): {
    correct: boolean;
    score: number;
    gateCount: number;
    proof: unknown;
    details: unknown;
  };
};

const PORT = Number(process.env.PORT ?? 9201);
const MAX_BODY = 5_000_000;

function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) reject(new Error("body too large"));
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

  const send = (status: number, value: unknown) => {
    const payload = JSON.stringify(value);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  };

  if (req.method === "GET" && url.pathname === "/health") {
    send(200, { ok: true, app: "chess", module: "chess.mjs" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/chess/verify") {
    try {
      const request = (await readJson(req)) as {
        artifact?: unknown;
        challenge?: unknown;
      };

      if (!request.artifact || !request.challenge) {
        send(422, { error: "artifact and challenge are required" });
        return;
      }

      const output = module.verify(request.artifact, request.challenge);
      send(200, output);
    } catch (error) {
      send(422, {
        error: error instanceof Error ? error.message : "verification failed",
      });
    }
    return;
  }

  send(404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`FABRIC chess verifier listening on http://127.0.0.1:${PORT}`);
});
