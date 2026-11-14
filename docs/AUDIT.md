# Audit — repository, deployment, and the rarext.com question

Date: 2026-11-14. Scope: the whole repository's quality gates, its deployment
path, and the live hosts it claims. Every claim below is a command you can
re-run; the output is quoted, not summarised into a slogan.

## 1. Quality gates (local)

| Gate | Command | Result |
| --- | --- | --- |
| Types | `npx tsc --noEmit` | exit 0 |
| Web build | `npm run build:web` | exit 0 (bundles emitted) |
| Full suite | `node --test --test-concurrency=2 …` (all packages) | **1248 tests, 1248 pass** |
| Web suite alone | `node --test apps/web/test/*.test.ts` | 65 tests, 65 pass |
| Drift check | `npm run claim:check` | **9** mismatches (see §4) |
| Markdown links | `node /tmp/check-links.mjs` | 0 broken local links/anchors |

Note on the full suite: at the default test concurrency the boot-heavy
`apps/api/test/become-a-node.test.ts` cases flake under memory pressure (each
passes in isolation). `--test-concurrency=2` is green, and that is the run
recorded above.

## 2. Deployment path

The site is a pure projection of the committed `site/` tree onto the repository's
`gh-pages` branch (`scripts/deploy-site.mjs`), which GitHub Pages serves.

- Remote: `https://github.com/999svs999/RAREXT-protocol.git`; `origin/gh-pages`
  exists.
- Dry run: `node scripts/deploy-site.mjs --dry-run` → **26 files**, roots
  consistent, front door pinned to `ee1ddae4b73b…`. This is the exact byte list a
  deploy would publish.
- Live reference deployment is **in sync**: the live
  `…/registry/seed.json` reports `bundleRoot ee1ddae4b73ba6c1f7a05bf71fd1f27fefbcb3e7e39fab36cc8744da5bd3df18`,
  equal to the local committed root.

So the artifact is launchable; what is missing is a domain, not a build.

The deploy was also **run for real** against the reference host, not just dry-run:

```console
$ GIT_TERMINAL_PROMPT=0 node scripts/deploy-site.mjs
front door pinned: 1 proof link(s) carry root ee1ddae4b73b…
files  26
gh-pages already matches site/; nothing to commit
live index.html c07b0c925af5
…
  bundle content address matches the seed's pin (bafkreid6gpv35dlys…)
  seed names 2 distinct locations
live roots equal ee1ddae4b73ba6c1f7a05bf71fd1f27fefbcb3e7e39fab36cc8744da5bd3df18
live renditions bounded, exact, generative
live links checked 15
live AI 2 rendition(s) verified by recomputation against https://999svs999.github.io/RAREXT-protocol/mirror
$ echo $?
0
```

Every published file matches byte-for-byte at the live base, every root equals the
anchored root, the live bundle hashes to the content address the live seed pins,
the seed names two distinct mirror locations, the link crawl passes, and the live
AI renditions are re-derived by recomputation.

## 3. The rarext.com question — **blocked on domain control**

`rarext.com` (and `rarext.co`) **already serve a different, live site**: an
"RAREXT — We Build AI Systems That Actually Ship" AI consultancy, with its own
homepage, `llms.txt`, `/api/v1` API, an MCP server, and an npm CLI
(`rarext-cli`). Quoted live:

```
GET https://rarext.com        -> "RAREXT — We Build AI Systems That Actually Ship … consultancy …"
GET https://rarext.com/registry/seed.json   -> 404
GET https://rarext.co/.well-known/rarext.json -> 404
```

Neither host serves this repository's registry or its
`.well-known/rarext.json`, so this project is **not** deployed at `rarext.com`
today. Pointing `rarext.com` at this site requires one of:

1. control of the DNS for `rarext.com` (apex `A`/`AAAA` records, `www` CNAME) and
   the GitHub Pages custom-domain setting, or
2. access to whatever host currently answers for `rarext.com` and the ability to
   serve this `site/` tree there.

