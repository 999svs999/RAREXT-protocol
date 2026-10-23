import type {
  AdapterInfo,
  AdapterReceipt,
  AdapterStatus,
} from "../../../../packages/core/src/index.ts";

import { statusFor } from "../adapters/types.ts";
import type { RarextAdapter } from "../adapters/types.ts";

export type ChainFamily =
  | "evm"
  | "solana"
  | "bitcoin"
  | "cosmos"
  | "rarext"
  | "trac";

export interface ChainConfig {
  id: string;
  name: string;
  family: ChainFamily;
  /** The node or relay that submits the anchor. */
  rpc?: string;
  /** The contract, program, account, or memo target on that chain. */
  address?: string;
  /** A chain id, for chains that have one. */
  chainId?: number | string;
  /** A public key that must have signed the anchor, where the chain has keys. */
  signer?: string;
  enabled?: boolean;
}

export interface ChainReceipt extends AdapterReceipt {
  chain: string;
  family: ChainFamily;
  height: number | null;
  hash: string | null;
  /** Whether the anchor was read back off the chain and confirmed. */
  confirmed: boolean;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// keccak256("anchors(uint256)")[0..4]. The API has no runtime Ethereum
// dependency, so the selector is pinned here. `apps/api/test/evm-relay.test.ts`
// checks it against ethers' `id("anchors(uint256)")`, so a signature change
// cannot silently drift.
const ANCHORS_UINT256_SELECTOR = "0x368b733e";

export function base58Decode(value: string): Uint8Array | null {
  if (value.length === 0) return null;

  const bytes: number[] = [0];

  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit === -1) return null;

    let carry = digit;

    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index]! * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (let index = 0; index < bytes.length && bytes[index] === 0; index += 1) {
    bytes.shift();
  }

  return Uint8Array.from(bytes.reverse());
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function containsHex(text: string, hex: string): boolean {
  return text.toLowerCase().includes(hex.toLowerCase());
}

/**
 * The relay returns either `<reference>:<index>` or a bare numeric index.
 * Without an id there is no `anchors(uint256)` key to read, so refuse to guess
 * index 0.
 */
