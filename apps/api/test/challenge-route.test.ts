import test from "node:test";
import assert from "node:assert/strict";

import type { Challenge } from "../../../packages/core/src/index.ts";
import { RarextStore } from "../src/store.ts";
import { post, start, stop } from "./helpers.ts";

/**
 * The challenge LOOKUP boundary — the third input path on this surface, after registration
 * (`asChallenge`) and configuration (`RAREXT_CHALLENGES`).
 *
 * A challenge id is a path segment in `GET /v1/challenges/:id`, so it arrives
 * percent-encoded. Every other route in this app decodes its path segment; this one did
 * not, which made an id containing a space or a non-ASCII character registrable and then
 * permanently unreachable — published, and unfetchable by the URL that names it.
 */

const challenge = (id: string): Challenge => ({
  id,
  app: "logic",
  title: `Challenge ${id}`,
  description: "A challenge used to probe the lookup boundary.",
  version: 1,
  spec: undefined,
  sampleArtifact: undefined,
  semanticsId: `logic/${id}`,
  semanticsVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "seed",
  sponsor: null,
});

const IDS = ["plain-id", "my challenge", "café/ünïcode"];

const registry = {
  list: () => IDS.map(challenge),
  get: (id: string) => {
    const found = IDS.find((candidate) => candidate === id);
    return found ? challenge(found) : null;
  },
};

test("an id with a space is fetchable at the URL that names it", async () => {
  const { server, base } = await start(new RarextStore(), { challenges: registry });
  try {
    const response = await fetch(`${base}/v1/challenges/${encodeURIComponent("my challenge")}`);
    assert.equal(response.status, 200, "a percent-encoded id must resolve to its challenge");
    const body = (await response.json()) as { id?: string };
    assert.equal(body.id, "my challenge", "and the id must come back as written");
  } finally {
    await stop(server);
  }
});

test("an id with non-ASCII characters is fetchable too", async () => {
  const { server, base } = await start(new RarextStore(), { challenges: registry });
  try {
    const response = await fetch(`${base}/v1/challenges/${encodeURIComponent("café/ünïcode")}`);
    assert.equal(response.status, 200, "a non-ASCII id must resolve");
    const body = (await response.json()) as { id?: string };
    assert.equal(body.id, "café/ünïcode", "and the id must round-trip exactly");
  } finally {
    await stop(server);
  }
});

test("a malformed escape is refused by name, not answered as a miss or a crash", async () => {
  const { server, base } = await start(new RarextStore(), { challenges: registry });
  try {
    // Genuinely malformed: bad hex, a truncated escape, an incomplete multi-byte sequence,
    // and a lone continuation byte. (`%e0%a4%a5` is NOT one of these — it is a valid escape
    // for U+0925, and answering 404 for it is correct.)
    for (const bad of ["%zz", "%", "%e0%a4", "%80"]) {
      const response = await fetch(`${base}/v1/challenges/${bad}`);
      assert.equal(response.status, 400, `${bad} must be a client error`);
      const body = (await response.json()) as { error?: string };
      // The refusal names the segment and says what is wrong with it. Asserting the actual
    // wording rather than a looser pattern keeps a vaguer message from passing.
    assert.match(String(body.error), /percent-encoding/i, `${bad} must be refused by name`);
    assert.ok(String(body.error).includes(bad.replace(/[.*+?^${}()|[\]\\]/g, "")), `${bad} must appear in the refusal`);
    }
  } finally {
    await stop(server);
  }
});

test("the plain path is unchanged, and an empty id is still a miss", async () => {
  const { server, base } = await start(new RarextStore(), { challenges: registry });
  try {
    const ok = await fetch(`${base}/v1/challenges/plain-id`);
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { id?: string }).id, "plain-id");

    const miss = await fetch(`${base}/v1/challenges/`);
    assert.equal(miss.status, 404, "no id at all is a miss, not a listing");

    const unknown = await fetch(`${base}/v1/challenges/nobody`);
    assert.equal(unknown.status, 404);
  } finally {
    await stop(server);
  }
});

test("the sibling segment routes share the same rule: a malformed escape is 400, not a crash", async () => {
  // The same defect existed in five other routes, each decoding a path segment unguarded —
  // where a malformed escape from a client became a server error. One helper, one rule.
  const { server, base } = await start(new RarextStore());
  try {
    for (const path of ["/v1/identities/%zz/delegations", "/v1/identities/%zz/rotations"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 400, `${path} must be a client error`);
      assert.match(String(((await response.json()) as { error?: string }).error), /percent-encoding/i);
    }
    const rotated = await post(base, "/v1/identities/%zz/rotate", {});
    assert.equal(rotated.status, 400, "a POST route refuses the same way");
  } finally {
    await stop(server);
  }
});
