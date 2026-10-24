import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer as createTcpServer, type Socket } from "node:net";
import { join } from "node:path";
import test from "node:test";

import {
  DurabilityLedger,
  httpHolder,
  type DurabilityHolder,
} from "../src/durability.ts";
import { decodeBytes, encodeBytes } from "../src/erasure.ts";
import { encodeFileToShards } from "../src/erasure-stream.ts";
import { createHolderServer } from "../src/holder-server.ts";

interface RunningHolder {
  holder: DurabilityHolder;
  directory: string;
  url: string;
  stop: () => Promise<void>;
}

function scratch(prefix: string): string {
  const base = join(process.cwd(), ".data");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

async function startHolder(
  id: string,
  root: string,
  token?: string,
): Promise<RunningHolder> {
  const directory = join(root, id);
  const server = createHolderServer({ id, directory, token });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    holder: httpHolder(id, url, token ? { token } : {}),
    directory,
    url,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function closedPort(): Promise<number> {
  const server = createTcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}

type FaultMode = "garbage" | "short" | "drop" | "status-404" | "status-500";

async function startFaultServer(
  mode: FaultMode | "slow" | "blackhole" | "trickle",
  bytes: Buffer,
): Promise<{ url: string; stop: () => Promise<void> }> {
  if (mode === "blackhole") {
    const sockets = new Set<Socket>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    return {
      url: `http://127.0.0.1:${port}`,
      stop: async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }

  const server = createHttpServer((_req, res) => {
    if (mode === "status-404") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
      return;
    }

    if (mode === "status-500") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("broken");
      return;
    }

    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
    });

    if (mode === "garbage") {
      const bad = Buffer.from(bytes);
      bad[0] = bad[0]! ^ 0xff;
      res.end(bad);
      return;
    }

    if (mode === "short") {
      res.end(bytes.subarray(0, Math.max(0, bytes.length - 1)));
      return;
    }

    if (mode === "drop") {
      res.write(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
      setTimeout(() => res.destroy(), 10);
      return;
    }

    if (mode === "trickle") {
      let sent = 0;
      const timer = setInterval(() => {
        if (sent >= bytes.length) {
          clearInterval(timer);
          res.end();
          return;
        }

        res.write(bytes.subarray(sent, sent + 1));
        sent += 1;
      }, 20);
      res.on("close", () => clearInterval(timer));
      return;
    }

    setTimeout(() => res.end(bytes), 80);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("a ledger places and challenges real holders over HTTP", async () => {
  const root = scratch("rarext-holder-transport-");

  try {
    const payload = randomBytes(32 * 1024);
    const shards = encodeBytes(payload, 4, 2);
    const ledger = new DurabilityLedger();
    const running = await Promise.all(
      Array.from({ length: 7 }, (_, index) => startHolder(`holder-${index}`, root)),
    );
    const holders = running.map((entry) => entry.holder);

    try {
      const placement = await ledger.place(shards, holders, "durable");

      assert.equal(placement.shards.length, 6);
      assert.equal(new Set(placement.shards.map((shard) => shard.holder)).size, 6);
      assert.ok(placement.shards.every((shard) => shard.leaves >= 2));

      const outcomes = await ledger.challenge(placement.blobHash, holders);
      const audit = ledger.audit(placement.blobHash);

      assert.ok(outcomes.every((outcome) => outcome.ok));
      assert.equal(audit.status, "ok");
      assert.equal(audit.live, 6);
    } finally {
      await Promise.all(running.map((entry) => entry.stop()));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreachable holder degrades the audit and is skipped when repairing", async () => {
  const root = scratch("rarext-holder-repair-");

  try {
    const payload = randomBytes(16 * 1024);
    const shards = encodeBytes(payload, 3, 2);
    const ledger = new DurabilityLedger();
    const running = await Promise.all(
      Array.from({ length: 8 }, (_, index) => startHolder(`holder-${index}`, root)),
    );
    const holders = running.map((entry) => entry.holder);

    try {
      const placement = await ledger.place(shards, holders.slice(1, 7), "durable");
      const lost = placement.shards[0]!;
      const lostHolder = lost.holder;
      const lostServer = Number(lostHolder.split("-")[1]);

      await running[0]!.stop();
      await running[lostServer]!.stop();

      const before = await ledger.challenge(placement.blobHash, holders);
      const failed = before.find((outcome) => outcome.index === lost.index)!;
      const auditBefore = ledger.audit(placement.blobHash);

      assert.equal(failed.ok, false);
      assert.equal(failed.reason, "holder-missing");
      assert.equal(auditBefore.status, "under-replicated");

      const repaired = await ledger.repair(placement.blobHash, holders);
      const moved = repaired.placement.shards.find((shard) => shard.index === lost.index)!;

      assert.equal(repaired.filled, 1);
      assert.ok(repaired.writtenBytes > 0);
      assert.notEqual(moved.holder, "holder-0", "the offline free holder is not chosen");
      assert.notEqual(moved.holder, lostHolder);

      const after = await ledger.challenge(repaired.placement.blobHash, holders);
      const auditAfter = ledger.audit(repaired.placement.blobHash);

      assert.ok(after.every((outcome) => outcome.ok));
      assert.equal(auditAfter.status, "ok");

      const group = after
        .filter((outcome) => outcome.ok)
        .map((outcome) => repaired.placement.shards.find((shard) => shard.index === outcome.index)!)
        .slice(0, 3);
      const fetched = await Promise.all(
        group.map(async (shard) => {
          const holder = holders.find((candidate) => candidate.id === shard.holder)!;

          return {
            index: shard.index,
            dataShards: repaired.placement.dataShards,
            parityShards: repaired.placement.parityShards,
            length: repaired.placement.length,
            payloadDigest: repaired.placement.blobHash,
            bytes: Uint8Array.from((await holder.get(shard.storedAs))!),
            digest: shard.digest,
          };
        }),
      );

      assert.deepEqual(Buffer.from(decodeBytes(fetched)), payload);
    } finally {
      await Promise.all(running.map((entry) => entry.stop()));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a holder answers a challenge without being told which blob it holds", async () => {
  const root = scratch("rarext-holder-challenge-");

  try {
    const running = await startHolder("holder-0", root);
    const bytes = randomBytes(10 * 1024);
    const storedAs = await running.holder.put(bytes);

    const first = await running.holder.respond({ storedAs, leafIndex: 1, nonce: "alpha" });
    const second = await running.holder.respond({ storedAs, leafIndex: 1, nonce: "beta" });

    assert.ok(first && second);
    assert.equal(first.leaf, second.leaf);
    assert.notEqual(first.digest, second.digest);
    assert.equal(await running.holder.respond({ storedAs, leafIndex: 99, nonce: "x" }), null);
    assert.equal(
      await running.holder.respond({ storedAs: "0".repeat(64), leafIndex: 0, nonce: "x" }),
      null,
    );
    assert.equal(await running.holder.has(storedAs), true);

    await running.stop();
    await assert.rejects(() => running.holder.has(storedAs));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("streamed retrieval skips a faulty holder for each transport failure mode", { timeout: 30_000 }, async (t) => {
  const root = scratch("rarext-holder-fault-modes-");
  const running = await Promise.all(
    Array.from({ length: 3 }, (_, index) => startHolder(`holder-${index}`, root)),
  );

  try {
    const payload = randomBytes(160_000);
    const inputPath = join(root, "payload.bin");
    writeFileSync(inputPath, payload);

    const streamed = encodeFileToShards({
      inputPath,
      outputDir: join(root, "shards"),
      dataShards: 2,
      parityShards: 1,
      chunkBytes: 2 * 4096 * 2,
    });

    const ledger = new DurabilityLedger();
    const placement = await ledger.placeStreamed(streamed, running.map((entry) => entry.holder), "durable");
    const victim = placement.shards.find((shard) => shard.holder === "holder-0")!;
    const victimBytes = readFileSync(join(running[0]!.directory, victim.storedAs));
    const modes: (FaultMode | "refuse" | "tls" | "slow" | "blackhole" | "trickle")[] = [
      "refuse",
      "tls",
      "blackhole",
      "trickle",
      "garbage",
      "short",
      "drop",
      "status-404",
      "status-500",
      "slow",
    ];

    for (const mode of modes) {
      await t.test(mode, async () => {
        let stop = async () => {};

        try {
          let faulty: DurabilityHolder;

          if (mode === "refuse") {
            faulty = httpHolder("holder-0", `http://127.0.0.1:${await closedPort()}`, {
              timeoutMs: 300,
              readTimeoutMs: 1_000,
            });
          } else if (mode === "tls") {
            faulty = httpHolder("holder-0", running[0]!.url.replace("http:", "https:"), {
              timeoutMs: 500,
              readTimeoutMs: 1_500,
            });
          } else {
            const fault = await startFaultServer(mode, victimBytes);
            stop = fault.stop;
            faulty = httpHolder("holder-0", fault.url, {
              timeoutMs: mode === "trickle" ? 1_000 : 300,
              readTimeoutMs: 250,
            });
          }

          // The slow case must contribute bytes, not merely lose a race to two
          // healthy holders. Replace one good holder with a refusing one so a
          // slow but correct download is required to reach k.
          const others = mode === "slow"
            ? [
              running[1]!.holder,
              httpHolder("holder-2", `http://127.0.0.1:${await closedPort()}`, {
                timeoutMs: 200,
                readTimeoutMs: 500,
              }),
            ]
            : [running[1]!.holder, running[2]!.holder];
          const output = join(root, `output-${mode}.bin`);
          const started = Date.now();
          const result = await ledger.retrieveStreamed(
            placement,
            output,
            [faulty, ...others],
            { concurrency: 3 },
          );
          const elapsed = Date.now() - started;

          assert.equal(result.downloaded, 2, mode);
          assert.deepEqual(readFileSync(output), payload, mode);
          assert.ok(elapsed < 2_000, `${mode} took ${elapsed}ms`);
        } finally {
          await stop();
        }
      });
    }
  } finally {
    await Promise.all(running.map((entry) => entry.stop()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("streamed retrieval fails loudly when more shards are lost than parity covers", async () => {
  const root = scratch("rarext-holder-threshold-");
  const running = await Promise.all(
    Array.from({ length: 3 }, (_, index) => startHolder(`holder-${index}`, root)),
  );
  let garbageStop = async () => {};
  let brokenStop = async () => {};

  try {
    const payload = randomBytes(120_000);
    const inputPath = join(root, "payload.bin");
    writeFileSync(inputPath, payload);

    const streamed = encodeFileToShards({
      inputPath,
      outputDir: join(root, "shards"),
      dataShards: 2,
      parityShards: 1,
      chunkBytes: 2 * 4096 * 2,
    });

    const ledger = new DurabilityLedger();
    const placement = await ledger.placeStreamed(streamed, running.map((entry) => entry.holder), "durable");
    const garbageShard = placement.shards.find((shard) => shard.holder === "holder-1")!;
    const garbageBytes = readFileSync(join(running[1]!.directory, garbageShard.storedAs));
    const garbage = await startFaultServer("garbage", garbageBytes);
    const broken = await startFaultServer("status-500", Buffer.alloc(0));
    garbageStop = garbage.stop;
    brokenStop = broken.stop;

    const output = join(root, "threshold-output.bin");
    const faulty = [
      running[0]!.holder,
      httpHolder("holder-1", garbage.url, { timeoutMs: 300, readTimeoutMs: 1_000 }),
      httpHolder("holder-2", broken.url, { timeoutMs: 300, readTimeoutMs: 1_000 }),
    ];

    await assert.rejects(
      () => ledger.retrieveStreamed(placement, output, faulty),
      /need 2 shard files, downloaded 1/,
    );
    assert.equal(existsSync(output), false, "a failed retrieval writes no partial payload");
  } finally {
    await garbageStop();
    await brokenStop();
    await Promise.all(running.map((entry) => entry.stop()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rejected holder token is skipped until parity runs out, then surfaced", async () => {
  const root = scratch("rarext-holder-auth-");
  const token = "holder-transport-secret";
  const running = await Promise.all(
    Array.from({ length: 3 }, (_, index) => startHolder(`holder-${index}`, root, token)),
  );

  try {
    const payload = randomBytes(100_000);
    const inputPath = join(root, "payload.bin");
    writeFileSync(inputPath, payload);

    const streamed = encodeFileToShards({
      inputPath,
      outputDir: join(root, "shards"),
      dataShards: 2,
      parityShards: 1,
      chunkBytes: 2 * 4096 * 2,
    });

    const ledger = new DurabilityLedger();
    const placement = await ledger.placeStreamed(streamed, running.map((entry) => entry.holder), "durable");
    const anonymous = running.map((entry, index) => httpHolder(`holder-${index}`, entry.url));

    const partialOutput = join(root, "one-rejected.bin");
    const partial = await ledger.retrieveStreamed(
      placement,
      partialOutput,
      [anonymous[0]!, running[1]!.holder, running[2]!.holder],
    );

    assert.equal(partial.downloaded, 2);
    assert.deepEqual(readFileSync(partialOutput), payload);

    const output = join(root, "all-rejected.bin");
    await assert.rejects(
      () => ledger.retrieveStreamed(placement, output, anonymous),
      /rejected getFile: 401/,
    );
    assert.equal(existsSync(output), false);
  } finally {
    await Promise.all(running.map((entry) => entry.stop()));
    rmSync(root, { recursive: true, force: true });
  }
});
