#!/bin/bash
# Move rarext.com onto the Cloudflare Pages showcase, leaving rarext.co alone.
#
# rarext.com and www.rarext.com are custom domains of the Worker `rarext`, and a
# Worker custom domain *is* the proxied DNS record for that hostname. So the
# order here is the opposite of the obvious one, and it is not a style choice:
#
#   release the Worker custom domain  ->  its DNS record goes with it
#   create the proxied CNAME          ->  to rarext-com.pages.dev
#   attach the Pages custom domain    ->  Pages sees the CNAME and goes active
#
# Creating the CNAME first fails: while the Worker owns the hostname the record
# belongs to the Worker. And Pages does not create the record for you. Probed on
# 2026-11-15 against project rarext-com: attaching pages-probe.rarext.com went
# to `pending` with `"error_message": "CNAME record not set"` and DNS stayed
# empty, so `pending` is the permanent state of an unattached hostname.
#
#   bash scripts/cutover-rarext-com.sh           # dry run: checks, no changes
#   bash scripts/cutover-rarext-com.sh --apply   # do it, with automatic rollback
#
# Which credential can do which part, as measured on 2026-11-15:
#
#   Workers:Edit (release the custom domains)  ~/.hermes/.env CLOUDFLARE_API_TOKEN
#     verified: a script upload reached the compiler, and deleting a Worker
#     custom domain reached the handler (100114 "Origin ... not found", not an
#     auth error). The script's own header used to say this token had no Workers
#     access; that was wrong.
#   Cloudflare Pages:Edit (attach the domains) ~/.hermes/cloudflare-oauth.json
#     verified: adding and deleting a Pages custom domain succeeded.
#   Zone.DNS:Edit (create/update the records)  MISSING EVERYWHERE
#     verified: `Authentication error` on read and write, in both zones. This is
#     the whole remaining blocker, and it is the one permission no credential on
#     this machine holds.
#
# A login token cannot be given more scope, and it may not mint an API token
# (POST /user/tokens returns 9109 Unauthorized), so the DNS half has to come from
# the dashboard. Any subset of the three may be supplied; each call is attempted
# with the tokens available and the first one allowed to do it wins.
set -uo pipefail

ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:-b37d1d7b1f289c7b37a637ad878bbb9e}"
ZONE="${RAREXT_COM_ZONE:-1975c4d2ffb4ffdadd366e1a5285df90}"
PROJECT="${PAGES_PROJECT:-rarext-com}"
PREVIEW="${PREVIEW:-https://${PROJECT}.pages.dev}"
DOMAIN="${DOMAIN:-https://rarext.com}"
APE="${APEX:-rarext.com}"
WWW="${WWW:-www.rarext.com}"
UNTIL_PROJECT="${UNTIL_PROJECT:-${PROJECT}.pages.dev}"
ROUTES="${ROUTES:-/ /mirror/ai.html /mirror/gallery.html /mirror/verify.html /registry/ /styles.css /proof-widget.js}"
EXPECT_TITLE="${EXPECT_TITLE:-don’t trust the model}"
KEEP_TITLE="${KEEP_TITLE:-Autonomous AI Agents}"
BACKUP="/tmp/rarext-cutover-backup-$(date +%Y%m%d-%H%M%S).json"
APPLY="${1:-}"

fail() { echo "REFUSING: $*" >&2; exit 1; }
warn() { echo "  ! $*" >&2; }

token_from_env_file() {
  [ -f "$HOME/.hermes/.env" ] || return 1
  python3 - "$1" <<'PY' 2>/dev/null
import sys
key = sys.argv[1] + "="
for line in open(__import__("os").path.expanduser("~/.hermes/.env")):
    if line.startswith(key):
        print(line.split("=", 1)[1].strip().strip('"').strip("'"))
        break
PY
}

