import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import {
  base32Encode,
  cidV1Raw,
  ContentPinAdapter,
  pinBundle,
  pinServiceUrl,
} from "../src/adapters/content.ts";
import { checkPin, getBytes } from "../../../scripts/verify-seed-mirrors.mjs";
import {
  MAX_BUNDLE_RESPONSE_BYTES,
} from "../../../packages/core/src/index.ts";

/**
 * The pinning service, as a test double the way bundle-seed.test.ts builds one:
 * a local HTTP server the pinning call really POSTs to, so the request, the
 * body, and the answer are the real wire shapes rather than a stubbed function.
 */
async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const PIN_ENV = ["RAREXT_PIN_SERVICE_URL", "RAREXT_PIN_URL", "RAREXT_PIN_TOKEN"] as const;

/** Runs with no pinning service configured by any name, restoring the env after. */
async function withoutPinService<T>(run: () => Promise<T>): Promise<T> {
  const saved = PIN_ENV.map((key) => [key, process.env[key]] as const);
  for (const [key] of saved) delete process.env[key];
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}


test("base32 encodes without padding", () => {
  // RFC 4648 test vectors, lowercased and unpadded.
  const encode = (value: string) => base32Encode(new TextEncoder().encode(value));

  assert.equal(encode(""), "");
  assert.equal(encode("f"), "my");
  assert.equal(encode("fo"), "mzxq");
  assert.equal(encode("foo"), "mzxw6");
  assert.equal(encode("foob"), "mzxw6yq");
  assert.equal(encode("fooba"), "mzxw6ytb");
  assert.equal(encode("foobar"), "mzxw6ytboi");
});

test("a CIDv1 raw is a version, a codec, and a sha2-256 multihash", () => {
  const cid = cidV1Raw(Buffer.from("hello world", "utf8"));

  assert.match(cid, /^b[a-z2-7]+$/);
  assert.ok(cid.length > 50, "a CID should carry the digest");

  // The same bytes always give the same pointer, and different bytes never do.
  assert.equal(cid, cidV1Raw(Buffer.from("hello world", "utf8")));
  assert.notEqual(cid, cidV1Raw(Buffer.from("hello worlds", "utf8")));
});

test("the content adapter reports a local reference when no service is configured", async () => {
  const adapter = new ContentPinAdapter();
  const receipt = await adapter.anchor("a".repeat(64), ["pub-1"]);

  assert.equal(receipt.adapter, "content");
  assert.equal(receipt.status, "ok");
  assert.match(receipt.reference ?? "", /^cid:b[a-z2-7]+$/);
});

test("the content adapter hands the CID to a pinning service", async () => {
  const seen: { cid?: string } = {};

  const adapter = new ContentPinAdapter({
    serviceUrl: "https://pin.invalid/pin",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { cid: string };
      seen.cid = body.cid;
      return new Response(JSON.stringify({ reference: "ipfs:" + body.cid }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });

  const receipt = await adapter.anchor("b".repeat(64), ["pub-2"]);

  assert.ok(seen.cid?.startsWith("b"), "the service received a CID");
  assert.equal(receipt.reference, `ipfs:${seen.cid}`);
});

test("a failing pinning service is an error, not a silent success", async () => {
  const adapter = new ContentPinAdapter({
    serviceUrl: "https://pin.invalid/pin",
    fetchImpl: (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch,
  });

  await assert.rejects(() => adapter.anchor("c".repeat(64), ["pub-3"]));
});

test("pinBundle hands a configured service the CID and the exact bytes", async () => {
  const bytes = Buffer.from(JSON.stringify({ publications: ["pub-1"] }), "utf8");
  const expected = cidV1Raw(bytes);
  const seen: { method?: string; path?: string; auth?: string | null; cid?: string; content?: string } = {};

  await withServer(
    (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        seen.method = request.method;
        seen.path = request.url;
        seen.auth = request.headers.authorization ?? null;
        const payload = JSON.parse(body) as { cid: string; content: string };
        seen.cid = payload.cid;
        seen.content = payload.content;
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ reference: `pin:${payload.cid}` }));
      });
    },
    async (base) => {
      const service = `${base}/v1/pins`;
      const pinned = await pinBundle(bytes, { serviceUrl: service, token: "publish-token" });

      assert.equal(pinned.cid, expected, "the CID is computed from the bytes locally");
      assert.equal(pinned.service, service, "the result says where the CID went");
      assert.equal(pinned.reference, `pin:${expected}`, "the result carries the service's reference");
      assert.equal(seen.method, "POST");
      assert.equal(seen.path, "/v1/pins");
      assert.equal(seen.auth, "Bearer publish-token");
      assert.equal(seen.cid, expected, "the service received the CID the bytes hash to");
      assert.equal(seen.content, bytes.toString("base64"), "the service received the exact bytes");
    },
  );
});

