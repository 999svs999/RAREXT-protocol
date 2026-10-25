#!/usr/bin/env bash
# The checks a CI job should run after checkout.
set -euo pipefail

if [ "${CI:-}" = "true" ]; then
  npm ci
fi

npm run check
npm run audit:baseline
npm run test:contracts
# Published numbers must be the ones the code produces.
npm run claim:check
