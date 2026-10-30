import { createHash } from "node:crypto";

import {
  bundleSemanticsCommitment,
  semanticsCommitmentHolds,
  semanticsKey,
  semanticsRecordDigest,
  type Bundle,
  type SemanticsCommitmentStatus,
} from "../../../packages/core/src/index.ts";

/**
 * Does the registry behind this MCP anchor the meanings it serves?
 *
 * The bundle is FETCHED from the registry, but the comparison runs here, on core's rule — the
 * same rule the browser proof page and the SDK's offline reader apply — so the server's word is
 * never the verdict. That is the whole point of an MCP verb here rather than a field the
 * registry fills in: an agent asking "is the meaning I resolved anchored?" must be able to
 * check it, not be told it.
 *
 * This is a COMMITMENT check, not a root check, and the difference is stated rather than
 * implied: the root is reported so a caller can pin it, but proving that a copy rebuilds a
 * pinned root is what `findVerifiedBundle` and `npm run demo:resident` do from a seed the
 * caller trusts. A commitment verified against a bundle nobody pinned is worth exactly the
 * registry's word about which bundle it was.
 */
export interface RegistrySemanticsReport extends SemanticsCommitmentStatus {
  /** True only when every committed digest matched a record this bundle carries. */
  anchored: boolean;
  /** The root the registry reports for this bundle, or null when it reports none. */
  root: string | null;
  /** What this check does NOT establish. Read it before quoting the verdict. */
  limit: string;
}

export async function verifyRegistrySemantics(registry: {
  bundle(): Promise<Bundle>;
}): Promise<RegistrySemanticsReport | null> {
  const bundle = await registry.bundle();

  const commitment = bundleSemanticsCommitment(bundle);
  if (!commitment) return null;

  const records = bundle.semantics ?? [];
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const digests: Record<string, string> = {};
  for (const record of records) digests[semanticsKey(record)] = semanticsRecordDigest(record, sha256);

  const status = semanticsCommitmentHolds(commitment, records, (record) => digests[semanticsKey(record)]!);
  return {
    ...status,
    anchored: status.missing.length === 0,
    root: typeof bundle.manifest?.root === "string" ? bundle.manifest.root : null,
    limit:
      "this proves the bundle's own commitment covers the records it carries; it does not prove the bundle rebuilds a root anyone pinned. Use a trusted seed's root for that.",
  };
}
