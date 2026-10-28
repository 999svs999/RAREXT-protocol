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
