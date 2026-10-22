import assert from "node:assert/strict";
import test from "node:test";

import { base32Encode, cidV1Raw, ContentPinAdapter } from "../src/adapters/content.ts";

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
