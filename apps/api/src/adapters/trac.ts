import type {
  AdapterInfo,
  AdapterReceipt,
  AdapterStatus,
} from "../../../../packages/core/src/index.ts";

import { statusFor } from "./types.ts";
import type { RarextAdapter } from "./types.ts";

function endpoint(): string | null {
  return process.env.TRAC_ANCHOR_URL ?? null;
}

export class TracAnchorAdapter implements RarextAdapter {
  info(): AdapterInfo {
    const url = endpoint();

    return {
      id: "trac",
      name: "Trac Network",
      kind: "network",
      capabilities: ["anchor", "identity"],
      configured: Boolean(url),
      status: url ? "ready" : "unconfigured",
      description:
        "Agent-first coordination and portable anchor announcements. Native identity is adapter-ready.",
      url,
    };
  }

  async status(): Promise<AdapterStatus> {
    return statusFor(this.info(), {
      transport: endpoint() ? "webhook" : null,
      nativeIdentity: false,
    });
  }

  async anchor(root: string, publicationIds: string[]): Promise<AdapterReceipt> {
    const url = endpoint();

    if (!url) {
      return {
        adapter: "trac",
        status: "skipped",
        reference: null,
        error: "TRAC_ANCHOR_URL is not configured",
      };
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol: "rarext.anchor.v1",
          root,
          publicationIds,
        }),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return {
          adapter: "trac",
          status: "error",
          reference: null,
          error: `Trac returned ${response.status}`,
        };
      }

      const reference = (await response.text()).slice(0, 500);

      return {
        adapter: "trac",
        status: "ok",
        reference: reference || `trac:${response.status}`,
      };
    } catch (error) {
      return {
        adapter: "trac",
        status: "error",
        reference: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
