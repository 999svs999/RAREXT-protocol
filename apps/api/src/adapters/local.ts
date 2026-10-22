import type {
  AdapterInfo,
  AdapterReceipt,
  AdapterStatus,
} from "../../../../packages/core/src/index.ts";

import { statusFor } from "./types.ts";
import type { RarextAdapter } from "./types.ts";

export class LocalAnchorAdapter implements RarextAdapter {
  info(): AdapterInfo {
    return {
      id: "local",
      name: "RAREXT local",
      kind: "network",
      capabilities: ["anchor"],
      configured: true,
      status: "ready",
      description: "Durable local Merkle anchors in the RAREXT store.",
      url: null,
    };
  }

  async status(): Promise<AdapterStatus> {
    return statusFor(this.info(), { transport: "file" });
  }

  async anchor(root: string): Promise<AdapterReceipt> {
    return {
      adapter: "local",
      status: "ok",
      reference: `local:${root.slice(0, 16)}`,
    };
  }
}
