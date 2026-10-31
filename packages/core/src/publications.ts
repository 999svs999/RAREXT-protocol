import { canonicalize } from "./canonical.ts";
import type { HashFn } from "./ai.ts";
import type {
  Attestation,
  Challenge,
  Circuit,
  ClaimKind,
  ClaimScope,
  Publication,
  PublicationSource,
  SignatureSuite,
  Artifact,
  OperatorAttestation,
  Visibility,
} from "./index.ts";

/**
 * What the publish route accepts — moved here beside the one function that turns
 * it into a stored `Publication`, so the field mapping and the shape it maps
 * FROM cannot be edited apart.
 */
export interface PublishInput {
  author: string;
  title: string;
  body: string;
  app: string;
  challengeId: string;
  artifact: Artifact;
  circuit?: Circuit;
  parentId: string | null;
  source: PublicationSource | null;
  createdAt: string;
  authorKey: string | null;
  delegatedBy?: string | null;
  verified: boolean;
  signature: string | null;
  nonce: string | null;
  claim?: { kind?: ClaimKind; scope?: ClaimScope | null };
  operatorAttestation?: OperatorAttestation | null;
  visibility?: Visibility;
  artifactCommitment?: string | null;
  attestation?: Attestation;
}

/**
 * Assemble the stored `Publication` from a validated publish input — the ONE
 * copy of the mapping between what an agent submits and what the registry keeps.
 *
 * It lived inline in the publish route, which made the mapping the route's
 * private knowledge: a resident that wants to publish offline (the self-publish
 * half of "AI lives on RAREXT") would have had to re-derive it, and two copies
 * of a field mapping drift exactly the way builders and verifiers drift. The
 * attestation stays a parameter because WHO verified the artifact is the
 * registry's business — this function only records what it was told.
 */
export function publicationFromSignedInput(input: PublishInput, extras: {
  /** The registry mints its ids; a resident mints its own. Injected. */
  id: string;
  attestation: Attestation;
  /** How the attestation was produced: a challenge run, or the operator. */
  verification: Publication["verification"];
  attestationKeyId: string | null;
  attestationSignature: string | null;
  challenge: Pick<Challenge, "id">;
  suite: SignatureSuite;
}): Publication {
  return {
    id: extras.id,
    author: input.author,
    authorKey: input.authorKey,
    delegatedBy: input.delegatedBy ?? null,
    signatureAlgorithm: extras.suite,
    title: input.title,
    body: input.body,
    app: input.app,
    challengeId: extras.challenge.id,
    artifact:
      input.visibility === "sealed"
        ? { ...input.artifact, body: null }
        : input.artifact,
    taskId: extras.challenge.id,
    circuit: input.circuit,
    visibility: input.visibility ?? "public",
    artifactCommitment: input.artifactCommitment ?? null,
    parentId: input.parentId,
    source: input.source,
    createdAt: input.createdAt,
    attestedAt: extras.attestation.createdAt,
    verified: input.verified,
    signature: input.signature,
    nonce: input.nonce,
    attestation: extras.attestation,
    verification: extras.verification,
    attestationKeyId: extras.attestationKeyId,
    attestationSignature: extras.attestationSignature,
  };
}

/** Domain separation: a publication's root can never be mistaken for another rule's output. */
export const PUBLICATION_ROOT_DOMAIN = "rarext.publication.root.v1";

/**
 * The fields a publication's root does NOT cover, because they are bookkeeping rather than content:
 * `id` is a label the publisher mints, `attestedAt` is when a particular node wrote the record
 * down, the attestation's own key id and signature say WHO attested (not what was published), and
 * `durability` is that node's storage tier for the bytes.
 *
 * Named in one place, and held by a test that enumerates the record's fields: adding a field to
 * `Publication` fails that test until the new field is either covered or listed here. Identity by
 * silence is how a rule rots — the failure mode this avoids is a future field quietly NOT being
 * part of the thing the root is supposed to commit to.
 */
export const PUBLICATION_ROOT_EXCLUDED_FIELDS = [
  "id",
  "attestedAt",
  "attestationKeyId",
  "attestationSignature",
  "durability",
] as const;

/**
 * A publication's identity, recomputed from the record itself.
 *
 * A publication is how the storage economy writes anything down, and until now its name was an
 * `id` the registry minted — a label, so a client could only take the node's word for what it was
 * holding. A root makes the record answerable: the same published content is the same object
 * whichever node wrote it down, a copy that differs in one covered field is a different object, and
 * a reference can name it (RFC 0022).
 *
 * Canonicalization does the field-order work (the governance lesson: an identity that depends on
 * key order is an identity that changes for no reason), and `hash` is a PORT so a browser, a node
 * and a test can each bring their own digest and still agree on what the record is.
 */
export function publicationRoot(publication: Publication, hash: HashFn): string {
  const covered: Record<string, unknown> = {};
  const excluded: readonly string[] = PUBLICATION_ROOT_EXCLUDED_FIELDS;

  for (const key of Object.keys(publication).sort()) {
    if (excluded.includes(key)) continue;
    covered[key] = (publication as unknown as Record<string, unknown>)[key];
  }

  return hash(`${PUBLICATION_ROOT_DOMAIN}\n${canonicalize(covered)}`);
}
