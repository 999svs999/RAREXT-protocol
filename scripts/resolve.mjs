#!/usr/bin/env node
// Resolve a RAREXT reference, and say what was verified or refused.
//
//   node scripts/resolve.mjs 'rarext:example.com/registry/bundle.json@<64-hex root>'
//   node scripts/resolve.mjs 'rarext:127.0.0.1:8787/v1/bundles/latest@<root>' --scheme http
//   node scripts/resolve.mjs 'rarext:<root>' --candidate https://example.com/registry/bundle.json
//
// A reference says what is meant and where to look. This says what was found: the candidates are
// walked (by the SDK's own search — this adds no second one) and only a copy whose recomputed root
// equals the root the reference CARRIES is accepted. A location is a hint, so a wrong copy is
// refused by name and the next candidate is tried, and a bare root is refused outright with no
// candidates to try — it names an object, not a place.
//
// Plain `node`, no install. Exit 0 when a copy verified, 1 when none did, 2 for a usage error.

import { resolveRarextUri } from "../packages/agent-sdk/src/index.ts";
import { formatRarextUri, parseRarextUri } from "../packages/core/src/index.ts";

const argv = process.argv.slice(2);
const positional = [];
const candidates = [];
let scheme = "https";
let asJson = false;

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--scheme") {
    scheme = argv[++index];
    if (scheme !== "http" && scheme !== "https") {
      console.error(`unknown scheme ${scheme}: a reference resolves over http or https`);
      process.exit(2);
    }
  } else if (arg === "--candidate") candidates.push(argv[++index]);
  else if (arg === "--json") asJson = true;
  else if (arg.startsWith("--")) {
    console.error(`unknown option ${arg}`);
    process.exit(2);
  } else positional.push(arg);
}

if (positional.length !== 1) {
  console.error(
    "usage: node scripts/resolve.mjs <rarext:...> [--scheme http|https] [--candidate <url> ...] [--json]",
  );
  process.exit(2);
}

const reference = positional[0];
const parsed = parseRarextUri(reference);
const resolved = await resolveRarextUri(reference, { scheme, candidates });

const outcome = {
  reference,
  canonical: parsed.ok ? formatRarextUri(parsed.uri) : null,
  parseError: parsed.ok ? null : parsed.reason,
  resolved: resolved.ok
    ? {
        kind: resolved.kind,
        root: resolved.root,
        source: resolved.source,
        candidates: resolved.candidates,
        // A LENGTH, never the bytes: a caller that wants the object fetches it, and a JSON dump of
        // a model file would help nobody. The media type is cheap and says what was served.
        ...(resolved.kind === "blob" ? { bytes: resolved.bytes?.length, mediaType: resolved.mediaType } : {}),
        // A record is small enough to name, and naming it is the point: whoever holds the root can
        // see WHICH record answered, not merely that something did.
        // Name WHAT answered. A record is small enough to name, and naming it is the point: whoever
        // holds the root can see which record answered, not merely that something did. An anchor's
        // receipts stay out — they are evidence for a chain read, not for a summary line.
        ...(resolved.kind === "credit"
          ? {
              record: {
                keyId: resolved.record?.keyId,
                action: resolved.record?.action,
                bounty: resolved.record?.bounty,
                challengeId: resolved.record?.challengeId,
                at: resolved.record?.at,
              },
            }
          : resolved.kind === "publication"
          ? {
              record: {
                id: resolved.record?.id,
                author: resolved.record?.author,
                title: resolved.record?.title,
              },
            }
          : resolved.kind === "anchor"
            ? {
                record: {
                  anchoredRoot: resolved.record?.root,
                  leafCount: resolved.record?.leafCount,
                  adapter: resolved.record?.adapter,
                  reference: resolved.record?.reference,
                },
              }
            : {}),
      }
    : null,
  error: resolved.ok ? null : resolved.reason,
  attempts: resolved.attempts,
};

if (asJson) {
  console.log(JSON.stringify(outcome, null, 2));
  process.exit(resolved.ok ? 0 : 1);
}

if (!parsed.ok) {
  console.error(`NOT A RAREXT REFERENCE: ${parsed.reason}`);
  process.exit(1);
}

console.log(`reference ${formatRarextUri(parsed.uri)}`);
const tally = {};
for (const attempt of resolved.attempts) {
  console.log(`  [${attempt.kind}] ${attempt.url}\n    ${attempt.reason}`);
  tally[attempt.kind] = (tally[attempt.kind] ?? 0) + 1;
}
if (resolved.attempts.length > 0) {
  console.log(
    "  attempts: " +
      Object.entries(tally)
        .map(([kind, count]) => `${kind} ${count}`)
        .join(" · "),
  );
}

if (!resolved.ok) {
  console.error(`\nNOT VERIFIED: ${resolved.reason}`);
  process.exit(1);
}

const what =
  resolved.kind === "blob"
    ? `a blob of ${resolved.bytes?.length ?? 0} bytes${resolved.mediaType ? ` (${resolved.mediaType})` : ""}, by the sha256 of its bytes`
    : resolved.kind === "publication"
      ? `a published record by ${resolved.record?.author ?? "an author"} ("${resolved.record?.title ?? ""}"), by the root the record rebuilds to`
      : resolved.kind === "anchor"
        ? `an anchor of ${resolved.record?.leafCount ?? "?"} publication(s) via ${resolved.record?.adapter ?? "an adapter"}${resolved.record?.reference ? ` (${resolved.record.reference})` : ""}, by the root the anchor rebuilds to`
        : resolved.kind === "credit"
          ? `a credit of ${resolved.record?.bounty ?? "?"} credit(s) to ${resolved.record?.keyId ?? "a key"} for ${resolved.record?.action ?? "work"} on ${resolved.record?.challengeId ?? "a challenge"}, by the root the receipt rebuilds to`
          : "a registry bundle, by the root its content rebuilds to";
console.log(`\nVERIFIED: ${resolved.root} — ${what} — read from ${resolved.source}`);
console.log(
  "The root decides: this copy is the object the reference named, wherever it was found, and " +
    "`rarext:" +
    resolved.root.slice(0, 16) +
    "…` names it without naming a location at all.",
);
process.exit(0);
