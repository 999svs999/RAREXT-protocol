export interface TapeOutStatus {
  configured: boolean;
  chainId: string | null;
  blockNumber: string | null;
  bemContract: string | null;
  address: string | null;
  bemBalance: string | null;
  error?: string;
}

export interface TapeOutCircuit {
  contract: string;
  tokenId: string;
  owner: string;
  from: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

export interface TapeOutComponentTransfer {
  contract: string;
  tokenId: string;
  from: string;
  to: string;
  amount: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

export interface TapeOutIndex {
  configured: boolean;
  chainId: string | null;
  blockNumber: string | null;
  fromBlock: string | null;
  toBlock: string | null;
  circuitContract: string | null;
  componentContract: string | null;
  circuits: TapeOutCircuit[];
  components: TapeOutComponentTransfer[];
  truncated: boolean;
  error?: string;
}

export interface TapeOutIndexQuery {
  fromBlock?: string;
  toBlock?: string;
}

interface RpcResponse {
  result?: unknown;
  error?: { message?: string };
}

interface RpcLog {
  address?: string;
  topics?: string[];
  data?: string;
  blockNumber?: string;
  transactionHash?: string;
  logIndex?: string;
}

const BALANCE_OF = "0x70a08231";
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TRANSFER_SINGLE_TOPIC =
  "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const TRANSFER_BATCH_TOPIC =
  "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";
const DEFAULT_WINDOW_BLOCKS = 5_000n;
const DEFAULT_MAX_BLOCKS = 50_000n;
const MAX_INDEX_ENTRIES = 500;

function rpcUrl(): string | null {
  return process.env.BSC_RPC_URL ?? process.env.TAPEOUT_RPC_URL ?? null;
}

function bemContract(): string | null {
  return process.env.BEM_CONTRACT ?? null;
}

async function rpc(
  url: string,
  method: string,
  params: unknown[],
  requestFetch: typeof fetch,
): Promise<unknown> {
  const response = await requestFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`RPC returned ${response.status}`);
  }

  const body = (await response.json()) as RpcResponse;

  if (body.error) {
    throw new Error(body.error.message ?? "RPC error");
  }

  if (body.result === undefined) {
    throw new Error("RPC response is missing a result");
  }

  return body.result;
}

async function call(
  url: string,
  method: string,
  params: unknown[],
  requestFetch: typeof fetch = fetch,
): Promise<string> {
  const result = await rpc(url, method, params, requestFetch);

  if (typeof result !== "string") {
    throw new Error("RPC response is missing a string result");
  }

  return result;
}

function encodeBalanceOf(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error("address must be a 0x-prefixed 20-byte hex value");
  }

  return `${BALANCE_OF}${address.slice(2).padStart(64, "0")}`;
}

function quantity(value: string): bigint {
  if (/^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  if (/^[0-9]+$/.test(value)) return BigInt(value);
  throw new Error(`invalid block quantity: ${value}`);
}

function hexQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function normalizeAddress(value: string | undefined): string | null {
  if (!value) return null;

  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error("TapeOut contract addresses must be 0x-prefixed 20-byte hex values");
  }

  return value.toLowerCase();
}

function addressFromTopic(topic: string | undefined): string | null {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return `0x${topic.slice(-40).toLowerCase()}`;
}

function dataWords(data: string | undefined): string[] | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data)) return null;

  const hex = data.slice(2);
  if (hex.length % 64 !== 0) return null;

  const words: string[] = [];
  for (let offset = 0; offset < hex.length; offset += 64) {
    words.push(hex.slice(offset, offset + 64));
  }

  return words;
}

function decodeUintArray(data: string, offset: bigint): bigint[] | null {
  const hex = data.slice(2);
  const start = Number(offset) * 2;

  if (!Number.isSafeInteger(start) || start < 0 || start + 64 > hex.length) {
    return null;
  }

  const length = Number(BigInt(`0x${hex.slice(start, start + 64)}`));
  const valuesStart = start + 64;

  if (!Number.isSafeInteger(length) || valuesStart + length * 64 > hex.length) {
    return null;
  }

  const values: bigint[] = [];
  for (let index = 0; index < length; index += 1) {
    const position = valuesStart + index * 64;
    values.push(BigInt(`0x${hex.slice(position, position + 64)}`));
  }

  return values;
}

function blockNumber(log: RpcLog): string {
  return quantity(log.blockNumber ?? "0x0").toString();
}

function logIndex(log: RpcLog): string {
  return quantity(log.logIndex ?? "0x0").toString();
}

