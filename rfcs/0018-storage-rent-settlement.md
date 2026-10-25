# RFC 0018: Storage rent quotes and settlement path

- **Status:** Draft
- **Author(s):** RAREXT maintainers
- **Created:** 2026-10-25
- **Requires:** RFC 0004 (storage economy), RFC 0005 (durable placements)
- **Implementation:** `apps/api/src/storage-rent.ts`,
  `GET /v1/storage/pricing`, `GET /v1/storage/quote`,
  `GET /v1/storage/usage`

## Summary

This RFC gives storage a public rent unit and a deterministic quote without
introducing a protocol token. The implemented slice prices bytes held for a
committed term in byte-months, publishes the operator's rates, and reports the
same unit in usage metering. Charging, refunds, renewal, and chain settlement are
designed here but are not implemented yet.

## Motivation

RFC 0004 establishes that storage is sold by proof of possession and metered in
byte-months. The missing step is the number a customer can see before committing:
how many bytes, for how long, in which tier, at what rate, and in what unit. Without
that number, "paid sealed storage" is a promise rather than a price, and a
settlement layer has nothing stable to settle.

The open tier should stay free. The sealed tier has a real operator cost. A quote
is the smallest useful slice between the two: it makes the price observable and
testable, while leaving custody of funds out of the protocol for now.

## Guide-level explanation

An operator publishes a rate card. A customer asks for a quote:

```bash
curl 'https://registry.example/v1/storage/quote?bytes=1073741824&tier=sealed&until=2026-11-24T00:00:00.000Z'
```

The response says the term is one 30-day month, the amount is one GiB-month, and
the cost is a whole number of microcredits. A public quote is free by default.

The quote is not a reservation. It does not extend `retentionUntil`, reserve
capacity, or move credits. It is a price offer that a later settlement flow can
accept or ignore. The customer still needs a separate, authenticated payment step
before the retention term changes.

Credits are operator-scoped accounting units, not a protocol token. They can be
earned through the existing work board, purchased off-chain, or settled on a chain
by a later adapter, but the quote does not require or create any of those.

## Reference-level design

### Units

- **Accounting month:** exactly 30 days (2,592,000,000 ms).
- **Byte-month:** one byte held for one accounting month.
- **GiB-month:** 2^30 byte-months.
- **Credit:** 1,000,000 microcredits. Amounts are integers in microcredits.

One GiB held for one month is 1,073,741,824 byte-months, 1 GiB-month, and 1 credit
at a rate of 1,000,000 microcredits per GiB-month. Byte-months are deliberately
large; GiB-months are the human-readable form.

### Pricing policy

`GET /v1/storage/pricing` returns:

```json
{
  "policy": "storage-rent-v1",
  "unit": "byte-month",
  "monthMs": 2592000000,
  "creditScale": 1000000,
  "currency": "credit",
  "tiers": [
    { "tier": "public", "rateMicroCreditsPerGiBMonth": 0, "free": true },
    { "tier": "sealed", "rateMicroCreditsPerGiBMonth": 1000000, "free": false }
  ]
}
```

