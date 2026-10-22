import type {
  AdapterInfo,
  AdapterStatus,
} from "../../../../packages/core/src/index.ts";

import { tapeOutStatus } from "../tapeout.ts";
import { statusFor } from "./types.ts";
import type { RarextAdapter } from "./types.ts";

function configured(): boolean {
  return Boolean(
    (process.env.BSC_RPC_URL ?? process.env.TAPEOUT_RPC_URL) &&
      process.env.BEM_CONTRACT,
  );
}

export class TapeOutAdapter implements RarextAdapter {
  info(): AdapterInfo {
    return {
      id: "tapeout",
      name: "TapeOut",
      kind: "network",
      capabilities: ["assets", "read"],
      configured: configured(),
      status: configured() ? "ready" : "unconfigured",
      description:
        "Read-only hardware assets, circuit ownership, and $BEM on BNB Chain.",
      url: "https://tapeout.ai",
    };
  }

  async status(): Promise<AdapterStatus> {
    const current = await tapeOutStatus();

    return statusFor(
      {
        ...this.info(),
        status: current.error ? "error" : this.info().status,
      },
      {
        chainId: current.chainId,
        blockNumber: current.blockNumber,
        bemContract: current.bemContract,
        error: current.error ?? null,
      },
    );
  }
}