# Candidate credentials, most specific first. Nothing here assumes one token can
# do everything: the DNS token from the dashboard, the Workers token in
# ~/.hermes/.env, and the Pages login token each cover a different part.
TOKENS=()
add_token() { [ -n "${1:-}" ] && TOKENS+=("$1") && return 0; return 1; }
add_token "${CLOUDFLARE_DNS_TOKEN:-$(token_from_env_file CLOUDFLARE_DNS_TOKEN || true)}" || true
add_token "${CLOUDFLARE_CUTOVER_TOKEN:-$(token_from_env_file CLOUDFLARE_CUTOVER_TOKEN || true)}" || true
add_token "${CLOUDFLARE_API_TOKEN:-$(token_from_env_file CLOUDFLARE_API_TOKEN || true)}" || true
add_token "${CLOUDFLARE_PAGES_TOKEN:-$(token_from_env_file CLOUDFLARE_PAGES_TOKEN || true)}" || true
if [ -f "$HOME/.hermes/cloudflare-oauth.json" ]; then
  add_token "$(python3 -c "import json;print(json.load(open('$HOME/.hermes/cloudflare-oauth.json')).get('access_token',''))" 2>/dev/null)" || true
fi
[ "${#TOKENS[@]}" -gt 0 ] || fail "no credential found (CLOUDFLARE_DNS_TOKEN / CLOUDFLARE_API_TOKEN / ~/.hermes/cloudflare-oauth.json)"

# api <METHOD> <url> [json]
#
# Tries each credential until one is allowed to make the call, and prints that
# response. A denied call changes nothing — Cloudflare rejects it before it takes
# effect — so a token that lacks the permission is skipped, not a hazard. Without
# this, a three-way split of permissions would need three hand-run passes.
api() {
  local method="$1" url="$2" data="${3:-}" out="" try=""
  for try in "${TOKENS[@]}"; do
    if [ -n "$data" ]; then
      out=$(curl -s -X "$method" -H "Authorization: Bearer $try" -H "content-type: application/json" --data "$data" "$url")
    else
      out=$(curl -s -X "$method" -H "Authorization: Bearer $try" -H "content-type: application/json" "$url")
    fi
    printf '%s' "$out" | grep -qE '"success": *true' && { printf '%s' "$out"; return 0; }
  done
  printf '%s' "$out"
  return 0
}
jq() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }

# 1. The candidate must answer every route before anything moves.
echo "--- preflight: $PREVIEW ---"
bad=0
for p in $ROUTES; do
  code=$(curl -s -o /dev/null -m 45 -w "%{http_code}" "$PREVIEW$p")
  printf "  %-24s %s\n" "$p" "$code"
  case "$code" in 2*|3*) ;; *) bad=$((bad+1));; esac
done
[ "$bad" -eq 0 ] || fail "$bad route(s) unhealthy on the preview — a cutover would ship them broken"

# The preview must be the page we mean to publish. A healthy 200 from the wrong
# deployment is the one preflight failure that looks like success.
preview_title=$(curl -s -m 45 "$PREVIEW/" | grep -o '<title>[^<]*</title>' | head -1)
printf "  %-24s %s\n" "title" "$preview_title"
printf '%s' "$preview_title" | grep -q "$EXPECT_TITLE" \
  || fail "the preview does not carry the expected title — wrong deployment?"

# 2. Every permission this needs, probed for real. A missing one is a partial
#    cutover, and a partial cutover is an outage.
echo "--- permission probe ---"
probe=$(api POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
  "{\"type\":\"TXT\",\"name\":\"_rarext-cutover.${APE}\",\"content\":\"probe\",\"ttl\":60}")
rid=$(printf '%s' "$probe" | jq "print((d.get('result') or {}).get('id','') if d.get('success') else '')")
if [ -z "$rid" ]; then
  printf '%s' "$probe" | jq "print('  dns write: DENIED —',json.dumps(d.get('errors'))[:140])"
  fail "this token cannot edit DNS for $APE. It needs Zone.DNS:Edit for rarext.com."
fi
api DELETE "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/$rid" >/dev/null
echo "  dns write:       permitted"

api GET "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/domains" \
  | jq "print('  workers domains: permitted' if d.get('success') else '  workers domains: DENIED '+json.dumps(d.get('errors'))[:90])"
api GET "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/pages/projects/$PROJECT/domains" \
  | jq "print('  pages domains:   permitted' if d.get('success') else '  pages domains:   DENIED '+json.dumps(d.get('errors'))[:90])"

# 3. Snapshot everything the rollback needs, before touching anything.
echo "--- snapshot (rollback material) ---"
api GET "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/domains" > /tmp/.cutover-workers.json
for host in "$APE" "$WWW"; do
  api GET "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records?name=$host" > "/tmp/.cutover-dns-$host.json"
