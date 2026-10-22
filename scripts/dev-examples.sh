#!/usr/bin/env bash
# Run every example app against one registry, for a local demo.
#
#   scripts/dev-examples.sh
#
# Starts the board-game verifiers, the fair-launch verifier, and the API with
# every challenge, semantics, and verifier registered. Data is ephemeral.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT=".data/examples"
mkdir -p "$OUT"

node -e '
const fs = require("fs");
const read = (file, key) => JSON.parse(fs.readFileSync(file, "utf8"))[key];
const merge = (files, key) => files.flatMap((file) => read(file, key));
const apps = [
  ["examples/board-games", "examples/launchpad", "examples/storage"],
];
const verifiers = [];
const challenges = [];
const semantics = [];
for (const group of apps) {
  for (const dir of group) {
    verifiers.push(...read(`${dir}/verifiers.json`, "verifiers"));
    challenges.push(...read(`${dir}/challenges.json`, "challenges"));
    semantics.push(...read(`${dir}/semantics.json`, "semantics"));
  }
}
fs.writeFileSync(".data/examples/verifiers.json", JSON.stringify({ verifiers }));
fs.writeFileSync(".data/examples/challenges.json", JSON.stringify({ challenges }));
fs.writeFileSync(".data/examples/semantics.json", JSON.stringify({ semantics }));
console.log(`registered ${verifiers.length} verifiers, ${challenges.length} challenges, ${semantics.length} semantics`);
'

cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

PIDS=()

python3 examples/board-games/server.py >"$OUT/board-games.log" 2>&1 &
PIDS+=($!)
python3 examples/launchpad/server.py >"$OUT/launchpad.log" 2>&1 &
PIDS+=($!)
python3 examples/storage/server.py >"$OUT/storage.log" 2>&1 &
PIDS+=($!)
sleep 1

RAREXT_DATA=none \
RAREXT_VERIFIERS=".data/examples/verifiers.json" \
RAREXT_CHALLENGES=".data/examples/challenges.json" \
RAREXT_SEMANTICS=".data/examples/semantics.json" \
node apps/api/src/server.ts &
PIDS+=($!)

sleep 2
echo "registry:  http://127.0.0.1:8787"
echo "verifiers: http://127.0.0.1:9200 (board games), http://127.0.0.1:9300 (fair launch), http://127.0.0.1:9400 (storage)"
wait