function transactionHash(log: RpcLog): string {
  return typeof log.transactionHash === "string" ? log.transactionHash : "";
}

function sortLogs(logs: RpcLog[]): RpcLog[] {
  return [...logs].sort((left, right) => {
    const block = Number(blockNumber(left)) - Number(blockNumber(right));
    if (block !== 0) return block;
    return Number(logIndex(left)) - Number(logIndex(right));
  });
}

function circuitEvents(logs: RpcLog[], contract: string): TapeOutCircuit[] {
  const latest = new Map<string, TapeOutCircuit>();

  for (const log of sortLogs(logs)) {
    const topics = log.topics;

    if (!topics || topics.length !== 4 || topics[0]?.toLowerCase() !== TRANSFER_TOPIC) {
      continue;
    }

    const from = addressFromTopic(topics[1]);
    const to = addressFromTopic(topics[2]);
    const tokenHex = topics[3];

    if (!from || !to || !tokenHex || !/^0x[0-9a-fA-F]{64}$/.test(tokenHex)) {
      continue;
    }

    const tokenId = BigInt(tokenHex).toString();
    latest.set(tokenId, {
      contract,
      tokenId,
      owner: to,
      from,
      blockNumber: blockNumber(log),
      transactionHash: transactionHash(log),
      logIndex: logIndex(log),
    });
  }

  return [...latest.values()].sort((left, right) =>
    BigInt(left.tokenId) < BigInt(right.tokenId) ? -1 : 1,
  );
}

function singleComponent(log: RpcLog, contract: string): TapeOutComponentTransfer | null {
  const topics = log.topics;
  const words = dataWords(log.data);

  if (!topics || topics.length !== 4 || topics[0]?.toLowerCase() !== TRANSFER_SINGLE_TOPIC) {
    return null;
  }

  if (!words || words.length < 2) return null;

  const from = addressFromTopic(topics[2]);
  const to = addressFromTopic(topics[3]);

  if (!from || !to) return null;

  return {
    contract,
    tokenId: BigInt(`0x${words[0]}`).toString(),
    from,
    to,
    amount: BigInt(`0x${words[1]}`).toString(),
    blockNumber: blockNumber(log),
    transactionHash: transactionHash(log),
    logIndex: logIndex(log),
  };
}

function batchComponents(log: RpcLog, contract: string): TapeOutComponentTransfer[] {
  const topics = log.topics;
  const data = log.data;

  if (
    !topics ||
    topics.length !== 4 ||
    topics[0]?.toLowerCase() !== TRANSFER_BATCH_TOPIC ||
    typeof data !== "string"
  ) {
    return [];
  }

  const words = dataWords(data);
  if (!words || words.length < 2) return [];

  const from = addressFromTopic(topics[2]);
  const to = addressFromTopic(topics[3]);
  if (!from || !to) return [];

  const ids = decodeUintArray(data, BigInt(`0x${words[0]}`));
  const amounts = decodeUintArray(data, BigInt(`0x${words[1]}`));

  if (!ids || !amounts || ids.length !== amounts.length) return [];

  return ids.map((tokenId, index) => ({
    contract,
    tokenId: tokenId.toString(),
    from,
    to,
    amount: amounts[index]!.toString(),
    blockNumber: blockNumber(log),
    transactionHash: transactionHash(log),
    logIndex: logIndex(log),
  }));
}

function componentEvents(logs: RpcLog[], contract: string): TapeOutComponentTransfer[] {
  const events: TapeOutComponentTransfer[] = [];

  for (const log of sortLogs(logs)) {
    const single = singleComponent(log, contract);
    if (single) {
      events.push(single);
      continue;
    }

    events.push(...batchComponents(log, contract));
  }

  return events;
}

function asLogs(value: unknown): RpcLog[] {
  if (!Array.isArray(value)) {
    throw new Error("RPC returned a non-array log list");
  }

  return value.filter(
    (entry): entry is RpcLog => typeof entry === "object" && entry !== null,
  );
}

async function getLogs(
  url: string,
  address: string,
  topics: string[],
  fromBlock: bigint,
  toBlock: bigint,
  requestFetch: typeof fetch,
): Promise<RpcLog[]> {
  const result = await rpc(
    url,
    "eth_getLogs",
    [
      {
        address,
        fromBlock: hexQuantity(fromBlock),
        toBlock: hexQuantity(toBlock),
        topics: [topics],
      },
    ],
    requestFetch,
  );

  return asLogs(result);
}