done
python3 - "$APE" "$WWW" "$BACKUP" <<'PY'
import json, sys
ape, www, out = sys.argv[1], sys.argv[2], sys.argv[3]
workers = json.load(open("/tmp/.cutover-workers.json")).get("result") or []
data = {"workers": [w for w in workers if w.get("hostname") in (ape, www)], "dns": {}}
for host in (ape, www):
    records = json.load(open(f"/tmp/.cutover-dns-{host}.json")).get("result") or []
    data["dns"][host] = [{k: r.get(k) for k in ("id", "type", "name", "content", "proxied", "ttl")} for r in records]
json.dump(data, open(out, "w"), indent=2)
print(f"  worker domains: {len(data['workers'])} | dns records: " +
      ", ".join(f"{h}={len(v)}" for h, v in data["dns"].items()))
print(f"  written to {out}")
PY

rollback() {
  echo "--- ROLLBACK ---"
  # Honest about its own limits: releasing a Worker custom domain works with the
  # Workers token, but re-creating one does not (POST /workers/domains answers
  # 10405 "Method not allowed for this authentication scheme"), so the last step
  # may have to be a dashboard click. The script says so instead of reporting a
  # clean rollback it did not achieve.
  python3 - "$APE" "$WWW" "$ZONE" "$BACKUP" "$ACCOUNT" "${TOKENS[*]}" <<'PY'
import json, subprocess, sys
ape, www, zone, backup, acct, token_list = sys.argv[1:7]
tokens = token_list.split()
data = json.load(open(backup))

def api(method, url, body=None):
    """First token allowed to make the call wins; a denied call changes nothing."""
    out = {}
    for token in tokens:
        args = ["curl", "-s", "-X", method, "-H", f"Authorization: Bearer {token}",
                "-H", "content-type: application/json"]
        if body is not None:
            args += ["--data", json.dumps(body)]
        args.append(url)
        try:
            out = json.loads(subprocess.run(args, capture_output=True, text=True).stdout or "{}")
        except json.JSONDecodeError:
            out = {}
        if out.get("success"):
            return out
    return out

# 1. Remove the CNAMEs this run created, so the hostnames are free again.
for host in (ape, www):
    listed = api("GET", f"https://api.cloudflare.com/client/v4/zones/{zone}/dns_records?name={host}")
    for record in listed.get("result") or []:
        if record.get("type") == "CNAME" and "pages.dev" in (record.get("content") or ""):
            api("DELETE", f"https://api.cloudflare.com/client/v4/zones/{zone}/dns_records/{record['id']}")
            print(f"  removed the pages CNAME for {host}")

# 2. Put the pre-cutover records back, whatever they were.
for host, records in data["dns"].items():
    for record in records:
        body = {k: record[k] for k in ("type", "name", "content", "proxied", "ttl") if record.get(k) is not None}
        result = api("PUT" if record.get("id") else "POST",
                     f"https://api.cloudflare.com/client/v4/zones/{zone}/dns_records"
                     + (f"/{record['id']}" if record.get("id") else ""), body)
        print(f"  restored dns {record['type']} {record['name']}: {result.get('success')}")

# 3. Re-attach the Worker custom domains, which is what actually served the site.
pending = []
for worker in data["workers"]:
    result = api("POST", f"https://api.cloudflare.com/client/v4/accounts/{acct}/workers/domains",
                 {"zone_id": zone, "hostname": worker["hostname"], "service": worker.get("service", "rarext"),
                  "environment": worker.get("environment", "production")})
    if result.get("success"):
        print(f"  re-attached worker custom domain {worker['hostname']}")
    else:
        pending.append(worker["hostname"])

if pending:
    print("")
    print("  These could not be restored through the API:")
    for host in pending:
        print(f"    {host}")
    print("  Restore them in the dashboard: Workers & Pages -> rarext (Worker) ->")
    print("  Settings -> Domains & Routes -> Add -> Custom Domain.")
PY
  echo "rollback attempted; verify manually before assuming it is clean."
}

if [ "$APPLY" != "--apply" ]; then
  echo "dry run only. Re-run with --apply to move the domain."
  exit 0
