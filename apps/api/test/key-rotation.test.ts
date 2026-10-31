import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeCapability } from "../src/capabilities.ts";
import { RarextStore } from "../src/store.ts";
import type { Circuit, Publication } from "../../../packages/core/src/index.ts";
import {
  AgentSigner,
  RarextClient,
  generateAgentKeypair,
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

function logicArtifact() {
  return {
    app: "logic",
    kind: "logic.netlist",
    version: 1,
    mediaType: "application/json",
    body: halfAdder,
  } as const;
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rarext-keys-"));
  const file = join(dir, "store.json");
  const store = new RarextStore(file);
  const server = await start(store);
  const client = new RarextClient({ baseUrl: server.base });
  const root = new AgentSigner(generateAgentKeypair().privateKey);

  await client.registerAgent(root, "alice");

  return {
    dir,
    file,
    store,
    server,
    client,
    root,
    async close() {
      await stop(server.server);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a rotated key takes over while old publications stay readable", async () => {
  const context = await setup();

  try {
    const { client, root } = context;
    const next = new AgentSigner(generateAgentKeypair().privateKey);

    const before = await client.publishArtifactAs(root, {
      author: "alice",
      title: "Signed before rotation",
      challengeId: "half-adder",
      artifact: logicArtifact(),
    });
    assert.equal(before.authorKey, root.keyId);

    const rotated = await client.rotateIdentity(root, {
      handle: "alice",
      toPublicKey: next.publicKey,
    });

    assert.equal(rotated.rotation.fromKeyId, root.keyId);
    assert.equal(rotated.rotation.toKeyId, next.keyId);
    assert.equal(rotated.identity.keyId, next.keyId);
    assert.equal((await client.identity("alice"))?.keyId, next.keyId);

    await assert.rejects(
      client.publishArtifactAs(root, {
        author: "alice",
        title: "Stale signer",
        challengeId: "half-adder",
        artifact: logicArtifact(),
      }),
      /retired key/,
    );

    const after = await client.publishArtifactAs(next, {
      author: "alice",
      title: "Signed after rotation",
      challengeId: "half-adder",
      artifact: logicArtifact(),
    });

    assert.equal(after.authorKey, next.keyId);
    assert.equal(after.delegatedBy, null);

    const history = await client.rotations("alice");
    assert.equal(history.length, 1);
    assert.equal(history[0]!.fromKeyId, root.keyId);

    const old = await client.publication(before.id);
    assert.equal(old.authorKey, root.keyId);
    assert.equal(old.author, "alice");
  } finally {
    await context.close();
  }
});

test("rotations refuse bad signatures, replays, and keys already in use", async () => {
  const context = await setup();

  try {
    const { client, root } = context;
    const next = new AgentSigner(generateAgentKeypair().privateKey);
    const other = new AgentSigner(generateAgentKeypair().privateKey);

    await assert.rejects(
      client.rotateIdentity(next, { handle: "alice", toPublicKey: other.publicKey }),
      /different handle|does not start from the current key/,
    );

    await assert.rejects(
      client.rotateIdentity(root, { handle: "nobody", toPublicKey: next.publicKey }),
      /not found/,
    );

    await client.rotateIdentity(root, { handle: "alice", toPublicKey: next.publicKey });

    await assert.rejects(
      client.rotateIdentity(root, { handle: "alice", toPublicKey: other.publicKey }),
      /different handle|does not start from the current key/,
    );

    const third = new AgentSigner(generateAgentKeypair().privateKey);
    await assert.rejects(
      client.registerAgent(third, "alice"),
      /already registered/,
    );
    await assert.rejects(
      client.registerAgent(root, "bob"),
      /already in use/,
    );

    const replay = await client
      .rotateIdentity(next, { handle: "alice", toPublicKey: third.publicKey })
      .then(() => client.rotateIdentity(next, { handle: "alice", toPublicKey: other.publicKey }))
      .then(() => null)
      .catch((error: Error) => error);

    assert.ok(replay, "the old key cannot rotate twice");
    assert.match(replay.message, /retired key|does not start from the current key/);
  } finally {
    await context.close();
  }
});

test("a delegated key may publish but cannot rotate or manage keys", async () => {
  const context = await setup();

  try {
    const { client, root } = context;
    const delegate = new AgentSigner(generateAgentKeypair().privateKey);

    const delegation = await client.delegateKey(root, {
      handle: "alice",
      delegatePublicKey: delegate.publicKey as never,
      app: "logic",
    });

    assert.equal(delegation.rootKeyId, root.keyId);
    assert.equal(delegation.delegateKeyId, delegate.keyId);
    assert.deepEqual(delegation.scopes, ["publish"]);

    const publication = await client.publishArtifactAs(delegate, {
      author: "alice",
      title: "Published by a delegate",
      challengeId: "half-adder",
      artifact: logicArtifact(),
    });

    assert.equal(publication.author, "alice");
    assert.equal(publication.authorKey, delegate.keyId);
    assert.equal(publication.delegatedBy, root.keyId);

    const scoped = new AgentSigner(generateAgentKeypair().privateKey);
    await client.delegateKey(root, {
      handle: "alice",
      delegatePublicKey: scoped.publicKey,
      app: "market",
    });

    await assert.rejects(
      client.publishArtifactAs(scoped, {
        author: "alice",
        title: "Wrong app",
        challengeId: "half-adder",
        artifact: logicArtifact(),
      }),
      /does not match the registered identity/,
    );

    await assert.rejects(
      client.rotateIdentity(delegate, {
        handle: "alice",
        toPublicKey: new AgentSigner(generateAgentKeypair().privateKey).publicKey,
      }),
      /does not start from the current key/,
    );

    await assert.rejects(
      client.delegateKey(delegate, {
        handle: "alice",
        delegatePublicKey: new AgentSigner(generateAgentKeypair().privateKey).publicKey,
      }),
      /root is not the current key/,
    );

    await assert.rejects(
      client.registerAgent(delegate, "mallory"),
      /already in use/,
    );

    const list = await client.delegations("alice");
    assert.equal(list.length, 2);
  } finally {
    await context.close();
  }
});

test("rotating the root invalidates delegated keys but keeps capabilities valid", async () => {
  const context = await setup();

  try {
    const { client, root } = context;
    const delegate = new AgentSigner(generateAgentKeypair().privateKey);
    const next = new AgentSigner(generateAgentKeypair().privateKey);

    await client.delegateKey(root, {
      handle: "alice",
      delegatePublicKey: delegate.publicKey as never,
    });

    const hidden = await client.publishArtifactAs(root, {
      author: "alice",
      title: "Unlisted work",
      challengeId: "half-adder",
      artifact: logicArtifact(),
      visibility: "unlisted",
    });

    const grant = {
      artifactId: hidden.id,
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      nonce: "grant-before-rotation",
      grantee: null,
    };

    const capability = encodeCapability({ grant, signature: root.sign(grant) });

    await client.rotateIdentity(root, { handle: "alice", toPublicKey: next.publicKey });

    await assert.rejects(
      client.publishArtifactAs(delegate, {
        author: "alice",
        title: "Delegate after rotation",
        challengeId: "half-adder",
        artifact: logicArtifact(),
      }),
      /does not match the registered identity/,
    );

    const response = await fetch(
      `${context.server.base}/v1/publications/${hidden.id}?capability=${encodeURIComponent(capability)}`,
    );

    assert.equal(response.status, 200, "a capability issued by a retired key still works");
    const publication = (await response.json()) as Publication;
    assert.equal(publication.id, hidden.id);
  } finally {
    await context.close();
  }
});

test("rotations and delegations persist at snapshot version 3", async () => {
  const context = await setup();

  try {
    const { client, root, file } = context;
    const delegate = new AgentSigner(generateAgentKeypair().privateKey);
    const next = new AgentSigner(generateAgentKeypair().privateKey);

    await client.rotateIdentity(root, { handle: "alice", toPublicKey: next.publicKey });
    await client.delegateKey(next, {
      handle: "alice",
      delegatePublicKey: delegate.publicKey as never,
    });

    await stop(context.server.server);

    const snapshot = JSON.parse(readFileSync(file, "utf8")) as {
      version: number;
      rotations: unknown[];
      delegations: unknown[];
    };
    assert.equal(snapshot.version, 3);
    assert.equal(snapshot.rotations.length, 1);
    assert.equal(snapshot.delegations.length, 1);

    const reloaded = new RarextStore(file);
    const identity = reloaded.getIdentity("alice");
    assert.equal(identity?.keyId, next.keyId);
    assert.equal(reloaded.resolveKey(root.keyId)?.current, false);
    assert.equal(reloaded.keysForHandle("alice").length, 2);
    assert.equal(reloaded.rotationsFor("alice").length, 1);
    assert.equal(reloaded.delegationsFor("alice").length, 1);
    assert.equal(reloaded.activeDelegation("alice", delegate.keyId, null)?.rootKeyId, next.keyId);
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test("expired delegations never authorize a publication", async () => {
  const store = new RarextStore();
  const root = new AgentSigner(generateAgentKeypair().privateKey);
  const delegate = new AgentSigner(generateAgentKeypair().privateKey);

  store.addIdentity({
    handle: "alice",
    keyId: root.keyId,
    algorithm: root.suite,
    publicKey: root.publicKey as never,
    createdAt: new Date().toISOString(),
  });

  const expiresAt = new Date(Date.now() + 100_000).toISOString();

  store.addDelegation({
    kind: "rarext.delegation",
    version: 1,
    handle: "alice",
    rootKeyId: root.keyId,
    delegateKeyId: delegate.keyId,
    delegatePublicKey: delegate.publicKey as never,
    algorithm: delegate.suite,
    scopes: ["publish"],
    app: null,
    createdAt: new Date().toISOString(),
    expiresAt,
    nonce: "expiring-delegation",
    signature: "",
  });

  assert.ok(store.activeDelegation("alice", delegate.keyId, null, Date.now()));
  assert.equal(
    store.activeDelegation("alice", delegate.keyId, null, Date.now() + 200_000),
    null,
  );
});
