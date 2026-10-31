# Moving a DNS site onto RAREXT

RAREXT does not ask anyone to leave the web they already have. A site that answers on a
hostname — any hostname, any certificate, any of today's servers, including a serverless
deployment that has nothing but a routing table and a static tree — can declare that it
serves a specific registry's copy of the record. After that, the network can say of its
bytes what it says of every other copy here: this is the registry's record, at the pinned
root, or it is not.

There is no migration step, no new server, and nothing to install on the site. The site
keeps its name, its TLS, and its deployment. It publishes one small statement.

## The statement, in either of two carriers

| Carrier | Where it goes | Who can do it |
| --- | --- | --- |
| A file | `/.well-known/rarext.json` on the site's own origin | any site that can serve bytes |
| A name record | `_rarext.<host>` `TXT` | any site that controls its name, not its tree |

Both carry the same statement, and they parse into one shape:

```
/.well-known/rarext.json
{"registry":"rarext","root":"<64-hex bundle root>"}

_rarext.example.com  TXT  "registry=rarext; root=<64-hex bundle root>"
```

Optional fields, in either carrier: `bundle` (where this site's copy of the bundle lives,
when it is not this host), `cid` (the content address, when the site pins one), and
`issuedAt`.

A site needs only one carrier. When both are present they must **agree**: a site whose file
and whose name record name different roots is reported as disagreeing, by carrier, rather
than averaged — the only honest reading of two contradictory statements is that one is
wrong, and an operator needs to know which one to go fix.

## What the statement does and does not do

It proposes a **location**, exactly as a [mirror announcement](../rfcs/0019-mirror-announcements.md)
does. It never states a fact. The verdict comes from comparing the declaration against the
root the **registry** pins — from its seed, its anchor, or the bundle a client already
verified:

- no pinned root to compare against → refused. A site's statement about itself is not
  evidence about itself, so `verifySiteBinding` will not certify anything without the
  registry's pin to check it against.
- the binding names a different root → `root-mismatch`. The site is serving a copy that is
  not the one its registry pins: a stale mirror, or someone else's copy under this name.
- the binding names another registry → `registry-mismatch`.

Those two findings are deliberately distinct. "This site is serving the wrong copy" and
"this site answers for a different registry" are different operator problems, and a single
"invalid" would hide which one they have.

## Every server is a node

A node here is not a special machine. It is any host that serves a registry's copy and
states its binding: an existing web server, a container, a serverless function with a static
tree, a laptop. RAREXT adds no daemon that must run, no port that must be open, and no
write path a site must accept — the file is static, the record is already DNS, and a client
verifies by recomputation rather than by trusting the host.

A host that wants to do more — publish, attest, run an API or an MCP server — can, and the
same tree runs all of it on plain `node` (see [OPERATIONS.md](OPERATIONS.md)). That is an
upgrade, not a requirement.

## What this is not

- **Not a name service, and not a replacement for DNS.** The hostname is still resolved by
  DNS and the bytes are still fetched over HTTPS. A binding sits *on top of* the existing
  name system so that today's sites can join without moving; it does not ask anyone to
  re-point a domain at infrastructure they do not control.
- **Not a trust transfer.** Declaring a binding grants nothing: no write access, no
  custody, no say in the registry.
- **Not a rewrite of the URL policy.** Fetching an arbitrary site's documents is subject to
  the same scheme, address, and redirect-hop policy as every other outbound read — see
  [HARDENING.md](HARDENING.md).

## Where this lives in code

| Piece | Where |
| --- | --- |
| The convention, parsed and verified | `packages/core/src/site-binding.ts`, exported from `@rarext/core` |
| The two carriers in one shape | `parseSiteBindingDocument`, `parseSiteBindingTxt`, `parseSiteBinding` |
| The verdict against the registry's pin | `verifySiteBinding` |
| Where to ask a site | `siteBindingUrl`, `siteBindingTxtName` |

Reading the documents and resolving the name record are deliberately **not** in core: core
decides what a statement means, and a caller decides how it reaches the site — through the
API's fetcher, the SDK's seed walk, a browser, or `dig`. This keeps the rule in one place and
the I/O wherever it belongs.
