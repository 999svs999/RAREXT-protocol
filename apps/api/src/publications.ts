import { randomUUID } from "node:crypto";

import { publicationFromSignedInput as assemble } from "../../../packages/core/src/index.ts";
import type { Publication } from "../../../packages/core/src/index.ts";
import type { PublishInput } from "../../../packages/core/src/index.ts";

export type { PublishInput };

/**
 * The registry's boundary to the one field mapping: core owns the mapping (so a
 * resident with no server assembles the same record), and what is the registry's
 * business here is exactly one thing — minting the id.
 */
export function publicationFromSignedInput(
  input: PublishInput,
  extras: Omit<Parameters<typeof assemble>[1], "id">,
): Publication {
  return assemble(input, { ...extras, id: randomUUID() });
}
