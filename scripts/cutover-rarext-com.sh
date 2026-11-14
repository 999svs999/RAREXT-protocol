#!/bin/bash
# Move rarext.com onto the Cloudflare Pages showcase, leaving rarext.co alone.
#
# rarext.com and rarext.co are BOTH custom domains of the Worker `rarext` today.
# The showcase is already deployed to the Pages project `rarext-com`, and
# `rarext.com` is registered on it but stuck `pending`: a Pages custom domain
# needs a proxied CNAME to the project, and the Worker's custom domain still owns
# the hostname. This script does the four remaining edits and verifies the live
# host. It refuses to start unless the candidate and the credential are ready —
# a refusal is the cheapest place to learn the destination is not.
#
#   bash scripts/cutover-rarext-com.sh           # dry run: checks only
#   bash scripts/cutover-rarext-com.sh --apply   # do it
#
# Required token permission: Zone.DNS:Edit for rarext.com, plus Workers:Edit to
# release the hostname from the Worker. The ops token in ~/.hermes/.env has
# neither (proven — see docs/LAUNCH.md); a broader token, or the two dashboard
# actions, is the missing piece.
set -uo pipefail

ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:-b37d1d7b1f289c7b37a637ad878bbb9e}"
ZONE="${RAREXT_COM_ZONE:-1975c4d2ffb4ffdadd366e1a5285df90}"
PROJECT="${PAGES_PROJECT:-rarext-com}"
PREVIEW="${PREVIEW:-https://${PROJECT}.pages.dev}"
DOMAIN="${DOMAIN:-https://rarext.com}"
APE="${APEX:-rarext.com}"
WWW="${WWW:-www.rarext.com}"
ROUTES="${ROUTES:-/ /mirror/verify.html /registry/ /styles.css}"
APPLY="${1:-}"

fail() { echo "REFUSING: $*"; exit 1; }
api() { curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" "$@"; }

# The token comes from the ops env at runtime, never from the repo.
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -f "$HOME/.hermes/.env" ]; then
  CLOUDFLARE_API_TOKEN=$(python3 -c "print(next(l.split('=',1)[1].strip().strip(chr(34)).strip(chr(39)) for l in open('$HOME/.hermes/.env') if l.startswith('CLOUDFLARE_API_TOKEN=')))")
  export CLOUDFLARE_API_TOKEN
fi
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fail "no CLOUDFLARE_API_TOKEN in the environment or ~/.hermes/.env"

# 1. The candidate must answer every route before anything moves.
echo "--- preflight: $PREVIEW ---"
bad=0
for p in $ROUTES; do
  code=$(curl -s -o /dev/null -m 45 -w "%{http_code}" "$PREVIEW$p")
  printf "  %-22s %s\n" "$p" "$code"
  case "$code" in 2*|3*) ;; *) bad=$((bad+1));; esac
done
[ "$bad" -eq 0 ] || fail "$bad route(s) unhealthy on the preview — a cutover would ship them broken"

# 2. The credential must be able to do the edits, or the run is a no-op that
#    looks like progress.
echo "--- permission probe ---"
probe=$(api -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
  --data "{\"type\":\"TXT\",\"name\":\"_rarext-cutover.${APE}\",\"content\":\"probe\",\"ttl\":60}")
rid=$(printf '%s' "$probe" | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('result') or {}).get('id','') if d.get('success') else '')")
if [ -z "$rid" ]; then
  printf '%s' "$probe" | python3 -c "import sys,json;d=json.load(sys.stdin);print('  dns write: DENIED —',json.dumps(d.get('errors'))[:120])"
  fail "this token cannot edit DNS for $APE. Give it Zone.DNS:Edit, or do the two dashboard actions in docs/LAUNCH.md."
fi
api -X DELETE "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/$rid" >/dev/null
echo "  dns write: permitted"

if [ "$APPLY" != "--apply" ]; then
  echo "dry run only. Re-run with --apply to move the domain."
  exit 0
fi

# 3. Register the Pages domain, then point the records at the project.
echo "--- pages domain ---"
api -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/pages/projects/$PROJECT/domains" \
  --data "{\"name\":\"$APE\"}" | python3 -c "import sys,json;d=json.load(sys.stdin);print('  add',d.get('success'),json.dumps(d.get('errors'))[:120])"
api -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/pages/projects/$PROJECT/domains" \
  --data "{\"name\":\"$WWW\"}" | python3 -c "import sys,json;d=json.load(sys.stdin);print('  add',d.get('success'),json.dumps(d.get('errors'))[:120])"

echo "--- dns records (proxied CNAMEs to $PROJECT.pages.dev) ---"
for host in "$APE" "$WWW"; do
  existing=$(api "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records?name=$host" | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('result') or [{}])[0].get('id',''))")
  if [ -n "$existing" ]; then
    api -X PUT "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/$existing" \
      --data "{\"type\":\"CNAME\",\"name\":\"$host\",\"content\":\"${PROJECT}.pages.dev\",\"proxied\":true,\"ttl\":1}" \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print('  update','$host',d.get('success'))"
  else
    api -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
      --data "{\"type\":\"CNAME\",\"name\":\"$host\",\"content\":\"${PROJECT}.pages.dev\",\"proxied\":true,\"ttl\":1}" \
      | python3 -c "import sys,json;d=json.load(sys.stdin);print('  create','$host',d.get('success'))"
  fi
done

# 4. Release the hostnames from the Worker `rarext`, or its custom domain keeps
#    intercepting. Account-level Worker domains; a user token may be required.
echo "--- release from the Worker ---"
for host in "$APE" "$WWW"; do
  id=$(api "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/domains" | python3 -c "import sys,json;d=json.load(sys.stdin);print(next((x.get('id') for x in (d.get('result') or []) if x.get('hostname')=='$host'),''))")
  if [ -z "$id" ]; then echo "  $host: not attached to a Worker (already moved)"; continue; fi
  api -X DELETE "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/domains/$id" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print('  detach','$host',d.get('success'),json.dumps(d.get('errors'))[:100])"
done

# 5. Verify the host customers use, not the one just deployed to.
echo "--- verifying $DOMAIN ---"
ok=0; tot=0
for p in $ROUTES; do
  tot=$((tot+1))
  code=$(curl -s -o /dev/null -m 60 -w "%{http_code}" "$DOMAIN$p")
  printf "  %-22s %s\n" "$p" "$code"
  case "$code" in 2*) ok=$((ok+1));; esac
done
echo "$ok/$tot routes healthy on $DOMAIN"
if [ "$ok" -lt "$tot" ]; then
  echo "ROLLBACK: re-add the Worker custom domain for $APE and delete the Pages domain + CNAME."
  exit 1
fi
echo "cutover complete. rarext.co is untouched."