test("a service that does not accept the pin surfaces as an error naming why", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("the pin store is full");
    },
    async (base) => {
      await assert.rejects(
        () => pinBundle(Buffer.from("published bytes"), { serviceUrl: `${base}/v1/pins` }),
        (error: Error) => {
          assert.match(error.message, /pinning service returned 503/, "the status is named");
          return true;
        },
      );
    },
  );

  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("<html>not a reference</html>");
    },
    async (base) => {
      await assert.rejects(
        () => pinBundle(Buffer.from("published bytes"), { serviceUrl: `${base}/v1/pins` }),
        /pinning service returned invalid JSON/,
      );
    },
  );
});

test("with no pinning service configured, the call is local and fetches nothing", async () => {
  await withoutPinService(async () => {
    assert.equal(pinServiceUrl(), null, "no service is the configured state");
    assert.equal(process.env.RAREXT_PIN_TOKEN, undefined, "and no token either");

    let fetched = 0;
    const neverCalled = (async () => {
      fetched += 1;
      return new Response(JSON.stringify({ reference: "fabricated" }), { status: 200 });
    }) as unknown as typeof fetch;

    const bytes = Buffer.from("no service configured", "utf8");
    const pinned = await pinBundle(bytes, { fetchImpl: neverCalled });

    assert.equal(pinned.service, null, "nobody was told");
    assert.equal(pinned.reference, `cid:${cidV1Raw(bytes)}`, "the reference is the local pointer");
    assert.equal(fetched, 0, "no service configured means no request is made");

    // An explicit `null` is "no service, on purpose", even with one configured
    // elsewhere — the caller, not the environment, decides in that case.
    process.env.RAREXT_PIN_SERVICE_URL = "https://pin.example/v1/pins";
    const local = await pinBundle(bytes, { serviceUrl: null, fetchImpl: neverCalled });
    assert.equal(local.service, null);
    assert.equal(local.reference, `cid:${cidV1Raw(bytes)}`);
    assert.equal(fetched, 0, "and it still fetches nothing");
  });
});

