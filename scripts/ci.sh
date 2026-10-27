#!/usr/bin/env bash
# The checks a CI job should run after checkout.
set -euo pipefail

if [ "${CI:-}" = "true" ]; then
  npm ci
fi

npm run check
npm run audit:baseline
npm run test:contracts
# The mirror's own acceptance criterion (docs/MIRRORS.md): publish, anchor,
# stop the registry, serve the copy, and prove an altered copy would not
# verify. Cheap (about a second) and the claim the whole mirror story rests on.
npm run test:takedown
# Published numbers must be the ones the code produces.
npm run claim:check
# The self-test proves every kind's guard can FAIL. Without it a decorative
# guard — one whose injection never trips it — rides a green gate, which is
# exactly what happened once: two announcement guards printed "the checker
# accepted ..." while ci stayed green, because the gate ran verify mode only.
npm run claim:self-test
