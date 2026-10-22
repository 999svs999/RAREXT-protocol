import { existsSync, readFileSync } from "node:fs";

import type {
  AdapterInfo,
  AdapterStatus,
} from "../../../../packages/core/src/index.ts";

import { RelayChainAdapter, type ChainConfig, type ChainFamily } from "./relay.ts";
import { RarextChainAdapter } from "./rarext.ts";

const FAMILIES: ChainFamily[] = [
  "evm",
  "solana",
  "bitcoin",
  "cosmos",
  "rarext",
  "trac",
];

function asChainConfig(value: unknown): ChainConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Partial<ChainConfig>;

  if (typeof record.id !== "string" || record.id.length === 0) return null;
  if (!FAMILIES.includes(record.family as ChainFamily)) return null;

  return {
    id: record.id,
    name: typeof record.name === "string" ? record.name : record.id,
    family: record.family as ChainFamily,
    rpc: typeof record.rpc === "string" ? record.rpc : undefined,
    address: typeof record.address === "string" ? record.address : undefined,
    chainId: record.chainId,
    signer: typeof record.signer === "string" ? record.signer : undefined,
    enabled: record.enabled !== false,
  };
}

/**
 * The chain registry.
 *
 * Chains are configuration, not code: an operator lists the chains they want to
 * anchor to, and the registry builds the adapters. That is what makes "all the
 * chains" a configuration change rather than a rewrite, and it is why a chain
 * nobody has written yet can be added by an operator with a relay and a read
 * path.
 *
 * The RAREXT chain is always present as a family; it is the one the protocol
 * ships with.
 */
export class ChainRegistry {
  private readonly configs: ChainConfig[];
  private readonly requestFetch: typeof fetch;

  constructor(configs: ChainConfig[], requestFetch: typeof fetch = fetch) {
    this.configs = configs;
    this.requestFetch = requestFetch;
  }

  list(): ChainConfig[] {
    return [...this.configs];
  }

  get(id: string): ChainConfig | null {
    return this.configs.find((config) => config.id === id) ?? null;
  }

  info(): AdapterInfo[] {
    return this.configs.map((config) => ({
      id: config.id,
      name: config.name,
      kind: "network" as const,
      capabilities: ["anchor" as const],
      configured: Boolean(config.rpc),
      status: config.rpc ? ("ready" as const) : ("unconfigured" as const),
      description: `Anchor commitments to ${config.name} (${config.family}).`,
      url: config.rpc ?? null,
    }));
  }

  async status(): Promise<AdapterStatus[]> {
    const statuses: AdapterStatus[] = [];

    for (const config of this.configs) {
      const adapter =
        config.family === "rarext"
          ? new RarextChainAdapter(config, this.requestFetch, config.signer ?? null)
          : new RelayChainAdapter(config, this.requestFetch);

      statuses.push(await adapter.status());
    }

    return statuses;
  }

  adapters() {
    return this.configs.map((config) =>
      config.family === "rarext"
        ? new RarextChainAdapter(config, this.requestFetch, config.signer ?? null)
        : new RelayChainAdapter(config, this.requestFetch),
    );
  }
}

export function loadChainConfigs(): ChainConfig[] {
  const source = process.env.RAREXT_CHAINS?.trim();
  if (!source) return [];

  let text = source;

  if (!source.startsWith("[") && !source.startsWith("{")) {
    if (!existsSync(source)) {
      throw new Error(`RAREXT_CHAINS file not found: ${source}`);
    }
    text = readFileSync(source, "utf8");
  }

  const parsed = JSON.parse(text) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && "chains" in parsed
      ? (parsed as { chains: unknown }).chains
      : null;

  if (!Array.isArray(list)) {
    throw new Error("RAREXT_CHAINS must be an array or { chains: [] }");
  }

  return list
    .map(asChainConfig)
    .filter((config): config is ChainConfig => config !== null)
    .filter((config) => config.enabled !== false);
}
