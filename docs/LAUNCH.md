# Launch the RAREXT web4 AI showcase on rarext.com

The showcase is the committed `site/` tree. It is already live on the reference
host (`https://999svs999.github.io/RAREXT-protocol/`), and `rarext.com` is a
Cloudflare-hosted property today, so there are two ways to put it at the sketch:
**Path A** keeps Cloudflare and replaces what `.com` serves; **Path B** moves the
domain to GitHub Pages. Both need a credential this repository does not hold.

> **`rarext.co` is not touched by either path.** It stays exactly as it is.

## Status (2026-11-15): deployed, one DNS step from live

- The showcase is **deployed** to the Pages project `rarext-com` and serving at
  `https://rarext-com.pages.dev/`.
- `rarext.com` is **registered on that project** (domain enabled; status
  `pending`, waiting on a CNAME).
- **Both `rarext.com` and `rarext.co` are custom domains of the Worker `rarext`**
  today, so the hostname has to be released from the Worker as well as recorded.
- `bash scripts/cutover-rarext-com.sh` probes every permission it needs before it
  changes anything, and refuses rather than half-move the domain.

**Which credential does what (measured 2026-11-15, not assumed):**

| Capability | Holder | Evidence |
| --- | --- | --- |
| Deploy Pages | ops token `~/.hermes/.env` | live deployments |
| **Workers:Edit** — release a custom domain, upload a script | ops token `~/.hermes/.env` | script upload reached the compiler; deleting a Worker custom domain returned `100114 Origin … not found`, not an auth error |
| Pages:Edit — attach a custom domain | login token `~/.hermes/cloudflare-oauth.json` | add + delete of a Pages custom domain succeeded |
| **Zone.DNS:Edit** — create/update the record | **nobody** | `Authentication error` on read and write, both zones |

So the earlier note that the ops token has "neither" was wrong: it has Workers.
The only genuinely missing permission is DNS, and no login can be given more
scope — an OAuth session may not mint an API token (`POST /user/tokens` returns
`9109 Unauthorized`).

Two more measured facts decide the order:

- **Pages does not create the record for you.** Attaching `pages-probe.rarext.com`
  left it `pending` with `"error_message": "CNAME record not set"` and DNS empty.
  `pending` is the permanent state of an unattached hostname.
- **The Worker release is one-way through the API.** `DELETE
  /accounts/…/workers/domains/{id}` works with the ops token, but `POST` to the
  same collection answers `10405 Method not allowed for this authentication
  scheme`. Restoring the custom domain is a dashboard action.

Either of these finishes it. Both need exactly one thing that does not exist on
this machine yet: **Zone.DNS:Edit**.

**Path 1 — one dashboard permission, no clicking through the move**

Create an API token with a single permission, `Zone → DNS → Edit`, limited to the
zone `rarext.com`, and put it in `~/.hermes/.env` as `CLOUDFLARE_DNS_TOKEN`. The
script then uses the ops token for the Worker half and the login token for the
Pages half:

```bash
bash scripts/cutover-rarext-com.sh          # dry run: preflight + permission probe
bash scripts/cutover-rarext-com.sh --apply  # release, record, attach, verify
```

**Path 2 — no token at all, four dashboard actions**

1. Workers & Pages → **`rarext`** (Worker) → Settings → Domains & Routes →
   remove `rarext.com` and `www.rarext.com`. **Leave `rarext.co` and
   `www.rarext.co` alone.** `rarext.com` is unreachable from here until step 2.
2. Workers & Pages → **`rarext-com`** (Pages) → Custom domains → add
   `rarext.com`, then `www.rarext.com`. The dashboard creates the proxied CNAMEs
   for you (the same shape `saikougoods.com` uses:
   `CNAME @  -> saikougoods.pages.dev`, proxied).

Either way the script verifies every route on the preview before touching
anything, and curls the live host afterwards. `rarext.co` is never touched.

Do it in this order, and do not pause between the two steps: while the hostname
is released from the Worker and not yet recorded for Pages, it resolves to
nothing. In the API path the gap is one round trip; in the dashboard path it is
however long you take to click step 2.

**What the move costs:** the Worker `rarext` answers `/api/v1`, `/llms.txt`, and
the MCP surface on `rarext.com` today. Pages serves the showcase for every path,
so those stop existing on `rarext.com` and keep working on `rarext.co`.

Confirm when done:

```bash
dig +short CNAME rarext.com          # -> rarext-com.pages.dev.
curl -s https://rarext.com/ | grep -o '<title>[^<]*</title>'
```

## Path A (reference) — the deploy itself

`rarext.com` resolves to Cloudflare Pages project `rarext-com`
(`rarext-com.pages.dev`), which is why `rarext.com/api/v1`, `/llms.txt`, and the
MCP surface exist. Deploying `site/` to that project replaces those pages with the
showcase — which is the intent, but note it **replaces** the current contents
(keep a copy of anything you want to serve alongside it).

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
