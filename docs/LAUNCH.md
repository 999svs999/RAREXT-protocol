# Launch the site on a custom domain (rarext.com)

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
