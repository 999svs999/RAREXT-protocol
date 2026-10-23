import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";

import { tapeOutIndex, tapeOutStatus } from "../src/tapeout.ts";
import { start, stop } from "./helpers.ts";

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TRANSFER_SINGLE_TOPIC =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const TRANSFER_BATCH_TOPIC =
  "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CIRCUIT_CONTRACT = "0x1111111111111111111111111111111111111111";
const COMPONENT_CONTRACT = "0x2222222222222222222222222222222222222222";
const BEM_CONTRACT = "0x5555555555555555555555555555555555555555";
const ALICE = "0x3333333333333333333333333333333333333333";
const BOB = "0x4444444444444444444444444444444444444444";

const ENV_KEYS = [
  "BSC_RPC_URL",
  "TAPEOUT_RPC_URL",
  "BEM_CONTRACT",
  "BEM_DECIMALS",
  "TAPEOUT_CIRCUIT_CONTRACT",
  "TAPEOUT_COMPONENT_CONTRACT",
  "TAPEOUT_INDEX_FROM_BLOCK",
  "TAPEOUT_INDEX_WINDOW",
  "TAPEOUT_INDEX_MAX_BLOCKS",
] as const;

function saveEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function addressTopic(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function word(value: bigint | number): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

function logEntry(
  address: string,
  topics: string[],
  data: string,
  blockNumber: string,
  logIndex: string,
) {
  return {
    address,
    topics,
    data,
    blockNumber,
    transactionHash: `0x${"a".repeat(64)}`,
    logIndex,
  };
}

async function startRpc() {
  const requests: {
    method: string;
    params: { address?: string; topics?: string[][] }[];
  }[] = [];

  const circuitLogs = [
    logEntry(
      CIRCUIT_CONTRACT,
      [TRANSFER_TOPIC, addressTopic(ZERO_ADDRESS), addressTopic(ALICE), `0x${word(1)}`],
      "0x",
      "0x10",
      "0x0",
    ),
    logEntry(
      CIRCUIT_CONTRACT,
      [TRANSFER_TOPIC, addressTopic(ALICE), addressTopic(BOB), `0x${word(1)}`],
      "0x",
      "0x20",
      "0x1",
    ),
    logEntry(
      CIRCUIT_CONTRACT,
      [TRANSFER_TOPIC, addressTopic(ZERO_ADDRESS), addressTopic(ALICE), `0x${word(2)}`],
      "0x",
      "0x11",
      "0x0",
    ),
  ];

  const single = logEntry(
    COMPONENT_CONTRACT,
    [
      TRANSFER_SINGLE_TOPIC,
      addressTopic(ALICE),
      addressTopic(ZERO_ADDRESS),
      addressTopic(ALICE),
    ],
    `0x${word(7)}${word(5)}`,
    "0x12",
    "0x0",
  );

  const batchData = `0x${word(0x40)}${word(0xa0)}${word(2)}${word(8)}${word(9)}${word(2)}${word(2)}${word(3)}`;
  const batch = logEntry(
    COMPONENT_CONTRACT,
    [
      TRANSFER_BATCH_TOPIC,
      addressTopic(ALICE),
      addressTopic(ALICE),
      addressTopic(BOB),
    ],
    batchData,
    "0x13",
    "0x1",
  );

  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;

    const request = JSON.parse(body) as {
      id: number;
      method: string;
      params: { address?: string; topics?: string[][] }[];
    };

    requests.push(request);

    let result: unknown;

    if (request.method === "eth_chainId") result = "0x38";
    else if (request.method === "eth_blockNumber") result = "0x100";
    else if (request.method === "eth_getLogs") {
      result =
        request.params[0]?.address === CIRCUIT_CONTRACT
          ? circuitLogs
          : request.params[0]?.address === COMPONENT_CONTRACT
            ? [single, batch]
            : [];
    } else {
      result = "0x0";
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("TapeOut status is explicitly unconfigured without env", async () => {
  const saved = saveEnv();

  for (const key of ENV_KEYS) delete process.env[key];

  try {
    const status = await tapeOutStatus();
    assert.equal(status.configured, false);
    assert.equal(status.chainId, null);
    assert.equal(status.bemBalance, null);
    assert.equal(status.bemDecimals, 18);

    const index = await tapeOutIndex();
    assert.equal(index.configured, false);
    assert.deepEqual(index.circuits, []);
    assert.deepEqual(index.components, []);
  } finally {
    restoreEnv(saved);
  }
});

test("TapeOut indexes latest circuit owners and component transfers", async () => {
  const rpc = await startRpc();
  const saved = saveEnv();

  process.env.BSC_RPC_URL = rpc.url;
  process.env.TAPEOUT_CIRCUIT_CONTRACT = CIRCUIT_CONTRACT;
  process.env.TAPEOUT_COMPONENT_CONTRACT = COMPONENT_CONTRACT;

  try {
    const index = await tapeOutIndex({ fromBlock: "0", toBlock: "256" });

    assert.equal(index.configured, true);
    assert.equal(index.chainId, "56");
    assert.equal(index.blockNumber, "256");
    assert.equal(index.fromBlock, "0");
    assert.equal(index.toBlock, "256");
    assert.equal(index.error, undefined);
    assert.equal(index.truncated, false);

    assert.deepEqual(
      index.circuits.map((circuit) => ({
        tokenId: circuit.tokenId,
        owner: circuit.owner,
      })),
      [
        { tokenId: "1", owner: BOB },
        { tokenId: "2", owner: ALICE },
      ],
    );

    assert.deepEqual(
      index.components.map((component) => ({
        tokenId: component.tokenId,
        from: component.from,
        to: component.to,
        amount: component.amount,
      })),
      [
        { tokenId: "7", from: ZERO_ADDRESS, to: ALICE, amount: "5" },
        { tokenId: "8", from: ALICE, to: BOB, amount: "2" },
        { tokenId: "9", from: ALICE, to: BOB, amount: "3" },
      ],
    );

    const logRequests = rpc.requests.filter((request) => request.method === "eth_getLogs");
    assert.equal(logRequests.length, 2);
    assert.equal(logRequests[1]?.params[0]?.topics?.[0]?.length, 2);
  } finally {
    restoreEnv(saved);
    await rpc.close();
  }
});

test("the API exposes the TapeOut indexer", async () => {
  const rpc = await startRpc();
  const saved = saveEnv();

  process.env.BSC_RPC_URL = rpc.url;
  process.env.TAPEOUT_CIRCUIT_CONTRACT = CIRCUIT_CONTRACT;
  process.env.TAPEOUT_COMPONENT_CONTRACT = COMPONENT_CONTRACT;

  const { server, base } = await start();

  try {
    const response = await fetch(
      `${base}/v1/tapeout/circuits?fromBlock=0&toBlock=256`,
    );
    assert.equal(response.status, 200);

    const index = (await response.json()) as {
      configured: boolean;
      circuits: { tokenId: string; owner: string }[];
    };

    assert.equal(index.configured, true);
    assert.equal(index.circuits.length, 2);
    assert.equal(index.circuits[0]?.owner, BOB);
  } finally {
    await stop(server);
    restoreEnv(saved);
    await rpc.close();
  }
});

test("TapeOut status reads a $BEM balance with configured decimals", async () => {
  const saved = saveEnv();
  const balance = 12345n * 10n ** 18n;
  const calls: { method: string; params: unknown[] }[] = [];

  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;

    const request = JSON.parse(body) as {
      id: number;
      method: string;
      params: unknown[];
    };
    calls.push({ method: request.method, params: request.params });

    const result =
      request.method === "eth_chainId"
        ? "0x38"
        : request.method === "eth_blockNumber"
          ? "0x100"
          : request.method === "eth_call"
            ? `0x${balance.toString(16)}`
            : "0x0";

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  process.env.BSC_RPC_URL = `http://127.0.0.1:${port}`;
  delete process.env.TAPEOUT_RPC_URL;
  process.env.BEM_CONTRACT = BEM_CONTRACT;
  process.env.BEM_DECIMALS = "18";

  try {
    const status = await tapeOutStatus(ALICE);

    assert.equal(status.configured, true);
    assert.equal(status.bemContract, BEM_CONTRACT);
    assert.equal(status.bemBalance, balance.toString());
    assert.equal(status.bemDecimals, 18);
    assert.equal(status.error, undefined);

    const call = calls.find((entry) => entry.method === "eth_call");
    assert.ok(call, "expected an eth_call for balanceOf");
    const payload = call.params[0] as { to: string; data: string };
    assert.equal(payload.to, BEM_CONTRACT);
    assert.equal(payload.data, `0x70a08231${ALICE.slice(2).padStart(64, "0")}`);
  } finally {
    restoreEnv(saved);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("TapeOut status honors a custom $BEM decimals setting", async () => {
  const saved = saveEnv();

  process.env.BSC_RPC_URL = "http://127.0.0.1:1";
  process.env.BEM_CONTRACT = BEM_CONTRACT;
  process.env.BEM_DECIMALS = "6";

  try {
    const status = await tapeOutStatus(ALICE);
    assert.equal(status.bemDecimals, 6);
  } finally {
    restoreEnv(saved);
  }
});
