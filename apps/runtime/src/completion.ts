/**
 * The part of a completion two providers must agree on, and the part a provider
 * signs its receipt over. Ids are minted per request and `created` is a wall
 * clock, so comparing or signing the raw envelope would report disagreement (or a
 * different digest) even when the model said exactly the same thing.
 *
 * This lives in one place because the GATEWAY that groups responses and the
 * PROVIDER that signs a receipt over its own response must compute the same
 * digest; two implementations would let an honest provider's receipt fail to
 * match the answer the gateway recorded.
 */
export function comparableCompletion(response: Record<string, unknown>): Record<string, unknown> {
  const {
    id: _id,
    created: _created,
    system_fingerprint: _fingerprint,
    ...rest
  } = response;
  return rest;
}
