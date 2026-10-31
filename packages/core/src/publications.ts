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
 * Every field of a publication, and whether the ROOT covers it — `true` is content, `false` is
 * bookkeeping.
 *
 * One declaration, exhaustive BY THE TYPE: `Record<keyof Publication, boolean>` stops compiling the
 * moment a field is added to `Publication`, so identity by silence is impossible — somebody has to
 * write `true` or `false` for the new field, which is a decision, made in one visible place.
 *
 * It is a FIELD MAP rather than a walk over the record's own keys because a record is served with
 * things attached to it that are not part of it: the API hands a publication out with its `root`
 * and its durability observation on board, and a client recomputing a root over "whatever keys
 * happen to be present" would get a different digest than the one it was told — the very thing the
 * root exists to prevent. Reading the declared fields means a presentation key is ignored by
 * construction, so a response recomputes to the root it was served with, no ceremony required.
 */
export const PUBLICATION_ROOT_FIELDS: Record<keyof Publication, boolean> = {
  id: false,
  author: true,
  authorKey: true,
  delegatedBy: true,
  signatureAlgorithm: true,
  title: true,
  body: true,
  app: true,
  challengeId: true,
  artifact: true,
  taskId: true,
  circuit: true,
  visibility: true,
  artifactCommitment: true,
  parentId: true,
  source: true,
  createdAt: true,
  attestedAt: false,
  verified: true,
  signature: true,
  nonce: true,
  attestation: true,
  verification: true,
  attestationKeyId: false,
  attestationSignature: false,
  durability: false,
};

/**
 * The fields a publication's root does NOT cover, derived from the map above so the two can never
 * disagree: `id` is a label the publisher mints, `attestedAt` is when a particular node wrote the
 * record down, the attestation's own key id and signature say WHO attested rather than what was
 * published, and `durability` is that node's storage tier — which core's own type already calls "a
 * reader's observation, not part of the publication".
 */
export const PUBLICATION_ROOT_EXCLUDED_FIELDS: readonly string[] = Object.entries(
  PUBLICATION_ROOT_FIELDS,
)
  .filter(([, isContent]) => !isContent)
  .map(([field]) => field)
  .sort();

export function publicationRoot(publication: Publication, hash: HashFn): string {
  const covered: Record<string, unknown> = {};
  const record = publication as unknown as Record<string, unknown>;

  for (const [field, isContent] of Object.entries(PUBLICATION_ROOT_FIELDS)) {
    if (!isContent) continue;
    const value = record[field];
    if (value !== undefined) covered[field] = value;
  }

  return hash(`${PUBLICATION_ROOT_DOMAIN}\n${canonicalize(covered)}`);
}
