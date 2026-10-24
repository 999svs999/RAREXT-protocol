#!/usr/bin/env bash
# The checks a CI job should run. GitHub Actions can call this after checkout:
#   - run: bash scripts/ci.sh
set -euo pipefail

npm ci
npm run check
npm run audit:baseline
npm run test:contracts
