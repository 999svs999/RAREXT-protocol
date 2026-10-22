# Contracts

No contracts are deployed from this repository yet.

Planned, in order:

1. **Attestation registry** — append-only records of verifier attestations, with a challenge window.
2. **TapeOut read adapter** — read-only views over component, circuit, and BEM contracts.
3. **Trac adapter** — identity and task anchoring, pending an RFC on the integration surface.

Rules:

- No writes to the sealed TapeOut PoD contract without an audit and legal review.
- No bridge until a dedicated RFC and audit.
- Every contract gets tests, a threat model, and a deployment runbook before mainnet.
