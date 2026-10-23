import assert from "node:assert/strict";
import test from "node:test";

import { AbiCoder, id } from "ethers";

import { RelayChainAdapter } from "../src/chains/relay.ts";

const CONTRACT = "0x00000000000000000000000000000000000000aa";
const ROOT = "a".repeat(64);
const TIMESTAMP = 1_700_000_000n;
const SELECTOR = id("anchors(uint256)").slice(0, 10);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function rpcResult(root: string, timestamp: bigint): string {
  return AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint64"],
    [`0x${root}`, timestamp],
  );
}

function evmAdapter(fakeFetch: typeof fetch): RelayChainAdapter {
  return new RelayChainAdapter(
    {
      id: "base",
      name: "Base",
      family: "evm",
      rpc: "http://node.test",
      address: CONTRACT,
    },
    fakeFetch,
  );
}

test("the EVM adapter reads back with canonical anchors(uint256) calldata", async () => {
  const transports: unknown[] = [];
  let relayRequest: Record<string, unknown> | undefined;

  const fakeFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    transports.push(request);

    if (request.protocol === "rarext.anchor.v1") {
      relayRequest = request;
      return json({ reference: "0xdeadbeef:7" });
    }

    if (request.method === "eth_call") {
      return json({ jsonrpc: "2.0", id: 1, result: rpcResult(ROOT, TIMESTAMP) });
    }

    return new Response("unexpected request", { status: 500 });
  };

  const receipt = await evmAdapter(fakeFetch).anchor(ROOT, ["pub-1"]);

  assert.equal(receipt.status, "ok", receipt.error);
  assert.equal(receipt.confirmed, true);
  assert.equal(relayRequest?.protocol, "rarext.anchor.v1");
  assert.equal(relayRequest?.root, ROOT);
  assert.deepEqual(relayRequest?.publicationIds, ["pub-1"]);
  assert.equal(relayRequest?.address, CONTRACT);

  const call = transports.find(
    (entry): entry is { method: string; params: unknown[] } =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { method?: unknown }).method === "eth_call",
  );

  assert.ok(call, "the adapter must make an eth_call");
  assert.deepEqual(call.params, [
    {
      to: CONTRACT,
      data: `${SELECTOR}${"7".padStart(64, "0")}`,
    },
    "latest",
  ]);
});

test("the EVM adapter accepts the relay's numeric index reference", async () => {
  const calls: unknown[] = [];

  const fakeFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;

    if (request.protocol === "rarext.anchor.v1") {
      return json({ index: 7 });
    }

    if (request.method === "eth_call") {
      calls.push(request);
      return json({ jsonrpc: "2.0", id: 1, result: rpcResult(ROOT, TIMESTAMP) });
    }

    return new Response("unexpected request", { status: 500 });
  };

  const receipt = await evmAdapter(fakeFetch).anchor(ROOT, ["pub-1"]);

  assert.equal(receipt.status, "ok", receipt.error);
  assert.equal(receipt.confirmed, true);
  assert.equal(calls.length, 1);
  assert.equal(
    (calls[0] as { params: [{ data: string }] }).params[0].data,
    `${SELECTOR}${"7".padStart(64, "0")}`,
  );
});

test("the EVM adapter does not guess index 0 when the reference has no id", async () => {
  let ethCalls = 0;

  const fakeFetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;

    if (request.protocol === "rarext.anchor.v1") {
      return json({ reference: "0xdeadbeef" });
    }

    if (request.method === "eth_call") {
      ethCalls += 1;
      return json({ jsonrpc: "2.0", id: 1, result: rpcResult(ROOT, TIMESTAMP) });
    }

    return new Response("unexpected request", { status: 500 });
  };

  const receipt = await evmAdapter(fakeFetch).anchor(ROOT, ["pub-1"]);

  assert.equal(receipt.status, "skipped");
  assert.equal(receipt.confirmed, false);
  assert.equal(ethCalls, 0);
  assert.match(receipt.error ?? "", /did not confirm/);
});
