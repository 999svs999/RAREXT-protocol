#!/usr/bin/env bash
# Publishes the CI workflows to GitHub.
#
#   npm run publish:ci
#
# GitHub refuses to create or update workflow files unless the credential
# carries the `workflow` scope, so this is a separate step from the first
# push. Refresh the token once, in a browser:
#
#   gh auth refresh -h github.com -s workflow
#
# then run this. The workflows are committed and pushed, and CI starts on the
# next push to main.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "no origin remote. add one first:"
  echo "  git remote add origin https://github.com/999svs999/RAREXT-protocol.git"
  exit 1
fi

if [ -z "$(git status --porcelain .github/workflows)" ]; then
  echo "the workflows are already committed"
  exit 0
fi

git add .github/workflows
git commit -m "ci: add the publish and verification workflows"
git push origin main

echo "CI is live. The next push to main runs it."
