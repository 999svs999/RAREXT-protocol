#!/usr/bin/env node
// Serve the showcase in the exact layout the deploy step publishes:
//
//   site/index.html              -> /index.html
//   site/registry/*              -> /registry/*
//   site/registry/mirror/*       -> /mirror/*
//
// `python3 -m http.server` in site/ does not reproduce that mapping, so local
// screenshots and link checks would test a tree nobody deploys.
//
//   node scripts/preview-showcase.mjs [--port 8080]
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const ROOT = new URL("../site/", import.meta.url).pathname;
const BASE = normalize(ROOT).replace(/\/+$/, "");
const at = process.argv.indexOf("--port");
const port = at >= 0 ? Number(process.argv[at + 1]) : Number(process.env.PORT ?? 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".png.map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

function resolve(pathname) {
  let clean = decodeURIComponent(pathname.split("?")[0] ?? "/");
  if (clean === "/") clean = "/index.html";
  let relative;
  if (clean.startsWith("/mirror/")) {
    relative = join("registry", clean);
  } else {
    relative = clean.replace(/^\//, "");
  }
  const absolute = normalize(join(ROOT, relative));
  if (!absolute.startsWith(BASE + sep) && absolute !== BASE) return null;
  if (existsSync(absolute) && statSync(absolute).isFile()) return absolute;
  // Clean URLs: /registry serves /registry/index.html.
  const withIndex = join(absolute, "index.html");
  if (existsSync(withIndex) && statSync(withIndex).isFile()) return withIndex;
  for (const candidate of [absolute + ".html", absolute + "/index.html"]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const server = createServer((request, response) => {
  const file = resolve(request.url ?? "/");
  if (file === null) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
    return;
  }
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  response.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  createReadStream(file).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`showcase preview: http://127.0.0.1:${port}/`);
});
