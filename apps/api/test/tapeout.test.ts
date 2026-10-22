import test from "node:test";
import assert from "node:assert/strict";

import { tapeOutStatus } from "../src/tapeout.ts";

test("TapeOut status is explicitly unconfigured without env", async () => {
  const saved = {
    BSC_RPC_URL: process.env.BSC_RPC_URL,
    TAPEOUT_RPC_URL: process.env.TAPEOUT_RPC_URL,
    BEM_CONTRACT: process.env.BEM_CONTRACT,
  };

  delete process.env.BSC_RPC_URL;
  delete process.env.TAPEOUT_RPC_URL;
  delete process.env.BEM_CONTRACT;

  try {
    const status = await tapeOutStatus();
    assert.equal(status.configured, false);
    assert.equal(status.chainId, null);
    assert.equal(status.bemBalance, null);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
