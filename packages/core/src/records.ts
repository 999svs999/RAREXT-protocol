import { canonicalize } from "./canonical.ts";
import {
  ANCHOR_ROOT_DOMAIN,
  ANCHOR_ROOT_FIELDS,
  ANCHOR_ROOT_REQUIRED_FIELDS,
  anchorRoot,
} from "./anchors.ts";
import {
  CREDIT_ROOT_DOMAIN,
  CREDIT_ROOT_FIELDS,
  CREDIT_ROOT_REQUIRED_FIELDS,
  creditRoot,
} from "./credits.ts";
import {
  PUBLICATION_ROOT_DOMAIN,
  PUBLICATION_ROOT_FIELDS,
  PUBLICATION_ROOT_REQUIRED_FIELDS,
  publicationRoot,
} from "./publications.ts";
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

/**
 * The preimage each recognizable record rule would hash, with the rule that owns it.
 *
 * This exists for CALLERS WHOSE ONLY DIGEST IS ASYNCHRONOUS — a browser's WebCrypto — and it is the
 * seam, not a second implementation: the preimage IS the rule (the domain prefix, the declared field
 * map, the canonicalization), computed here in core exactly as the synchronous functions compute it,
 * and the caller hashes the returned strings with its one await and compares hex to hex. Building the
 * preimage in the caller would split every rule in half; hashing in core with an async hasher would
 * recreate the Promise-vs-digest trap. One side computes, one side digests, and neither improvises.
 *
 * A rule appears only when the document is recognizable as its kind (every required field present),
 * so an empty-cover digest can never be offered for a document the rule is not about.
 */
export function recordRootPreimages(
  document: unknown,
): Array<{ kind: RecordKind; preimage: string }> {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return [];

  const record = document as Record<string, unknown>;
  const preimages: Array<{ kind: RecordKind; preimage: string }> = [];

  const preimageFor = (domain: string, fields: Record<string, boolean>): string => {
    const covered: Record<string, unknown> = {};
    for (const [field, isContent] of Object.entries(fields)) {
      if (!isContent) continue;
      const value = record[field];
      if (value !== undefined) covered[field] = value;
    }
    return `${domain}\n${canonicalize(covered)}`;
  };

  if (PUBLICATION_ROOT_REQUIRED_FIELDS.every((field) => record[field] !== undefined)) {
    preimages.push({ kind: "publication", preimage: preimageFor(PUBLICATION_ROOT_DOMAIN, PUBLICATION_ROOT_FIELDS) });
  }
  if (ANCHOR_ROOT_REQUIRED_FIELDS.every((field) => record[field] !== undefined)) {
    preimages.push({ kind: "anchor", preimage: preimageFor(ANCHOR_ROOT_DOMAIN, ANCHOR_ROOT_FIELDS) });
  }
  if (CREDIT_ROOT_REQUIRED_FIELDS.every((field) => record[field] !== undefined)) {
    preimages.push({ kind: "credit", preimage: preimageFor(CREDIT_ROOT_DOMAIN, CREDIT_ROOT_FIELDS) });
  }

  return preimages;
}