function anchorIndex(reference: string): number | null {
  const separator = reference.lastIndexOf(":");
  const candidate = separator === -1 ? reference : reference.slice(separator + 1);
  if (!/^\d+$/.test(candidate)) return null;

  const index = Number(candidate);
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

/**
 * A chain adapter for chains where a relay submits the transaction.
 *
 * The interesting part is not the submission, it is the read-back: after
 * anchoring, the adapter asks the chain itself whether the root is there. An
 * operator who lies about anchoring cannot get a confirmed receipt, because
 * the confirmation comes from the chain, not from the relay.
 */
export class RelayChainAdapter implements RarextAdapter {
  private readonly config: ChainConfig;
  private readonly requestFetch: typeof fetch;

  constructor(config: ChainConfig, requestFetch: typeof fetch = fetch) {
    this.config = config;
    this.requestFetch = requestFetch;
  }

  info(): AdapterInfo {
    const configured = Boolean(this.config.rpc);

    return {
      id: this.config.id,
      name: this.config.name,
      kind: "network",
      capabilities: ["anchor"],
      configured,
      status: configured ? "ready" : "unconfigured",
      description: `Anchor commitments to ${this.config.name} (${this.config.family}).`,
      url: this.config.rpc ?? null,
    };
  }

  async status(): Promise<AdapterStatus> {
    const details: Record<string, unknown> = {
      family: this.config.family,
      chainId: this.config.chainId ?? null,
    };

    if (!this.config.rpc) {
      return statusFor(this.info(), details);
    }

    try {
      details.head = await this.readHead();
      details.reachable = true;
    } catch (error) {
      details.reachable = false;
      details.error = error instanceof Error ? error.message : String(error);
    }

    return statusFor(this.info(), details);
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await this.requestFetch(this.config.rpc!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      throw new Error(`${this.config.id} returned ${response.status}`);
    }

    const payload = (await response.json()) as {
      result?: unknown;
      error?: { message?: string };
    };

    if (payload.error) {
      throw new Error(payload.error.message ?? "chain error");
    }

    return payload.result;
  }

  private async readHead(): Promise<string | number | null> {
    switch (this.config.family) {
      case "evm": {
        const block = (await this.rpc("eth_blockNumber", [])) as string;
        return block ? Number.parseInt(block, 16) : null;
      }
      case "cosmos": {
        const height = (await this.rpc("status", [])) as {
          sync_info?: { latest_block_height?: string };
        };
        return height?.sync_info?.latest_block_height ?? null;
      }
      case "solana": {
        const slot = (await this.rpc("getSlot", [])) as number;
        return slot ?? null;
      }
      default:
        return null;
    }
  }

  /**
   * Ask the chain whether this root is really there.
   *
   * Each family carries the commitment differently, and each is read back the
   * way that chain's readers would read it.
   */
  private async confirm(root: string, reference: string | null): Promise<{
    confirmed: boolean;
    height: number | null;
    hash: string | null;
  }> {
    if (!reference) return { confirmed: false, height: null, hash: null };

    switch (this.config.family) {
      case "evm": {
        if (!this.config.address) {
          return { confirmed: false, height: null, hash: null };
        }

        const index = anchorIndex(reference);
        if (index === null) {
          return { confirmed: false, height: null, hash: reference };
        }

        // The contract writes through `publish(bytes32,bytes)` (or the
        // compatibility `anchor(bytes32,bytes32[])` wrapper) and exposes the
        // stored record through the `anchors(uint256)` view.
        const data = `${ANCHORS_UINT256_SELECTOR}${index.toString(16).padStart(64, "0")}`;

        const response = await this.requestFetch(this.config.rpc!, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [{ to: this.config.address, data }, "latest"],
          }),
          signal: AbortSignal.timeout(8_000),
        });

        const payload = (await response.json()) as { result?: string };

        if (!payload.result || payload.result === "0x") {
          return { confirmed: false, height: null, hash: null };
        }

        const decoded = Buffer.from(payload.result.slice(2), "hex").toString("hex");
        const confirmed = decoded.slice(0, 64) === root.toLowerCase();

        return { confirmed, height: null, hash: reference };
      }

      case "solana": {
        const transaction = (await this.rpc("getTransaction", [
          reference,
          { maxSupportedVersion: 0, encoding: "json" },
        ])) as {
          meta?: { logMessages?: string[] };
        };

        const logs = transaction?.meta?.logMessages ?? [];
        const decoded = logs
          .map((entry) => {
            const bytes = base58Decode(entry);
            return bytes ? toHex(bytes) : entry;
          })
          .join("");

        return {
          confirmed: containsHex(decoded, root),
          height: null,
          hash: reference,
        };
      }

      case "cosmos": {
        const tx = (await this.rpc("tx", [`0x${reference}`])) as {
          tx?: { body?: { messages?: { memo?: string }[] } };
        };

        const memo =
          tx?.tx?.body?.messages?.map((message) => message.memo ?? "").join(" ") ?? "";

        return { confirmed: containsHex(memo, root), height: null, hash: reference };
      }

      case "bitcoin": {
        const tx = (await this.requestFetch(
          `${this.config.rpc!.replace(/\/$/, "")}/tx/${reference}/raw`,
          { signal: AbortSignal.timeout(8_000) },
        ).then((response) => response.json())) as { hex?: string };

        return {
          confirmed: containsHex(tx?.hex ?? "", root),
          height: null,
          hash: reference,
        };
      }

      default:
        return { confirmed: false, height: null, hash: null };
    }
  }

  async anchor(root: string, publicationIds: string[]): Promise<ChainReceipt> {
    if (!this.config.rpc) {
      return {
        adapter: this.config.id,
        chain: this.config.id,
        family: this.config.family,
        status: "skipped",
        reference: null,
        height: null,
        hash: null,
        confirmed: false,
        error: `${this.config.name} is not configured`,
      };
    }

    let reference: string | null = null;

    try {
      const response = await this.requestFetch(this.config.rpc!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol: "rarext.anchor.v1",
          chain: this.config.id,
          root,
          publicationIds,
          address: this.config.address ?? null,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        throw new Error(`${this.config.id} relay returned ${response.status}`);
      }

      const payload = (await response.json()) as {
        reference?: string;
        hash?: string;
        index?: number;
        height?: number;
      };

      reference =
        payload.reference ??
        payload.hash ??
        (payload.index !== undefined ? String(payload.index) : null);
    } catch (error) {
      return {
        adapter: this.config.id,
        chain: this.config.id,
        family: this.config.family,
        status: "error",
        reference: null,
        height: null,
        hash: null,
        confirmed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      const confirmation = await this.confirm(root, reference);

      return {
        adapter: this.config.id,
        chain: this.config.id,
        family: this.config.family,
        status: confirmation.confirmed ? "ok" : "skipped",
        reference,
        height: confirmation.height,
        hash: confirmation.hash,
        confirmed: confirmation.confirmed,
        error: confirmation.confirmed
          ? undefined
          : "the relay accepted the anchor, but the chain did not confirm it",
      };
    } catch (error) {
      return {
        adapter: this.config.id,
        chain: this.config.id,
        family: this.config.family,
        status: "skipped",
        reference,
        height: null,
        hash: reference,
        confirmed: false,
        error: `the anchor was submitted but could not be read back: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
}
