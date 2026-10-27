import { existsSync, readFileSync } from "node:fs";

import { parseRegistrySeedList } from "../../../packages/core/src/registries.ts";
import type { RegistrySeedEntry } from "../../../packages/core/src/registries.ts";

/**
 * One entry of the seed list. Re-exported from core rather than restated: the
 * client that consumes this list reads the same shape, and two declarations of
 * one list is how they drift.
 */
export type RegistrySeed = RegistrySeedEntry;

/**
 * The seed list: the registries a client can look for.
 *
 * A mirror is only useful if someone can find it, so the set of known
 * registries is itself a published, versioned list. It lives in the repository
 * so it can be reviewed, and it can be overridden with RAREXT_REGISTRIES for a
 * deployment that runs its own federation.
 */
export function registrySeedList(): RegistrySeed[] {
  const source = process.env.RAREXT_REGISTRIES?.trim();
  if (!source) return defaultSeeds();

  let text = source;
  if (!source.startsWith("[") && !source.startsWith("{")) {
    if (!existsSync(source)) return defaultSeeds();
    text = readFileSync(source, "utf8");
  }

  try {
    // The parsing — what an entry must carry, what is dropped, what is
    // defaulted — lives in core, because a client consuming this list needs the
    // same answers. A second normaliser here is how one list grows two meanings.
    const parsed = parseRegistrySeedList(JSON.parse(text) as unknown);
    return parsed.length > 0 ? parsed : defaultSeeds();
  } catch {
    return defaultSeeds();
  }
}

function defaultSeeds(): RegistrySeed[] {
  return [
    {
      id: "apesdaily",
      url: "https://registry.apesdaily.com",
      operator: "apesdaily",
      chains: ["rarex", "base", "solana", "bitcoin", "cosmos"],
      note: "The reference deployment of the RAREXT registry.",
      // No seed named: the convention applies, and whether that registry
      // answers at ${url}/registry/seed.json is the network's business, not a
      // claim this list makes.
      seed: null,
    },
  ];
}
