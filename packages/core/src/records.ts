import { anchorRoot } from "./anchors.ts";
import { publicationRoot } from "./publications.ts";
import type { HashFn } from "./ai.ts";

/**
 * Which record rule rebuilds this document to the root the caller already holds, if either does.
 *
 * This is the registry of record identities, and it lives in CORE because the rules are the
 * protocol's: a bundle, a publication, an anchor are what this network writes down, and "what is
 * this document the root of" must have ONE answer, not one per client. The resolver calls it with
 * whatever a candidate served; a new record kind is added HERE, in one entry, and every client
 * gains the reading without another hand-written branch.
 *
 * The rules are domain-separated from each other and from a byte digest, so trying them in any
 * order is safe: at most one can match a given document and root.
 */
export type RecordKind = "publication" | "anchor";

export function matchRecordRoot(
  document: unknown,
  wanted: string,
  hash: HashFn,
): { kind: RecordKind; root: string } | null {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return null;

  const record = document as Record<string, unknown>;
  const target = wanted.toLowerCase();

  const publication = publicationRoot(record as never, hash).toLowerCase();
  if (publication === target) return { kind: "publication", root: publication };

  const anchor = anchorRoot(record as never, hash).toLowerCase();
  if (anchor === target) return { kind: "anchor", root: anchor };

  return null;
}
