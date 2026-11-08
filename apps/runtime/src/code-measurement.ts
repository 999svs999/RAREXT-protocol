import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "./digest.ts";

/**
 * The runtime source files that make up the serving path. Their contents are
 * what the enclave actually RUNS, so hashing them yields a measurement of the
 * code — the thing a deployment pins when it says "only this build may count".
 */
const RUNTIME_FILES = [
  "provider.ts",
  "model-bundle.ts",
  "gateway.ts",
  "transcript.ts",
  "replay.ts",
  "confidential.ts",
  "hardware-root.ts",
  "code-measurement.ts",
];

/**
 * A measurement of the runtime this process is running. It is computed from the
 * bytes on disk, so a different build — an enclave running other code — produces
 * a different value, and a deployment that pins one refuses the other. In a real
 * TEE this would be the enclave image measurement, taken by the hardware;
 * self-measured here, it is still a CODE identity the deployment checks rather
 * than a claim.
 */
export function runtimeCodeMeasurement(): string {
  const directory = dirname(fileURLToPath(import.meta.url));
  const parts: string[] = [];
  for (const file of RUNTIME_FILES) {
    try {
      parts.push(`${file}\0${sha256Hex(readFileSync(join(directory, file)))}`);
    } catch {
      parts.push(`${file}\0unreadable`);
    }
  }
  return sha256Hex(`rarext.runtime-code.v1\n${parts.join("\n")}`);
}
