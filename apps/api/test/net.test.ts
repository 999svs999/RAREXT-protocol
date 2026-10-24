import assert from "node:assert/strict";
import test from "node:test";

import { destructiveGcAllowed, isLoopbackAddress } from "../src/net.ts";

function request(address: string | undefined) {
  return { socket: { remoteAddress: address } };
}

test("loopback covers IPv4, IPv6, and IPv4-mapped IPv6", () => {
  for (const address of ["127.0.0.1", "127.5.6.7", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackAddress(address), true, address);
  }

  for (const address of [undefined, "", "10.0.0.1", "192.0.2.1", "::ffff:10.0.0.1", "not-an-ip"]) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }
});

test("destructive GC needs a token or a loopback connection", () => {
  assert.equal(destructiveGcAllowed(request("203.0.113.9"), 1), true);
  assert.equal(destructiveGcAllowed(request("203.0.113.9"), 0), false);
  assert.equal(destructiveGcAllowed(request(undefined), 0), false);
  assert.equal(destructiveGcAllowed(request("127.0.0.1"), 0), true);
});