function envBigInt(name: string, fallback: bigint): bigint {
  const value = process.env[name];
  if (!value) return fallback;
  return quantity(value);
}

function queryBound(value: string | undefined): bigint | null {
  if (value === undefined || value.trim() === "") return null;
  return quantity(value.trim());
}

export async function tapeOutIndex(
  query: TapeOutIndexQuery = {},
  requestFetch: typeof fetch = fetch,
): Promise<TapeOutIndex> {
  const url = rpcUrl();
  const circuitContract = normalizeAddress(process.env.TAPEOUT_CIRCUIT_CONTRACT);
  const componentContract = normalizeAddress(process.env.TAPEOUT_COMPONENT_CONTRACT);
  const configured = Boolean(url && (circuitContract || componentContract));

  if (!configured) {
    return {
      configured: false,
      chainId: null,
      blockNumber: null,
      fromBlock: null,
      toBlock: null,
      circuitContract,
      componentContract,
      circuits: [],
      components: [],
      truncated: false,
    };
  }

  const index: TapeOutIndex = {
    configured: true,
    chainId: null,
    blockNumber: null,
    fromBlock: null,
    toBlock: null,
    circuitContract,
    componentContract,
    circuits: [],
    components: [],
    truncated: false,
  };

  try {
    const chainId = BigInt(await call(url!, "eth_chainId", [], requestFetch));
    const latest = BigInt(await call(url!, "eth_blockNumber", [], requestFetch));

    const requestedFrom = queryBound(query.fromBlock);
    const requestedTo = queryBound(query.toBlock);
    const window = envBigInt("TAPEOUT_INDEX_WINDOW", DEFAULT_WINDOW_BLOCKS);
    const maxBlocks = envBigInt("TAPEOUT_INDEX_MAX_BLOCKS", DEFAULT_MAX_BLOCKS);

    const from =
      requestedFrom ??
      (process.env.TAPEOUT_INDEX_FROM_BLOCK
        ? quantity(process.env.TAPEOUT_INDEX_FROM_BLOCK)
        : latest >= window
          ? latest - window + 1n
          : 0n);
    const to = requestedTo ?? latest;

    if (from > to) {
      throw new Error("fromBlock must not be greater than toBlock");
    }

    if (to > latest) {
      throw new Error("toBlock is ahead of the chain head");
    }

    if (to - from + 1n > maxBlocks) {
      throw new Error(`block range exceeds TAPEOUT_INDEX_MAX_BLOCKS (${maxBlocks})`);
    }

    const circuits = circuitContract
      ? circuitEvents(
          await getLogs(url!, circuitContract, [TRANSFER_TOPIC], from, to, requestFetch),
          circuitContract,
        )
      : [];
    const components = componentContract
      ? componentEvents(
          await getLogs(
            url!,
            componentContract,
            [TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC],
            from,
            to,
            requestFetch,
          ),
          componentContract,
        )
      : [];

    index.chainId = chainId.toString();
    index.blockNumber = latest.toString();
    index.fromBlock = from.toString();
    index.toBlock = to.toString();
    index.truncated =
      circuits.length > MAX_INDEX_ENTRIES || components.length > MAX_INDEX_ENTRIES;
    index.circuits = circuits.slice(0, MAX_INDEX_ENTRIES);
    index.components = components.slice(0, MAX_INDEX_ENTRIES);
  } catch (error) {
    index.error = error instanceof Error ? error.message : String(error);
  }

  return index;
}

export async function tapeOutStatus(address?: string): Promise<TapeOutStatus> {
  const url = rpcUrl();
  const contract = bemContract();

  if (!url || !contract) {
    return {
      configured: false,
      chainId: null,
      blockNumber: null,
      bemContract: contract,
      address: address ?? null,
      bemBalance: null,
    };
  }

  const status: TapeOutStatus = {
    configured: true,
    chainId: null,
    blockNumber: null,
    bemContract: contract,
    address: address ?? null,
    bemBalance: null,
  };

  try {
    status.chainId = BigInt(await call(url, "eth_chainId", [])).toString();
    status.blockNumber = BigInt(await call(url, "eth_blockNumber", [])).toString();

    if (address) {
      const result = await call(url, "eth_call", [
        { to: contract, data: encodeBalanceOf(address) },
        "latest",
      ]);
      status.bemBalance = BigInt(result === "0x" ? "0x0" : result).toString();
    }
  } catch (error) {
    status.error = error instanceof Error ? error.message : String(error);
  }

  return status;
}
