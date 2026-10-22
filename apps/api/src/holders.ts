import { httpHolder, type DurabilityHolder } from "./durability.ts";

/**
 * Reads holders from `RAREXT_HOLDERS`, a comma-separated list of `id=url`
 * entries, for example `holder-0=http://127.0.0.1:9600,holder-1=https://h1.example`.
 * A holder without a URL is not a remote holder and is not accepted here.
 */
export function parseHolderSpec(
  spec = process.env.RAREXT_HOLDERS ?? "",
): { id: string; url: string }[] {
  const entries = spec
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const seen = new Set<string>();

  return entries.map((entry) => {
    const at = entry.indexOf("=");

    if (at <= 0) throw new Error(`holder entry is not id=url: ${entry}`);

    const id = entry.slice(0, at).trim();
    const url = entry.slice(at + 1).trim();

    if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
      throw new Error(`holder id is invalid: ${id}`);
    }

    if (!/^https?:\/\/[^/]+/i.test(url)) {
      throw new Error(`holder url is not http(s): ${url}`);
    }

    if (seen.has(id)) throw new Error(`holder id is repeated: ${id}`);

    seen.add(id);

    return { id, url };
  });
}

export function holdersFromEnv(
  spec?: string,
  options: { fetch?: typeof fetch; token?: string } = {},
): DurabilityHolder[] {
  return parseHolderSpec(spec).map((entry) =>
    httpHolder(entry.id, entry.url, options),
  );
}
