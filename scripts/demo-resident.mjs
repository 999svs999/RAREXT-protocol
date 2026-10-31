#!/usr/bin/env node
/**
 * demo-resident.mjs — the thesis from the outside, in one command.
 *
 * A resident needs no operator, no keys, and no server: it takes a seed URL,
 * asks the SDK to find the first copy whose bytes verify against the root and
 * CID the seed pins, and then replays every AI claim inside that copy offline.
 * This script does exactly that over the real network by default, and over a
 * local tree with --local for a hermetic run. It writes nothing.
 *
 * Usage:
 *   npm run demo:resident
 *   npm run demo:resident -- https://example/registry/seed.json
 *   npm run demo:resident -- --local ./some/tree
 *
 * A local tree is a directory served over loopback HTTP. Its seed.json names
 * bundle copies as paths relative to the seed (or paths under the served tree),
 * so the run never reaches the network. The live seed URL is the default.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const sdk = await import(new URL("../packages/agent-sdk/src/index.ts", import.meta.url).href);
import { attestAiLocally } from "../apps/mcp/src/attest-local.ts";

const LIVE_SEED_URL = "https://999svs999.github.io/RAREXT-protocol/registry/seed.json";
const TIMEOUT_MS = Number(process.env.RAREXT_DEMO_TIMEOUT_MS ?? 20_000);

const contentTypes = {
  ".json": "application/json",
  ".js": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function usage(message) {
  if (message) console.error(`demo-resident: ${message}`);
  console.error(
    "usage: node scripts/demo-resident.mjs [seed-url]\n" +
      "       node scripts/demo-resident.mjs --local <dir> [--port <n>]",
  );
}

function parseArgs(argv) {
  let local = null;
  let port = 0;
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const value = arg.startsWith("--port=") ? arg.slice("--port=".length) : argv[index + 1];
      if (value === undefined || !/^\d+$/.test(value) || Number(value) === 0) {
        usage("--port needs a port number");
        process.exit(2);
      }
      port = Number(value);
      if (!arg.startsWith("--port=")) index += 1;
      continue;
    }
    if (arg === "--local") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0 || value.startsWith("--")) {
        usage("--local needs a directory");
        process.exit(2);
      }
      local = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--local=")) {
      local = arg.slice("--local=".length);
      if (local.length === 0) {
        usage("--local needs a directory");
        process.exit(2);
      }
      continue;
    }
    if (arg.startsWith("-")) {
      usage(`unknown option ${arg}`);
      process.exit(2);
    }
    positional.push(arg);
  }
  if (positional.length > 1) {
    usage("at most one seed URL");
    process.exit(2);
  }
  if (local !== null && positional.length === 1) {
    usage("a seed URL and --local are alternatives, not a pair");
    process.exit(2);
  }
  return { local, port, seedUrl: positional[0] ?? LIVE_SEED_URL };
}

function serveTree(directory) {
  const root = resolve(directory);
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
      if (path !== root && !path.startsWith(root + sep)) {
        response.writeHead(403).end("outside the served tree");
        return;
      }
      if (!existsSync(path) || !statSync(path).isFile()) {
        response.writeHead(404).end("not found");
        return;
      }
      response.writeHead(200, {
        "content-type": contentTypes[extname(path)] ?? "application/octet-stream",
        "content-length": String(statSync(path).size),
      });
      createReadStream(path).pipe(response);
    } catch {
      response.writeHead(500).end("demo server error");
    }
  });
  return server;
}

/** In a local run, every candidate is read from the served tree, never the network. */
function localiseSeed(seed, seedUrl, base) {
  const local = (candidate) => {
    if (typeof candidate !== "string" || candidate.length === 0) return candidate;
    const parsed = new URL(candidate, seedUrl);
    return new URL(parsed.pathname, base).href;
  };
  return {
    ...seed,
    bundle: local(seed.bundle),
    mirrors: Array.isArray(seed.mirrors)
      ? seed.mirrors.map((mirror) => ({ ...mirror, bundle: local(mirror.bundle) }))
      : seed.mirrors,
    announcements: Array.isArray(seed.announcements)
      ? seed.announcements.map((url) => local(url))
      : seed.announcements,
  };
}

