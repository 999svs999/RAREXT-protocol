import { existsSync, readFileSync } from "node:fs";

export interface RegistrySeed {
  id: string;
  url: string;
  operator: string;
  chains: string[];
  note: string | null;
}

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
    if (!existsSync(source)) {
      return defaultSeeds();
    }
    text = readFileSync(source, "utf8");
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && "registries" in parsed
        ? (parsed as { registries: unknown }).registries
        : null;

    if (!Array.isArray(list)) return defaultSeeds();

    return list
      .map((value) => {
        if (typeof value !== "object" || value === null) return null;
        const record = value as Partial<RegistrySeed>;
        if (typeof record.id !== "string" || typeof record.url !== "string") {
          return null;
        }

        return {
          id: record.id,
          url: record.url,
          operator: typeof record.operator === "string" ? record.operator : "",
          chains: Array.isArray(record.chains)
            ? record.chains.filter((chain): chain is string => typeof chain === "string")
            : [],
          note: typeof record.note === "string" ? record.note : null,
        };
      })
      .filter((seed): seed is RegistrySeed => seed !== null);
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
    },
  ];
}