Both are credentials a machine here does not hold. This is the one step of
"launch on rarext.com" that only the operator can do — and it must be done
**before** a CNAME is published, because GitHub Pages redirects the
`*.github.io` URL to the custom domain the moment a `CNAME` file exists. Shipping
the CNAME first takes the current site down. The deploy therefore refuses to
publish a domain without an explicit confirmation flag.

`docs/LAUNCH.md` is the runbook. The mechanism is already wired and verified:

```console
$ node scripts/deploy-site.mjs --dry-run --domain rarext.com
files  27
domain rarext.com (CNAME)
  (generated) -> /CNAME c7012e3f21f2
$ node scripts/deploy-site.mjs --dry-run | grep -c CNAME
0
$ node scripts/deploy-site.mjs --domain rarext.com     # no confirmation
Error: refusing to publish a custom domain without RAREXT_LAUNCH_CONFIRM=1: …
$ node scripts/deploy-site.mjs --dry-run --domain 'not a domain'
Error: --domain is not a hostname: "not a domain"
```

So the launch is **one command** once DNS is ready, and cannot fire by accident.

## 4. Findings

### 4.1 Drift check is at 9, one above the recorded baseline of 8
`npm run claim:check` reports 9 mismatches. Eight are the long-standing,
pre-existing items; the ninth is
`\.ai-proof/mirror/styles.css is older than the served copy`. Cause: the site
mirror (`site/registry/mirror/*`) was regenerated by the repository's own ship
watchdog after the `.ai-proof` copy was last published, so the proof copy is one
revision behind. This is exactly the drift the check exists to surface; the fix
is the release pipeline (`scripts/publish-futuristic-proof.mjs`, run by
`scripts/ship-registry.mjs`), not a hand edit. It is not introduced by this
audit.

### 4.2 The friendly verifier is not in the published site
The human-facing verifier at `apps/web/public/verify.html` (added 2026-11-14) is
served by the **dev app** (`apps/api`) but is **not** part of the published site:
`deploy-site.mjs` republishes `site/` only, and the live `mirror/verify.html` is
the older, technical page generated by the publish scripts. To give live visitors
the one-sentence verifier, its bundle must be added to the mirror the publisher
emits. Recommended next step.

### 4.3 There is no CI
`.github/workflows` does not exist. "Shipping" is a local watchdog
(`scripts/ship-registry.mjs`) that anchors, tests, commits, pushes, deploys, and
federates. Nothing runs it but the operator's machine, so a deploy can only
happen from here.

### 4.4 The ship watchdog is environment-coupled
`scripts/ship-registry.mjs` reads a machine-local ledger
(`/Users/r/FUTURISTIC/state/ledger.jsonl`), a local media root
(`/Users/r/FUTURISTIC/state/media`), and a Cloudflare origin
(`https://futuristiclive.pages.dev/`). On any other machine the drift check
throws before it can ship. This is fine for one operator and a hazard for a
second, which matters the moment "launch" means "someone else can run it".

### 4.5 Absolute paths in release scripts
Several scripts embed `/Users/r/...` (the watchdog and the ecosystem checks).
Portability, not correctness: the runs here are on this host.

## 5. What is healthy

- 1248/1248 tests, types clean, links clean, the deploy artifact consistent and
  pinned, and the live reference deployment byte-equal to the committed root.
- The protocol's own promises are checked, not asserted: the deploy verifies
  live bytes, roots, the seed's content address, the two-distinct-location mirror
  rule, and re-derives the live AI renditions.

## 6. Launch status

| Item | Status |
| --- | --- |
| Site builds and is deploy-ready | ✅ (dry run, 26 files) |
| Reference deployment live and in sync | ✅ |
| One-command custom-domain launch wired + guarded | ✅ |
| `rarext.com` pointed at this project | ⛔ blocked: the domain serves a different site; needs its DNS/host |
| Human verifier on the published site | ⚠️ not yet (finding 4.2) |

The only thing standing between this repository and `rarext.com` is DNS the
operator controls. Give the word (and access), or run `docs/LAUNCH.md` yourself;
everything on this side is finished and verified.
