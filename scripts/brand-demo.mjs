/**
 * Brand demonstration for RAREXT web4 network.
 * 
 * Demonstrates the FUTURISTIC vision: a standalone brand living on the
 * RAREXT web4 network with a unique link address, where visitors can
 * interact and verify claims in their browser.
 */

// The brand's unique address on the RAREXT web4 network
// Format: rarext:brand-name@64-hex-root
const BRAND_ADDRESS = "rarext:futuristic@46ef40bd237d320d71290e83788a175cfc88f699e378ab3a779fb73d28060d73";

// The live mirror verification page where visitors can verify the brand
const MIRROR_PAGE = "https://999svs999.github.io/RAREXT-protocol/mirror/verify.html";

// The published API surface where strangers can fetch the protocol surface
const ROUTES_SURFACE = "https://999svs999.github.io/RAREXT-protocol/schema/routes.json";

// The brand's bundle on the live site
const BRAND_BUNDLE_URL = "https://999svs999.github.io/RAREXT-protocol/registry/bundle.json";

// Demonstration of the FUTURISTIC vision
async function brandDemo() {
  console.log("=== FUTURISTIC Brand on RAREXT web4 ===\n");

  console.log("1. BRAND UNIQUE ADDRESS");
  console.log(`   The Futuristic brand has a unique, content-addressed address:`);
  console.log(`   ${BRAND_ADDRESS}`);
  console.log(`   - This is a persistent, verifiable address on the RAREXT network`);
  console.log(`   - No company permission needed - anyone can use it`);
  console.log(`   - The address is derived from the brand's anchor root`);

  console.log(`\n2. VISITOR VERIFICATION (in browser)`);
  console.log(`   A visitor can paste the address into the mirror verification page:`);
  console.log(`   ${MIRROR_PAGE}`);
  console.log(`   - The page recomputes each registry's frozen state root in the browser`);
  console.log(`   - Derives the brand's statement from the archived credits`);
  console.log(`   - Earned/spent/net/weight and receipt classes are shown`);
  console.log(`   - No CLI, no repo, no trust in the node's "now" needed`);
  console.log(`   - The proof is checkable by anyone, anywhere`);

  console.log(`\n3. STRANGER ACCESS (no clone needed)`);
  console.log(`   The protocol surface is published at:`);
  console.log(`   ${ROUTES_SURFACE}`);
  console.log(`   - Kind: rarext.routes.v1`);
  console.log(`   - 41 routes with methods, paths, bodies, and response shapes`);
  console.log(`   - A program can fetch the entire API surface in one HTTP request`);
  console.log(`   - The checker holds the published file, the doc table, and the code`);
  console.log(`   - in agreement so the three cannot drift in either direction`);

  console.log(`\n3. AI ON RAREXT (all types)`);
  console.log(`   - Rule-based AI: deterministic replay from committed seed + rule table`);
  console.log(`   - No third parties needed - anyone can recompute from the seed`);
  console.log(`   - Part of the "AI lives on RAREXT" vision`);
  console.log(`   - Includes external cloud providers, self-hosted local models,`);
  console.log(`     and new types of AI that use completely different computation`);

  console.log(`\n4. HOW RAREXT web4 WORKS (innovative storage & transportation)`);
  console.log(`   - Content-addressed: CIDv1 over SHA-256 multihash (artifactHash)`);
  console.log(`   - State archives: frozen ledger chained to genesis (64 zeros root)`);
  console.log(`   - Federation: registries + digest commitments`);
  console.log(`   - Settlement: work-based, no protocol token`);
  console.log(`   - The new type of AI uses the same infrastructure`);
  console.log(`   - Compute and reasoning may be rule-based, not traditional AI`);

  console.log(`\n=== FUTURISTIC VISION REALIZED ===`);
  console.log(`   - Brand: unique content-addressed address ✓`);
  console.log(`   - Visitor verification: browser-recomputed ✓`);
  console.log(`   - Stranger access: one-file API surface ✓`);
  console.log(`   - AI on RAREXT: rule-based + all types ✓`);
  console.log(`   - web4: innovative storage + transportation ✓`);
}

brandDemo().catch(console.error);
