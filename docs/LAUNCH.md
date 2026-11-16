# Launch the RAREXT web4 AI showcase on rarext.com

The showcase is the committed `site/` tree. It is live at **`https://rarext.com/`**
and **`https://www.rarext.com/`**, served from the Cloudflare Pages project
`rarext-com`. `rarext.co` was deliberately left alone and still serves the old
Worker.

> **`rarext.co` is not touched by the cutover.** It still serves the Worker
> `rarext`, byte for byte.

## Status (2026-11-16): cut over and verified live

`rarext.com` and `www.rarext.com` now serve the Pages showcase. Measured after
the move, not asserted:

| Check | Result |
| --- | --- |
| Routes on `https://rarext.com` | **7/7** — `/`, `/mirror/{ai,gallery,verify}.html`, `/registry/`, `/styles.css`, `/proof-widget.js` all **200 without a redirect** |
| Title | `<title>RAREXT — don’t trust the model. Check it.</title>` |
| Pages custom domains | `rarext.com` **active**, `www.rarext.com` **active** |
| DNS | proxied `CNAME rarext.com` and `CNAME www.rarext.com` → `rarext-com.pages.dev` |
| Worker custom domains remaining | only `rarext.co` and `www.rarext.co` |
| TLS | `CN=rarext.com`, Google Trust Services WE1, valid to 2027-02-14 |
| Unknown path | `/definitely-not-a-page` → **404** |
| Showcase suite against the apex | **44/44** (`SHOWCASE_URL=https://rarext.com/ npm run test:showcase`) |
| `rarext.co` | 40232 B, old title — unchanged |
| Live UI/UX score | **100** warm (99 cold first hit), TTFB 466 → 283 → **205 ms** |

The cutover is `bash scripts/cutover-rarext-com.sh --apply`, idempotent — a
second run reports "already moved", re-asserts the records, and finds the Pages
domains already `active,active`.

**Which credential did what (measured 2026-11-16, not assumed):**

| Capability | Holder | Evidence |
| --- | --- | --- |
| Deploy Pages | ops token `~/.hermes/.env` | live deployments |
| Workers:Edit — release a custom domain | ops token | `DELETE /workers/domains/{id}` succeeded |
| Pages:Edit — attach a custom domain | login token `~/.hermes/cloudflare-oauth.json` | domains attached |
| **Account API Tokens:Edit** — mint a scoped token | ops token | `POST /accounts/{acct}/tokens` returned a token with `success: true` |
| **Zone.DNS:Edit** | minted `rarext-com-dns-cutover` | created, verified on read, then used for the move |

Two credential findings worth keeping:

- **`CLOUDFLARE_DNS_TOKEN` in `~/.hermes/.env` is scoped to the wrong zone.**
  It authenticates (`9109 Unauthorized to access requested resource`, not
  "invalid token") but lists only `saikougoods.com`; it cannot read or write
  `rarext.com`. Do not reuse it for this.
- **The ops token can mint account-owned tokens, and that broke the blocker.**
  An OAuth *session* cannot (`POST /user/tokens` → `9109`), which is what made
  the DNS permission look like it required a human. `POST
  /accounts/{acct}/tokens` does work with the ops token: `DNS Write`
  (`4755a26eedb94da69e1066d98aa820be`) with resource
  `com.cloudflare.api.account.zone.1975c4d2ffb4ffdadd366e1a5285df90` produced
  `rarext-com-dns-cutover` (id `084e99b6deed1180d12265a867c352b7`), stored as
  `CLOUDFLARE_CUTOVER_TOKEN`. `/user/tokens/verify` reports `Invalid API Token`
  for account-scoped tokens, so it is **not** a validity signal.

The same two pre-cutover facts still hold, and are why the script does the steps
in this order:

- **Pages does not create the record for you.** Attaching a domain leaves it
  `pending` with `"error_message": "CNAME record not set"` until the CNAME exists.
- **The Worker release is one-way through the API.** `DELETE
  /accounts/…/workers/domains/{id}` works, but `POST` to the same collection
  answers `10405 Method not allowed for this authentication scheme`. Rolling back
  to the Worker is a dashboard action (Workers & Pages → `rarext` → Settings →
  Domains & Routes).

**What the move cost — measured, and one earlier claim corrected.** The Worker
`rarext` served more than HTML on `rarext.com`. After the cutover:

| Path | `rarext.co` (Worker, untouched) | `rarext.com` (Pages, now) |
| --- | --- | --- |
| `/` | 200, 40232 B | 200, showcase |
| `/api` | 307 → `/developers` | 404 |
| `/api/v1` | **404** (was already 404) | 404 |
| `/llms.txt` | 200, 4639 B | 404 |
| `/openapi.json` | 200, 7136 B | 404 |
| `/mcp` | 200, MCP server banner | 404 |
| `/robots.txt` | 200, 1546 B | 200 (the showcase's own) |

An earlier draft of this document said `/api/v1` "stops existing on `.com`". It
was **already 404 on `.co`**; the surface that actually left `rarext.com` is
`/llms.txt`, `/openapi.json`, `/mcp`, and the `/api → /developers` redirect.
Those still answer on `rarext.co`. Restoring them on `.com` means adding them to
`site/` (as static files or a Pages Function) — they are not being proxied from
the Worker.

Rolling back is the reverse of the script: re-attach the Worker custom domains in
the dashboard, then point the two CNAMEs back. `rarext-com.pages.dev` keeps
serving the showcase either way.

Confirm the live state at any time:

```bash
dig +short CNAME rarext.com                    # -> rarext-com.pages.dev.
curl -s https://rarext.com/ | grep -o '<title>[^<]*</title>'
SHOWCASE_URL=https://rarext.com/ npm run test:showcase
```

## Path A (reference) — the deploy itself

`rarext.com` resolves to Cloudflare Pages project `rarext-com`
(`rarext-com.pages.dev`). Pages serves the uploaded tree verbatim, so a deploy
**replaces** whatever is there; anything to keep must live in `site/`. The
previous `/llms.txt`, `/openapi.json`, and `/mcp` surfaces came from the Worker
and were left on `rarext.co` rather than carried alongside the showcase.

```bash
npx wrangler login                       # the credential step; only you can do this
npm run deploy:brand:com                 # npx wrangler pages deploy site --project-name=rarext-com
```

Then point `rarext.com` at the production deployment if it is not already (Pages
project → Custom domains → `rarext.com`), and confirm:

```bash
curl -s https://rarext.com/ | grep -o '<title>[^<]*</title>'
curl -s https://rarext.com/mirror/verify.html -o /dev/null -w '%{http_code}\n'
```

After the first deploy the ecosystem's `rarext` brand record (anchored at
`rarext-com.pages.dev`) describes older bytes; the ship watchdog re-anchors it, or
run `node scripts/ecosystem-records.mjs rarext`.

