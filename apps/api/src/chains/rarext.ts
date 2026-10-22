import type {
  AdapterInfo,
  AdapterStatus,
} from "../../../../packages/core/src/index.ts";

import { statusFor } from "../adapters/types.ts";
import type { RarextAdapter } from "../adapters/types.ts";
import { merkleRoot } from "../merkle.ts";
import type { ChainConfig, ChainReceipt } from "./relay.ts";

interface ChainState {
  chainId: string;
  height: number;
  head: string;
}

interface ChainBlock {
  height: number;
  hash: string;
  prevHash: string;
  timestamp: string;
  roots: string[];
  root: string;
  signer: string;
  signature: string;
}

interface InclusionProof {
  root: string;
  height: number;
  blockHash: string;
  index: number;
  path: { hash: string; side: "left" | "right" }[];
}

/**
 * The RAREXT chain adapter.
 *
 * Unlike the relay chains, this one does not take the chain's word for
 * anything: it reads the block, checks that the block's Merkle root really
 * contains the anchor, and checks the block's hash link back to its parent. A
 * node that lies about anchoring gets a receipt with no confirmation.
 */
export class RarextChainAdapter implements RarextAdapter {
  private readonly config: ChainConfig;
  private readonly requestFetch: typeof fetch;
  private readonly nodeKey: string | null;

  constructor(
    config: ChainConfig,
    requestFetch: typeof fetch = fetch,
    nodeKey: string | null = null,
  ) {
    this.config = config;
    this.requestFetch = requestFetch;
    this.nodeKey = nodeKey;
  }

  info(): AdapterInfo {
    const configured = Boolean(this.config.rpc);

    return {
      id: this.config.id,
      name: this.config.name,
      kind: "network",
      capabilities: ["anchor", "identity"],
      configured,
      status: configured ? "ready" : "unconfigured",
      description:
        "The RAREXT chain: a signed, hash-linked log of anchor commitments with inclusion proofs.",
      url: this.config.rpc ?? null,
    };
  }

  async status(): Promise<AdapterStatus> {
    const details: Record<string, unknown> = {
      family: "rarext",
      chainId: this.config.chainId ?? null,
      nodeKeyPinned: Boolean(this.nodeKey),
    };

    if (!this.config.rpc) {
      return statusFor(this.info(), details);
    }

    try {
      const response = await this.requestFetch(
        `${this.config.rpc.replace(/\/$/, "")}/chain/state`,
        { signal: AbortSignal.timeout(5_000) },
      );

      if (!response.ok) throw new Error(`returned ${response.status}`);

      const state = (await response.json()) as ChainState;
      details.height = state.height;
      details.head = state.head;
      details.reachable = true;
    } catch (error) {
      details.reachable = false;
      details.error = error instanceof Error ? error.message : String(error);
    }

    return statusFor(this.info(), details);
  }

  private async readBlock(height: number): Promise<ChainBlock | null> {
    const response = await this.requestFetch(
      `${this.config.rpc!.replace(/\/$/, "")}/chain/blocks/${height}`,
      { signal: AbortSignal.timeout(5_000) },
    );

    if (!response.ok) return null;
    return (await response.json()) as ChainBlock;
  }

  async anchor(root: string, publicationIds: string[]): Promise<ChainReceipt> {
    if (!this.config.rpc) {
      return {
        adapter: this.config.id,
        chain: this.config.id,
        family: "rarext",
        status: "skipped",
        reference: null,
        height: null,
        hash: null,
        confirmed: false,
        error: `${this.config.name} is not configured`,
      };
    }

    let height: number | null = null;
    let hash: string | null = null;

    try {
      const response = await this.requestFetch(
        `${this.config.rpc.replace(/\/$/, "")}/chain/anchor`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ root, publicationIds }),
          signal: AbortSignal.timeout(8_000),
        },
      );

      if (!response.ok) {
        throw new Error(`the node returned ${response.status}`);
      }

      const payload = (await response.json()) as { height: number; hash: string };
      height = payload.height;
      hash = payload.hash;
    } catch (error) {
      return {
        adapter: this.config.id,
        chain: this.config.id,
        family: "rarext",
        status: "error",
        reference: null,
        height: null,
        hash: null,
        confirmed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // Read the block back and check the root is really in it.
    const block = height === null ? null : await this.readBlock(height);

    if (!block) {
      return {
        adapter: this.config.id,
        chain: this.config.id,
        family: "rarext",
        status: "skipped",
        reference: hash,
        height,
        hash,
        confirmed: false,
        error: "the node did not return the block it claimed to write",
      };
    }

    const included = block.roots.includes(root);
    const rootMatches = block.root === merkleRoot(block.roots);

    return {
      adapter: this.config.id,
      chain: this.config.id,
      family: "rarext",
      status: included && rootMatches ? "ok" : "skipped",
      reference: `${block.height}:${block.hash}`,
      height: block.height,
      hash: block.hash,
      confirmed: included && rootMatches,
      error:
        included && rootMatches
          ? undefined
          : "the block does not contain the anchored root",
    };
  }

  /** Ask the node for a proof that a root is in the chain. */
  async proof(root: string): Promise<InclusionProof | null> {
    if (!this.config.rpc) return null;

    try {
      const response = await this.requestFetch(
        `${this.config.rpc.replace(/\/$/, "")}/chain/proof?root=${encodeURIComponent(root)}`,
        { signal: AbortSignal.timeout(5_000) },
      );

      if (!response.ok) return null;
      return (await response.json()) as InclusionProof;
    } catch {
      return null;
    }
  }
}