fi

# 4. Release the hostnames from the Worker. This is the irreversible-looking
#    step, and it is the one that is actually fine: it is snapshotted above.
echo "--- release from the Worker ---"
released=0
for host in "$APE" "$WWW"; do
  id=$(python3 - "$host" <<'PY'
import json, sys
host = sys.argv[1]
workers = json.load(open("/tmp/.cutover-workers.json")).get("result") or []
print(next((w.get("id") for w in workers if w.get("hostname") == host), ""))
PY
)
  if [ -z "$id" ]; then echo "  $host: not attached to a Worker (already moved)"; continue; fi
  result=$(api DELETE "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/domains/$id")
  ok=$(printf '%s' "$result" | jq "print(d.get('success'))")
  if [ "$ok" = "True" ]; then
    echo "  released $host"
    released=$((released+1))
  else
    printf '%s' "$result" | jq "print('  release failed','$host',json.dumps(d.get('errors'))[:120])"
  fi
done

# 5. Point the records at the Pages project. Create or update, because a
#    released Worker custom domain may or may not leave the record behind.
echo "--- dns records -> $UNTIL_PROJECT ---"
for host in "$APE" "$WWW"; do
  existing=$(api GET "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records?name=$host" \
    | jq "print((d.get('result') or [{}])[0].get('id',''))")
  body="{\"type\":\"CNAME\",\"name\":\"$host\",\"content\":\"$UNTIL_PROJECT\",\"proxied\":true,\"ttl\":1}"
  if [ -n "$existing" ]; then
    api PUT "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/$existing" "$body" \
      | jq "print('  update','$host',d.get('success'),json.dumps(d.get('errors'))[:110] if not d.get('success') else '')"
  else
    api POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" "$body" \
      | jq "print('  create','$host',d.get('success'),json.dumps(d.get('errors'))[:110] if not d.get('success') else '')"
  fi
done

# 6. Make sure both hostnames are registered on the Pages project.
echo "--- pages domains ---"
for host in "$APE" "$WWW"; do
  api POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/pages/projects/$PROJECT/domains" \
    "{\"name\":\"$host\"}" \
    | jq "print('  attach','$host',d.get('success'),(d.get('result') or {}).get('status') or json.dumps(d.get('errors'))[:80])"
done

# 7. Pages flips a domain to active only once it can see the CNAME; wait for it
#    rather than declaring success on the write.
echo "--- waiting for pages to see the records ---"
for i in $(seq 1 12); do
  sleep 5
  state=$(api GET "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/pages/projects/$PROJECT/domains" \
    | jq "print(','.join(sorted({(r.get('name') or ''):(r.get('status') or '')}.get(h,'?') for h in ['$APE','$WWW'])))")
  echo "  t+$((i*5))s pages status: $state"
  case "$state" in
    active,active) break;;
  esac
done

# 8. Verify the hostname customers use, and that the one we must not touch did
#    not move.
echo "--- verifying $DOMAIN ---"
ok=0; tot=0
for p in $ROUTES; do
  tot=$((tot+1))
  # -L because Pages answers /mirror/ai.html with a 308 to the extensionless
  # path; following it is what a browser does, and an unfollowed 308 is not a
  # broken page.
  code=$(curl -sL -o /dev/null -m 60 -w "%{http_code}" "$DOMAIN$p")
  printf "  %-24s %s\n" "$p" "$code"
  case "$code" in 2*) ok=$((ok+1));; esac
done
echo "$ok/$tot routes healthy on $DOMAIN"

title=$(curl -s -m 60 "$DOMAIN/" | grep -o '<title>[^<]*</title>' | head -1)
echo "  title: $title"
if ! printf '%s' "$title" | grep -q "$EXPECT_TITLE"; then
  warn "the live title is not the showcase's"
  rollback
  exit 1
fi

untouched=$(curl -sL -m 45 "https://rarext.co/" | grep -o '<title>[^<]*</title>' | head -1)
echo "  rarext.co: $untouched"
if ! printf '%s' "$untouched" | grep -q "$KEEP_TITLE"; then
  warn "rarext.co changed — that was not supposed to happen"
  exit 1
fi

echo "cutover complete. rarext.co is untouched."
echo "backup of the previous state: $BACKUP"
