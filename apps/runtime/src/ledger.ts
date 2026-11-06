import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { runRecordFor, verifyLedger } from "./transcript.ts";
import type { LedgerVerification, ModelRunBody, RunRecord } from "./types.ts";

const HEX64 = /^[0-9a-f]{64}$/;

export function writeJsonFile(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

function readRecords(file: string): RunRecord[] {
  if (!existsSync(file)) return [];
  const records: RunRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      records.push(JSON.parse(trimmed) as RunRecord);
    } catch {
      // A torn final line is retained in the file for inspection; it is not
      // silently dropped from verification, so record it as a null body.
      records.push({ kind: "rarext.model-run.record.v1", body: null as never, digest: "" });
    }
  }
  return records;
}

/**
 * Append-only local ledger. One JSON object per line; each record's `previous`
 * is the previous record's digest, so removing or reordering a line is visible
 * without a server.
 */
export class RunLedger {
  readonly directory: string;
  readonly file: string;
  #head: string | null | undefined = undefined;

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = join(directory, "runs.jsonl");
  }

  head(): string | null {
    if (this.#head !== undefined) return this.#head;
    const records = readRecords(this.file);
    const last = records.at(-1);
    this.#head = last && typeof last.digest === "string" && HEX64.test(last.digest) ? last.digest : null;
    return this.#head;
  }

  append(body: ModelRunBody): RunRecord {
    if (body.previous !== this.head()) {
      throw new Error(
        `run chain refused: body.previous is ${String(body.previous)} but the ledger head is ${String(this.head())}`,
      );
    }
    const record = runRecordFor(body);
    appendFileSync(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Best effort.
    }
    this.#head = record.digest;
    return record;
  }

  records(): RunRecord[] {
    return readRecords(this.file);
  }

  latest(): RunRecord | null {
    return this.records().at(-1) ?? null;
  }

  verify(): LedgerVerification {
    return verifyLedger(this.records());
  }
}
