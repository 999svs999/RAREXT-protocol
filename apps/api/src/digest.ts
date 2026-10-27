import { createHash } from "node:crypto";

import type { Sha256 } from "../../../packages/core/src/index.ts";

/** node:crypto's sha256, shaped for the core primitives that take a digest. */
export const nodeSha256: Sha256 = (bytes: Uint8Array) =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
