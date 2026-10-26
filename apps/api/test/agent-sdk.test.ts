import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Circuit } from "../../../packages/core/src/index.ts";
import { canonicalize } from "../../../packages/core/src/canonical.ts";
import {
  AgentSigner,
  createAgentKeyfile,
  RarextClient,
  readAgentKeyfile,
  writeAgentKeyfile,
} from "../../../packages/agent-sdk/src/index.ts";
import { start, stop } from "./helpers.ts";

const halfAdder: Circuit = {
  components: [
    { id: "a", type: "INPUT" },
    { id: "b", type: "INPUT" },
    { id: "n1", type: "NAND", inputs: ["a", "b"] },
    { id: "n2", type: "NAND", inputs: ["a", "n1"] },
    { id: "n3", type: "NAND", inputs: ["b", "n1"] },
    { id: "xor", type: "NAND", inputs: ["n2", "n3"] },
    { id: "n5", type: "NAND", inputs: ["n1", "n1"] },
    { id: "sum", type: "OUTPUT", inputs: ["xor"] },
    { id: "carry", type: "OUTPUT", inputs: ["n5"] },
  ],
};

test("agent SDK registers and publishes a verifiable build", async () => {
  const { server, base } = await start();

  try {
    const keyfile = createAgentKeyfile("agent-one");
    const signer = new AgentSigner(keyfile.privateKey);
    const client = new RarextClient({ baseUrl: base });

    const identity = await client.registerAgent(signer, "agent-one");
    assert.equal(identity.keyId, signer.keyId);

    const publication = await client.publishAs(signer, {
      author: "agent-one",
      title: "Agent-built half adder",
      body: "Signed by the local agent key.",
      taskId: "half-adder",
      circuit: halfAdder,
    });

    assert.equal(publication.author, "agent-one");
    assert.equal(publication.authorKey, signer.keyId);
    assert.equal(publication.verified, true);

    const check = await client.verify(publication.id);
    assert.equal(check.valid, true);

    const found = await client.searchBuilds({
      taskId: "half-adder",
      author: "agent-one",
      minScore: 900,
      sort: "score",
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, publication.id);
    assert.equal(found[0].reuses, 0);

    const lineage = await client.buildLineage(publication.id);
    assert.equal(lineage.build.id, publication.id);
    assert.deepEqual(lineage.ancestors, []);
    assert.deepEqual(lineage.descendants, []);

    const profile = await client.profile("agent-one");
    assert.equal(profile.verified, true);
    assert.equal(profile.publications, 1);
  } finally {
    await stop(server);
  }
});

// The keyfile and signing boundary an external agent touches directly. The
// round's mechanisms: an honest round trip, the file mode the README promises,
// a second write that refuses to clobber a key, every malformed shape the
// reader must name, the public/private pairing, and a signature that verifies
// over its own bytes and fails over anything else.
test("the agent SDK's keyfile and signing boundary", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rarext-sdk-keys-"));
  const keyPath = join(dir, "agent-key.json");
  const created = createAgentKeyfile("boundary-agent");
  const signer = new AgentSigner(created.privateKey);

  try {
    await t.test("an honest keyfile round-trips with the promised modes", async () => {
      await writeAgentKeyfile(created, keyPath);
      const read = await readAgentKeyfile(keyPath);

      assert.equal(read.handle, "boundary-agent");
      assert.equal(read.keyId, signer.keyId);
      assert.deepEqual(read.publicKey, signer.publicKey);
      assert.equal(read.kind, "rarext.agent-key");
      assert.equal(read.version, 1);

      // The README's security claim: 0600 on the file, 0700 on its directory.
      if (process.platform !== "win32") {
        assert.equal(statSync(keyPath).mode & 0o777, 0o600, "the keyfile is 0600");
        assert.equal(statSync(dir).mode & 0o777, 0o700, "the key directory is 0700");
      }
    });

    await t.test("a second write refuses to clobber an existing key", async () => {
      const before = readFileSync(keyPath, "utf8");
      const other = createAgentKeyfile("other-agent");

      await assert.rejects(
        () => writeAgentKeyfile(other, keyPath),
        (error: NodeJS.ErrnoException) => error.code === "EEXIST",
        "writing over an existing keyfile must refuse, not replace the identity",
      );

      assert.equal(readFileSync(keyPath, "utf8"), before, "the original keyfile is untouched");
      // The original still parses to the original identity.
      assert.equal((await readAgentKeyfile(keyPath)).keyId, signer.keyId);
    });

    await t.test("every malformed keyfile shape is named in the refusal", async () => {
      const shapes: Array<[string, string, RegExp]> = [
        ["not json", "{nope", /JSON/i],
        ["an array", "[]", /JSON object/],
        ["a foreign kind", JSON.stringify({ ...created, kind: "rarext.something-else" }), /unsupported/i],
        ["a future version", JSON.stringify({ ...created, version: 2 }), /unsupported/i],
        ["a bad handle", JSON.stringify({ ...created, handle: "Not A Handle" }), /handle/i],
        ["no private key", JSON.stringify({ ...created, privateKey: undefined }), /private key/i],
        ["a mismatched keyId", JSON.stringify({ ...created, keyId: "0".repeat(64) }), /keyId/i],
      ];

      for (const [label, body, expected] of shapes) {
        const path = join(dir, "malformed.json");
        writeFileSync(path, body, "utf8");
        await assert.rejects(
          () => readAgentKeyfile(path),
          expected,
          `a keyfile with ${label} must be refused with a message naming the problem`,
        );
      }

      // The pairing itself: another agent's public key beside this private key
      // must be refused, so the file can never advertise one identity and sign
      // as another.
      const foreign = createAgentKeyfile("foreign-agent");
      const crossedPath = join(dir, "crossed.json");
      writeFileSync(
        crossedPath,
        JSON.stringify({ ...created, publicKey: foreign.publicKey }),
        "utf8",
      );
      await assert.rejects(
        () => readAgentKeyfile(crossedPath),
        /public key does not match/i,
        "a public key that does not pair with the private key must be refused",
      );
    });

    await t.test("a signature verifies over its own bytes and fails over anything else", () => {
      const payload = { kind: "rarext.publication", version: 1, title: "signed", body: "bytes" };
      const signature = Buffer.from(signer.sign(payload), "base64");
      // The SDK's JsonWebKey type is structurally narrower than node's (no
      // index signature), so the import needs an explicit widening cast; the
      // runtime shape is a real JWK in both worlds.
      const publicKey = createPublicKey({
        key: signer.publicKey,
        format: "jwk",
      } as Parameters<typeof createPublicKey>[0]);
      const message = Buffer.from(canonicalize(payload));

      // Positive control: the honest signature verifies.
      assert.equal(
        cryptoVerify("sha256", message, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature),
        true,
        "the honest signature verifies against the keyfile's public key",
      );

      // Negative control: one changed byte of the payload fails.
      const tampered = Buffer.from(canonicalize({ ...payload, body: "byt3s" }));
      assert.equal(
        cryptoVerify("sha256", tampered, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature),
        false,
        "a modified payload must not verify",
      );

      // ...and so does a flipped signature bit.
      const flipped = Buffer.from(signature);
      flipped[0] ^= 0x01;
      assert.equal(
        cryptoVerify("sha256", message, { key: publicKey, dsaEncoding: "ieee-p1363" }, flipped),
        false,
        "a modified signature must not verify",
      );
    });

    await t.test("a handle outside the documented shape is refused at creation", () => {
      for (const handle of ["Uppercase", "has space", "", "-leading-dash", "a".repeat(33)]) {
        assert.throws(
          () => createAgentKeyfile(handle),
          /handle must match/,
          `handle ${JSON.stringify(handle)} must be refused`,
        );
      }
      // ...and a boundary-length honest handle is accepted.
      const long = createAgentKeyfile("a".repeat(32));
      assert.equal(long.handle.length, 32);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