Rates come from the operator environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RAREXT_STORAGE_PUBLIC_MICROCREDITS_PER_GIB_MONTH` | `0` | Open-tier rate |
| `RAREXT_STORAGE_SEALED_MICROCREDITS_PER_GIB_MONTH` | `1000000` | Sealed-tier rate |

A missing value uses the default. A value that is not a non-negative safe integer
fails at process start rather than silently changing the price. The default sealed
rate is illustrative policy, not a protocol constant.

### Quote

`GET /v1/storage/quote?bytes=<positive integer>&tier=<public|sealed>&until=<ISO date>`
returns:

```json
{
  "policy": "storage-rent-v1",
  "bytes": 1073741824,
  "tier": "sealed",
  "from": "2026-10-25T00:00:00.000Z",
  "until": "2026-11-24T00:00:00.000Z",
  "durationMs": 2592000000,
  "monthMs": 2592000000,
  "byteMonths": 1073741824,
  "gibMonths": 1,
  "rateMicroCreditsPerGiBMonth": 1000000,
  "costMicroCredits": 1000000,
  "costCredits": 1,
  "free": false
}
```

The calculation is:

```
byteMonths       = bytes × durationMs / monthMs
gibMonths        = byteMonths / 2^30
costMicroCredits = ceil(gibMonths × rateMicroCreditsPerGiBMonth)
```

`from` is the server's clock at request time. `until` must be strictly later and
at most 10 years ahead. `bytes` must be a positive safe integer. The endpoint is
read-only and unauthenticated; it changes no state. Cost rounds up to a whole
microcredit so a tiny quote cannot truncate to free.

### Usage

`GET /v1/storage/usage` keeps the existing `tier`, `blobs`, and `bytes` fields and
adds:

- `retainedUntil`: the latest valid retention term in the tier;
- `committedByteMonths`: the sum of `size × (retentionUntil − createdAt) / monthMs`
  over blobs with a valid, non-empty term.

Malformed or absent terms contribute no committed byte-months. They are not
silently repriced or deleted; GC already fails closed on unparseable terms.

### Settlement path (not implemented)

A future flow should be:

1. **Quote:** the customer receives the stable `storage-rent-v1` quote.
2. **Intent:** the customer signs the quote digest, payer key, blob hash, tier, and
   requested `until`.
3. **Settlement:** an operator ledger or an external chain adapter confirms the
   transfer. The quote alone is never proof of payment.
4. **Apply:** only after confirmation, extend `retentionUntil` and publish a new
   signed placement or retention record.
5. **Renew:** a new quote starts at `max(now, current retainedUntil)` so overlapping
   terms are not charged twice.
6. **Refund:** early deletion is a policy decision; if offered, it uses the same
   unit and a published proration rule.

The current slice stops at step 1. It deliberately has no debit endpoint, because
spending credits requires an authenticated payer identity, a durable balance, and
a rule for reversing a failed write. Those belong in the settlement work, not in a
read-only price endpoint.

## Alternatives considered

- **A protocol token or fixed protocol price.** Rejected: it makes the protocol a
  currency issuer and freezes a number the market has not tested.
- **Charge on upload.** Rejected: upload does not prove the term, and it makes the
  free public tier awkward.
- **Charge on download.** Rejected: it prices retrievability, not storage, and it
  makes mirrors worse.
- **Only an off-chain invoice.** Rejected as the whole design: invoice totals are
  not reproducible from public metering. A quote keeps the number auditable.
- **Settle every byte-month on chain immediately.** Rejected for now: too much
  chain traffic before there is a chain or real volume.

## Risks and mitigations

- **Stale prices.** A quote is computed from current policy and has no expiry. A
  settlement flow must either accept the quoted digest or publish a short validity
  window; until then, clients should not treat a saved quote as a promise.
- **Rounding disputes.** The formula and the round-up rule are explicit and tested.
  Integer microcredits avoid floating-point money.
- **Credit confusion.** Credits are not a protocol token and are not transferable
  by this RFC. Documentation and the response shape must keep saying so.
- **Free-tier abuse.** Public storage remains free, but it is still bounded by the
  existing blob quota, rate limits, and GC. A free quote grants no capacity.
- **Operator price opacity.** Publishing the rate card is what makes the quote
  checkable; hiding the environment would recreate the invoice problem.
- **Term drift.** The 30-day accounting month is a convention, not a calendar
  month. Renewal and refund rules must use the same convention.

## Migration and compatibility

The endpoints are additive reads. `StorageUsage` gains one optional-in-practice
field; existing consumers that ignore it continue to work. No publication leaf,
attestation, placement, or chain format changes. No existing retention term is
rewritten by a quote. Rolling back the code removes the endpoints and the extra
usage field without touching stored bytes.

## Open questions

1. Who is allowed to pay for a blob: its author, any payer, or a delegated
   capability holder?
2. Does a failed or partial upload refund automatically, and in what unit?
3. Are holder payouts settled from the same credit, or is rent kept by the
   registry operator until a holder market exists?
4. Does renewal extend from the old `retentionUntil` or restart at payment time
   when the term has already lapsed?
5. Which chain adapter settles credits first, and does it settle quotes or only
   periodic net positions?
6. Should the quote include a signed operator price commitment, or is the
   `storage-rent-v1` policy plus a response digest enough?

## Decision

Draft. The quote and metering slice is implemented and tested; settlement remains
open.