/**
 * In a local run, announcement records may name paths relative to the served
 * tree — the same affordance the seed already has — because a tree written to
 * disk cannot know the loopback port it will be served on. Live runs use the
 * plain fetch: an announcement there is a URL or it is nothing.
 */
/**
 * A tree's records are SIGNED, and a signature covers the URLs it names — so a
 * local run cannot rewrite them the way it rewrites the seed's own paths. A tree
 * that carries announcements therefore writes them against the port it will be
 * served on, which is what `--port` is for: pin it, write absolute loopback
 * URLs, and the signatures stay honest.
 */
async function fetchSeed(seedUrl) {
  let response;
  try {
    response = await fetch(seedUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`seed ${seedUrl} — unreachable (${error.message})`);
  }
  if (!response.ok) throw new Error(`seed ${seedUrl} — HTTP ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`seed ${seedUrl} — not JSON (${error.message})`);
  }
}

function printEvidence(claim) {
  const evidence = claim.evidence;
  if (!evidence) return;
  if (claim.representation === "generative") {
    console.log(
      `    evidence: seed ${evidence.seed}, steps ${evidence.steps}, modelDigest ${evidence.modelDigest}`,
    );
    console.log(`    expected: ${JSON.stringify(evidence.expected)}`);
    console.log(`    actual:   ${JSON.stringify(evidence.actual)}`);
    return;
  }
  const attested =
    evidence.attestedMetricValue === undefined
      ? ""
      : `, attested ${evidence.attestedMetricValue}`;
  console.log(
    `    evidence: ${evidence.metricName} ${evidence.metricValue} (bound ${evidence.bound}${attested})`,
  );
}

async function main() {
  const { local, port, seedUrl: requestedSeed } = parseArgs(process.argv.slice(2));
  let server;
  let seedUrl = requestedSeed;
  let exitCode = 0;

  try {
    if (local !== null) {
      const directory = resolve(local);
      if (!existsSync(directory) || !statSync(directory).isDirectory()) {
        throw new Error(`--local ${local} — not a directory`);
      }
      if (!existsSync(resolve(directory, "seed.json"))) {
        throw new Error(`--local ${local} — no seed.json in the tree`);
      }
      server = serveTree(directory);
      // A caller that pins the port is a tree that had to know it in advance:
      // signed announcement records name absolute URLs, and a signature over a
      // rewritten URL is not a signature.
      server.listen(port, "127.0.0.1");
      await once(server, "listening");
      // The port actually bound — with no --port it is whatever the OS handed
      // out, and the seed URL names that, not what was requested.
      const { port: boundPort } = server.address();
      seedUrl = `http://127.0.0.1:${boundPort}/seed.json`;
      console.log(`resident demo — local tree ${directory} at http://127.0.0.1:${boundPort}`);
    } else {
      console.log("resident demo — from a seed URL, with no operator and no keys");
    }

    console.log(`seed ${seedUrl}`);
    let seed = await fetchSeed(seedUrl);
    if (local !== null) seed = localiseSeed(seed, seedUrl, seedUrl.slice(0, -"seed.json".length));
    if (typeof seed.bundleRoot !== "string" || !/^[0-9a-f]{64}$/.test(seed.bundleRoot)) {
      throw new Error("the seed pins no 64-hex bundleRoot");
    }
    console.log(`pinned root ${seed.bundleRoot.slice(0, 16)}…`);
    if (typeof seed.bundleCid === "string" && seed.bundleCid.length > 0) {
      console.log(`pinned bundle CID ${seed.bundleCid}`);
    }

    const onCandidate = (event) => {
      if (event.status === "trying") {
        console.log(`  trying ${event.url}`);
      } else if (event.status === "refused") {
        console.log(`  refused ${event.url} — ${event.reason}`);
      } else {
        console.log(`  accepted ${event.url} — root ${event.root.slice(0, 16)}…`);
      }
    };

    const announcementUrls = Array.isArray(seed.announcements) ? seed.announcements : [];
    let found;
    try {
      if (announcementUrls.length === 0) {
        console.log("\nfinding a copy whose bytes rebuild the pinned root");
        found = await sdk.findVerifiedBundle(seed, { timeoutMs: TIMEOUT_MS, onCandidate });
      } else {
        // The seed names announcements, so this run needs something the seed
        // alone never needed: the KEYS those records were signed with. The
        // resident reads them from the documents the publisher serves — no
        // operator, no server of its own — and every record is believed only
        // under the key its named handle's history resolves.
        const origin = new URL(".", seedUrl).href;
        // The served tree's own layout, from the one place that knows both
        // surfaces: a static tree keeps `<handle>.json` beside its seed, while
        // an API serves /v1/identities/<handle>. Hardcoding it here is how a
        // resident ends up reading 404s and calling a publisher unknown.
        const identity = sdk.identityFromPublishedOrigin({
          origin,
          surface: "static-tree",
          timeoutMs: TIMEOUT_MS,
        });
        console.log(
          `\nfolding ${announcementUrls.length} announcement document(s) through published identity documents`,
        );
        found = await sdk.findVerifiedBundleFromSeeds([seed], {
          timeoutMs: TIMEOUT_MS,
          identity,
          onCandidate,
          onAnnouncement: (event) => {
            if (event.status === "accepted") {
              console.log(`  announcement accepted ${event.url} — mirror ${event.mirror}`);
            } else {
              console.log(`  announcement refused ${event.url} — ${event.reason}`);
            }
          },
        });
      }
    } catch (error) {
      throw new Error(error.message);
    }

    const publications = Array.isArray(found.bundle.publications) ? found.bundle.publications.length : 0;
    console.log(`\nServed from ${found.source}`);
    console.log(`verified root ${found.root} · ${publications} publication(s)`);

    const replay = sdk.replayBundleAi(found.bundle);
    if (replay.root !== found.root) {
      throw new Error(
        `the replay names root ${replay.root}, but the verified copy rebuilt ${found.root}`,
      );
    }
    console.log(`\nAI claims replayed offline from the verified bundle (${replay.claims.length})`);
    if (replay.claims.length === 0) {
      console.error("  no AI claim in the verified bundle — nothing about AI was proven");
      exitCode = 1;
    }

    let failed = 0;
    for (const claim of replay.claims) {
      const pass = claim.correct === true;
      if (!pass) failed += 1;
      console.log(`\n  [${pass ? "PASS" : "FAIL"}] ${claim.title}`);
      console.log(`    representation: ${claim.representation} · correct: ${claim.correct}`);
      if (claim.error) console.log(`    error: ${claim.error}`);
      printEvidence(claim);
    }

    // The other thing a resident needs from a registry: the MEANING it resolved must be the
    // one the registry anchored. RFC 0003's question 1 — the same check the browser page
    // runs, through the same core comparison, so the page and the agent cannot disagree.
    let meaningsOk = true;
    const semantics = sdk.verifyBundleSemantics(found.bundle);
    if (semantics === null) {
      console.log("\nmeanings: this registry records no semantics commitment");
    } else {
      meaningsOk = semantics.missing.length === 0;
      console.log(
        `\nmeanings anchored: ${semantics.matched} of ${semantics.committed} committed digest(s) match the records this copy carries`,
      );
      if (!meaningsOk) console.error(`  unmatched: ${semantics.missing.join(", ")}`);
    }

    // The third question: the bundle COMMITS to a federation list of registries, and the list
    // published beside it must be the one committed to. The SDK's own function does the fetch,
    // the parse, and the digest check — the resident verifies, it does not re-implement.
    let federationOk = true;
    const commitment = sdk.federationCommitment(found.bundle);
    if (!commitment) {
      console.log("\nfederation: this bundle records no federation commitment");
    } else {
      try {
        const entries = await sdk.registriesFromPublishedList(commitment.listUrl, {
          expectDigest: commitment.digest,
        });
        console.log(
          `\nfederation: the seed list at ${commitment.listUrl} matches the committed digest ` +
            `(${entries.length} registrie(s): ${entries.map((entry) => entry.id).join(", ")})`,
        );
      } catch (error) {
        federationOk = false;
        console.error(`\nfederation: ${error.message}`);
      }
    }

    // The fourth answer — the MAKE direction. Everything so far re-verified what the
    // registry already published. A registry is only alive if a NEW run can make evidence
    // it accepts, right now, locally: so make one — the committed starter model, a fresh
    // seed, the attestation core builds — and hand it to the same local verifier the
    // registry's own publications pass. One maker, not two: the MCP's attest-local runs
    // this same core path.
    let makingOk = false;
    const makeChallenge = (Array.isArray(found.bundle.challenges) ? found.bundle.challenges : [])
      .find((c) => c && c.id === "gen-starter");
    if (!makeChallenge || typeof makeChallenge.spec?.steps !== "number" || !makeChallenge.sampleArtifact?.body?.model) {
      console.error("\nmaking: the verified bundle carries no generative-starter challenge with a committed model — nothing fresh could be made");
    } else {
      try {
        // The demo assembles NOTHING: attestAiLocally is the one maker the MCP verb runs,
        // given a registry view of the verified bundle's own challenge.
        const made = await attestAiLocally(
          makeChallenge.id,
          { challenge: async () => makeChallenge },
          { seed: 20261031 % 2147483647 },
        );
        makingOk = made.verification.correct === true;
        console.log(
          `\nmaking: a fresh run (seed ${made.verification.seed}, ${made.verification.steps} steps) attested as ${made.attestation.id.slice(0, 16)}… ` +
            `${makingOk ? "VERIFIES against the committed challenge — made right now, locally" : "DID NOT verify — the maker and the verifier disagree"}`,
        );
      } catch (error) {
        console.error(`\nmaking: ${error.message}`);
      }
    }

    if (replay.claims.length > 0) {
      console.log(`\nverdicts tie to the verified root ${replay.root}`);
      if (failed > 0 || !meaningsOk || !federationOk || !makingOk) {
        const why =
          failed > 0
            ? `${failed} of ${replay.claims.length} AI claim(s) did not replay true`
            : !meaningsOk
              ? `${semantics.missing.length} committed meaning(s) do not match this copy`
              : !federationOk
                ? "the federation seed list does not match the commitment"
                : "a fresh attestation made just now did not verify locally";
        console.error(`\nDEMO FAILED: ${why} from ${found.source} (root ${replay.root}).`);
        exitCode = 1;
      } else {
        console.log(
          `\nDEMO PASSED: ${replay.claims.length} AI claim(s) replayed true, ` +
            `${semantics ? `${semantics.matched} committed meaning(s) matched` : "the registry records no meanings"}, and ` +
            `${commitment ? "the federation seed list matches the commitment" : "the bundle records no federation commitment"} ` +
            `${makingOk ? "a fresh attestation made just now verifies locally" : "no fresh attestation could be made"}, ` +
            `from the verified copy at ${found.source} (root ${replay.root}), found from seed ${seedUrl}. ` +
            `No keys, no server, no writes.`,
        );
      }
    }
  } catch (error) {
    console.error(`\nDEMO FAILED: ${error.message}`);
    exitCode = 1;
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    }
  }

  process.exitCode = exitCode;
}

await main();