test("the pinning call reads the documented configuration", async () => {
  await withoutPinService(async () => {
    process.env.RAREXT_PIN_SERVICE_URL = "https://pin.example/v1/pins";
    assert.equal(pinServiceUrl(), "https://pin.example/v1/pins");

    const reference = { reference: "pin:from-the-service" };
    const pinned = await pinBundle(Buffer.from("configured by env"), {
      fetchImpl: (async () =>
        new Response(JSON.stringify(reference), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    assert.equal(pinned.service, "https://pin.example/v1/pins", "no options, configured by env");
    assert.equal(pinned.reference, "pin:from-the-service", "the service's reference, not a local one");

    // The adapter's long-standing name still resolves, so an existing
    // deployment keeps working beside the new one.
    delete process.env.RAREXT_PIN_SERVICE_URL;
    process.env.RAREXT_PIN_URL = "https://legacy.example/v1/pins";
    assert.equal(pinServiceUrl(), "https://legacy.example/v1/pins");
  });
});

test("the live checker accepts a pin that resolves to the bundle's address", async () => {
  const bytes = Buffer.from(JSON.stringify({ manifest: { root: "a".repeat(64) } }), "utf8");
  const cid = cidV1Raw(bytes);
  const seed = { bundleCid: cid };

  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(bytes);
    },
    async (base) => {
      // The reference is the bare local form, so the check must resolve it
      // through the service the pin names: `${service}/${cid}`.
      const ok = await checkPin({ cid, service: base, reference: `cid:${cid}` }, seed, getBytes);
      assert.equal(ok.ok, true, ok.reason);
      assert.equal(ok.url, `${base}/${cid}`);

      // A full URL reference is fetched as recorded, without re-deriving it.
      const byUrl = await checkPin(
        { cid, service: base, reference: `${base}/${cid}` },
        seed,
        getBytes,
      );
      assert.equal(byUrl.ok, true, byUrl.reason);
    },
  );
});

test("the live checker reports a pin that resolves elsewhere, or not at all", async () => {
  const bytes = Buffer.from(JSON.stringify({ manifest: { root: "a".repeat(64) } }), "utf8");
  const cid = cidV1Raw(bytes);
  const seed = { bundleCid: cid };

  // The tampered service: right reference, wrong bytes.
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from("something other than the published bytes"));
    },
    async (base) => {
      const tampered = await checkPin({ cid, service: base, reference: `cid:${cid}` }, seed, getBytes);
      assert.equal(tampered.ok, false, "a tampered service must be a failing pin");
      assert.match(tampered.reason, /serves .* the pin says /);
    },
  );

  // The service answers, and what it serves is a DIFFERENT content address
  // than the one the seed pins: the pin disagrees with bundleCid.
  const otherCid = cidV1Raw(Buffer.from("a different bundle"));
  assert.notEqual(otherCid, cid);
  const disagrees = await checkPin(
    { cid: otherCid, service: "https://pin.example", reference: `cid:${otherCid}` },
    seed,
    async () => Buffer.from("a different bundle"),
  );
  assert.equal(disagrees.ok, false);
  assert.match(disagrees.reason, /but the seed pins /);

  // A pin the publish recorded as a failure is reported with that failure.
  const failed = await checkPin(
    { cid, service: "https://pin.example", error: "pinning service returned 500" },
    seed,
    async () => bytes,
  );
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /the publish recorded an error: pinning service returned 500/);

  // A pin that does not resolve is reported, never skipped as uninteresting.
  await withServer(
    (_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("gone");
    },
    async (base) => {
      const unreachable = await checkPin({ cid, service: base, reference: `cid:${cid}` }, seed, getBytes);
      assert.equal(unreachable.ok, false);
      assert.match(unreachable.reason, /did not resolve \(HTTP 404\)/);
    },
  );

  // And an entry naming nowhere to read from is a failing pin, not a pass.
  const nowhere = await checkPin({ cid }, seed, async () => bytes);
  assert.equal(nowhere.ok, false);
  assert.match(nowhere.reason, /names no service or URL/);
});

test("the live checker's getBytes refuses a bundle response past the shared cap", async () => {
  // No network: the fetch is injected, and the responses are the plain shapes
  // the shared reader needs — headers.get plus an optional streaming body.
  type FakeResponse = {
    ok: boolean;
    headers: { get(name: string): string | null };
    body: ReadableStream<Uint8Array> | null;
  };
  const fakeFetch =
    (response: FakeResponse) =>
    async () => response;

  // An honest small body passes through byte for byte.
  const small = new TextEncoder().encode("the published bytes");
  const served = await getBytes("https://mirror.example/bundle.json", fakeFetch({
    ok: true,
    headers: { get: () => String(small.length) },
    body: new Response(small).body,
  }));
  assert.deepEqual(Buffer.from(served).toString("utf8"), "the published bytes");

  // A LYING Content-Length (2 GiB declared, tiny body served) is refused
  // before the body is read, naming the cap and the claimed size.
  let pulled = 0;
  const guarded = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(8));
      controller.close();
    },
  });
  await assert.rejects(
    () =>
      getBytes("https://mirror.example/bundle.json", fakeFetch({
        ok: true,
        headers: { get: () => String(2 * 1024 * 1024 * 1024) },
        body: guarded,
      })),
    (error: Error) => {
      assert.match(error.message, /declares 2147483648 bytes/);
      assert.match(error.message, new RegExp(`above the ${MAX_BUNDLE_RESPONSE_BYTES} byte cap`));
      return true;
    },
  );
  assert.equal(pulled <= 1, true, "an oversized declaration is refused unread (the stream is not consumed)");

  // A body that streams past the cap with no header at all is cut off
  // mid-read by the byte counter.
  const chunk = new Uint8Array(1024 * 1024);
  let count = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      count += 1;
      if (count > 64) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });
  await assert.rejects(
    () =>
      getBytes("https://mirror.example/bundle.json", fakeFetch({
        ok: true,
        headers: { get: () => null },
        body: endless,
      })),
    (error: Error) => {
      assert.match(error.message, new RegExp(`streamed past the ${MAX_BUNDLE_RESPONSE_BYTES} byte cap`));
      return true;
    },
  );
});
