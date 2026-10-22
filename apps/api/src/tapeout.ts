export interface TapeOutStatus {
  configured: boolean;
  chainId: string | null;
  blockNumber: string | null;
  bemContract: string | null;
  address: string | null;
  bemBalance: string | null;
  error?: string;
}

interface RpcResponse {
  result?: string;
  error?: { message?: string };
}

const BALANCE_OF = "0x70a08231";

function rpcUrl(): string | null {
  return process.env.BSC_RPC_URL ?? process.env.TAPEOUT_RPC_URL ?? null;
}

function bemContract(): string | null {
  return process.env.BEM_CONTRACT ?? null;
}

async function call(url: string, method: string, params: unknown[]): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`RPC returned ${response.status}`);
  }

  const body = (await response.json()) as RpcResponse;

  if (body.error) {
    throw new Error(body.error.message ?? "RPC error");
  }

  if (typeof body.result !== "string") {
    throw new Error("RPC response is missing a result");
  }

  return body.result;
}

function encodeBalanceOf(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error("address must be a 0x-prefixed 20-byte hex value");
  }

  return `${BALANCE_OF}${address.slice(2).padStart(64, "0")}`;
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
