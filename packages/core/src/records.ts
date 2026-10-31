import { ANCHOR_ROOT_REQUIRED_FIELDS, anchorRoot } from "./anchors.ts";
import { CREDIT_ROOT_REQUIRED_FIELDS, creditRoot } from "./credits.ts";
import { PUBLICATION_ROOT_REQUIRED_FIELDS, publicationRoot } from "./publications.ts";
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
export type RecordKind = "publication" | "anchor" | "credit";

export function matchRecordRoot(
  document: unknown,
  wanted: string,
  hash: HashFn,
): { kind: RecordKind; root: string } | null {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return null;

  const record = document as Record<string, unknown>;
  const target = wanted.toLowerCase();

  // A rule answers only for a document it could actually be ABOUT: every field its type marks
  // required must be present. Coverage alone is not recognition — a credit receipt carries
  // `challengeId` too, and a digest computed over a mostly-empty cover is the same for every
  // object, so answering with it would let a nonsense reference call a receipt a publication.
  // Each rule's required list is declared beside the rule, so there is no second place to drift.
  const recognizable = (required: readonly string[]) =>
    required.every((field) => record[field] !== undefined);

  if (recognizable(PUBLICATION_ROOT_REQUIRED_FIELDS)) {
    const publication = publicationRoot(record as never, hash).toLowerCase();
    if (publication === target) return { kind: "publication", root: publication };
  }

  if (recognizable(ANCHOR_ROOT_REQUIRED_FIELDS)) {
    const anchor = anchorRoot(record as never, hash).toLowerCase();
    if (anchor === target) return { kind: "anchor", root: anchor };
  }

  if (recognizable(CREDIT_ROOT_REQUIRED_FIELDS)) {
    const credit = creditRoot(record as never, hash).toLowerCase();
    if (credit === target) return { kind: "credit", root: credit };
  }

  return null;
}
