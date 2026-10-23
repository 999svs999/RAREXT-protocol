import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { TracAnchorAdapter } from "../src/adapters/trac.ts";
import {
  INTERCOM_TRANSPORT_BLOCKER,
  WebhookAnchorTransport,
  createTracAnchorTransport,
} from "../src/adapters/trac-transport.ts";
import type { TracAnchorTransport } from "../src/adapters/trac-transport.ts";

const ROOT = "a".repeat(64);

test("selects the blocked native transport when no webhook is configured", async () => {
  const transport = createTracAnchorTransport(null);

  assert.equal(transport.kind, "intercom");
  assert.equal(transport.configured, false);
  assert.equal(transport.endpoint, null);
  await assert.rejects(
    () => transport.announce({ protocol: "rarext.anchor.v1", root: ROOT, publicationIds: [] }),
    /anchor move/,
  );
});

test("selects the webhook transport when a URL is configured", () => {
  const transport = createTracAnchorTransport("http://127.0.0.1:9/anchor");

  assert.equal(transport.kind, "webhook");
  assert.equal(transport.configured, true);
  assert.equal(transport.endpoint, "http://127.0.0.1:9/anchor");
});

test("webhook transport posts the announcement and returns its reference", async () => {
  let received = "";
  const server = createServer((request, response) => {
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
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  try {
    const transport = new WebhookAnchorTransport(`http://127.0.0.1:${port}/anchor`);
    const result = await transport.announce({
      protocol: "rarext.anchor.v1",
      root: ROOT,
      publicationIds: ["pub-1"],
    });

    assert.equal(result.reference, "trac:accepted");
    assert.match(received, /rarext\.anchor\.v1/);
    assert.match(received, /pub-1/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("webhook transport rejects a non-2xx response", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(503);
    response.end("busy");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  try {
    const transport = new WebhookAnchorTransport(`http://127.0.0.1:${port}/anchor`);
    await assert.rejects(
      () => transport.announce({ protocol: "rarext.anchor.v1", root: ROOT, publicationIds: [] }),
      /503/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the adapter announces through an injected transport", async () => {
  const announcements: unknown[] = [];
  const transport: TracAnchorTransport = {
    kind: "webhook",
    endpoint: "http://example.test/anchor",
    configured: true,
    async announce(announcement) {
      announcements.push(announcement);
      return { reference: "trac:injected" };
    },
  };
  const adapter = new TracAnchorAdapter(transport);

  const receipt = await adapter.anchor(ROOT, ["pub-2"]);

  assert.equal(receipt.status, "ok");
  assert.equal(receipt.reference, "trac:injected");
  assert.equal(announcements.length, 1);
  assert.equal(adapter.info().configured, true);
});

test("the adapter skips anchoring when the native transport is blocked", async () => {
  const transport: TracAnchorTransport = {
    kind: "intercom",
    endpoint: null,
    configured: false,
    async announce() {
      throw new Error(INTERCOM_TRANSPORT_BLOCKER);
    },
  };
  const adapter = new TracAnchorAdapter(transport);

  const receipt = await adapter.anchor(ROOT, []);

  assert.equal(receipt.status, "skipped");
  assert.equal(adapter.info().configured, false);
});

test("status reports the transport kind and the native blocker", async () => {
  const webhook: TracAnchorTransport = {
    kind: "webhook",
    endpoint: "http://example.test/anchor",
    configured: true,
    async announce() {
      return { reference: "trac:ok" };
    },
  };
  const native: TracAnchorTransport = {
    kind: "intercom",
    endpoint: null,
    configured: false,
    async announce() {
      throw new Error(INTERCOM_TRANSPORT_BLOCKER);
    },
  };

  const webhookDetails = (await new TracAnchorAdapter(webhook).status()).details;
  assert.equal(webhookDetails.transport, "webhook");
  assert.equal(webhookDetails.nativeTransport, "blocked");
  assert.equal(webhookDetails.identityProof, "reset-mcp-login");

  const nativeDetails = (await new TracAnchorAdapter(native).status()).details;
  assert.equal(nativeDetails.transport, "intercom");
  assert.equal(nativeDetails.nativeTransport, "blocked");
  assert.match(String(nativeDetails.nativeBlocker), /anchor move/);
});
