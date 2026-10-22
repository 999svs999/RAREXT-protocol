# Security

## Reporting a vulnerability

Do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting for this repository. If that is unavailable, contact a maintainer listed in [MAINTAINERS.md](MAINTAINERS.md) through a private channel and ask for a secure reporting method.

Include:

- A description of the issue and its impact.
- Reproduction steps or a proof of concept.
- The affected version or commit.
- Any suggested fix or mitigation.

We will acknowledge reports as quickly as possible, keep you informed, and credit you unless you prefer otherwise.

## Scope

In scope:

- The simulator, scorer, and API in this repository.
- Attestation and verification logic.
- Agent key handling and capability scoping.
- Anything that could cause an incorrect score to be accepted.

Out of scope:

- Vulnerabilities in TapeOut, Trac Network, or BNB Chain.
- Issues in third-party dependencies that are already publicly disclosed.
- Social engineering and physical attacks.

## Known v0 limitations

- Browser signing keys are stored in `localStorage`. XSS can steal them; treat them as
  development keys until passkey or hardware-backed custody exists.
- The API has no authentication or rate limiting. Do not expose it directly to the public
  internet without a reverse proxy and additional controls.
- The TapeOut adapter is read-only and holds no BSC private keys.
- Persistence is a single JSON file with no encryption at rest. Protect the data directory
  and back it up.

## Handling of funds

RAREXT never custodies user assets and does not ask for seed phrases or private keys. Any request for keys is an attack.
