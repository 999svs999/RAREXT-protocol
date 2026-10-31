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
  // THIS PROJECT'S OWN DEPLOYMENT, and nothing else. A default that names someone else's
  // registry is a dependency wearing a fallback's clothes: every client of this build would
  // learn one third party's address before it learned anything else, and removing that party
  // would mean changing a default. Registries are federated by OPTING IN — RAREXT_REGISTRIES,
  // or a published seed a deployment trusts — never by inheriting an address from us.
  //
  // The reference registry below is the same one `discovery.ts` defaults to, so the two
  // defaults agree about what this project is.
  return [
    {
      id: "rarext",
      url: "https://999svs999.github.io/RAREXT-protocol",
      operator: "rarext",
      // A CLAIM, not a fact: `rarex` is this project's own chain app and the only chain the
      // project itself runs. Other chains are integrations a deployment may add, and a
      // default is not the place to assert somebody else's.
      chains: ["rarex"],
      note: "The project's own reference deployment.",
      // No seed named: the convention applies, and whether that registry answers at
      // ${url}/registry/seed.json is the network's business, not a claim this list makes.
      seed: null,
    },
  ];
}
