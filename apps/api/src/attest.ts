import { createHash, randomUUID } from "node:crypto";

import { attestRun } from "../../../packages/core/src/index.ts";
import type {
  Attestation,
  AttestationBinding,
  Circuit,
  Task,
} from "../../../packages/core/src/index.ts";

export type { AttestationBinding };

const VERIFIER = process.env.RAREXT_VERIFIER ?? "rarext-v0";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function attest(
  circuit: Circuit,
  task: Task,
  binding: AttestationBinding,
): Attestation {
  // The assembly is core's, so a resident running the same circuit attests the
  // same run. What the registry supplies here is what is genuinely ITS business:
  // the name it verifies under, its clock, and a fresh id.
  return attestRun({
    circuit,
    task,
    binding,
    verifier: VERIFIER,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    sha256,
  });
}
