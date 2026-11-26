#!/usr/bin/env bash
# Update direct.rarext.com's AAAA to this machine's current global IPv6.
#
# The ISP renumbers the prefix (measured: 2401:e180:8c30:ea24::/… →
# 2401:e180:8c10:328d::/64 between 2026-11-24 and 2026-11-26), so the edge's
# direct hostname goes dark until the record follows. The tunnel
# (ai.rarext.co) is unaffected.
#
# Credentials, as measured on this machine:
#   CLOUDFLARE_CUTOVER_TOKEN  Zone.DNS:Edit for rarext.com — VERIFIED 2026-11-26:
#                             a PUT updated direct.rarext.com's AAAA (the record
#                             id must be fetched in full; a truncated id returns
#                             1001 method_not_allowed)
#   CLOUDFLARE_DNS_TOKEN      scoped to saikougoods.com only — useless here
#   CLOUDFLARE_API_TOKEN      reads zones, but DNS read/write on rarext.com is
#                             "Authentication error"
#
#   bash scripts/update-direct-aaaa.sh            # update to the current address
#   bash scripts/update-direct-aaaa.sh --check    # report only
#
# Without a DNS-capable token this prints exactly what to change in the
# Cloudflare dashboard.
set -uo pipefail

ZONE_NAME="rarext.com"
HOST="direct.rarext.com"
ADDR=$(ifconfig 2>/dev/null | grep "inet6 2401" | grep -v temporary | head -1 | awk '{print $2}')
if [ -z "${ADDR:-}" ]; then
  ADDR=$(ifconfig 2>/dev/null | grep "inet6 2401" | head -1 | awk '{print $2}')
fi
if [ -z "${ADDR:-}" ]; then
  echo "no global IPv6 address on this machine — nothing to update to"
  exit 1
fi
echo "current global IPv6: $ADDR"

# order matters: only the cutover token can write rarext.com's DNS
TOKEN="${CLOUDFLARE_CUTOVER_TOKEN:-${CLOUDFLARE_DNS_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}}"
if [ -z "$TOKEN" ]; then
  echo "no Cloudflare token in env (set CLOUDFLARE_DNS_TOKEN with Zone.DNS:Edit)"
  exit 2
fi
AUTH="Authorization: Bearer $TOKEN"

ZID=$(curl -s -m 30 "https://api.cloudflare.com/client/v4/zones?name=$ZONE_NAME" -H "$AUTH" |
  python3 -c "import json,sys; d=json.load(sys.stdin); r=d.get('result') or []; print(r[0]['id'] if r else '')")
if [ -z "$ZID" ]; then
  echo "could not read zone $ZONE_NAME with this token"
  exit 2
fi
echo "zone: $ZID"

REC=$(curl -s -m 30 "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records?type=AAAA&name=$HOST" -H "$AUTH")
OK=$(echo "$REC" | python3 -c "import json,sys; print(json.load(sys.stdin).get('success'))")
if [ "$OK" != "True" ]; then
  echo "dns READ not permitted with this token: $(echo "$REC" | python3 -c "import json,sys; e=json.load(sys.stdin).get('errors') or [{}]; print(e[0].get('message',''))")"
fi

REC_ID=$(echo "$REC" | python3 -c "import json,sys; d=json.load(sys.stdin); r=d.get('result') or []; print(r[0]['id'] if r else '')")
CURRENT=$(echo "$REC" | python3 -c "import json,sys; d=json.load(sys.stdin); r=d.get('result') or []; print(r[0]['content'] if r else '')")

if [ "${1:-}" = "--check" ]; then
  if [ "$CURRENT" = "$ADDR" ]; then echo "in sync: $HOST -> $ADDR"; else
    echo "DRIFT: DNS has '${CURRENT:-<none>}', machine has '$ADDR'";
  fi
  exit 0
fi

if [ "$CURRENT" = "$ADDR" ]; then
  echo "already in sync: $HOST -> $ADDR"
  exit 0
fi

BODY=$(python3 -c "import json; print(json.dumps({'type':'AAAA','name':'$HOST','content':'$ADDR','ttl':300,'proxied':False}))")
if [ -n "$REC_ID" ]; then
  RES=$(curl -s -m 30 -X PUT "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records/$REC_ID" -H "$AUTH" -H "content-type: application/json" -d "$BODY")
else
  RES=$(curl -s -m 30 -X POST "https://api.cloudflare.com/client/v4/zones/$ZID/dns_records" -H "$AUTH" -H "content-type: application/json" -d "$BODY")
fi
SUCCESS=$(echo "$RES" | python3 -c "import json,sys; print(json.load(sys.stdin).get('success'))")
if [ "$SUCCESS" = "True" ]; then
  echo "updated: $HOST AAAA -> $ADDR (ttl 300; re-verify in a few minutes)"
  curl -s -o /dev/null -w "direct endpoint now: %{http_code}\n" -m 20 "https://$HOST:8791/v1/models" || true
else
  echo "DNS WRITE not permitted with this token: $(echo "$RES" | python3 -c "import json,sys; e=json.load(sys.stdin).get('errors') or [{}]; print(e[0].get('message',''))")"
  echo
  echo "MANUAL FIX (dashboard → $ZONE_NAME → DNS):"
  echo "  $HOST  AAAA  $ADDR  (ttl 300, DNS only)"
  echo "or mint a token with Zone.DNS:Edit for $ZONE_NAME and put it in"
  echo "~/.hermes/.env as CLOUDFLARE_DNS_TOKEN, then re-run this script."
  exit 3
fi