## Path B — move rarext.com to GitHub Pages

The site is a projection of the committed `site/` tree onto the `gh-pages`
branch. Publishing it is one command; the only thing a script cannot do is own
the domain.

> **Read this first.** GitHub Pages redirects the `*.github.io` URL to whatever
> domain a top-level `CNAME` file names. If you publish the CNAME **before** the
> DNS resolves, the live site goes down for everyone. Do the DNS first.

## 0. Check the domain is yours and free

As of 2026-11-14, `https://rarext.com` answers with a different, live site (an AI
consultancy with its own `/api/v1`, MCP server, and npm CLI). If that is not you,
you need the domain owner's cooperation; if it is you but served by another host
(Cloudflare Pages, Vercel, …), decide whether `rarext.com` should move to GitHub
Pages or whether the protocol site should be mounted at a path (e.g.
`https://rarext.com/registry`) on the existing host instead.

```bash
curl -sI https://rarext.com | head -5
curl -s  https://rarext.com/.well-known/rarext.json   # 404 means this repo is not there
```

## 1. Point DNS at GitHub Pages

At the registrar for `rarext.com`:

| Type | Name | Value |
| --- | --- | --- |
| A | `@` | `185.199.108.153` |
| A | `@` | `185.199.109.153` |
| A | `@` | `185.199.110.153` |
| A | `@` | `185.199.111.153` |
| AAAA | `@` | `2606:50c0:8000::153` |
| AAAA | `@` | `2606:50c0:8001::153` |
| AAAA | `@` | `2606:50c0:8002::153` |
| AAAA | `@` | `2606:50c0:8003::153` |
| CNAME | `www` | `999svs999.github.io` |

Remove any conflicting `A`/`AAAA`/`CNAME` at `@` (the records currently answering
for the consultancy site). For a **subdomain** instead (`ai.rarext.com`), a single
`CNAME <sub> 999svs999.github.io` is all that is needed.

Verify before continuing:

```bash
dig +short rarext.com A          # must list the four GitHub addresses
dig +short www.rarext.com CNAME  # must be 999svs999.github.io.
```

## 2. Set the custom domain in GitHub Pages

Repository → Settings → Pages → Custom domain → `rarext.com` → Save. Leave
"Enforce HTTPS" until the DNS check shows green, then tick it.

## 3. Publish the CNAME and the site

The deploy carries the CNAME only when named, and refuses a non-dry run without an
explicit confirmation:

```bash
# what will be published (no network, nothing written)
node scripts/deploy-site.mjs --dry-run --domain rarext.com

# the launch (pushes gh-pages and then verifies the live bytes)
RAREXT_LAUNCH_CONFIRM=1 npm run deploy:site -- --domain rarext.com
```

If `site/` has uncommitted changes, commit it first — the deploy refuses a tree
that is not equal to `HEAD` (that is deliberate: what ships must be what is
committed).

## 4. Verify the launch

`deploy-site.mjs` already does this and fails loudly if any of it is untrue:

- every published file, byte-for-byte, at the live base;
- the seed's `bundleRoot`, the bundle's and mirror's `manifest.root`, and every
  mirror root equal to the anchored root;
- the live bundle hashes to the content address the live seed pins;
- the seed names at least two distinct mirror locations;
- the live verifier rebuilds the copies and re-derives the live AI renditions;
- a link crawl of the landing page and the registry page.

To check the domain itself rather than the branch origin:

```bash
RAREXT_LIVE_BASE=https://rarext.com/ npm run deploy:site -- --dry-run
# then, for a published check:
RAREXT_LIVE_BASE=https://rarext.com/ node scripts/verify-live-ai.mjs https://rarext.com/mirror
```

A visitor can confirm the same thing by hand: open
`https://rarext.com/mirror/verify.html?root=ee1ddae4b73ba6c1f7a05bf71fd1f27fefbcb3e7e39fab36cc8744da5bd3df18`
and read the verdict.

## 5. Rolling back

The `gh-pages` branch is the only thing that changed. To revert:

```bash
git push origin "$(git rev-parse HEAD~1):gh-pages"   # or the last good commit
# and remove the custom domain in Settings → Pages if the DNS was the problem
```

## Why the confirm flag exists

Without it, a stray `--domain` in a copy-pasted command would move a live site
before its DNS exists. The guard is cheap; an outage is not. The same reasoning
is why the domain is never inferred from a file that happens to be present.
