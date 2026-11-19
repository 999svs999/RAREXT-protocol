#!/usr/bin/env bash
# evolution-status.sh — one command: everything about the self-evolving loop.
#
#   ./agents/self-evolve/evolution-status.sh          # full status
#   watch -n 30 ./agents/self-evolve/evolution-status.sh   # live dashboard
#   tail -f /private/var/folders/nm/_h14dgzj3w702_87z438zp7m0000gn/T/opencode/evolve21.log  # raw training stream
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GENS="$HERE/generations"
LEDGER="$GENS/generations.jsonl"
LOG="${EVOLUTION_LOG:-/private/var/folders/nm/_h14dgzj3w702_87z438zp7m0000gn/T/opencode/evolve21.log}"
SERVED="$HOME/rarext-protocol/models/live-host-lm/live-host-lm.gguf"

echo "══ process ══"
if pgrep -f evolve.py >/dev/null 2>&1; then
  P=$(pgrep -f evolve.py | head -1)
  printf "  RUNNING  pid %s  cpu %s%%  elapsed %s\n" "$P" \
    "$(ps -o pcpu= -p "$P" | tr -d ' ')" "$(ps -o etime= -p "$P" | tr -d ' ')"
else
  echo "  STOPPED  (restart: cd ~/rarext-protocol/agents/self-evolve && \\"
  echo "    nohup \$(ls -d /private/var/folders/nm/*/T/opencode 2>/dev/null | head -1)/lmenv/bin/python \\"
  echo "      evolve.py --generations 0 --iters 60 --rl-lr 5e-5 --rollout-temp 0.35 >> evolution.out 2>&1 &)"
fi

echo "══ current run (last 5 log lines) ══"
[[ -f "$LOG" ]] && tail -5 "$LOG" | sed 's/^/  /' || echo "  log not found at $LOG (EVOLUTION_LOG env overrides)"

echo "══ ledger ══"
python3 - "$LEDGER" <<'EOF'
import json, sys, os
path = sys.argv[1]
if not os.path.exists(path):
    print("  (no ledger yet)"); sys.exit(0)
rows = [json.loads(l) for l in open(path) if l.strip()]
promoted = [r for r in rows if r["promoted"]]
print(f"  {len(rows)} generations recorded, {len(promoted)} promoted")
for r in rows[-5:]:
    s = " ".join(f"{k.split()[0]} {v:.2f}" for k, v in r["scores"].items())
    mark = "✅" if r["promoted"] else "·"
    print(f"  {mark} gen {r['generation']:>2}  {s}  engine {r['engine_exact']:.2f}  digest {r['gguf_digest'][7:19]}")
if promoted:
    last = promoted[-1]
    print(f"  incumbent: gen {last['generation']}  digest {last['gguf_digest'][:26]}")
EOF

echo "══ serving model ══"
if [[ -f "$SERVED" ]]; then
  D=$(shasum -a 256 "$SERVED" | awk '{print "sha256:"substr($1,1,22)}')
  printf "  %s  (%s bytes, modified %s)\n" "$D" "$(stat -f %z "$SERVED")" "$(stat -f '%Sm' -t '%H:%M' "$SERVED")"
  P=$(curl -s -m 5 https://ai.rarext.co/v1/models -A "Mozilla/5.0" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['data'][0]['digest'][:29])" 2>/dev/null)
  echo "  live at ai.rarext.co: ${P:-unreachable}"
  [[ "$P" == "${D#sha256:}"* ]] && echo "  ✅ provider is serving the ledger's promoted model" || echo "  ⚠️  provider is NOT serving the latest promoted weights (restart: pkill -f rarext_ai.mjs && ~/BAPECLUB/apps/live-host/rarext-ai-up.sh)"
fi

echo "══ checkpoints ══"
ls -t "$GENS"/gen-*.gguf 2>/dev/null | head -3 | while read f; do
  printf "  %s  (%s)\n" "$(basename "$f")" "$(stat -f '%Sm' -t '%m-%d %H:%M' "$f")"
done
