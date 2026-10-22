# Contributing

Thanks for building in public with us.

## Before you start

- Read the [litepaper](docs/LITEPAPER.md) and [architecture](docs/ARCHITECTURE.md).
- For anything larger than a bug fix, open an issue or write an RFC first. We would rather discuss the design than reject a large PR.
- Be decent. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Development

Requires Node 22.18 or newer. We use npm workspaces and Node's native TypeScript support.

```bash
npm install
npm run check      # typecheck + tests
npm run dev:api    # http://127.0.0.1:8787
```

Guidelines:

- TypeScript strict mode, ES modules, `.ts` extensions in relative imports.
- Prefer Node built-ins over new dependencies. Every dependency needs a reason.
- Keep the simulator deterministic. No floating point in scoring paths.
- Add a test for every behavior change.
- Keep pull requests small and focused.

## Commit sign-off

We use the Developer Certificate of Origin. Sign off every commit:

```bash
git commit -s -m "core: reject unsettled circuits from scoring"
```

By signing off you certify that you wrote the change or have the right to submit it under the project license.

## Branches and commits

- `main` is always releasable. Feature work branches from `main` as `feat/<short>`, `fix/<short>`, `docs/<short>`, or `chore/<short>`.
- Commits use a conventional prefix, matching the area they touch: `core:`, `api:`, `web:`, `sdk:`, `mcp:`, `store:`, `examples:`, `docs:`, `ci:`, `chore:`. The squash-merge commit keeps the same prefix.
- One logical change per commit. A change to the wire format, the scoring, or the semantics binding is its own commit, never bundled with a refactor.
- Protocol-visible changes say so in the commit body: what a client will notice, and whether old data stays valid.

## Versioning and releases

The workspace shares one version. `npm run version:all` writes it into every package
so the published packages can never drift from each other.

Releases are cut from `main` when the local check is green. There is no CI service and
no registry dependency:

```bash
npm run check
npm run test:examples
npm run verify:packages
npm run test:takedown
```

1. `npm run version:all 0.2.0-alpha.1` — writes the version into every package and
   rewrites the `@rarext/*` dependency ranges. `npm run version:all -- --check` fails if
   they drift.
2. `npm run pack:all` — builds `release/*.tgz` in dependency order.
3. Commit as `chore(release): 0.2.0-alpha.1`, tag `v0.2.0-alpha.1`, push both.
4. Create the GitHub release, attach the four tarballs, and mark it pre-release.
5. Update [`CHANGELOG.md`](CHANGELOG.md) with the release notes.

Consumers install from the release, by URL:

```bash
npm install https://github.com/999svs999/RAREXT-protocol/releases/download/v0.2.0-alpha.1/rarext-core-0.2.0-alpha.1.tgz
```

Publishing to a public registry is optional. The protocol never depends on it.

The registry protocol version and the package version are different things. A change to
the payload format, the attestation, or the semantics binding is a **protocol** change:
it needs an RFC, a migration note, and a major or pre-release bump. Anything else is a
routine release.

## RFC process

Material changes to protocol, scoring, economics, governance, or chain strategy require an RFC.

1. Copy [`rfcs/0000-template.md`](rfcs/0000-template.md) to `rfcs/NNNN-short-title.md`.
2. Fill it in and open a pull request.
3. Discussion happens in the PR. Maintainers merge accepted RFCs.
4. Implementation can follow in separate pull requests.

Scoring changes are always RFCs. So are bridges, tokens, and chain decisions.

## What we are not accepting yet

- Token launches, presales, or yield promises.
- Bridges or wrapped-asset designs.
- Writes to the sealed TapeOut PoD contract.
- Custody of user funds.
- Features that require a privileged human-only API.

These need an RFC and, in some cases, an audit and legal review.

## Review and merge

- A maintainer reviews within roughly five working days.
- CI must pass: typecheck and tests.
- One approval is enough for routine changes; protocol changes need two maintainer approvals.
- We squash merge with a conventional prefix (`core:`, `api:`, `docs:`, `sdk:`, `ci:`).

## Build-in-public cadence

- Weekly devlog with what shipped, what broke, and what is next.
- Public roadmap updates when priorities change.
- Demos recorded and posted, not described.
- Contributor recognition in release notes.

## Good first issues

Look for the `good first issue` label. Starter tasks include:

- Add a new challenge with a truth table and reference circuit.
- Improve simulator error messages.
- Write an SDK example for an agent framework.
- Add a canonical trace format and hashing test.
- Build a read-only TapeOut indexer prototype.

## Maintainers

See [MAINTAINERS.md](MAINTAINERS.md).
