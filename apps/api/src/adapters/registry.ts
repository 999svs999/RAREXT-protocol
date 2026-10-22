import type {
  AdapterInfo,
  AdapterReceipt,
  AdapterStatus,
  SourceQuery,
  SourceResolution,
} from "../../../../packages/core/src/index.ts";

import { GitHubSourceAdapter } from "./github.ts";
import { LocalAnchorAdapter } from "./local.ts";
import { TapeOutAdapter } from "./tapeout.ts";
import { TracAnchorAdapter } from "./trac.ts";
import type { RarextAdapter, IdentityLinkProof } from "./types.ts";

export class AdapterRegistry {
  private readonly adapters: RarextAdapter[];

  constructor(adapters: RarextAdapter[]) {
    this.adapters = adapters;
  }

  list(): AdapterInfo[] {
    return this.adapters.map((adapter) => adapter.info());
  }

  get(id: string): RarextAdapter | null {
    return this.adapters.find((adapter) => adapter.info().id === id) ?? null;
  }

  async status(id: string): Promise<AdapterStatus | null> {
    const adapter = this.get(id);
    return adapter ? adapter.status() : null;
  }

  async anchor(root: string, publicationIds: string[]): Promise<AdapterReceipt[]> {
    const receipts: AdapterReceipt[] = [];

    for (const adapter of this.adapters) {
      if (!adapter.anchor) continue;

      const info = adapter.info();

      if (!info.configured) {
        receipts.push({
          adapter: info.id,
          status: "skipped",
          reference: null,
          error: `${info.name} is not configured`,
        });
        continue;
      }

      try {
        receipts.push(await adapter.anchor(root, publicationIds));
      } catch (error) {
        receipts.push({
          adapter: info.id,
          status: "error",
          reference: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return receipts;
  }

  async resolveSource(kind: string, query: SourceQuery): Promise<SourceResolution> {
    const adapter = this.get(kind);

    if (!adapter?.resolveSource) {
      throw new Error(`unsupported source adapter: ${kind}`);
    }

    return adapter.resolveSource(query);
  }

  async verifyIdentityLink(
    network: string,
    proof: IdentityLinkProof,
  ): Promise<void> {
    const adapter = this.get(network);

    if (!adapter?.verifyIdentityLink) {
      throw new Error(`identity links are not supported for ${network}`);
    }

    await adapter.verifyIdentityLink(proof);
  }
}

export function createDefaultRegistry(requestFetch: typeof fetch = fetch): AdapterRegistry {
  return new AdapterRegistry([
    new LocalAnchorAdapter(),
    new TracAnchorAdapter(),
    new TapeOutAdapter(),
    new GitHubSourceAdapter(requestFetch),
  ]);
}
