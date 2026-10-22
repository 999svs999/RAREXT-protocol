#!/usr/bin/env node
// A local demonstration of the durability contract.
//
//   npm run demo:durability
//
// One machine, seven directories pretending to be seven independent holders.
// 1 MB, 4 data shards + 2 parity. Place, challenge, lose a holder, watch the
// audit say "under-replicated", repair from the survivors, verify the bytes.

import { randomBytes, createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

import {
  DurabilityLedger,
  directoryHolder,
} from "../apps/api/src/durability.ts";
import { decodeBytes, encodeBytes } from "../apps/api/src/erasure.ts";

const root = join(process.cwd(), ".data", "durability-demo");
const HOLDERS = 7;
const SIZE = 1024 * 1024;

rmSync(root, { recursive: true, force: true });

const holders = Array.from({ length: HOLDERS }, (_, index) =>
  directoryHolder(`holder-${index}`, join(root, `holder-${index}`)),
);

const payload = randomBytes(SIZE);
const digest = createHash("sha256").update(payload).digest("hex");
const shards = encodeBytes(payload, 4, 2);
const ledger = new DurabilityLedger();

const line = (label, value) => console.log(`${label.padEnd(10)} ${value}`);
const kilobytes = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;

line("blob", `${digest.slice(0, 16)}… (${(SIZE / 1024 / 1024).toFixed(1)} MB)`);
line("code", "4 data + 2 parity, tier durable");
line("holders", `${HOLDERS} directories on this machine (a stand-in for a network)`);

const placement = ledger.place(shards, holders, "durable");
line(
  "placed",
  placement.shards.map((shard) => `${shard.index}→${shard.holder}`).join("  "),
);

ledger.challenge(placement.blobHash, holders);
let report = ledger.audit(placement.blobHash);
line("challenge", `${report.live}/${report.required} answered`);
line("audit", `live ${report.live}/${report.required} · ${report.status}`);

const lost = placement.shards[1];
const lostHolder = holders.find((holder) => holder.id === lost.holder);
lostHolder.remove(lost.storedAs);
line("lost", `${lost.holder} stopped holding shard ${lost.index}`);

ledger.challenge(placement.blobHash, holders);
report = ledger.audit(placement.blobHash);
line("challenge", `${report.live}/${report.required} answered`);
line("audit", `live ${report.live}/${report.required} · ${report.status}`);

const repaired = ledger.repair(placement.blobHash, holders);
line(
  "repair",
  `${repaired.filled} shard rebuilt · read ${kilobytes(repaired.readBytes)} · wrote ${kilobytes(repaired.writtenBytes)}`,
);

ledger.challenge(placement.blobHash, holders);
report = ledger.audit(placement.blobHash);
line("challenge", `${report.live}/${report.required} answered`);
line("audit", `live ${report.live}/${report.required} · ${report.status}`);

const final = ledger.get(placement.blobHash);
const recovered = final.shards.slice(0, 4).map((shard) => {
  const holder = holders.find((candidate) => candidate.id === shard.holder);
  const bytes = holder.get(shard.storedAs);

  return {
    index: shard.index,
    dataShards: final.dataShards,
    parityShards: final.parityShards,
    length: final.length,
    payloadDigest: final.blobHash,
    bytes: Uint8Array.from(bytes),
    digest: shard.digest,
  };
});

const rebuilt = createHash("sha256").update(decodeBytes(recovered)).digest("hex");
line("decode", rebuilt === digest ? "payload matches the original" : "PAYLOAD MISMATCH");

rmSync(root, { recursive: true, force: true });

if (rebuilt !== digest) process.exit(1);
