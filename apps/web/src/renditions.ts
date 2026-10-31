/**
 * The gallery's entry point to the rendition check.
 *
 * A thin surface on purpose: the gallery is a hand-written page with an inline
 * module script, and importing the AI PAGE would run its DOM wiring. `ai.ts` has no
 * side effects, so this re-export bundles to just the check and the primitives it
 * needs — one implementation of the rule, reachable from both pages.
 */
export {
  verifyPublishedRendition,
  renderProofPicture,
  renderBoundedPicture,
  semanticsCommitmentHolds,
  sha256Bytes,
  sha256Hex,
  federationFromBundle,
} from "./ai.ts";
export { parseRegistrySeedList, registryListDigestSource } from "@rarext/core";
