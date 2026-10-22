import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalize } from "@rarext/core";
import type { Circuit } from "@rarext/core";
import {
  AgentSigner,
  createAgentKeyfile,
  generateAgentKeypair,
  parseAgentKeyfile,
  publicKeyId,
  readAgentKeyfile,
  removeAgentKeyfile,
  writeAgentKeyfile,
} from "../src/index.ts";

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

test("agent signer produces a verifiable P-256 signature", () => {
  const keypair = generateAgentKeypair();
  const signer = new AgentSigner(keypair.privateKey);

  assert.equal(signer.keyId, publicKeyId(keypair.publicKey));

  const payload = signer.publicationPayload({
    author: "agent-one",
    title: "Signed agent build",
    taskId: "half-adder",
    circuit: halfAdder,
    createdAt: "2026-10-21T12:00:00.000Z",
    nonce: "0123456789abcdef",
  });
  const signature = signer.sign(payload);

  assert.equal(payload.authorKey, signer.keyId);
  assert.equal(
    verify(
      "sha256",
      Buffer.from(canonicalize(payload)),
      {
        key: createPublicKey({
          key: keypair.publicKey as unknown as import("node:crypto").JsonWebKey,
          format: "jwk",
        }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(signature, "base64"),
    ),
    true,
  );
});

test("agent keyfile round-trips with restrictive permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rarext-agent-"));
  const path = join(directory, "agent-key.json");

  try {
    const file = createAgentKeyfile("agent-one");

    await writeAgentKeyfile(file, path);

    const loaded = await readAgentKeyfile(path);
    assert.equal(loaded.handle, "agent-one");
    assert.equal(loaded.keyId, file.keyId);
    assert.equal(loaded.publicKey.x, file.publicKey.x);
    assert.match(await readFile(path, "utf8"), /"privateKey"/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(writeAgentKeyfile(file, path), /EEXIST/);

    await removeAgentKeyfile(path);
    await assert.rejects(readAgentKeyfile(path), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent keyfile rejects mismatched key material", () => {
  const file = createAgentKeyfile("agent-one");
  const other = createAgentKeyfile("agent-two");

  assert.throws(
    () => parseAgentKeyfile({ ...file, keyId: other.keyId }),
    /keyId does not match/,
  );
  assert.throws(
    () => parseAgentKeyfile({ ...file, publicKey: other.publicKey }),
    /public key does not match/,
  );
});
