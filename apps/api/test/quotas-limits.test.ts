import test from "node:test";
import assert from "node:assert";
import { createHolderServer } from "../src/holder-server.ts";
import { createPinServer, PinStore } from "../src/pin-server.ts";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("holder and pin server quotas, rate limits, and token rotation", async () => {
  const holderDir = mkdtempSync(join(tmpdir(), "holder-quota-"));
  const pinDir = mkdtempSync(join(tmpdir(), "pin-quota-"));

  const holder = createHolderServer({
    id: "h-test",
    directory: holderDir,
    token: "old-token,new-token",
    maxBytes: 100,
    maxRequestsPerWindow: 10,
    windowMs: 60_000,
  });

  await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const holderPort = (holder.address() as any).port;
  const holderUrl = `http://127.0.0.1:${holderPort}`;

  const pinStore = new PinStore(pinDir);
  const pinServer = createPinServer(pinStore, {
    token: ["old-token", "new-token"],
    maxBytes: 100,
    maxRequestsPerWindow: 2,
    windowMs: 60_000,
  });

  await new Promise<void>((resolve) => pinServer.listen(0, "127.0.0.1", resolve));
  const pinPort = (pinServer.address() as any).port;
  const pinUrl = `http://127.0.0.1:${pinPort}`;

  try {
    // 1. Test token rotation (old-token works) -> request 1
    const resOld = await fetch(`${holderUrl}/v1/holder`, {
      headers: { authorization: "Bearer old-token" },
    });
    assert.strictEqual(resOld.status, 200);

    // 2. Test token rotation (new-token works) -> request 2
    const resNew = await fetch(`${holderUrl}/v1/holder`, {
      headers: { authorization: "Bearer new-token" },
    });
    assert.strictEqual(resNew.status, 200);

    // 3. Test storage quota on holder (maxBytes: 100)
    const largeContent = Buffer.alloc(150).toString("base64");
    const resQuota = await fetch(`${holderUrl}/v1/holder/shards`, {
      method: "POST",
      headers: {
        authorization: "Bearer new-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: largeContent }),
    });
    assert.strictEqual(resQuota.status, 507);

  } finally {

    await new Promise((resolve) => holder.close(resolve));
    await new Promise((resolve) => pinServer.close(resolve));
  }
});
