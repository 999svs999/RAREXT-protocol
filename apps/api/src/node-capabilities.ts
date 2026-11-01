/**
 * The node capabilities document: what THIS node serves, as data.
 *
 * An agent landing cold asks GET /v1/capabilities and bootstraps without reading the
 * source or the docs. (The file is named node-capabilities because capabilities.ts is
 * the storage system's capability tokens - a different idea that owns its name.)
 *
 * The list is STATIC and the test suite holds it against the route table in app.ts in
 * BOTH directions - every route literal must be covered, and every entry must match a
 * real route - so the document cannot silently drift from what the node answers.
 * Adding a route means adding a line here; forgetting fails CI with the path named.
 */

export const NODE_CAPABILITIES_KIND = "rarext.capabilities.v1";

export interface NodeCapabilityRoute {
  path: string;
  note?: string;
}

export interface NodeCapabilitiesDocument {
  kind: typeof NODE_CAPABILITIES_KIND;
  version: 1;
  binding: "/.well-known/rarext.json";
  rails: NodeCapabilityRoute[];
  families: string[];
}

export const NODE_CAPABILITIES: NodeCapabilitiesDocument = {
  kind: NODE_CAPABILITIES_KIND,
  version: 1,
  binding: "/.well-known/rarext.json",
  rails: [
    { path: "/" },
    { path: "/health", note: "liveness and counts" },
    { path: "/v1/history", note: "the state-archive chain: the ledger's history, tamper-evident" },
    { path: "/v1/adapters" },
    { path: "/v1/anchors" },
    { path: "/v1/apps" },
    { path: "/v1/artifacts" },
    { path: "/v1/blobs" },
    { path: "/v1/builds" },
    { path: "/v1/chains" },
    { path: "/v1/chains/status" },
    { path: "/v1/capabilities", note: "this document" },
    { path: "/v1/challenges" },
    { path: "/v1/consensus/state" },
    { path: "/v1/consensus/validate" },
    { path: "/v1/crypto" },
    { path: "/v1/discovery" },
    { path: "/v1/durability" },
    { path: "/v1/durability/challenge" },
    { path: "/v1/durability/gc" },
    { path: "/v1/feed", note: "the publication feed" },
    { path: "/v1/governance/open", note: "the decisions a community can weigh in on right now" },
    { path: "/v1/governance/proposals", note: "the 民主 rail: propose and list" },
    { path: "/v1/identities" },
    { path: "/v1/identity-links" },
    { path: "/v1/leaderboard" },
    { path: "/v1/market" },
    { path: "/v1/market/aggregate" },
    { path: "/v1/nodes", note: "discovery: this node, and the peers it knows with their provenance" },
    { path: "/v1/participants" },
    { path: "/v1/placements" },
    { path: "/v1/profiles" },
    { path: "/v1/publications" },
    { path: "/v1/registries", note: "the federation list this node's decisions admitted" },
    { path: "/v1/revocations" },
    { path: "/v1/score" },
    { path: "/v1/semantics" },
    { path: "/v1/simulate" },
    { path: "/v1/sources/github/resolve" },
    { path: "/v1/storage/gc" },
    { path: "/v1/storage/pricing" },
    { path: "/v1/storage/quota" },
    { path: "/v1/storage/quote" },
    { path: "/v1/storage/tiers" },
    { path: "/v1/storage/usage" },
    { path: "/v1/tapeout/circuits" },
    { path: "/v1/tapeout/status" },
    { path: "/v1/tasks" },
    { path: "/v1/tournaments" },
    { path: "/v1/tracregistry" },
    { path: "/v1/verifications" },
    { path: "/v1/verifier-operators" },
    { path: "/v1/verifiers" },
    { path: "/v1/verify", note: "verification submissions" },
    { path: "/v1/work", note: "the action board and the work queue" },
    { path: "/v1/work/anchor", note: "the operator's anchoring receipt — the work ledger's mining analog" },
    { path: "/v1/work/earnings", note: "a participant's receipts with inclusion proofs" },
    { path: "/v1/work/ledger", note: "the whole-ledger commitment" },
    { path: "/v1/work/participation", note: "the participation receipt rail" },
    { path: "/v1/work/statement", note: "the ledger read from the earner's side: holds, credits, weight" },
    { path: "/v1/work/treasury", note: "the receipt classes a decision can name, and how big each is" },
  ],
  families: [
    "/v1/history/",
    "/v1/adapters/",
    "/v1/anchors/",
    "/v1/artifacts/",
    "/v1/blobs/",
    "/v1/builds/",
    "/v1/bundles",
    "/v1/challenges/",
    "/v1/governance/proposals/",
    "/v1/identities/",
    "/v1/identity-links/",
    "/v1/placements/",
    "/v1/profiles/",
    "/v1/publications/",
    "/v1/semantics/",
    "/v1/storage/retention/",
    "/v1/tournaments/",
    "/v1/tracregistry/",
    "/v1/verifier-operators/",
    "/v1/verifiers/",
  ],
};
