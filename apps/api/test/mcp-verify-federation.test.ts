import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import {
  federationCommitmentArtifact,
  parseRegistrySeedList,
  registryListDigest,
  type RegistrySeedEntry,
} from "../../../packages/core/src/index.ts";
import { verifyRegistryFederation } from "../../mcp/src/verify-federation.ts";

/**
 * `rarext_verify_federation` from the outside: a registry port literal plus a local HTTP
 * server standing in for the committed seed list, because the verb's claim is that the VERDICT
 * is computed here from the list as it is FETCHED — a fixture that answered without a fetch
 * would not be testing the thing the verb promises.
 */
const sha256Bytes = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

const entries: RegistrySeedEntry[] = [
  {
    id: "rarext",
    url: "https://999svs999.github.io/RAREXT-protocol",
    operator: "rarext",
    chains: ["rarex"],
    note: "The project's own reference deployment.",
    seed: null,
  },
];

function digestOf(list: RegistrySeedEntry[]): string {
  return registryListDigest(list, sha256Bytes);
}

async function listServer(body: string) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/registry/seed.json` };
}

function registryOver(url: string, list: RegistrySeedEntry[]) {
  const commitment = federationCommitmentArtifact({ listUrl: url, digest: digestOf(list), generatedAt: "2026-10-31T00:00:00.000Z" });
  return {
    bundle: async () =>
      ({
        publications: [{ artifact: commitment }],
        anchors: [],
        challenges: [],
      }) as never,
  };
}

test("the published list that matches the commitment reports matches, with the registries as data", async () => {
  const { server, url } = await listServer(JSON.stringify({ registries: entries }));
  try {
    const report = await verifyRegistryFederation(registryOver(url, entries));
    assert.ok(report);
    assert.equal(report!.matches, true);
    assert.equal(report!.listDigest, report!.committedDigest);
    assert.deepEqual(
      report!.registries,
      [{ id: "rarext", operator: "rarext", url: "https://999svs999.github.io/RAREXT-protocol" }],
    );
    assert.match(report!.limit, /does not vouch for any registry/);
  } finally {
    server.close();
  }
});

test("a list that grew an entry after the commitment is reported as NOT matching", async () => {
  const grown: RegistrySeedEntry[] = [
    ...entries,
    { id: "someone-else", url: "https://registry.someone-else.com", operator: "someone-else", chains: ["rarex"], note: null, seed: null },
  ];
  const { server, url } = await listServer(JSON.stringify({ registries: grown }));
  try {
    // The BUNDLE still commits to the original list; the list being served has an extra
    // registry in it. That is the attack the digest exists to catch, and the verdict must
    // be false here rather than a pass that read the bundle's word.
    const report = await verifyRegistryFederation(registryOver(url, entries));
    assert.equal(report!.matches, false);
    assert.notEqual(report!.listDigest, report!.committedDigest);
    assert.equal(report!.registries.length, 2, "the list as FETCHED is reported, not the committed one");
  } finally {
    server.close();
  }
});

test("a bundle that records no federation commitment answers null — never a failed claim", async () => {
  assert.equal(
    await verifyRegistryFederation({
      bundle: async () => ({ publications: [], anchors: [], challenges: [] }) as never,
    }),
    null,
  );
});

test("the list digest is core's rule, spelled the way the publisher spells it", async () => {
  const { server, url } = await listServer(JSON.stringify({ registries: entries }));
  try {
    const report = await verifyRegistryFederation(registryOver(url, entries));
    const parsed = parseRegistrySeedList(entries) as never;
    assert.equal(report!.listDigest, digestOf(parsed as never));
  } finally {
    server.close();
  }
});
