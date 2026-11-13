# Changelog

All notable changes to the RAREXT protocol, the registry, and the published
packages. The format follows [Keep a Changelog](https://keepachangelog.com/1.1.0/),
and the project uses [semantic versioning](https://semver.org/) with pre-release
tags while the protocol is in pre-alpha.

Protocol-visible changes — the publication envelope, the attestation, the semantics
binding, the Merkle leaf — are called out explicitly. They are the changes that can
break a client or invalidate stored data.

## [Unreleased]

- **Streaming is one chunk per generated token, not one chunk per response.**
  `stream: true` used to send the whole completion in a single SSE `delta`. The
  provider now emits **one chunk per token** for chat and completions, each with
  the delta from the engine's prefix decode — so a character split across tokens
  is byte-correct — followed by exactly one final chunk that states the real
  `finish_reason` while the content chunks say `null`. When `logprobs` were
  requested, each chunk carries the logprob of the token it delivered. The chunk
  count equals the decode trace and the deltas concatenate to the non-streaming
  completion, both asserted end to end. A third-party engine's ids are not ours
  to decode and a mid-token stop makes prefixes disagree with the returned text;
  both stream as one delta rather than inventing token boundaries. See
  [WEB4-MODEL.md](docs/WEB4-MODEL.md#streaming).
- **The engine reports its own confidence.** `logprobs` / `top_logprobs` are now
  honoured end to end: the engine computes the softmax over the penalized logits
  before temperature/top-k/top-p shape the sampler, so the number is the model's
  own and is identical for a greedy and a sampled run. The provider exposes it in
  the OpenAI shape (`choices[0].logprobs.content` for chat, the
  `tokens/token_logprobs/top_logprobs` block for completions), off by default so
  an unrequested run pays no vocabulary-wide `exp()`. Tokens, logprobs, and text
  stay aligned: a stop sequence drops the token that carried it rather than
  reporting confidence for text that was not returned. `npm run demo:decoding`
  shows eight real tokens' logprobs and asserts they are finite, `≤ 0`,
  descending, and headed by the greedy choice. See
  [WEB4-MODEL.md](docs/WEB4-MODEL.md#confidence-logprobs).
- **A run cannot outgrow the model's context.** The engine reads
  `${arch}.context_length` from the container and holds every run to it: an
  oversized prompt is truncated deterministically (most recent tokens, BOS kept
  at the front) and the step budget is capped so `prompt + generated` never
  exceeds the declared context. Before this, a long prompt grew the KV cache
  without bound until the host ran out of memory. A prompt that fits is
  evaluated verbatim; the result reports `contextLength`, `promptTokens`,
  `promptTruncated`, and the exact `promptIds` evaluated. Undeclared context
  lengths fall back to 4096. Tests assert the truncation, the BOS, the tail, the
  step cap, and determinism. See
  [WEB4-MODEL.md](docs/WEB4-MODEL.md#the-context-bound).
- **The engine honours real decoding controls, and a sampled run replays.** The
  OpenAI request fields were parsed by nobody: `temperature` never reached the
  engine, `top_p`/`top_k`/penalties did not exist, and every response said
  `finish_reason: "stop"` even when `max_tokens` cut the run off. The engine now
  implements `temperature`, `top_p`, `top_k`, `repetition_penalty`,
  `presence_penalty`, `frequency_penalty`, and `stop`, each with its OpenAI
  default and clamped so a client cannot make a run non-finite or unbounded. The
  sampler is seeded and deterministic, so a **sampled** run is replayable, not
  just a greedy one; `finish_reason` reports `"stop"` (EOS or a stop sequence) or
  `"length"` (the step budget) and the stop text is not returned. `top_k: 1` is
  asserted to reproduce the greedy tokens exactly, over HTTP as well as in the
  engine. On real weights a 21-repeat greedy loop drops to zero repetitions with
  `repetition_penalty: 2`. `npm run demo:decoding` is the proof; see
  [WEB4-MODEL.md](docs/WEB4-MODEL.md#decoding-controls).
- **The AI lives on RAREXT, engine included.** The engine that turns tokens is now
  a content-addressed RAREXT artifact, sharded and committed beside the weights in
  `rarext.engine-bundle.v1` and named by the model bundle (`execution.artifact`).
  A provider fetches, verifies, and runs the committed engine, and its digest is
  folded into the engine fingerprint every run records and every replay checks. A
  model is now one identity over weights **and** engine, with no out-of-band engine
  flag and no engine endpoint. `npm run demo:web4-model` runs the full 34-phase
  path; `npm run demo:ai-on-rarext` starts two independent nodes with no host
  engine, runs real inference from the committed `RXHF`/GGUF bytes, replays the
  trace, and commits a perturbed copy of the same weights to show the answer
  changes. See [docs/WEB4-MODEL.md](docs/WEB4-MODEL.md).
- **Four portable engine runtimes — no host capability required.** RAREXT's own
  native model and its GGUF/RXHF transformer (`rarext.gguf-engine.node-cjs.v1`),
  a third-party WebAssembly engine instantiated with an empty import object
  (`rarext.wasm-engine.wasm.v1`), and a foreign engine program on a worker thread
  inside `node:vm` with no `require`, `process`, or filesystem
  (`rarext.worker-engine.node-cjs.v1`). All four are in
  `PORTABLE_ENGINE_RUNTIMES`; none needs a container runtime, GPU, or hardware
  root of trust. A raw ELF/Mach-O image is refused rather than run unsandboxed.
- **RAREXT's own Hugging Face ingest and quantization.**
  `scripts/convert-hf-safetensors.mjs` reads `config.json`, `*.safetensors`, and a
  BPE `tokenizer.json` or SentencePiece `tokenizer.model` (its protobuf parsed
  directly) and emits the native `rarext.hf-container.v1` (`RXHF`) container — no
  llama.cpp, gguf-py, or third-party converter. It quantizes with RAREXT's own
  `Q8_0`, `Q4_0`, `IQ4_NL`, and `Q4_K` encoders, keeping norms/biases in the
  checkpoint dtype and falling back to `Q8_0` for rows too narrow for a `Q4_K`
  super-block.
- **Every engine must emit a replayable trace.** A token-hiding engine is recorded
  as a `rarext.output-trace.v1` over the exact completion text; a token-emitting
  engine as `rarext.decode-trace.v1`. A replay refuses a diverging trace even when
  the text happens to match, for any runtime, not just RAREXT's own.
- **A published AI proof can no longer lose a rendition to the inline budget.** The
  mirror embeds AI rendition blobs first and skips a blob that does not fit instead
  of ending the scan, so a large unrelated blob cannot keep the bounded picture out
  of `blobs.json`. `npm run demo:ai` re-derives both renditions and fails if either
  is missing.
- **The generations ladder, as one commitment.** `rarext.generations.v1` writes
  what "and the generations after it" means — the network generations (5G→8G), the
  model-size classes (1G→8G), the web generations (web4→web8), and the
  publication-leaf generations (gen-4→gen-8) — into one canonical object with one
  sha256. `@rarext/core` ships the object, a validator that refuses a renumbered or
  duplicated ladder, and pure helpers (`networkMeets`, `planModelShards`,
  `nextGeneration`, `shippedGeneration`). It is **declared, not measured**: each
  entry carries `shipped` — the `1G` model class (GGUFs/RXHF under 1 GiB) is
  shipped, and no 6/7/8 GB class is claimed as served. `npm run demo:generations`
  prints it and recomputes the digest, and the FUTURISTIC brand demo carries the
  same ladder. See [docs/GENERATIONS.md](docs/GENERATIONS.md).
- **A deployment commits its generation, and the ladder answers the 6/7/8G
  question honestly.** `rarext-runtime deploy --generation
  network=5G,model=1G,web=web4,protocol=gen-4` folds a declared rung into the
  deployment manifest and its digest; an undeclared id is refused
  (`parseGenerationSpec`, `validateDeployment`). `npm run demo:generations` also
  prints whether **this** host can serve each model class (weights ×2 vs total
  memory), so a 6/7/8 GB class is reported as too large on a small host rather
  than pretended.
- **An agent can live on RAREXT — and its thought is a network-engine inference.**
  `npm run demo:live` gives a real agent a residence made only of content-addressed
  bytes: its public key as a blob, a signed generative AI claim, the generations
  charter, and a **storage-native run** whose weights *and* engine are sharded into
  RAREXT and run by a provider with no host engine. It fetches every byte back by
  hash, **stops the node and the provider**, then rebuilds the residence from those
  bytes alone: the key id re-hashes, the charter revalidates, the publication
  leaves rebuild the anchored Merkle root, every AI claim replays with
  `replayBundleAi`, the weights and engine reassemble and verify every digest and
  shard root, and the **committed engine re-run over the committed weights
  reproduces the recorded trace digest**. See
  [docs/LIVE-ON-RAREXT.md](docs/LIVE-ON-RAREXT.md).
- **The surface is published, not just described.** `GET`-able at `/schema/routes.json`
  (kind `rarext.routes.v1`), generated from `docs/ARCHITECTURE.md`'s route table by
  `scripts/build-route-index.mjs`: every route with its method, path (query string included — an
  agent wants the parameters), request body and response shape, in the documentation's own words.
  A consumer that just wants the surface fetches one file instead of cloning the repo and parsing
  docs. The checker holds the published file, the table, and the route guards in
  `apps/api/src/app.ts` in agreement, so the three cannot drift in either direction; a test proves
  the committed bytes came from the committed generator (regeneration is a no-op), and the doc
  gains its own pointer to the artifact that the checker also holds. `npm run build:routes`
  regenerates; `--check` fails if the file is stale.
- **Anyone with a browser can check what a key was owed.** The mirror's proof page gained a
  statement panel: enter a key, and for each registry it recomputes the FROZEN state root in the
  browser and derives that key's statement — earned / spent / net / weight and the receipt classes
  it holds — from the archived credits. To make that honest rather than a second implementation,
  the derivation MOVED INTO CORE (`creditStatement` in `packages/core/src/credits.ts`): the node's
  statement route now calls it, and so does the page, so the two cannot disagree about what
  somebody was owed. The receipt-act vocabulary moved with it (`RECEIPT_ACTS`), and the node's
  `RECEIPT_ACTIONS` is now a typing of that one list rather than a second copy. A core test holds
  the derivation's purity and separation (earned vs spent vs net, sorted deduped roots, an empty
  statement for a key with nothing).
- **Proving the past, not just reading it.** Every read so far answered "today", recomputed by the
  node — fine for acting, useless for proving: a participant handing somebody a receipt could prove
  the receipt but not the world it sat in. `GET /v1/work/statement?keyId=<key>&at=<anchorRoot>` reads
  the statement out of a FROZEN state (the whole ledger is chained at every anchor), and the
  response carries `asOf` naming that archive and the root it commits to — so the past is CHECKED by
  fetching `/v1/history/:anchorRoot` and recomputing the archive's state root, not taken on this
  node's word. `ledger.root` is the ARCHIVED commitment, not today's. An unknown anchor is a 404
  naming it; a malformed `?at` is a 400. `RarextClient.statement(keyId, atAnchorRoot?)` speaks it.
- **The statement: the ledger from the earner's side.** The receipts rail leaves records, the
  treasury sizes the classes a decision can pay, and a budget pays them — but an earner could not
  ask the one question that ties them together. `GET /v1/work/statement?keyId=<key>` answers it:
  `holds` (the receipt CLASSES this key is in, each with its roots — the classes a decision can pay
  it through, which is what "owed to me" means here), `credits` split into earned / spent / net (a
  worker that pledged a budget has been debited, and one total hides that), `byAction`, the live
  ledger commitment, and `weight` — the SAME number a work-weighted ballot would weigh, so the
  earner sees its standing before voting instead of inferring it. No `keyId` is a 400: a statement
  is about a key. `RarextClient.statement(keyId)` speaks it. WORK.md documents it; claim-check
  holds the doc, the route, and the SDK method.
- **A voter's standing, read before acting.** The rail could only tell somebody they could not
  vote by REFUSING their ballot, and the agenda could only describe a decision in general terms.
  `GET /v1/governance/proposals/:root?keyId=<key>` and `GET /v1/governance/open?keyId=<key>` now
  carry that key's own `eligibility`: whether this key may vote, why not when it may not, whether
  it already voted, what its ballot would weigh (one under a key policy; the key's credit total
  under a work-weighted one), and how much quorum the decision still needs — the same rules the
  tally uses, read in advance. Without `keyId` no standing is claimed, because there is no key to
  compute one for. `RarextClient.decision(root, keyId?)` and `openDecisions(keyId?)` speak it.
- **A latent CI flake fixed at the root.** `governance-budget-route.test.ts` built its budget
  pledge payload TWICE — once to post, once to sign — and `pledge()` carries a fresh `createdAt`,
  so when the millisecond ticked between the two calls the signed payload no longer matched the
  posted one and the refusal came from the wrong cause ("signature does not match the debited
  key"). All three sites now build the payload once and sign THAT object. The forged case is
  thereby a stronger test too: it now models the attack it names (a wrong SIGNER over the same
  message) rather than a different message. Two consecutive full CI runs confirm stability.
- **The agenda: what needs deciding.** `GET /v1/governance/open` lists every proposal whose window
  is still OPEN — the question, when it closes, WHAT it would do (its `admission` or `budget`), and
  the tally so far. A bulletin board that only answers by root is a board you must already know the
  address of; an assembly has an agenda. "Open" is recomputed at read time, so a closed proposal is
  absent rather than listed under a stale label. `RarextClient.openDecisions()` speaks it.
  OPERATOR.md documents it; claim-check holds the doc, the route, and the SDK method together.
- **Filing the join request, and a hole in deciding.** `become-a-node --announce <federation-origin>`
  now FILES the admission as a real proposal on that node's 民主 rail — a live decision with a
  window and a tally — creating the proposal, attaching the admission, and printing the proposal
  root and its vote URL. It proposes and attaches only (exactly what any participant may do): it
  never votes; the tally applies the join; a registry with a decision already open answers 409 and
  the script says so.
- **A real hole fell out of testing it.** `GET /v1/governance/proposals/:root` served the proposal,
  its votes, its sponsorships, and its tally — but NOT its attachments. A voter was asked to decide
  on "Admit node-x" with no way to read node-x's url, operator, or chains before voting, and no way
  to see the budget a funded decision would move. The view now serves `admission` and `budget`
  (each `null` when the decision carries none). Deciding on a question whose substance you cannot
  read is not deciding.
- **Handle salting hardened.** `become-a-node`'s free-handle probe counted up numerically, which
  walked into a wall of seeded demo identities (`operator-alice`, `operator-alice-1`, …). Candidates
  are now salted with the operator key's own bytes, so the probe terminates on any node.
- **The reader can see the network: discovery on the verify page.** The mirror's proof page now
  probes each listed registry's `/v1/nodes` alongside its admissions list and its state chain —
  three independent probes, so one absence never hides another — and shows what each registry IS
  (the registry it serves and the root it committed) and which peers it KNOWS, each labelled
  "from the seed it carries" or "admitted by decision". The label is the substance for a reader:
  inherited knowledge and a decision the community made are different claims, and the page says
  which is which. A static registry serves no `/v1/nodes` and the page reports that dimly, as an
  answer rather than a failure.
- **Discovery: a node says who it is and which peers it knows — with provenance.** `GET /v1/nodes`
  answers a cold agent's first question in one shape: `self` (the registry served, the origin, the
  binding path, the root committed or null) and `known` — the peers, each labelled `source: "seed"`
  (inherited from the list the operator configured) or `source: "admission"` (a decision this
  node's own 民主 rail applied, carrying the proposal that did it). The label is the substance:
  inherited knowledge and admitted knowledge are different claims. One id, one entry. `RarextClient.nodes()`
  speaks it. **A real defect fixed on the way**: a SECOND `/v1/registries` handler had been
  unreachable since the admissions handler took the path — the seed list it walked was dead code.
  That knowledge now lives here, reachable and labelled, instead of shadowed. OPERATOR.md documents
  the view; claim-check holds the doc, the route, and the SDK method together.
- **The agent can earn on the node it runs: `treasury()` and `claimAnchoring()` on the client.**
  The economy had all three legs — work is counted (receipts), a class can be sized (treasury),
  a decision can pay it (budgets) — but the SDK spoke only the first: an AI agent driving a node
  could not ask what a class is worth, nor claim its own operator's work, through the typed
  surface. `RarextClient.claimAnchoring(signer, root)` signs and files the operator's anchoring
  claim (zero-bounty, the mining analogy with the mint removed); `RarextClient.treasury()` reads
  the receipt classes with their real size and the budgets in flight. The lifecycle test now runs
  the whole loop through typed methods: register → publish → anchor → journey → participate →
  propose → pledge → vote → execute → verifyStateChain → claimAnchoring → treasury. The SDK README
  documents the surface; claim-check holds both method names against the README AND the source, so
  an agent-facing promise cannot outlive the method that keeps it.
- **The treasury view: a community can size a decision against the real class.** A budget that
  pays `{"kind":"receipt-holders","act":X}` resolves X against the node's ledger at execution, so
  a pledge made without seeing that class is a guess against an invisible population.
  `GET /v1/work/treasury` reports, per receipt act, how many receipts exist and how many DISTINCT
  holders hold them, with a per-root breakdown (so a root-scoped decision sizes against the root),
  plus `pending`: the proposals whose budgets already name a class, so a new pledge is not blind to
  the ones in flight. Counts are recomputed from the same records the commitment covers, never
  stored — a view that could drift from the ledger would be worse than none. WORK.md documents it;
  claim-check holds the doc sentence and the route together.
- **The one command now leaves a work record, not just a join request.** `become-a-node` gained
  two rungs between the archive and the journey: `[identity]` registers the operator's key as a
  real identity on the node, and `[receipt]` claims the operator's FIRST work receipt — the
  anchoring it just did, counted at zero bounty, so a 民主 decision can pay it later. The role is
  therefore real from the first run: before this, the operator's very first contribution went
  unrecorded, and a role without a record can never be paid. The join request now rides the
  operator's real handle (probed free on the node, suffixing rather than failing when a seeded
  identity holds the name), and the script asks the node which author handle is unregistered
  instead of assuming — a registered handle demands a signed build, which made the unsigned first
  publication flaky. Documented in OPERATOR.md; claim-check holds the two new rungs and the
  "FIRST work receipt" sentence against the script's emitters.
- **Anchor receipts: the operator's side of the roles — the mining analogy with the mint
  removed.** The participation receipt is what a READER did; running a node is what an OPERATOR
  does, and it now leaves a record the same way. `POST /v1/work/anchor` takes a signed
  `rarext.anchor-work.v1` claim naming the root the operator anchored; the node corroborates
  exactly what it can know (the key is registered, the signature is the operator's, and the root
  is one THIS node anchored) and records a receipt with `action: "anchor"` and `bounty: 0`. Zero
  is the design: nothing is emitted for anchoring — it is not a lottery over hashes — but the work
  is COUNTED, so a 民主 budget decision can pay the operators it names with
  `{"kind":"receipt-holders","act":"anchor"}`, which resolves to exactly the operators whose
  anchoring this node corroborated. One receipt per operator and root; an unregistered key, a
  forged signature, and a root the node never anchored are each refused by name. The receipt-act
  vocabulary is one place (`RECEIPT_ACTIONS` in the node's work module) so the budget rail and the
  docs cannot disagree about which actions are receipt classes. WORK.md documents the rail;
  claim-check holds the doc, the route, the claim shape, and the action vocabulary together.
- **One command: become a node.** `npm run become-a-node` composes the whole operator path —
  boot (on a free port, or an `--origin` already running), publish a seeded half-adder, anchor,
  confirm the state archive froze, the four-rail journey check, and PRINT the admission document
  (the join request, ready to attach to a governance proposal on a registry already in the
  federation). Every step's evidence is printed; a failed step names itself and the run stops;
  the script never files the request itself — an operator ASKS to join, the tally APPLIES the
  join. server.ts now prints the BOUND port (PORT=0 asks the OS for one; printing the constant
  named a port nobody was listening on). OPERATOR.md documents the command; claim-check holds
  the steps the doc names against the script's emitters.
- **The state chain, verified in the reader's browser.** The verify page's federation section now
  probes each listed registry's `/v1/history` alongside its admissions list — the two probes
  independent, so one absence never hides another — and verifies the chain IN THE READER'S
  BROWSER: every archive's state root recomputed from core's `stateArchivePreimage` (the rule
  whole in core, one await at the page's boundary — the same seam `recordRootPreimages` opened),
  every link naming the archive before it, the head anchoring to genesis. "verified: N archive(s),
  head …", the failure named per archive, or the absence reported as an answer. The seam is
  core's: `stateArchivePreimage` exports the exact string the root hashes, and the test asserting
  preimage-hashed equals the synchronous root is the seam's own proof. renditions.ts re-exports
  it; the mirror bundle rebuilt (the drift-checker caught the staleness); claim-check holds the
  history markers in the published page; live-checked on the deployed origin (both static
  registries report their 404 absence correctly).
- **The state archive: the ledger's history is tamper-evident, not merely recorded.** Publications
  were always verifiable backwards; the rest of the node's state was present-tense only. Every
  anchor now freezes a state archive — the durable state (proposals, votes, credits, admissions)
  hashed together with the PREVIOUS archive's state root (`stateArchiveRoot` in core; the first
  chains to a genesis root of 64 zeros) — so rewriting any past archive breaks the next one's
  chain. Served at `GET /v1/history` and `/v1/history/:anchorRoot`;
  `RarextClient.verifyStateChain()` recomputes every root with core's rule and checks every link
  (the head must anchor to genesis, so a reordered history fails at its head before anything else
  is trusted). Snapshot schema v8 (`stateArchives`; OPERATIONS.md's migration table updated).
  APP-PROTOCOL.md documents the rule and claim-check holds it against core's implementation.
- **The capabilities document — an agent lands cold and bootstraps from one answer.**
  `GET /v1/capabilities` returns `rarext.capabilities.v1`: the node's exact-path routes, its
  parameterized families, and the transition binding path — as data, listing itself so an agent
  that finds the node once can find the surface again. The document is held against the route
  table in BOTH directions by a test that extracts every route literal from the API's source: a
  route missing from the document fails CI with the path named, and a document entry matching no
  real route fails too — the machine contract and the node cannot silently disagree. (The file is
  `node-capabilities.ts` because `capabilities.ts` is the storage system's capability tokens — a
  different idea that owns its name.) `RarextClient.capabilities()` types it for the agent-sdk;
  APP-PROTOCOL.md documents the surface and claim-check holds the kind and the both-direction
  rule.
- **"AI lives on RAREXT" at the client surface: `RarextClient` now speaks the whole lifecycle.**
  The five-rail journey moved INTO the SDK (`packages/agent-sdk/src/journey.ts`,
  `runNodeJourney` — the CLI is a thin formatter over it, so a script and an agent cannot drift);
  and the client gained typed methods for the participation economy: `participate(signer, act,
  root)` builds and signs the assertion from the agent's key, `journey(root, registry)` asks
  whether the node is a full node, `propose`/`attachAdmission`/`vote`/`pledgeBudget`/`execute`
  drive the 民主 rail (the vote and the pledge are signed HERE, from the signer's key, via core's
  `voteStatement` and the canonical-payload signature), plus `anchor`, `ledger`, `earnings`,
  `registries`. A new test runs the whole loop through the client only: register → publish →
  anchor → journey (five rails pass) → participate → propose → pledge to receipt-holders → vote →
  execute → the holder paid, zero-sum even when the pledger and the holder are the same key. An
  agent runs the ecosystem without hand-building HTTP.
- **The seam closes: participation receipts are payable by decision.** A budget's `to` may be a
  receipt-holders spec — `{"kind":"receipt-holders","act":"mirror-verify","root":"<optional>"}` —
  and at execution the node resolves the class from its own ledger and
  `budgetDistributionRecords` (new, in core) derives the records: the pledger's single debit
  equals the SUM of the holder credits (zero-sum, never minted), the amount splits evenly with
  the remainder to the first holder in sorted order (deterministic — two nodes executing the same
  decision produce byte-identical records), and every record carries the proposal's root as its
  artifact reference, so a decision is payable once. A class that resolves to nobody pays nothing
  and the refusal says the class was empty; a spec naming a root pays only that root's holders;
  the receipt-holder loop prompt's "user contributing by just participating" now runs from verify
  to receipt to paid-by-decision end to end. RFC 0021 documents the rule.
- **Participation receipts — the user's side of the roles, countable in the ledger.** The loop's
  "user who is contributing by just participating" now leaves a record: a reader who verifies a
  mirror against a pinned root submits a signed assertion to `POST /v1/work/participation`
  (`rarext.participation.v1`), and the node corroborates what it can actually know — the key is
  registered, the signature is the participant's, and the root is one THIS node anchored — then
  records a receipt with `action: "participate"` and `bounty: 0`. ZERO is the design, not a
  placeholder: nothing is minted for participation (the protocol never mints), the receipt exists
  so a community's later budget decision can pay the participants a decision names through the
  same rail that pays any other work. One receipt per participant, act, and root; a root the node
  never anchored is refused by name ("it cannot corroborate a verification of it"); a forged
  signature earns nothing and leaves nothing. The receipt carries its `creditRoot` and its
  inclusion proof against the ledger commitment, and `/v1/work/earnings` serves it like any other
  receipt. WORK.md and RFC 0021 document the rail; claim-check holds kind, endpoint, and
  zero-bounty in both docs against the wiring. The action board gained `participate` in the
  `governance` style — recorded in the ledger, never offered as a job.
- **The circle closes: a node that can join must also serve the list it grew.** The node journey
  gained a fifth rail, `federation`: `GET /v1/registries` must parse through the seed's OWN rule
  (`parseRegistrySeedList`), not a shape the journey invents — walkable is a machine property, and
  the journey checks it as one. The mirror's federation section now probes each listed registry's
  admitted list in the reader's browser (the API sends CORS `*`), showing "N admitted by decision:
  <ids>" or reporting the absence as an answer ("a static site or a node from before admissions")
  — the 民主 rail's output is visible, or its absence is named, never hidden. OPERATOR.md,
  MIRRORS.md and the checker's markers updated with the five-rail claim.
- **The federation list joins through the 民主 rail** — a registry admission is a decision, not an
  edit: an operator attaches an admission document (`rarext.registry-admission.v1`, the seed's own
  entry shape + a `payOn` naming the choice that applies it) to a proposal at
  `POST /v1/governance/proposals/:root/admission`; the community votes; execute applies it through
  the SAME window/tally/decided guards the budget path uses — the decided choice must be the one
  the admission named, the decision applies exactly once, the registry id is unique (a second
  request while another proposal's is pending is refused: one open decision per registry), and the
  admitted entry is served at `GET /v1/registries` in the seed's own shape, parseable by
  `parseRegistrySeedList`, carrying the proposal root that admitted it. A rejected decision changes
  nothing and says so in the refusal. Snapshot schema v7 (`governanceAdmissions`,
  `registryAdmissions`; OPERATIONS.md's migration table updated). The attach route validates
  structurally (`admissionProblems`: kind, seed-shaped id, http(s) URL, operator, chains, payOn)
  and refuses a `payOn` the proposal does not offer at ATTACH time, not at execute time. RFC 0021
  documents the rule, OPERATOR.md the operator's curl, claim-check holds both against the wiring.
- **The operator's one command — `scripts/node-journey.mjs`**: "is THIS node a full node?"
  answered with four rails and evidence per rail, against any origin: `binding` (the node's own
  `/.well-known/rarext.json`, verified against the pinned root the caller owes — without it the
  rail is INDETERMINATE, never passed), `registry` (the bundle the node serves at
  `/v1/bundles/latest`, recomputed through `verifyBundle` — its manifest root must equal the pin),
  `ledger` (the work rail's commitment, live and shaped — labeled reachability-and-shape, because
  a full recompute needs the receipts, which are the earner's to pull by key), and `governance`
  (the 民主 rail answers, shaped like a proposal list). Exit 0 only when every rail holds;
  `--json` prints the same journey as a document. The failure names WHICH rail did not hold and
  what it answered — on a wrong root the evidence names the root the node actually serves, which
  is what the operator needs to see. OPERATOR.md documents the journey, claim-check holds the
  four rails in both doc and script, and four tests run the journey against a real in-process
  node (all four pass; an empty node fails naming the binding rail; a wrong root fails naming the
  root the node actually serves; no `--root` marks the binding rail indeterminate). Verified live:
  a real node process, publish + anchor through its API, journey exit 0 with evidence per rail.
- **The transition handshake works on shared hosts** — and the reference deployment proved it the
  hard way: the site-binding reader resolved `/.well-known/rarext.json` against the HOST ROOT,
  which dropped GitHub Pages' base path and 404'd against the project's own published binding.
  RFC 8615 registers well-known paths against the origin, but a site on a shared host cannot
  serve there — the host root belongs to someone else. Core gained `siteBindingUrlCandidates`
  (root first, then the site's own base path, deduped), the SDK reader asks both in order with
  every miss noted by location, and the fetch carries `cache: "no-cache"` — a discovery check
  that reads a CDN-cached absence reports a confident lie until the TTL expires. The project's
  own origins now publish their bindings (derived from the seed, nothing hand-written; the peer
  gets one plus `.nojekyll` so Pages serves the dot-path), and both verify LIVE:
  `site-binding.mjs https://999svs999.github.io/RAREXT-{protocol,mirror} --registry rarext --root
  46ef40bd…` → **JOINED**. Held: claim-check fails if the binding vanishes, answers for another
  registry, or names a root the committed bundle no longer rebuilds to; a unit test exercises the
  shared-host case (root 404s, base path answers) end-to-end against the registry's pin.
- **The reference deployment eats its own cooking**: the origin publishes its own transition
  binding at `/.well-known/rarext.json` — derived from the seed published beside the bundle
  (registry, root, bundle URL, cid, issuedAt; nothing hand-written) — and the peer gets its own,
  plus a `.nojekyll` so Pages serves the dot-path instead of Jekyll-ignoring it. A stranger
  verifies either origin the ordinary way: `node scripts/site-binding.mjs <origin> --registry
  rarext --root <pinned>` → JOINED. The claim is held: claim-check fails if the binding file
  disappears, answers for another registry, or names a root the committed bundle no longer
  rebuilds to; a unit test parses the published binding with the same rule any stranger's site
  goes through and verifies it against the seed's pin.
- **The resolve verdict is a published machine contract**: `site/schema/resolve-outcome.schema.json`
  (JSON Schema draft 2020-12, served on Pages at `/schema/resolve-outcome.schema.json`) and
  `docs/RESOLVE-JSON.md` — how to invoke, the exit codes (0 verified / 1 nothing verified or
  unparseable / 2 usage), the outcome fields, the refusal kinds, and two UNEDITED examples from
  live runs against the federation's peer (one verified, one a mirror that answered and lied).
  A robot branches on the exit code and `attempts[].kind` — never on prose. The dead `bundle`
  attempt kind was removed from `RarextAttemptKind` (no emitter, no reader — a dead enum value in
  a machine contract is a lie). The contract is HELD: claim-check compares the schema's attempt
  kinds against `RarextAttemptKind` in the SDK and the documented exit codes against the CLI's
  actual exits, and two tests validate live CLI `--json` output against the schema file itself
  with a dependency-free validator (native independence — no ajv, no installs).
- **The proof page is for every reader**: its result regions are live regions
  (`aria-live="polite"` / `role="status"`), so a screen reader announces the verdict when it
  arrives instead of an async injection happening in silence; the reference input is labeled,
  spellchecks off (a hex root is not a typo), takes Enter to resolve, and carries
  `enterkeyhint="go"` on a phone's keyboard; focus is visible on the dark theme
  (`:focus-visible`); `color-scheme: dark` keeps native controls and the mobile keyboard from
  flashing white; below 560px the rows stack. MIRRORS.md publishes the claim and claim-check
  holds all six markers in the published page — an accessibility claim that silently regresses
  is worse than none. Verified at a 375px viewport in a real browser, including the keyboard-only
  resolve of the peer's reference.
- **Attempt evidence is structural: every refusal an attempt records now carries a KIND** —
  `unreachable` (the host never answered), `unavailable` (it answered without the object), `malformed`
  (not parseable as the shape a reading needs), `mismatch` (it answered and does not rebuild the
  pinned root) — so an operator debugging mirrors tells a dead mirror from a lying one without
  grepping prose, which is the exact failure mode the codebase's own rule ("never classify a failure
  by matching message prose") warns about. The kinds are mapped from the walk's refusal STAGES and
  from the status a fetch carried — which meant teaching two things to say what they know: the walk's
  fetch refusals now carry the HTTP status they answered (a dead mirror and a 404 are different
  facts), and `verifyBundleShape` distinguishes "not shaped like a bundle" from "contradicts its own
  manifest" (`kind: "structure" | "rebuild"`), which the walk files at the right stage — a bundle
  lying about its own root is a ROOT refusal, not a shape one. The resolve CLI prints `[kind]` per
  attempt and a tally. Verified live: a wrong-root reference against the deployed registry reads
  `attempts: mismatch 3`.
- `findVerifiedBundleFromSeeds` keeps its evidence on both paths: a winning copy carries the
  refusals accumulated on the way to it, and a refusal throws WITH its refusals instead of a bare
  message — which is what let the resolver's attempts become structural at all.
- **The mirror's verify page resolves a `rarext:` reference in the reader's own browser** — paste
  one, and the page parses it with core's parser, fetches the location, and verifies it through the
  readings: a bundle through the page's own verifier, a record by hashing the preimage core computes
  (the rule whole in core, the one await at the page's boundary — the async-digest seam, tested to
  agree with the synchronous rules byte for byte), or raw bytes by their sha256. Verified LIVE
  against the deployed registry: a reference to the new bundle resolves to "VERIFIED: a registry
  bundle, by the root its content rebuilds to". RFC 0022's non-goal shrinks accordingly: what does
  not exist is a browser HANDLER for the scheme, not verification in a browser. The republish moved
  the pinned root to 33ebe079ecff007c…, mirrors OK 2 of 2, and the checker holds the panel in the
  published page and its one generator.
- **The budget wiring ships: a community can fund what it decides.** `POST
  /v1/governance/proposals/:root/budget` accepts the pledger's signed commitment — the payload names
  the proposal by its ROOT (the identity everything else defers to), the choice whose decision
  triggers payment, and is signed by the key that will be debited; the key must be a registered
  identity, one budget per proposal, and a pledge whose signature does not match the debited key is
  refused with "the money leaves THAT key or it leaves nothing" as the operating principle.
  `POST /v1/governance/proposals/:root/execute` pays a DECIDED budget — the node recomputes the
  tally itself, so the window must be closed, the outcome decided, and the decided choice the one
  the budget named (a tie funds nothing; an unmet quorum funds nothing; a "no" owes nothing) — and a
  replay is refused by the once-only field the debit and credit share. Snapshot migration 5 → 6
  persists budgets, so a pledge outlives the request that made it; every version pin moved with it.
  The audit chain is complete: pledge → decision → two ledger entries → the commitment a stranger
  recomputes.
- **A budget line exists as a protocol rule — and only as a rule, and the RFC says so.** The piece
  that lets a DECISION move credits instead of merely describing them: a pledge is the pledger's
  signed commitment (the payload carries the whole proposal it funds, the sponsorship pattern), it
  names the choice whose decision triggers payment, and it is refused by name for an unsound
  proposal, a non-positive or fractional amount, a pledge to yourself, or a `payOn` the proposal does
  not offer. `budgetPaymentRecords` derives what a decided budget becomes: exactly TWO ledger entries
  — the pledger debited, the recipient credited, summing to zero because the protocol never mints —
  both referencing the decision's root, the field the board already uses to keep the same work from
  being paid twice, so a decision is payable once. The ledger commitment covers both sides with no
  new machinery, and a ledger holding only the credit is provably not the ledger with both.
  Deliberately NOT in this commit: the route, the snapshot persistence, and the execution trigger —
  the rules are the part that must be right, and shipping them alone keeps the wiring an afternoon
  behind them instead of half-wired.
- **The credit ledger carries a commitment, so "the accounting is a node's word" is now false in
  the strongest sense available without the chain.** `creditLedgerRoot(records, hash)` in core
  recomputes a Merkle root over the records' identities — leaves sorted by the records' own roots, so
  the same ledger in a different order recomputes to the same root (the tally's determinism lesson,
  applied to money) — and `GET /v1/work/ledger` publishes it, recomputed at read time so it cannot
  drift from the records it commits to. A payment dropped, edited, or quietly added produces a
  different root; a partial copy is honestly a different ledger, because the count is bound by the
  tree; an empty ledger has a defined root, because "nobody has been paid yet" is a state worth
  committing to.
- **A receipt travels with its inclusion proof.** `creditLedgerProof` returns the siblings and the
  index (verifying needs both, and a worker holding only its own receipt cannot recompute where it
  sits), `null` when the record is not in the ledger — the honest answer to the question, not an
  error. The earnings response carries the proof per receipt, and the API test performs the whole
  audit from outside: fetch the published commitment, verify the receipt against it with core's
  `verifyProof`, trust nothing but the records named.
- **A worker's receipt is verifiable: credit records carry a recomputable root.** The credits board
  is this node's policy, but the identity of what it pays out is the protocol's — so core owns
  `creditRoot` over a declared field map, and a credit record is the one protocol record with NO
  minted label at all: every field is content (`CREDIT_ROOT_EXCLUDED_FIELDS` is empty, which is the
  claim that identity is entirely recomputable, and `at` is covered deliberately because WHEN a
  credit was earned is part of the payment, not bookkeeping about it). `GET /v1/work/earnings` now
  returns the receipts beside the summary, each with its `root` recomputable from the response as it
  arrived, and the API's own `CreditRecord` type is held against core's field map by a test that
  enumerates its fields — the seam where a new field would otherwise silently sit outside the
  receipt's identity. A `rarext:` reference names a receipt too (`matchRecordRoot` gained the
  credit rule): `a credit of 12 credit(s) to worker-key for verify on gen-starter`.
- **Recognition is not coverage.** The first version of `matchRecordRoot` let a rule compute a
  digest over a document carrying none of its required fields — a credit receipt carries
  `challengeId`, so the publication rule produced a mostly-empty-cover digest that a nonsense
  reference could have "matched", telling a client a receipt is a publication. Each rule now
  declares the fields that make a document recognizable AS that kind
  (`PUBLICATION_ROOT_REQUIRED_FIELDS`, `ANCHOR_ROOT_REQUIRED_FIELDS`,
  `CREDIT_ROOT_REQUIRED_FIELDS`), declared beside the rule so there is no second place to drift.
- **An anchor is addressable by the root its record rebuilds to** — the last object in the protocol
  that was named only by a minted label. `anchorRoot(anchor, hash)` in core covers the CLAIM (which
  root, over which publications, which leaf version, attested by which adapter under which reference
  and receipts) and excludes what a node minted (`id`) or wrote down (`createdAt`), with the same
  compile-time guard as a publication: `ANCHOR_ROOT_FIELDS` is `Record<keyof Anchor, boolean>`, so
  adding a field fails the build until somebody decides. The API serves anchors with their
  `anchorIdentity` (recomputed at read time), `GET /v1/anchors/:id` accepts the identity too, and
  the CLI names what answered: `an anchor of 2 publication(s) via eip-3009-anchor (0xabc), by the
  root the anchor rebuilds to`.
- **The registry of record identities moved into core.** The resolver was on its way to one
  hand-written reading per record kind; `matchRecordRoot(document, wanted, hash)` is now the ONE
  place that asks which rule rebuilds a document to a held root (publication, anchor — and the next
  record kind is one entry in core, after which every client gains the reading without another
  branch). The rules are domain-separated from each other and from a byte digest, so trying them in
  any order is safe, and the test proves neither document answers for the other's root.
- RFC 0022's non-goal has shrunk to browser support: every kind of thing the protocol writes down —
  a bundle, a publication, an anchor, raw bytes — is now nameable and verifiable by a reference.
- **A `rarext:` reference can now name a publication record** — the entries the storage economy is
  written in — by the root the record rebuilds to. The resolver reads each candidate ONCE and
  interprets it three ways (a bundle, a record, raw bytes), because fetching twice could disagree
  with itself about what a mirror said, and a failure reports every reading. Verified END TO END
  against a real node: a store seeded with a record from the committed bundle, the API serving
  `GET /v1/publications/<root>`, and the CLI resolving
  `rarext:127.0.0.1:<port>/v1/publications/<root>@<root>` into `a published record by ai-proof
  ("Replay of the committed starter model (32 steps)")` — while a wrong root is refused with all
  three readings' evidence.
- **A document that is not a bundle is refused BY NAME, not with a TypeError.** `verifyBundleShape`
  walked into `bundle.publications.map` on anything that was not a bundle, and the resulting
  `Cannot read properties of undefined (reading 'map')` reached the command line as the REASON a
  reference failed. It was found by pointing the resolver at a node serving records, which is the
  ordinary case, not the exceptional one: a candidate serves bytes, and the next step assumes a
  manifest. `bundleShapeProblem` now names the first missing piece ("it carries no manifest", "its
  manifest states no root", …), and the resolver's failure reads like a refusal because it is one.
- **The served record recomputes to the served root, with no ceremony** — a fix to yesterday's
  identity work, found by asking what a client actually receives. The API attaches `root` and a
  durability observation to a record when it serves it, and the first version of `publicationRoot`
  walked the record's own keys, so a NAIVE client recomputing over the response got a different
  digest than the one it was told (confirmed against live data: `78014d41…` vs `bd504c4a…`). The
  root now reads a DECLARED field map — `PUBLICATION_ROOT_FIELDS`, exhaustive by the type, `true`
  content / `false` bookkeeping — so presentation keys are ignored by construction, and the route
  test now asserts the recomputation from the response AS IT ARRIVED. The excluded-fields list is
  derived from that map, so it can never disagree with it.
- **A publication now has a recomputable identity, so the records the storage economy is written in
  are answerable instead of asserted.** A publication's name was an `id` the registry minted — a
  label, which meant a client could only take the node's word for what it was holding. Core now
  computes `publicationRoot(publication, hash)`: canonical, domain-separated, and taken over what
  the AUTHOR published, so the same content is the same object whichever node wrote it down and
  however many ids it was filed under. `id`, `attestedAt`, the attestation's own key id and
  signature, and `durability` are excluded BY NAME — the last one because core's own type already
  calls it "a reader's observation, not part of the publication".
- **What a root covers is a decision, not an omission, and the gate enforces it.** The test declares
  one mutator per field as `Record<keyof Publication, …>`, so adding a field to `Publication` fails
  the TYPE CHECK until somebody decides whether the root covers it or excludes it; the runtime half
  then proves the decision: every covered field moves the root, every excluded field provably does
  not, and every field of the record was decided on. A `HashFn` is a port, so the test also brings a
  hashing function that LOOKS at the preimage and shows the domain prefix is really there and the
  excluded labels are really absent.
- **`GET /v1/publications/:id` accepts the root too**, and every publication the API hands out now
  carries its `root` — recomputed at read time inside the one decorator all eight
  publication-returning paths already pass through, so no route has to remember. The served record
  rebuilds to the served root: the client recomputes the node's claim from the bytes it received.
  Two copies of one record under different minted ids share a root and therefore answer for each
  other, and a 64-hex segment no record rebuilds to is a 404 rather than a guess.
- The two record-root hashers became one: `governanceSha256` is now `recordRootHash`, a `HashFn` that
  takes bytes as well as text, because a second hasher for one kind of identity drifts the first time
  a digest's encoding is questioned. (tsc caught the width mismatch, not a test.)
- **A reference names CONTENT, not a format: bytes resolve by their sha256, and one URL can be two
  objects.** `resolveRarextUri` had one reading — a registry's bundle, checked by the root its content
  rebuilds to. It now has two, and a reference does not say which it means (only the root does), so
  the same candidates are read both ways: bytes are checked by their sha256. An image, a model file
  or a tarball of a site can therefore be named and verified by a client that has never heard of its
  type — which is what makes a reference a name for content rather than for a document format. The
  byte reading uses the walk's own policy-guarded fetch, timeout and private-address allowance
  (derived once and handed to both readings, because a second derivation is a second rule waiting to
  disagree), and a failure reports BOTH readings — "not a bundle" is not the same answer as "not
  there".
- **The two readings cannot both accept one copy**, and that is verified rather than assumed: a
  bundle root is domain-separated from the sha256 of the bytes that carry it, so the same URL named
  by two different roots is two different objects. Proven against the project's own live deployment —
  the published `bundleCid` (a CIDv1, base32) and the hex sha256 of the same bytes are the same
  32-byte digest spelled two ways, while the bundle root is something else — and both references to
  the one live URL resolve: `…@7ebdf81a…` as a bundle, `…@a26f7e87…` as a blob of 27124 bytes.
- **A new core test decodes a CID with an INDEPENDENT base32 implementation** (written in the test,
  not borrowed from the module it checks) and shows its payload is version 1, raw codec, sha256,
  32 bytes — the digest the hex form spells. It also moved the CID/hex equivalence out of prose and
  into a test, since a reference carries hex while the seed publishes a CID.
- The resolve CLI now says which reading answered (`VERIFIED: … — a blob of 27124 bytes
  (application/json), by the sha256 of its bytes — read from …`) and reports a blob's size, never its
  bytes: a JSON dump of a model file helps nobody, and a caller who wants the object fetches it.
- **The reference form is now USED, not merely specified: the surfaces print one, and a command
  resolves one.** `demo:resident` ends by naming the copy it verified — against the live registry it
  prints `rarext:999svs999.github.io/RAREXT-protocol/registry/bundle.json@7ebdf81a…` — and
  `scripts/site-binding.mjs` names the object a joined site serves (falling back to the bare-root
  form when the binding names no bundle URL, which is the honest one: the object, and no place to
  look). `scripts/resolve.mjs` resolves a reference from the command line with the same contract as
  the other CLIs: exit 0 verified, 1 not verified, 2 for a usage error, and every refused candidate
  printed with its reason. The round trip is proven against the project's own live registry — the
  demo's reference resolves, and the same reference with a wrong root fails naming BOTH roots
  ("verifies internally but rebuilds …, not the pinned …").
- **Two conversions moved into core, so nothing re-implements them.** `rarextUriFromUrl` (a
  location plus a verified root becomes a reference, refused by name for a `file:`-style scheme) and
  `urlForRarextUri` (where to go, or `null` for a bare root that names no location) now sit beside
  the parser they must agree with, and the resolver uses them instead of building URLs inline.
- **Who pays for a vote: a ballot can be sponsored, and the payer is in the record.** RFC 0021's
  last open governance question is closed. Participation is free and unpaid, so a participant with
  no credits must still be able to vote — and "free for the voter" must not become "anyone can vote
  in their name". `POST /v1/governance/proposals/:root/votes/sponsored` therefore requires TWO
  signatures that mean different things: the sponsor's assertion carries the whole ballot (change a
  field and their signature stops matching, so a sponsor cannot be tricked into paying for a
  different one), and the ballot's OWN signature is verified against the voter's key, so a sponsor
  cannot push a vote nobody cast. **Money buys storage; it never buys a choice.** The payer is
  recorded beside the vote (`voteSponsorships`, snapshot migration 4 → 5) and returned by the
  proposal `GET`, so the cost of free participation is visible in the same record instead of being
  implied.
- **One sponsorship rule, not two.** The existing challenge-sponsorship verifier was a monolith;
  the half that is the same whoever is being sponsored — the roster check, the freshness window,
  the nonce bounds, the member's signature — is now extracted and called by both paths, with the
  messages still naming what is being sponsored (`vote sponsorship is not configured` tells an
  operator something `sponsorship is not configured` hides). The ballot's own signature is checked
  through a PORT, because the same check runs on the unsponsored route; one rule, two callers. The
  challenge suite stayed green through the extraction, which is what makes it a refactor rather
  than a rewrite.
- **A crash mid-sponsorship is recoverable rather than corrupting**, and the order is chosen for
  it: the ballot is stored first and the nonce last, and because the tally keys duplication on the
  voter's KEY, a ballot stored twice counts once and the second copy is refused by name — so the
  window between the writes cannot produce a double vote.
- **A `rarext:` reference now resolves to a VERIFIED object — the client half of RFC 0022.**
  `resolveRarextUri` (in `@rarext/agent-sdk`) turns a reference into candidates, walks them with the
  SDK's existing search — `findVerifiedBundleFromSeeds` owns the walk, the pins and the refusal
  records, so no second walk exists — and accepts only a copy whose recomputed root equals the root
  THE REFERENCE CARRIES. The test resolves the project's own published bundle through a reference
  served over loopback, rather than a fixture invented for the occasion.
- **The property that makes a reference safe to pass around is exercised, not asserted: a location
  is a hint.** A copy that lies about its own root (the committed bytes with the manifest's root
  rewritten) is refused BY NAME and the mirror still resolves; with no location serving the pinned
  root, every candidate is named and the failure says which root it was looking for. A bare root
  with no candidates is refused with its reason — it says what to look for, not where. A registry ID
  as an authority is refused rather than guessed, because an id needs the federation list and a
  guessed host would make the hint load-bearing.
- **Two instrument bugs, both about honesty rather than correctness.** The reference was put in the
  seed's `url` field, and the private-address allowance reads exactly that field — a `rarext:` string
  parses with an empty hostname, which passes the address policy, so a caller's own loopback node was
  refused as if it were public; the seed's location is now the candidate, and a loopback reference
  earns the allowance the same way a local seed does. And the checker's own summary line still said
  "no resolver" after the resolver shipped, while the RFC's non-goal still claimed "nothing here
  resolves anything" — both were made true: the sentence now says a lookup decides nothing, and the
  line reports a resolver that only verifies against the root.
- **RFC 0022 — naming: does RAREXT need its own URL form? Answered with a syntax and one rule, and
  with the alternative it refuses named in writing.** The protocol could verify an object and could
  not WRITE ONE DOWN in a way that is checkable before fetching: quoting
  `https://example.com/registry/bundle.json` in a document, a message or an artifact carries no
  commitment, so the reader either fetches on faith or fetches and then finds out what it got.
  `packages/core/src/rarext-uri.ts` now parses, canonicalizes and compares a `rarext:` reference
  with one rule — **a RAREXT reference carries the root it commits to**; without one it is a name
  you have to trust, and this protocol does not have those. Two forms, both carrying a root:
  `rarext:<64-hex root>` (the root IS the address — nothing to resolve) and
  `rarext:<authority>/<path>@<64-hex root>` (a location plus the pin). `sameRarextObject` compares
  ROOTS, so two references that disagree about where to look still name one object when they agree
  about what its bytes must rebuild to — which is what makes a reference safe to carry across
  mirrors. Refusals are part of the design and are tested: no root, a root that is not 64 hex, a
  path with an empty segment or `..` (how a written address quietly becomes a different address),
  and any other scheme refused by name rather than coerced.
- **The alternatives are named and rejected, which is the part that matters.** A new global name
  service would be a name root run by someone — the third party as critical infrastructure this
  project refuses, capturing every site's identity into a namespace they did not choose, duplicating
  DNS badly to solve a problem about writing a reference down rather than looking one up. A `rarext`
  TLD asks a standards body for a namespace that is not ours to take. A root in an https query
  string works and is droppable by any layer that rewrites URLs, which for a commitment is a
  contradiction. And the syntax resolves NOTHING: a client still finds the bytes over ordinary HTTPS
  through the existing URL policy and still decides by recomputing the root, so the location is a
  hint and never authority. Held by `claim-check` — 13 primitives, the document it cites, its
  sections, and the four sentences its argument turns on, with two injections (a missing cited
  document, and the one rule softening into a recommendation).
- **The transition page now points at it**, because the two are one story: a DNS site joins by
  declaring a binding (RFC-less, shipped), and a `rarext:` reference is how that object is written
  down when it leaves the context that carries its root.
- **A vote now has somewhere to travel: the governance route, and a decision survives the
  process that recorded it.** `POST /v1/governance/proposals` pins a proposal and answers with the
  root the node COMPUTED for it; `GET /v1/governance/proposals` lists what the node holds;
  `GET /v1/governance/proposals/:root` returns the proposal, its votes and the tally; and
  `POST /v1/governance/proposals/:root/votes` accepts a signed vote. Proposals and votes live in
  the store's snapshot — migration 3 → 4 adds `proposals` and `governanceVotes` — so a decision
  outlives a restart, held by a test that stops the deployment and starts a second one on the same
  file.
- **The node is a bulletin board, never a judge.** It refuses what it cannot store honestly: a
  proposal the tally could not compute (one validation in core, shared by the route and the tally)
  and a vote whose signature does not verify, so the store does not fill with unusable rows. But
  acceptance is not a verdict — `one key is one vote`, the window, the choice and the weight are
  the tally's findings, and GET recomputes them with core's `tallyVotes`, the same function a
  stranger runs offline. A test recomputes the tally independently from the published votes and
  requires the SAME root as the node's answer, so the node's arithmetic is never taken on trust.
- **A real vulnerability, found by the test that was written to check it: the identity that votes
  is the KEY, not the label.** Duplicate detection keyed on the `voter` field — a name a voter
  chooses for itself — so one key could vote every choice simply by relabelling itself, and the
  count showed two voters. The same field would have let a work-weighted ballot inherit another
  worker's credits by naming them. The tally now keys duplication on `canonicalize(publicKey)`,
  and the weight port receives the VOTE rather than a voter name, so the ledger entry it reads is
  the one the ballot was actually signed by (`keyId(publicKey)` — the key the ledger already pays).
  A regression test votes twice with one key under two labels and requires one counted vote.
- **Two doc claims the checker caught before a reader could: one invented route and one stale
  version.** This iteration's APP-PROTOCOL entry named `GET /v1/earnings/:keyId` — written from
  memory, and handled by nothing; the real route is `GET /v1/work/earnings`, and the doc↔code rule
  said so immediately. The same run caught `OPERATIONS.md` still calling snapshot version 3
  current, which is exactly the kind of drift a migration creates.
- **RFC 0021's central claim is now executable: the tally ships.** `packages/core/src/governance.ts`
  adds `proposalRoot`, `voteStatement`, `tallyVotes` and `tallyRoot` — a proposal is a document
  whose root the votes are bound to, a vote is a signed statement over exactly five fields, and
  the tally is a pure function of the published votes and the pinned policy. Signature verification
  and the credit ledger are PORTS (`verify`, `weights`), the same shape as the injected hash in
  every other core primitive, so the rule never touches a key or a balance — and a work-weighted
  policy with no ledger is an ERROR rather than a tally of zeroes, because a silent zero looks
  exactly like a community that did not show up. Verdicts are `decided`, `tie` (no winner invented
  from a tie) and `no-quorum`; every vote that does not count is refused BY NAME — wrong proposal,
  unknown choice, outside the window, forged or edited signature, a second ballot from one voter,
  a voter the ledger does not know — because a silent subtraction is not an audit. `tallyRoot` is
  what two independent recomputations compare instead of arguing.
- **A determinism bug my own test caught, and the regression that now holds it.** The duplicate
  rule originally ran BEFORE signature verification, and two ballots from one voter sort by
  signature when their issue times match — so the same set of votes could be reported as
  "invalid + duplicate" or "duplicate + invalid" depending on which ballot sorted first, yielding
  two different result roots for identical inputs. Order independence of the COUNTS was not enough
  when the refusals ride along in the same root. Validity is now checked first (an invalid vote is
  not a duplicate of anything — it is an invalid vote), and a regression test recomputes four
  permutations of a set containing a duplicate and an edited ballot, requiring ONE root.
- **The checker's sentence needles were breaking on markdown line wraps, and two false "no longer
  states" failures on the first run were that bug rather than a change to the RFC.** A wrap is not
  a change to a claim, so the comparison now collapses whitespace (and lowercases) on both sides —
  the same treatment the earlier prose-matching bug in the URL policy earned, applied to this
  rule's own instrument.
- **RFC 0021 — roles, work, and how the community decides (the economics half, grounded and
  labelled).** Three questions a person arriving with an idea asks in the first hour had no
  single answer: what am I here, where does money come from, and who decides what is good. The
  first two were scattered across `docs/WORK.md` and the RFCs — workable for an auditor, useless
  for someone deciding whether to bring a server, an agent or a business. The third had no answer
  anywhere: the ROADMAP listed "Governance approval" unchecked, and nothing in the tree said what
  a decision would even look like. The RFC states the roles once, each a worker with a key and a
  different kind of work rather than a different permission — operator (經營者), builder, verifier,
  reporter, participant, agent — and states the operator's economics plainly: not paid for running
  software or holding a key, but for provable work whose receipt anyone can recompute, which is
  the honest kernel of the mining analogy. Participation is free and unpaid ("participation costs
  nothing and pays nothing"), which is both the equal-opportunity half and the reason there is no
  leaderboard by default.
- **The AI-token question answered by drawing the boundary rather than dodging it.** "AI lives on
  RAREXT" has an economic reading that is not "the protocol issues a coin": an agent is a WORKER —
  it attests, verifies, stores, mirrors — paid in the same per-key credits, and that credit is the
  AI token in substance, existing today because the board exists today. If a community wants those
  credits transferable or traded, that is an application, not the protocol, exactly as a launchpad
  is an application; the application publishes its issuance policy as an artifact and certifies
  against it, and the ROADMAP's refusal to run a token sale is not reopened.
- **Governance as an artifact, with the tally recomputed rather than announced.** A proposal is a
  document with a pinned root; a vote is a signed attestation over (proposalRoot, choice, voter,
  issuedAt) using primitives the protocol already has; the tally is a pure function of the
  published votes and the pinned policy, so anyone recomputes it and either agrees or finds the
  disagreement in writing; the result is published beside the votes. No committee, and the rules
  are policy rather than code — one key one vote, work-weighted credits, an operator attestation,
  a paid proof, an invite: the protocol does not choose, the community pins a document and a
  reader sees which rule produced the number. The limits are stated rather than implied: keys are
  free, so **one key is not one person** — a verifiable tally and no privileged decider are
  claimed, proof of personhood is not, and a community needing sybil resistance pins a policy
  that names how weight is earned. All four open questions carry real verdicts (the weight and
  quorum defaults are deliberately NOT the protocol's to set; anchoring orders a result without
  making it true; nobody pays for a vote yet and the RFC says so).
- **Held by the gate, in the spirit of RFC 0019.** `claim-check` verifies the 22 primitives the
  RFC leans on exist in the source trees (the board, the credit records, rent, attestation,
  signatures, rotation, revocation, anchors, semantics), that every document it cites resolves,
  that its sections are present, and that the five sentences its argument turns on survive — with
  two injections (a cited document that no longer exists, and a tally that is announced instead
  of recomputed) so the rule cannot pass vacuously. The repo's open-question rule caught this RFC
  on its first run, which is why every question now carries a verdict.
- **A node declares its own binding — the reference deployment is now the first site that
  transited, and it says so from its own state.** Iterations #1 and #2 made a site's binding mean
  something and readable; this makes a node answer the question about itself, at the same path a
  static site publishes: `GET /.well-known/rarext.json` returns
  `{registry, root, bundle, issuedAt}`, where the root is the newest anchor **this deployment
  actually made** (so the statement cannot drift from the record it describes) and the location
  comes from `requestOrigin`, the helper every other self-describing route already uses, so a
  node behind a proxy names the address a client actually reached. Nothing is hand-written and
  nothing is guessed: `RAREXT_REGISTRY_ID` names the registry the node answers for, and unset (or
  blank) means it publishes **no** binding rather than a plausible one, because a node that picks
  its own name is making a claim about someone else's registry; a node that has anchored nothing
  answers 404 with the reason, because it cannot state a root it does not have. Both refusals are
  tested, and the client reads the node with the ordinary reader — `readSiteBinding` against a
  loopback node, then `node scripts/site-binding.mjs http://127.0.0.1:8787 --registry rarext
  --root <64-hex> --allow-private` printing JOINED. The environment setting is in the OPERATIONS
  table, which the checker enforces in both directions, so it could not be added silently.
- **One limit stated plainly rather than glossed.** The file carrier lives at
  `/.well-known/rarext.json` on the ORIGIN, because a binding binds a host and not a path. A
  project page under a shared origin — the usual `user.github.io/project` shape, which is what
  this project's own site is — therefore cannot declare for that origin: the origin root belongs
  to whoever controls the origin. TRANSITION.md now says so, and names the three ways such a site
  joins instead: its own hostname, the `_rarext` record at its own host, or running a node and
  serving the route.
- **The transition can now be READ, in one command, and the client says which of four things
  happened.** Iteration #1 made a site's binding mean something; this one reads it. The reader
  (`readSiteBinding`, exported from `@rarext/agent-sdk`, living in the SDK because core decides
  what a binding MEANS and a caller decides how it reaches the site) reads both carriers and
  reports each as `served`, `absent`, `refused`, or `unreachable`, then hands the bytes to
  core's parser and nothing else. Fetching and resolving are ports — an injectable `fetch` and
  an injectable TXT resolver, with `fetch` and `node:dns` as the real defaults — so a suite
  reads a binding from a loopback server and a stub resolver and never touches the network. A
  TXT record's chunking is joined here, because that is a transport fact this layer owns and not
  something the parser should know. And `node scripts/site-binding.mjs <origin> [--registry]
  [--root]` makes it one command: exit 0 only when the site has joined (readable and matching
  the pin), 1 when it published no binding or does not match, 2 for a usage error — and with no
  `--root` it prints the statement and REFUSES to invent a verdict, because a binding cannot
  certify itself.
- **A policy refusal is no longer confused with an unreachable site — and the fix was to stop
  matching prose.** The reader's first version classified a refusal by matching `/private
  address|not fetchable|scheme/` against the policy's message. The message says "private **or
  link-local** address", so the pattern never matched, and a refusal was silently reported as a
  network failure — the exact confusion the reporting exists to prevent, and invisible because
  both outcomes are "no binding". `fetchWithUrlPolicy` now tags its refusals with a
  machine-readable `URL_POLICY_REFUSAL_CODE`, the reader compares the code, and a core test
  holds the distinction in both directions: a refused URL is not contacted at all, and a
  genuinely unreachable host is not tagged as a refusal. Every caller that must tell a decision
  from a failure — the API and the SDK included — now can.
- **The reading half is held, not just documented.** `claim-check` requires TRANSITION.md to
  name the CLI, the reader and the refusal code, requires the CLI to keep its honest refusal
  (checked against the CLI's own source), and requires core to stay free of any reader of its
  own — with both of those guards INJECTED (a CLI that invents verdicts, a core that grew a
  reader) so neither can pass vacuously. The CLI suite spawns the real command against a
  loopback site and a committed seed's root, so the exit codes are exercised end to end.
- **A DNS site can join RAREXT without moving — the transition is now a verified rule, not an
  intention.** The web4 network should not ask anyone to leave the web they already have, so
  the smallest possible step onto it is a statement: a site that answers on a hostname declares
  which registry's copy it serves, in one of two carriers — `/.well-known/rarext.json` (any site
  that can serve a file) or a `_rarext.<host>` TXT record (a site that controls its name and not
  its tree). Both parse into ONE shape and must AGREE: a site whose file and whose name record
  name different roots is reported as disagreeing, by carrier, rather than averaged. The verdict
  never comes from the site's own word — `verifySiteBinding` refuses without the registry's
  pinned root, then distinguishes `root-mismatch` (serving a copy that is not the one its
  registry pins) from `registry-mismatch` (answering for a different registry), because those
  are different operator problems. This lives in `packages/core/src/site-binding.ts` and is
  exported from `@rarext/core`; reading the document and resolving the record are deliberately
  left to the caller, so the rule stays in one place and the I/O stays where it belongs.
  `docs/TRANSITION.md` states the convention and its limits (it is not a name service and does
  not replace DNS; it proposes a location, never a fact), the README links it, and
  `claim-check.mjs` holds the page against the code in both directions that rot: the ADDRESS a
  site is told to use is read from the constant, never from the prose, and the promised verdicts
  are EXERCISED — no-pin refused, root-mismatch, registry-mismatch, and a matching binding
  accepted.
- **Two injections repaired, and one of them was lying.** The snapshot-migration injection
  doctored the literal "Snapshot version 2 is current." — which stopped existing when the
  document was updated to v3, so it mutated nothing and its case proved nothing; the doctor
  guard reported it STALE, which is the only reason it was caught. It now doctors the PATTERN
  (`Snapshot version \d+ is current.`), which stays valid across future bumps instead of needing
  a matching edit each time. And the new transition injection used `replace`, which rewrites
  only the FIRST occurrence — the doctored page still named the real path further down and the
  rule correctly found nothing wrong, so the case was vacuous until `replaceAll` made it honest.
- **The native path is now real, and held: npm is an optional rail, not a foundation.** RAREXT
  is for web4, so natively it should depend on nothing but Node itself — and it nearly did: the
  API, the core, the verifiers and the tests already resolved inside the tree, but
  `packages/agent-sdk/src` imported `@rarext/core` by package name, which meant the SDK, the MCP
  server and BOTH resident demos could not start without `npm install` laying down workspace
  symlinks. A package manager had become the thing that decided whether the protocol starts.
  Every runtime specifier in that graph is now relative (source, tests, the web page, the
  self-publish demo), so a clean clone with **no `npm install` and no `node_modules`** runs the
  API, the MCP server, `demo:resident` (all four answers), `demo:self-publish`, `claim-check`
  (and its self-test), `verify-seed-mirrors`, and the core/SDK/web test suites on plain `node`.
  The npm rail is unchanged and still proven: `scripts/build-packages.mjs` keeps the packaged
  bundles importing `@rarext/core` by name — a tarball ships no source tree — rewriting the
  relative specifier back for both the bundle and its declarations, and `npm run verify:packages`
  imports those tarballs by name to prove it. `scripts/claim-check.mjs` now holds the difference
  with a dedicated rule and its own injection: **no file on the runtime path may import a sibling
  package by name** (254 runtime files scanned), the one exemption being `verify-packages.mjs`,
  which exists to prove the optional rail rather than participate in the native one. README and
  OPERATIONS.md state the native path with plain-`node` commands, and the dev tooling that
  genuinely needs npm — the esbuild workbench bundle and the solc/ethers contract toolchain —
  is named as such instead of standing in for the whole project.
- **RFC 0019 — mirror announcements, the last stated federation gap, argued in writing.** The
  agent wrote the RFC and its MIRRORS.md link; the claim kind and the commit were cut mid-turn and
  the supervisor finished them. The RFC proposes announcements as **signed locations**: an
  operator signs a statement binding a registry's bundle URL, a mirror URL, the pinned root and
  CID, an issue time and an expiry, using identity primitives that already exist. Its security
  section states the shape the design turns on — **an announcement proposes LOCATIONS, never
  facts**: it cannot change a pinned root or CID (clients still run the existing candidate
  verification and refuse bytes that do not hash), a forged record fails signature verification,
  an expired one is discarded before it reaches the union, and two operators disagreeing is still
  the loud stop `planSeedUnion` already provides. It is additive by construction (an optional
  `announcements[]`, absent meaning today's exact behaviour) with explicit non-goals (no DHT, no
  new transport, no consensus, no change to what "verified" means). All seventeen primitives it
  leans on were verified to exist in the tree. The new kind holds it: primitives present, paths
  resolve, and the three sections plus the load-bearing sentence must survive edits. Its own
  injection caught a mistake in the test rather than the code — the first version doctored the
  RFC's prose about primitives, which the kind never reads (the explicit list is checked against
  the SOURCES), so it proved nothing; the injection now weakens the sentence the kind does read.
- **Two body readers, one hardened — the pin service could be wedged.** The MCP hardening round
  taught `holder-server.ts`'s `readJson` an inactivity bound and a declared-versus-delivered
  refusal; `pin-server.ts`'s `readBody` kept a size cap alone. A client that declared a
  `content-length`, sent a fragment, and held the socket open therefore wedged a pin write
  indefinitely — the hardening never reached the second implementation. Both now read through ONE
  collector (`apps/api/src/http-body.ts`: hard cap, inactivity bound reset on every chunk,
  early-end detection, declared-versus-delivered check), with each caller keeping its own refusal
  style (the holder writes a 400 and flushes before the socket dies; the pin server throws and its
  handler answers 400). The pin service gains `RAREXT_PIN_BODY_STALL_MS` (default 30s, documented),
  and the new test opens a raw socket that declares 200 bytes, sends 10, and holds — proving the
  request is refused rather than held. Anti-vacuity was proven by raising the bound to 60s: all
  three tests in the file fail, the wedged request taking the service down with it, which is the
  availability impact stated as a measurement rather than an argument.
- **The docs' configuration surface is asserted, not just true today (kind 22).** A sweep of the
  docs that grew most in recent cycles found env-style names, state paths, and RFC references that
  were **backed by the code but asserted by nothing** — true the day the sweep ran, free to rot the
  next. Nothing was unbacked, so the finding is the missing assertion rather than a false claim:
  the new config-surface kind now extracts those tokens from ARCHITECTURE, SEMANTICS, MIRRORS, and
  OPERATIONS, and requires each env name to be read somewhere in the source trees (scripts count as
  readers, since an operator's knob may be read only by the scripts they run), each `rfcs/*.md` to
  exist, and each state path's file name to appear in the code that writes it — 35 env names, 1 RFC
  path and 9 state paths, now held by the gate. The source walk itself was extracted into one
  helper both this kind and the app-protocol kind use, because two kinds disagreeing about what
  "the sources" means is the same disease as two implementations of anything. Two of its own traps
  were caught while wiring it: a duplicated binding from the extraction (a syntax error, found by
  running it), and the phantom-name trap a third time — the self-test's invented env name was
  itself in the walked sources, so the doctored doc read as backed by the checker's own fixture.
  The checker is now excluded as a reader, with that reason recorded, and the phantom name is built
  at runtime.
- **The client, the pin service and the checker had never been run against each other — and they
  disagreed.** Starting from the belief that no pin service shipped here, the check that
  prevented a duplicate implementation found `apps/api/src/pin-server.ts` already wired as
  `npm run pin`, documented in OPERATIONS.md, with `/v1/pins` and GC. The duplicate was
  discarded (deleting it rather than landing a second implementation is the whole discipline of
  the last several cycles). What the sweep DID uncover is that nobody had ever driven the real
  service with the real client: the service answers `GET /v1/pins/<cid>` with a JSON envelope
  carrying base64 content, while `checkPin` hashed the raw response body — so every pin recorded
  from the real service would have failed verification against itself, hashing the envelope
  instead of the bundle. `pinContentBytes` now reads both honest shapes (raw bytes for a static
  copy, the envelope's `content` for the service), the new end-to-end test drives the documented
  command with `pinBundle`, reads the reference back, hashes it, verifies through `checkPin`,
  and then tampers the store on disk to prove the check still catches it. A second test keeps
  the raw-bytes path honest. Also corrected in this cycle's report: the earlier claim that
  nothing here lets an operator run a pin service was wrong — the service existed; the gap was
  the untested seam between the three pieces.
- **An agent can now replay a verified bundle's AI claims with no server.** The SDK gained
  `findVerifiedBundle` two cycles ago, so a resident can find and check a copy of the
  registry from a seed document alone — but the only SDK path to an AI verdict was
  `verifyAi`, which fetches the challenge from the API first. A verified bundle already
  carries everything that fetch was retrieving: each AI publication's artifact and the
  challenge spec its claim was written against, which is exactly what the mirror's proof
  page replays with. `replayBundleAi(bundle)` closes the gap: it walks the publications
  whose attestation declares a representation, pairs each with the challenge the same
  bundle carries, and replays it through core's `verifyAiArtifact` — no fetch, no server,
  no API, and no representation math of its own. One verdict per AI claim, carrying the
  bundle's manifest root so it ties to the copy that was verified: a generative claim
  reports the seed, the steps, and the model digest (the same computation `verifyAi`
  does, now shared by both) plus core's regenerated output beside the output the claim
  carries; a bounded claim reports the recomputed metric beside the attested
  `metricValue`, and a disagreement is `correct: false` rather than a silent pass. A
  publication whose challenge the bundle lacks is an entry whose error reads
  `challenge <id> not in bundle` — a verdict, not a silent skip — and a bundle that
  claims nothing AI returns an empty list. Nothing an attestation says can raise
  `correct`: it is only ever compared against what the resident recomputed, including a
  representation that disagrees with what the artifact replays as. Four mirror tests
  hold it: the committed bundle found from a served seed with that server stopped and
  `fetch` poisoned, then both live claims verified with evidence; a forged generative
  output failing with expected-vs-actual evidence beside it; a dropped challenge named
  by its id; and a bundle with no AI publications returning an empty list. claim:check
  replays the committed bundle itself as part of `docs/AI-VERIFICATION.md`'s kind —
  every AI claim correct with evidence, and a forged output rejected — and the new
  sentences in that doc and `docs/MIRRORS.md` are held to the SDK export by two
  self-tested injections.

- **A bundle response is now capped before it is read, on every client path.** All four
  fetch paths — `bundleFromSeed`, the SDK's `findVerifiedBundle`, `verify-seed-mirrors.mjs`,
  and the proof page's failover — materialized the whole body before any check ran, so a
  hostile or compromised mirror could hand every verifier, agent, checker, and visitor's
  browser a 2 GiB allocation from a ~21 KiB honest bundle. Each path now reads through one
  shared cap, `MAX_BUNDLE_RESPONSE_BYTES` (8 MiB in `@rarext/core`; generous headroom
  without being an amplifier): a declared `Content-Length` above the cap is refused
  unread, and the body is otherwise consumed in chunks with a running byte counter, so
  the cap holds even when the header is absent or the server streams forever. A refusal
  names the cap and the size when known, and lands in `refusals` like any other candidate
  refusal — the next candidate is still tried. The pinning adapter's 64 KiB service cap
  is unchanged.
- **A mirror pointer is now a hash, not just a URL.** MIRRORS.md named content addressing for
  the bundle as federation's other missing half; the first half of it is implemented. The seed
  pins the bundle's content address — `bundleCid`, a CIDv1 over the raw sha2-256 of the exact
  published bytes, computed by `publish-proof.mjs` where the bytes are written — and every
  client path verifies it: `bundleFromSeed` reads BYTES (not a parsed shape), hashes them, and
  refuses a copy that hashes elsewhere **even if it verifies internally and rebuilds the pinned
  root**, because a pointer that is a hash cannot be re-serialized into being (the test serves a
  semantically identical bundle with different whitespace and requires the refusal);
  `verify-seed-mirrors.mjs` hashes each live candidate; and the deploy fails unless the live
  bundle hashes to exactly what the live seed pins. Honest scope, stated in the doc: the CID is
  computed and verified everywhere, but nothing yet hands it to IPFS or Arweave, so the hash
  still resolves only at the URLs the seed lists — that is the pinning adapter, whose slot
  exists in `apps/api/src/adapters/content.ts`.
- **The front door now links the proof, and the deploy pins it.** The landing page — where a
  visitor decides whether this project is a promise or a proof — linked only the registry
  listing; the pinned verifier and the gallery (the AI artifacts that verify themselves) were
  two clicks deep. The hero now carries "Verify this registry in your browser" and "Watch AI
  artifacts verify themselves", and the deploy rewrites every `data-pin-root` link to carry the
  anchored root, so the verifier opens already pinned to the root the chain holds — the front
  door verifies THIS registry, not a screenshot of one. The pinning is loud in both directions:
  a marker that fails to rewrite fails the deploy, and a landing page with no marker fails it
  too (a proof link that silently stayed unpinned is precisely the quiet degradation this
  protocol exists to prevent). MIRRORS.md states the contract and claim:check holds both sides
  to it — the landing page must carry the marker, the verifier link, and the gallery link, and
  the self-test removes the marker and requires the mismatch.
- **A sweep for duplicated generated artifacts found the inline bundle written three times.**
  After fixing the proof page's twin generators in the previous cycle, a sweep across all of
  `scripts/*.mjs` found the same pattern live in the bundle itself: `build-mirror.mjs` and
  `publish-ai-proof.mjs` each wrote `bundle.js` with the same inline one-liner
  (`window.__RAREXT_BUNDLE__ = ...`), and publish-ai-proof's own comment admitted it: it built
  "the same way scripts/build-mirror.mjs does". The twins had already diverged: one injected
  `./bundle.js` into the workbench and the other `/bundle.js`, relying on a later pass to
  reconcile them. That pair now lives in `scripts/mirror-artifacts.mjs` (`writeBundleFiles`,
  `injectBundleScript`), and the injection throws loudly if the needle is absent rather than
  silently no-op'ing. A twenty-first claim kind (`checkArtifactSources`) now asserts the
  inline bundle and the proof page each live in exactly one module and that every generator
  delegates to them — so the whole class of "the edit landed in the copy nobody publishes" is
  structurally impossible to reintroduce. The checker caught two errors of its own while being
  wired: it initially flagged itself for mentioning the markers it enforces (it is now
  excluded with the reason recorded), and `isGeneratorScript` was referenced before its const
  was initialized — both caught by the self-test before any commit.
- **The published proof page was a second implementation, and the failover landed in the copy
  nobody published.** After adding mirror failover to the generated page, the live page had no
  trace of it: `build-mirror.mjs` writes the local dev tree, while the PUBLISHED page comes from
  `publish-ai-proof.mjs`, which carried its own near-identical copy of the same page. Both were
  "generated correctly" by their own generator, so the duplication was invisible and the fix
  simply went to the unused twin — the same trap as before, one level up: not a broken check but
  a broken assumption about which artefact the check was looking at. The page now exists once,
  in `scripts/mirror-verify-page.mjs`, and both generators call it with their own title and
  heading; the committed `site/registry/mirror/verify.html` was regenerated from that module
  (5,389 → 8,487 chars) and its failover proved again in a real browser (tampered local copy
  rejected with its reason, faithful sibling served, roots equal at 793915a9…). `claim:check`
  now asserts the page's behaviour lives in the module AND that neither generator keeps a
  private copy of the page code — that guard caught two mistakes of its own while being written
  (it first failed on the heading strings, which are legitimate arguments rather than
  duplication), which is recorded because a guard that cannot tell an argument from a copy is
  the same class of error it exists to prevent.
- **The published proof page now fails over between copies, and says which one it used.**
  A visitor who opened a mirror's `verify.html` had no recourse if that mirror's own copy was
  tampered or missing: the page fetched `./bundle.json` and stopped. It now applies the same
  rule as `bundleFromSeed` in the browser — this mirror's copy, then the sibling registry copy
  (whichever relative form the tree is published in), then the locations the seed names —
  accepting the first candidate that verifies **and rebuilds the pinned root**, and printing
  `Served from` plus every rejection with its reason. Proved against a local server in a real
  browser: a tampered mirror page reports `Rejected ./bundle.json: the publications in this
  bundle do not rebuild the anchored root` and serves the faithful sibling copy (roots equal,
  AI renditions re-derived); with both copies tampered it reports "No copy verified" instead of
  a green row; and with a WRONG pin the honest copy is refused with "the bundle root does not
  match the pinned chain root", so the pin really gates client-side. The doc's claim about the
  page is now checked against its generator (build-mirror.mjs), so it cannot rot.
- **The seed's mirror list was a mirror list in name only, and a test held it there.**
  Checking the published seed against the live network — before writing any new code —
  showed its single `mirrors[]` entry pointed back at the registry's own bundle URL, so the
  seed named one location twice and `bundleFromSeed` had nothing to fail over between. The
  deploy was green the whole time because every root matched; a mirror that is a copy of
  the seed is indistinguishable from a mirror by root alone. `scripts/verify-seed-mirrors.mjs`
  is the check that was missing: it fetches the seed, requires at least two DISTINCT
  locations, and requires each to rebuild the pinned root (a merely unreachable location is
  reported, not fatal, while another verifies — mirrors exist to be redundant). It failed on
  the live seed exactly as predicted, then passed once the seed named the mirror tree at
  `/mirror/`, which is a genuinely separate copy that rebuilds the same root. The deploy now
  asserts distinctness too, so this cannot recur. The obsolete assertion in
  `apps/api/test/published-bundle.test.ts` required `mirror.bundle === seed.bundle` — it
  encoded the bug and stayed green for precisely as long as the bug existed; a test can hold
  a defect in place as firmly as it can catch one.
- **Federation's first step, implemented: a client finds the mirror that verifies.**
  `docs/MIRRORS.md` names mirror discovery as the next step; `bundleFromSeed`
  (`apps/api/src/bundle.ts`) is its first half, and it is the half that carries the trust:
  the client tries the seed's own URL and then each mirror in order, and accepts only a
  copy that **rebuilds the root the seed pins**. Internal validity is deliberately not
  enough — a mirror can rewrite both its bytes and the root inside them — so a bundle that
  verifies but rebuilds a different root is refused by the pin, which is the case the test
  exercises directly alongside a tampered copy, a 404, and a seed whose candidates all
  fail (the error names every candidate and why, so an outage reads as evidence). What is
  still missing is stated in the doc rather than implied: mirrors do not gossip, and the
  seed is still a file someone publishes. Test: `apps/api/test/bundle-seed.test.ts`.
- **The claim axis is closed with a checked coverage map (kind 20).** `docs/CLAIMS.md`
  records which documents `claim:check` mechanically verifies (15, with the kind that
  reads each) and which are deliberately prose (8, each with its reason). The map is
  itself checked: every document listed as checked must be referenced by the checker, every
  prose row must state a reason, and no document may appear in both lists — so the axis is
  an auditable boundary rather than an open-ended sweep. Three parser lessons, recorded
  because each failed silently: a fixed three-column regex matched a two-column row ACROSS
  its newline (half the prose table parsed, the rest vanished — cells are now split, not
  matched); `OPERATOR.md` was listed as both checked and prose (the overlap check caught
  it); and a self-test fixture that names a phantom document in the checker's own source
  satisfies "the checker never mentions it" vacuously, so the phantom is now built at
  runtime from the file's length.
- **The crypto doc's runtime floor, leaf versions, and suites are checked (kind 19).**
  `docs/CRYPTO.md` publishes the runtime floor ("Node 22.18+"), the leaf-version history
  ("Leaf version 3 added the profile"), and the suite set (ECDSA P-256, ML-DSA).
  `claim:check` compares the floor with `package.json`'s own `engines.node`, requires the
  shipped `PUBLICATION_LEAF_VERSION` (currently 4) to be at least the documented profile
  version, and derives the suites **functionally** through the SDK's `suiteOf` — a P-256
  key is `ecdsa-p256`, ML-DSA-44/65 keys map to their suites, and a foreign key (RSA) is
  refused rather than silently classified. Self-test: a doctored runtime floor is
  reported.
- **The app-protocol doc's configuration and routes are checked (kind 18).** A coverage
  sweep of the docs found `docs/APP-PROTOCOL.md` — 48 numeric/structural claim lines —
  was the largest unchecked surface. `claim:check` now verifies that every `RAREXT_*`
  name the doc tells an app author to set is actually read by the implementation
  (discovered by walking the api, mcp, chain, core and sdk source trees, not a hand-picked
  file list) and that all 21 published routes are still handled. Two checker bugs were
  found and fixed while wiring it, both recorded because they are the same trap: `root` is
  a URL object, so `path.join` mangles it silently (a directory walk that finds nothing) and
  the file reads that reused the mangled form returned empty strings whose `join("\n")` is
  only 72 characters — the check then reported every documented name as unread at once. The
  walk's file count is now printed in the summary so a future silent-empty walk is visible
  immediately, and a zero-file walk fails loudly.
- **Hardening round: the agent SDK's keyfile and signing boundary (negative result,
  pinned).** The path an external agent touches first — its key file and signatures —
  went from a single 73-line integration case to that plus a fault suite: the keyfile
  round-trips with its identity intact and the README's modes hold (0600 file, 0700
  directory); a second write refuses `EEXIST` instead of clobbering a key, leaving the
  original bytes untouched; seven malformed keyfile shapes are each refused with a
  message naming the problem; the public/private **pairing** is validated (a file cannot
  advertise one identity while signing as another); a signature verifies over its own
  canonical bytes and fails over a modified payload or a flipped bit; and handles
  outside the documented shape are refused at creation. **No defect was found** — the
  SDK already validated more than suspected (the pairing check was in place before this
  round) — so the value is that each property is now pinned, including the file-mode
  claims. One type-level trap recorded: `node:crypto`'s `JsonWebKey` is structurally
  wider than the SDK's, so importing a JWK needs an explicit widening cast that the
  runtime never needed. Guarantees row in `docs/HARDENING.md`.
- **Hardening round: the sealed tier's fault surface (negative result, pinned).** The
  primitives behind "a mirror holds ciphertext it cannot read" got their own fault suite
  in `sealed-path.test.ts`: a round trip is byte-exact while a one-bit tamper of the
  ciphertext or auth tag is refused (`authentication failed`, never partial output), a
  wrong secret is refused, malformed `iv`/`salt`/`authTag` are named in the refusal
  before any crypto runs (an empty ciphertext is valid base64 and refused by
  authentication instead), metadata recorded by a placement is bound to its ciphertext
  (a swapped pair refuses), the same plaintext encrypted twice shares no salt, iv, or
  ciphertext, and the recorded metadata plus committed ciphertext carry no plaintext.
  **No defect was found** — every injected fault was already refused — so the round's
  value is that the refusals are now pinned and the length bound is stated rather than
  implied: AES-GCM is a stream cipher, so ciphertext length equals plaintext length, and
  the sealed tier hides content, not size (`docs/HARDENING.md`, sealed tier row).
- **The mirrors doc's claims are checked, and its CI claim made true.** Seventeenth
  claim kind: `docs/MIRRORS.md`'s bundle routes are held to `app.ts`'s guards, its four
  named npm scripts to `package.json`, its published-copy artifacts to the deploy's own
  sources (`site/registry/{bundle.json,seed.json,mirror/verify.html}` plus the
  `registry/mirror/* → /mirror/*` mapping that makes the URLs resolve) — and its claim
  that the takedown test "runs in CI" to `scripts/ci.sh`. That last one was **false**:
  the doc calls the takedown test the acceptance criterion and says CI runs it, but
  `ci.sh` never did. It passes in about a second, so it is now wired into the gate, and
  the checker keeps the sentence true. The self-test doctors the doc to name an
  undefined script and asserts the mismatch is reported. A second suspicion was checked
  and dismissed rather than assumed: the published `/mirror/` URLs resolve because the
  deploy sources them from `site/registry/mirror/`, not `site/mirror/`.
- **The audit-window and verifier-timeout claims are checked.** Sixteenth claim kind:
  `docs/OPERATIONS.md`'s audit-freshness row and `docs/STORAGE-SECURITY.md`'s
  nonce/timeout statements are verified against the code — `AUDIT_WINDOW_MS` = 15 min
  (imported constant), the 5-minute future-timestamp tolerance (`CLOCK_SKEW_MS` read
  from source), the exact refusal literals the doc quotes and the code must produce,
  `MAX_CHALLENGE_NONCE` as a positive integer, and `MAX_EXTERNAL_VERIFIER_TIMEOUT_MS` =
  300,000 matching the doc's published range. The boundary behaviour stays pinned
  functionally by `apps/api/test/audit-attestation.test.ts`, whose existence and
  execution the evidence-citation kind already enforces — so the checker asserts the
  published numbers, not a second copy of the behaviour. Self-test: a doctored 30-minute
  window is reported. One over-strict assertion was corrected while wiring it: the doc
  quotes one refusal verbatim and describes the other in shorthand, so the check anchors
  each in its own form.
- **Hardening round: the multi-holder gate and the non-loopback holder path.** The
  layer that decides which holders store which shards — and how a client reaches one
  off-loopback — went from two single-case test files to a suite that pins the
  placement contract: with exactly `k + m` holders, a holder answering 5xx (e.g. a
  `507` quota) fails the placement loudly instead of letting it proceed with fewer
  shards; a holder answering with anything that is not a valid shard name is refused
  at placement; the probe/repair path skips spares that reject writes, refuses to
  commit when its lease expires or its placement is forgotten mid-read, and backs off
  after failures instead of storming; and the non-loopback holder streams
  byte-exact with its token enforced. One honest bound is recorded in
  `docs/HARDENING.md` (and in the source): the returned `storedAs` is a locator, not a
  proof — equality with the shard digest is deliberately NOT asserted at placement
  (a holder names the file by its own digest of the bytes it received), so integrity is
  enforced when the bytes are read back against that name; asserting equality there
  refused honest repairs and stub holders that named files by their own rule.
  Supervisor note: the round was agent-authored and carried to green by the
  supervisor after every rail ran dry mid-round (OpenCode/OpenRouter caps, Agnes
  throttle, Google's 20-requests-per-model daily buckets); the mid-write tree it left
  had numbered-line prefixes in the test file, a missing import, and non-deterministic
  holder selection in the 5xx case — all repaired before the commit.
- **Hardening round: the external MCP agent storage path.** The surface "AI lives on
  RAREXT" rests on — an external agent putting and getting bytes through MCP — went
  from 1 guarding test case to 10, with failure injection across the whole path: a
  lying `content-length` is refused loudly and never parsed as a fragment (the holder
  now cross-checks the declared length against the delivered bytes, ends the
  connection, and bounds a stalled body with a timer); the byte quota is checked
  before the stream is consumed (`507` before bytes are stored, both upload paths);
  corrupted shard bytes are caught by the digest check; persistence holds across a
  holder restart; a challenge after GC answers a clean `404` with the ledger recording
  the shard not-live; concurrent identical puts converge to one stored object; a
  revoked identity is refused; malformed tool arguments do not crash the MCP server.
  The per-path guarantees and their bounds are in `docs/HARDENING.md`'s
  "Guarantees by path" table — including the honest bound that a truncated body's 400
  is not always deliverable when the client's FIN races the response: the contract is
  loud refusal, not a specific status. Two defects were found and fixed mid-round
  (a `readJson` signature refactor whose call sites were not updated —
  `setTimeout(…, undefined)` fired instantly and killed every JSON request — and a
  response flushed after its socket was destroyed). Supervisor note: the round was
  authored by the external agent and finished by the supervisor after its turn was
  cut twice (25-minute attempt timeout, then the Agnes text throttle and the Google
  per-minute token wall); the continuation prompt quoted the agent's own failing
  tests as the specification.
- **The snapshot/migration claims in the operations doc are checked.** Fifteenth
  claim kind: `docs/OPERATIONS.md`'s "Snapshots and migrations" and "Game-native
  state migration" sections publish the current snapshot version (2), the 1 → 2
  migration that adds empty `rotations`/`delegations` arrays and preserves the
  existing `publications` array, the load-time refusal of a newer snapshot
  ("newer than this build supports"), the broken-chain refusal, the
  "publications must be an array" validation, the "could not load …" refusal on a
  corrupt file, the game-state plan's kind (`rarext.game-state-migration`),
  version (1), status (`deferred`), mode (`no-op`), its eight durable
  collections, the bundle's copying of extension fields, and the command's
  refusal of `--execute`/`--cutover`. The checker parses the version out of the
  doc and compares it against `CURRENT_SNAPSHOT_VERSION`; runs `migrateSnapshot`
  with a v1 snapshot as a positive control (empty rotations/delegations,
  preserved publications); exercises the newer-snapshot and broken-chain
  refusals through the real `migrateSnapshot` with the published rejection
  messages; confirms the store's load path still carries "publications must be
  an array" and "could not load"; builds a plan through
  `buildGameStateMigrationPlan` and re-derives its kind/version/status/mode and
  collection list from `apps/api/src/game-state-migration.ts`; builds a bundle
  through `buildGameStateMigrationBundle` with an extension field and requires
  it to appear in both the snapshot copy and `unmanagedTopLevelFields`; and
  confirms the script source still refuses cutover. The self-test doctored
  "Snapshot version 2 is current." to "Snapshot version 3 is current." and the
  fixture-changed guard covers the new fixture.
- **The semantics doc's claims are checked against the real validator.** Fourteenth
  claim kind: `docs/SEMANTICS.md` publishes the `Semantics` record's fourteen named
  fields, its two hash fields (`specHash`, `semanticsHash`), the four binding-status
  values (`ok`, `missing`, `version-mismatch`, `spec-mismatch`), the three API routes
  (`GET /v1/semantics`, `GET /v1/semantics/:id`, `GET /v1/challenges`), the four claim
  kinds a record licenses (`satisfies`, `attests`, `produces`, `derives`), and the
  scope rule that a claim's scope keys must appear in the record's `inputs` or
  `outputs`. The checker parses each field name out of the doc and locates it in the
  validator's return object in `apps/api/src/semantics.ts`; re-derives `specHash`
  through `semantics.specHash` and `semanticsHash` through `semantics.semanticsHash`,
  requiring both to be stable 64-char digests; extracts the route guards the same way
  the route-surface kind does; and exercises the scope rule through `bindClaim` — a
  scope-less claim and a scope key the record contemplates (`circuit`) must bind, and
  a key it does not (`dataset`) must be rejected. The self-test doctored the
  interface's `createdAt: string;` to `created: string;` and the fixture-changed
  guard covers the new fixture.
- **The AI-verification vision doc is now a checked claim surface.** Thirteenth claim kind:
  `docs/AI-VERIFICATION.md` publishes the two rendition rule names (`xorshift32-image-v1`,
  `bounded-strip-v1`), the stable verifier hashes derived from their manifests, the
  functional behaviour of `isGenerativeMedia`/`isBoundedMedia` and the deterministic
  raster renderers (`renderRaster`, `renderBoundedRaster` with their rejection guards),
  the verifier module routes (`GET /v1/verifiers`, `GET /v1/verifiers/:app/:hash.mjs`),
  and the attestation field contract. The checker parses the rule names from the doc,
  compares them against `packages/core/src/ai.ts`, calls the real media validators and
  raster functions with positive controls and published rejection inputs, verifies the
  route guards in `apps/api/src/app.ts`, and confirms the verifier hashes are stable.
  The self-test doctored `xorshift32-image-v1` to `xorshift32-image-v2` and the
  fixture-changed guard covers the new fixture.

- **Deploys verify the AI renditions live.** `scripts/deploy-site.mjs`'s post-deploy
  `verifyLive` stage now ends with the AI recomputation smoke check:
  `scripts/verify-live-ai.mjs` runs against the just-deployed mirror URL, re-deriving
  both renditions from the commitments alone and matching the served PNG bytes — the
  same verification a stranger runs — and a non-zero exit fails the deploy. Spawned
  asynchronously (the `spawnSync`-blocks-the-event-loop lesson applied forward).
- **`npm run demo:ai` — the one-command, third-party proof that AI lives on RAREXT.**
  The claim axis had made the docs provable to CI; this makes the vision demonstrable
  to a person. The demo composes the repo's existing gated pieces: it publishes real
  signed generative + bounded AI publications through the live API flow
  (`scripts/publish-ai-proof.mjs`), serves the resulting mirror over loopback HTTP,
  re-derives both AI renditions from the commitments alone
  (`scripts/verify-live-ai.mjs` against the local server), and checks the anchor pins
  the published root and covers the publications — a phase-by-phase receipt, exit
  non-zero on any broken link, writes only to the gitignored `.ai-proof/`.
  Verified 4/4: publish → serve → recompute (2 renditions) → pin. One build
  mistake, recorded: the first version ran the verifier with `spawnSync` while its own
  HTTP server lived in the same process — `spawnSync` blocks the event loop, so the
  server could not accept connections and the child's fetches hung until the timeout
  killed them. The demo now runs children with async `spawn`.
- **The work-economy reward schedule is checked both ways.** Twelfth claim kind:
  `docs/WORK.md`'s credit table (verify 10, store 1, mirror 25, relay 15, publish 5,
  remix 20, report 50) is verified against the `base` values in
  `apps/api/src/work.ts`'s exported `ACTIONS` — every published row must equal the
  code's base for that action, and every action the code defines must appear in the
  doc's schedule, so an undocumented reward cannot pay silently. The self-test doctored
  verify's credit to 12 and the fixture-changed guard covers the new fixture.
- **The chain-registry surface is checked like the API's.** Eleventh claim kind:
  `docs/CHAINS.md` publishes seven chain routes (`POST /chain/anchor`,
  `GET /chain/{state,head,key,proof,blocks/:height,audit}`) and a chains table; the
  checker verifies every published route is handled by `apps/chain/src/server.ts`
  (including the `/chain/blocks/` prefix form), that the table's `trac` row has its
  adapter in `apps/api/src/anchorer.ts`, and that the `evm` row's backing artifacts —
  `contracts/RarextAnchor.sol` and `contracts/scripts/deploy-anchor.mjs` — exist. The
  self-test publishes a `POST /chain/rollback` route the server does not have and
  asserts the mismatch is reported.
- **The fault-limit tables' cited evidence is checked.** Tenth claim kind: the
  fault-limit tables in `docs/OPERATIONS.md` name 30 test files as the measurement for
  each published behaviour; `claim:check` now verifies every citation exists and is
  non-empty in the tree, that the gate's test glob (`apps/api/test/*.test.ts`) is broad
  enough to run them, that the doc cites evidence at all, and that the `BACKUP_VERSION`
  contract the backup-fault section pins (version 1) matches `apps/api/src/backup.ts`.
  The self-test rewrites one citation to a file that does not exist and asserts the
  mismatch is reported — a doc that cites evidence the CI never runs is drift.
- **The operational defaults are checked against the source that reads them.** Ninth
  claim kind: `docs/OPERATOR.md`'s retention/GC defaults — the challenge scheduler "every
  6 hours", storage and pin GC loops "both 24h, `0` disables", and the 24-hour blob GC
  grace — are verified against the actual `??` fallbacks in `apps/api/src/server.ts`,
  `apps/api/src/pin-server.ts`, and `apps/api/src/durability.ts` (6 h, 24 h, 24 h, 24 h).
  The doc's "21600s" rendering and the gracePeriodMs-0 delete-on-first-scan note are
  anchored too. The self-test injects a doctored OPERATOR.md (scheduler "every 12
  hours") and asserts the mismatch is reported.
- **The AI replay bounds are checked functionally, not just as constants.** Eighth claim
  kind: `docs/OPERATIONS.md`'s replay-bounds table states `MAX_GENERATIVE_TOKEN_LENGTH` =
  256 and `MAX_GENERATIVE_OUTPUT_LENGTH` = 1 MiB, and the behavioural claim that a replay
  whose longest token times steps exceeds the bound is rejected without generating.
  `claim:check` verifies the constants against `packages/core/src/ai.ts`, runs a positive
  control (an exact 100-step replay verifies correct — guarding against the check passing
  because the function always returns false), and asserts the published rejection
  behaviour at the arithmetic boundary the doc implies: 256 x 4,097 = 1,048,832 > 2^20 is
  returned as `{ correct: false, expected: "" }`, while 1 MiB / 256 = 4,096 is exactly
  the largest step count that still replays. The self-test injects a doctored bounds row.
- **The published limits are checked against the exported constants.** A programmatic
  sweep found 393 numeric claim lines across 21 docs; the limits table in
  `docs/OPERATIONS.md` cites named constants, so `claim:check` now verifies
  `MAX_BLOB_BYTES` = 32 MiB and `MAX_BODY_BYTES` = 1,000,000 bytes (the doc's "1 MiB" is
  a rounded label, noted where checked), `MAX_GENERATIVE_STEPS` = 100,000 and
  `MAX_VOCAB` = 4,096 — doc values parsed from the markdown, code values imported from
  `apps/api/src/storage.ts`, `apps/api/src/app.ts` (module-local, read from source), and
  `packages/core/src/ai.ts`. The self-test injects a limits table the code outgrows
  (`MAX_VOCAB` = 8,192) and asserts the mismatch is reported. Seventh claim kind.
- **The soak claims are re-derived and artifact-backed.** The 10-minute chaos run was
  re-run against its published numbers: 5,991 puts at 100%, 5,991 retrievals at 100%,
  148 repairs at 100% with 148 re-audits passing, 22 holder kills, 2 transient put
  retries; peak client RSS 196.0 MiB (median 180.3, live heap 22.8 MiB) and peak holder
  RSS 91.8 MiB — better than the published 242/94 MiB, same 100% completion. The log is
  committed as `bench/storage/soak-2026-10-26.log`; HARDENING and OPERATOR cite it with
  the date, and `claim:check` now parses the committed log, requires every operation
  class at 100%, requires OPERATOR's "latest" numbers to be the log's numbers, and its
  self-test feeds a doctored log (99.2% completion) that must be reported.
- **The measured repair claim is re-derived and checked too.** The 1 GiB `4 + 2`
  bench was re-run against the published claim: read 1.000 GiB, write 0.500 GiB, total
  1.500x — the MDS floor, `exact: true` — in 121.7 s (an earlier run of the same
  command: 127 s, so the ratio is the number to trust). `claim:check` now verifies the
  doc's paragraph against `bench/repair/RESULTS.json` — the harness's own committed
  artifact — asserting the ratios add up, `totalRatio` equals the floor, and a plausible
  elapsed time exists; its self-test feeds a doctored record (`totalRatio: 1.4` against
  a floor of 1.5) and asserts the mismatch is reported. The self-test monkey-patch that
  first attempted this was replaced with injection, because reassigning an ESM import
  binding throws.
- **Published claims are checked against the code (`npm run claim:check`).** The
  availability-sampling table in RFC 0010 and the MDS floor `1 + m/k` cited in
  `docs/HARDENING.md` and `docs/STORAGE-FRONTIER.md` are now re-derived from
  `samplesForMissingFraction` and from the codec's own shard sizes, with the table parsed
  out of the RFC itself so editing either the document or the implementation alone fails
  the check. Verified: all four published rows match (20%→21/31, 10%→44/66, 5%→90/134,
  1%→444/657), the prose holds (44 samples miss 10% withholding with probability 0.957%,
  costing 0.48% of the media), and the codec measures the floor at 1.5000x for `4 + 2`,
  1.4001x for `10 + 4`, 1.3334x for `3 + 1`. `--self-test` asserts the checker reports a
  doctored row as a mismatch, so a passing run means something. Runs inside
  `scripts/ci.sh`.
- **The operator and placement gates are pinned branch by branch (hardening).** A sweep
  for store-shaped methods with no in-body type check produced four candidates; all four
  are gated before they store anything, so the sweep found no defect and is recorded as a
  negative result in `docs/HARDENING.md`. What it did change: `verifyOperator` and
  `verifyPlacement` decide who is paid for verifier work and what repair reads, and each
  had four test cases. The operator gate now pins the 17 named refusals it can return and
  the placement gate 16, each with a positive control, and the placement gate asserts
  `digest` is `null` on every refusal so a refused record cannot be handed back as a
  valid chain link.
- **The Trac task registry enforces what it publishes (hardening).** `register`
  checked truthiness only, so the registry accepted and then *served* values its own
  type forbids: an unknown status, a numeric `app`, an object `challengeId`, an
  unparseable `createdAt`, a whitespace handle, and an array handle — the last being
  an entry that appears in `list()` and cannot be fetched by handle at all, because a
  `Map` keys by identity. `get` and `list` also returned the live record, so one
  in-process reader's edit changed the status every other reader saw. Entries are now
  validated field by field, and readers get frozen copies. The task-registry suite
  goes from 3 cases to 9, and the limits are written into `docs/OPERATIONS.md`.
- **An invalid verification clock no longer disables the freshness window (hardening).**
  Every freshness comparison in the audit verifier is numeric, and `NaN` fails all of
  them — so passing `now: NaN` did not narrow the window, it removed it. Measured
  before the fix: an attestation a millisecond past its window verified. The clock is
  now validated exactly as `windowMs` already was. The audit suite goes from 3 cases to
  12, one per mechanism (clock, signature transplant, key substitution, expected
  verifier, algorithm, forged and self-admitted transcript entries, out-of-range leaf
  index, malformed shapes by name, and the unsigned-field bound), and the mechanisms
  are recorded in `docs/HARDENING.md`.
- **One anchor per batch (hardening).** `anchorPending` read the pending set, awaited
  the anchoring adapter, and only then committed — so two overlapping calls both read
  the same batch and both committed it. Measured before the fix: two anchors, the same
  root, the same publications in each, and two adapter submissions. Overlapping calls
  now share a single anchor (same id, same root, one submission). The HTTP route had
  hidden this because one keep-alive connection serializes requests, but the function
  has two call sites and their interleaving was reachable. The anchoring suite goes
  from 2 cases to 11 — concurrency, proof refusals, post-anchor tampering, restart
  durability, root-vs-leaves recomputation, a dead rail, and threshold parsing — and
  the guarantees are written into `docs/ARCHITECTURE.md`.
- **Renditions are checked where they are attested (hardening).** The verifiers
  re-derive an AI artifact's picture from its commitment and reject a rendition
  that is not the function of it. Measured before the fix, four attacks were all
  attested `correct: true` on the serving side — an unknown rendition rule, a
  lying raster digest, a lying bounded plot, and impossible geometry — while the
  browser reported nothing, because a rule it does not implement is silently
  dropped. Now an unimplemented rule or a malformed rendition is refused, and a
  rendition that does not re-derive makes the attestation incorrect with score 0.
  Test coverage for the two AI verifiers goes from 22 cases to 32, and the limits
  are written into `docs/AI-VERIFICATION.md`.
- **Exact rent arithmetic (hardening).** Storage-rent quotes are now computed in
  exact integer arithmetic: the ceiling is taken on the exact rational, so a
  quote can no longer be off by a microcredit in either direction. Measured
  before the fix, a sweep of 25,800 legal quotes disagreed with exact arithmetic
  88 times (including undercharges at TB-scale multi-year terms); the same sweep
  now agrees on every quote that produces a price, and a cost beyond the exact
  range is refused instead of approximated. A pricing object whose policy,
  monthMs, or creditScale drifts from the committed constants is refused rather
  than quoted. Test coverage for the money path goes from 7 cases to 20, one per
  mechanism, with measured limits written into `docs/STORAGE-ECONOMY.md`.
- **Deterministic site deploy.** `npm run deploy:site` projects the committed
  `site/` tree onto `gh-pages`, publishes the mirror at `/mirror/`, refuses to
  write when the seed, bundle, and mirror roots differ or a published byte does
  not match its repo source, and verifies the live bytes, roots, links, and both
  AI renditions after pushing.

- **Reproducible EVM anchor audit package.** `npm run audit:package` writes a
  hash-verified package with the exact contract source, tests, scripts, runbooks,
  relay file, ABI, creation/runtime bytecode, and storage layout, plus a manifest
  and `SHA256SUMS`. `npm run audit:package:verify` checks every checksum, the
  audit status flags, the source hash, and the compiled artifact hashes. A valid
  testnet record can be bundled with `--deployment`. The package records whether
  the tree was dirty and does not change the external-audit or live-deployment
  gate.

- **Storage rent quotes (v1 slice).** `GET /v1/storage/pricing` publishes the
  operator's public and sealed rates, and `GET /v1/storage/quote` returns a
  deterministic 30-day byte-month quote in integer microcredits. `/v1/storage/usage`
  now reports `committedByteMonths` and the latest `retainedUntil`. The public tier
  defaults to free and the sealed rate is operator-configurable. A quote is not a
  reservation and does not charge; settlement remains in
  [RFC 0018](rfcs/0018-storage-rent-settlement.md).

- **Public-testnet rehearsal.** `npm run testnet:rehearsal` starts a chain, three
  token-protected holders, a pin service, and an HTTPS API on loopback; publishes
  through the external SDK; anchors and checks the proof; places, challenges, and
  reconstructs storage; builds and verifies a mirror; restarts the chain and API;
  backs up and restores state; and verifies the mirror with the API stopped. DNS,
  public certificates, firewall rules, and off-host monitoring remain handoff items.

- **Repair-path hardening.** `DurabilityLedger.repair` now reads another survivor when
  a holder drops between the presence probe and `get`, and tries the next free spare
  when a target rejects `put`/`putFile`; streamed repair follows the same rules. A repair
  holds a 30-minute in-memory lease tied to the placement object and refuses to commit
  after a `forget`, `maxPlacements` eviction, replacement, or lease expiry. The challenge
  scheduler backs off failed repairs per blob (60s initial, doubled, 6h cap) and reports
  `repairDeferred`/attempt counts instead of retrying every run. New fault tests cover
  each path, and `docs/OPERATIONS.md` records the measured limits.

- **Community tournament hardening.** `TournamentService` now caps a field at
  `MAX_TOURNAMENT_PARTICIPANTS` (1024) and refuses a participant-count overflow, and a
  recorded result must name the two participants of the match it settles: a winner that
  is not in the match, or a loser that is not its counterpart, is refused. A duplicate
  tournament name and an unknown match id are 400s, not 500s. Concurrent submissions of
  the same result record the match exactly once (synchronous check-and-write).
  Regression tests cover every bound, and `docs/OPERATIONS.md` records the measured
  limits for the next pass.

- **Community tournament (in-memory).** `POST /v1/tournaments` creates a session-scoped
  bracket or round-robin from a participant list, `POST /v1/tournaments/:name/results`
  records a match outcome, and `GET /v1/tournaments[/:name]` reads the bracket or
  standings. Winners advance through single-elimination rounds; round-robin standings
  are ordered by points, then wins, then fewest losses. Nothing is signed or persisted,
  so a restart clears the field. Tests drive a 4-player bracket and a 4-player table to
  known outcomes and exercise the HTTP surface end to end.

- **Task registry on Trac (read-only).** `GET /v1/tracregistry` lists registered task
  handles with status (`pending`/`running`/`completed`/`failed`) and metadata, or a
  single handle by id via `?handle=`. It reads through the Trac adapter and never signs
  or writes. Fixture-backed unit tests cover all four states plus a missing handle, and
  an API-route test pins the returned shape.

- **External-agent MCP storage integration test.** `npm test` now runs
  `apps/api/test/mcp-storage-agent.test.ts`, which starts six token-protected holders,
  the API, and a pin service, then drives the real MCP stdio server through put, get,
  challenge, audit, and pin as an outside client. The test asserts the exact payload,
  all six live challenges, an `ok` audit, and a stored pin.


### Security

- **Storage challenge, transport, placement, and pin hardening.** Challenge responses
  now bind to the requested leaf index and a fresh nonce, reject replays, cap nonce and
  proof sizes, and require an exact Merkle depth. `httpHolder` verifies shard bytes
  against `storedAs`, caps responses, and times out; holder and pin servers support
  optional bearer tokens, bounded bodies, constant-time comparison, and bounded caches.
  Placements reject co-location, oversized or inconsistent shards, impossible required
  counts, and malformed claims before adoption. The pin store recomputes CIDs and writes
  metadata atomically. `docs/STORAGE-SECURITY.md` and RFC 0012 record the model and the
  still-open findings (confidentiality, retrievability, quotas/TLS/identity, lying
  verifiers, orphan GC). Eight security tests.

### Fixed

- **EVM anchor read-back calldata.** `apps/api/src/chains/relay.ts` now calls
  `anchors(uint256)` with the Keccak selector and a directly ABI-encoded id, instead of
  SHA-256 hashing the signature and hex-encoding the ASCII calldata. It also accepts a
  bare numeric relay reference and refuses to guess index 0 when no id is present. Three
  tests pin the calldata against ethers, cover both reference shapes, and cover the
  no-id skip.

### Added

- **Consensus interface and settlement gate.** `GET /v1/consensus/state` exposes a
  state root over the anchor audit trail, a deterministic height-scoped head, and
  settlement status. `POST /v1/consensus/validate` verifies a P-256 or ML-DSA
  signature over a canonical `rarext.consensus.anchor-proof` v1 object, recomputes
  the head and state root at the proof's height, checks the anchor and root against
  the trail, and applies a strict `CONSENSUS_SETTLEMENT_MIN` gate. Reaching the
  minimum is `at-threshold` and invalid; only above it is valid. The API never
  trusts a caller-supplied volume or head. Production settlement volume is pending,
  so `productionDataPending` is true and `liveGating` is false. A three-scenario
  fixture covers below/at/above, and an integration test drives the real anchor
  audit trail and a signed proof through the HTTP endpoints.

- **EVM anchor audit trail and guarded funded-testnet deployment.** `contracts/AUDIT.md`
  records the pinned source and toolchain, the external-audit-not-performed status,
  an internal finding and disposition register, a manual auditor checklist, and the
  blocked live-deployment gate. The contract now rejects a zero owner at
  initialization. The deploy script verifies proxy and implementation code, the
  ERC-1967 implementation slot, and publisher read-back. `npm run deploy:anchor:testnet`
  refuses known mainnet chain ids, requires explicit testnet acknowledgement, runs
  the existing deploy script, and writes a record whose audit flags keep live
  deployment blocked. Tests cover zero-owner initialization, the 512-byte metadata
  boundary, the 14-publication compatibility cap, publisher revocation, and the
  deployment guard. No external audit was performed and no contract was deployed.

- **Game-native state migration skeleton.** `npm run plan:game-state` reads a
  registry snapshot and writes a deferred, no-op preservation plan with collection
  counts, field inventories, canonical digests, unmanaged top-level fields, and
  explicit gaps for active builds, challenges, reputation, and ratings. `--bundle`
  writes every durable record and optional challenge export verbatim for a future
  target. The command never writes the source and refuses `--execute`/`--cutover`.
  Seven tests cover field retention, deterministic digests, challenge export,
  version migration, malformed input, and the deferred gaps. RFC 0017 records the
  cold-cutover runbook, inherited RESET/trac-peer constraints, rollback boundary,
  and the remaining target-schema gate.

- **Sponsored challenges.** A configured community member can sign a
  `rarext.challenge-sponsorship.v1` payload and POST it to
  `/v1/challenges/sponsored`. The registry verifies the member's P-256 or ML-DSA key,
  binds a timestamp and nonce, stores the challenge as `status: "sponsored"`, exposes it
  through the existing challenge API, and emits `rarext.challenge.v1` to an optional
  webhook. The workbench lists sponsored challenges and badges matching feed items. The
  member roster is supplied through `RAREXT_SPONSOR_MEMBERS`; no live community directory
  ships with this repository, and the running registry does not yet persist sponsored
  challenges across restarts. Four tests cover the signed flow, webhook delivery, replay
  and signature rejection, and the unconfigured state.

- **EVM anchor contract and local deployment path.** `contracts/RarextAnchor.sol` is a
  UUPS-upgradeable, two-step-owned, pausable append-only anchor log. It stores a unique
  root, the metadata hash, the publisher, and the timestamp; emits `AnchorPublished` with
  the bounded metadata; and exposes `anchors(uint256)` plus `anchor(bytes32,bytes32[])` for
  the registry's existing EVM adapter. Ten local-EVM tests cover publication, duplicate
  roots, authorization, metadata bounds, pausing, ownership, state-preserving upgrades, and
  direct implementation safety. `npm run deploy:anchor` deploys an implementation and an
  ERC-1967 proxy only when the RPC chain id matches an explicit expected value. The
  contract is **not deployed or audited**; the runbook in `contracts/README.md` records
  what remains.

- **RFC 0016: appchain evaluation.** Evaluates a RAREXT appchain against staying on
  anchored transports. It uses the pinned RESET/trac-peer wire format as primary
  evidence for why native anchor moves are a protocol change, and recommends deferring
  a chain behind a measurable demand, economics, and validator-supply gate.

- **$BEM balance in the web UI.** The community page accepts a BSC address and shows its
  read-only `$BEM` balance from `GET /v1/tapeout/status?address=`. The status response now
  includes `bemDecimals` from `BEM_DECIMALS` (default 18), and the browser bundle formats the
  base units. No signing and no write path.

- **Trac anchor transport boundary.** `apps/api/src/adapters/trac-transport.ts` defines
  `TracAnchorTransport` and the adapter announces through it; `GET /v1/adapters/trac` reports
  the transport kind. The HTTP webhook (`TRAC_ANCHOR_URL`) is the shipped, tested transport.
  The native RESET/trac-peer transport is recorded as blocked: message moves are fixed
  `{v,t,b,h,p,w}` types and MSB transactions only carry a strict `{op,to,amount}` transfer
  command, so there is no anchor move or memo to carry a root. Evidence is in RFC 0001 §4.

- **Trac identity-link prototype.** `POST /v1/identity-links` accepts an optional
  `externalProof` for `network: "trac"`. The proof is a
  [RESET](https://github.com/Trac-Systems/reset) `reset-mcp-login` Ed25519 challenge
  whose `nonce` is `sha256(canonicalize(payload))` and whose `audience` must match the
  RAREXT origin. Trac addresses may be 64-hex or `trac1…` bech32m and are normalized
  before verification. `AgentSigner.identityLinkPayload` and `identityLinkBinding`
  build the payload, and `RarextClient.linkIdentity(payload, signature, externalProof)`
  submits it. The adapter verifies the signature offline; no Intercom round trip and no
  canonical-identity migration yet. Run `npm run example:trac-identity` for the full flow.

- **Read-only TapeOut circuit/component indexer.** `GET /v1/tapeout/circuits`
  reads bounded ERC-721 `Transfer` and ERC-1155 `TransferSingle`/`TransferBatch`
  logs, reports the latest circuit owners and component movements, and returns
  `configured:false` without `TAPEOUT_CIRCUIT_CONTRACT` or
  `TAPEOUT_COMPONENT_CONTRACT`. It never signs or writes.

- **MCP storage tools and a runnable network example.** The MCP server now exposes
  `rarext_storage_put`, `rarext_storage_get`, `rarext_storage_challenge`,
  `rarext_storage_audit`, and `rarext_storage_pin`. Put encodes and places shards on the
  configured holders, signs the placement with the local agent key, and registers it;
  get digest-checks shards before rebuilding; challenge and audit share the process
  ledger; pin computes the CID and calls the pin service. The holder and pin bearer
  tokens are supported through `RAREXT_HOLDER_TOKEN` and `RAREXT_PIN_TOKEN`.
  `examples/mcp-storage` drives the real stdio server end to end against six
  token-protected holders, an API, and a pin service. One integration test covers the
  same verbs directly.

- **Storage roadmap completion (Issues #6–10 closed).** Proof of Retrievability
  specification (RFC 0013), byte and request quotas with rate limiting for holders and
  pins, signed independent audit attestations (RFC 0014), and orphan shard garbage
  collection with grace period and dry run. Added `npm run net`, a local storage
  network runner, property/fuzz tests over erasure, placement, and GC, and a 1 GiB
  throughput/memory benchmark.

  The sealed tier is wired into the real MCP put path. `rarext_storage_put` with
  `sealed:true` encrypts with HKDF-SHA256 + AES-256-GCM (matching RFC 0015) before
  erasure coding, records the salt/IV/tag in the signed placement, and the shard
  digests and Merkle roots cover ciphertext; `rarext_storage_get` decrypts client-side.
  `POST /v1/blobs` rejects `tier:"sealed"` instead of mislabelling plaintext. Covered by
  `apps/api/test/sealed-path.test.ts` and `examples/sealed-storage`.

  Still not a production confidentiality claim: no key wrapping, rotation, per-tenant
  isolation, or envelope review, and `RAREXT_SEALED_SECRET` is a raw caller-held secret.
  Do not upload real secrets or describe sealed storage as audited encryption yet.

- **Raw, bounded shard transport over HTTP.** Holders gained
  `PUT/GET /v1/holder/shards/:hash/raw`: uploads stream the request body to a temp file
  while hashing it, downloads stream the file with a length, and challenge leaves are
  computed from the file rather than a whole-shard buffer. `httpHolder.putFile/getFile`,
  `DurabilityLedger.placeStreamed/retrieveStreamed`, and streamed placement metadata
  (`chunkBytes`, `chunks`, `chunkDigests`) make the 1 GiB file path placeable over real
  holders. `npm run bench:network` measured a 242 MiB client peak and 94 MiB holder peak
  at 1 GiB; the whole-shard JSON path cannot accept 1 GiB because of the 32 MiB body cap.
  Key management for the sealed tier remains open.

- **Streamed placements are signed, auditable, repairable, and proven over the network.**
  `DurabilityLedger.repair` now rebuilds a lost streamed shard from k survivor files with
  `reencodeStreamedShard`, uploads only that shard through raw PUT, and re-audits it;
  `BlobStore.has` no longer reads the whole file just to answer a probe. `npm run net`
  adds a third scenario: an 8 MiB file is chunked at 2+1, placed over raw HTTP, signed
  with `AgentSigner`, registered in `PlacementRegistry`, reloaded from a fresh registry,
  challenged, killed, repaired, re-audited, and retrieved byte-for-byte. Still missing:
  the MCP put path remains 8 MiB in-memory, and streamed repair is not load-tested at
  100 GiB.

- **Bounded placement retention and retry-safe puts.** `DurabilityLedger` accepts a
  `maxPlacements` limit and evicts the oldest placement and its witnesses; `forget()`
  releases one explicitly. The soak uses a limit of 24, a zero-grace orphan GC sweep,
  and up to six put attempts with 250 ms-4 s backoff. Its 604 s rerun completed 5,910
  puts at 100.0% (the prior run was 99.9%), 145 repairs and 145 re-audits at 100%, with
  the ledger pinned at 24 and live JS heap near 10.5 MiB. Client RSS reached a bounded
  median of 170.7 MiB after warm-up; the residual is V8 reserved and external/allocator
  memory, not live heap. Defaults remain unlimited for compatibility.

- **Ten-minute soak and chaos run.** `npm run bench:soak` kept eight token-protected
  holders busy for 611 s with continuous puts, challenges, audits, repairs, and
  retrievals while killing and restarting a random holder every 15-30 s. It recorded
  5,507 puts (99.9%), 5,507 retrievals (100%), 143 repairs (100%), 143 successful
  post-repair re-audits, 21 kills/restarts, and peak client/holder RSS of 222/119 MiB.
  The script writes `bench/storage/SOAK.md`/`SOAK.json` with rates and memory-over-time.
  This is loopback on one machine with reused holder identities; it is not a durability
  proof, and the caveats are printed in the report.

- **`npm run net` now proves the sealed tier end to end.** After the open scenario, it
  encrypts a 64 KiB payload with AES-256-GCM/HKDF-SHA256 before erasure coding, places
  it on three HTTP holders, scans every holder directory for a plaintext marker (zero
  hits, all shard hashes match), kills a holder, repairs onto a spare, then retrieves
  and decrypts back to the original bytes. The documented output is a real run. This is
  still a demo of the envelope, not a key-management or confidentiality claim.

- **Bounded-memory erasure for large payloads.** `apps/api/src/erasure-stream.ts`
  stripes a file into fixed chunks, encodes one chunk at a time, and appends shard
  blocks to disk, so peak memory follows the chunk size rather than the payload size.
  `decodeShardsToFile` reconstructs any `k` of the shard files and verifies both the
  per-chunk digest and the whole-payload digest. At 1 GiB and 4+2, peak RSS fell from
  3243 MiB (in-memory `encodeBytes`) to 393 MiB while remaining byte-exact (8.3x lower);
  encode throughput moved from 11.2 to 8.6 MiB/s and decode from 48.6 to 23.2 MiB/s.
  Holders now also accept raw `PUT`/`GET` of shard files, and
  `DurabilityLedger.placeStreamed`/`retrieveStreamed` use that transport. Over real
  loopback holders the client peak stayed at about 250 MiB for both 64 MiB and 1 GiB,
  while the whole-shard JSON path needed 676 MiB for 64 MiB and cannot store 1 GiB at
  all. Streamed repair now rebuilds one shard at a time from k survivors. See
  `bench/storage/RESULTS.md` and
  `apps/api/test/erasure-stream.test.ts`.

- **Storage failure hardening and multi-loss repair accounting.** `BlobStore` writes
  blobs and its index through unique temp files and renames, rolls back a new blob when
  the index write fails, and no longer swallows index errors. Durability repair reads
  exactly `k` survivors, stages every replacement before moving the signed placement,
  adopts an already-written shard on retry, and fails loudly on a corrupt survivor. Five
  failure-injection tests cover partial repair writes, tampered shards, crash/restart,
  holder churn with two losses, and disk/index failures; `docs/HARDENING.md` records the
  recovery behavior and the remaining limits (no `fsync`, orphan shards, whole-payload
  memory, possession not retrievability). The repair benchmark now takes `--losses`;
  a 1 GiB `4+2`, two-loss run measured 1.000 GiB read + 0.500 GiB written = 1.500x,
  matching the MDS floor `1 + m/k`.

- **Documentation index.** `docs/README.md` links every document in `docs/` exactly
  once, gives reading orders for app developers, verifier operators, and researchers,
  names the draft or stale documents, and points back to the storage frontier. The root
  README links it.

- **Open Graph image for the landing page.** `site/og.png` (1200×630) carries the
  brand mark, headline, and one-line promise; `site/index.html` now declares
  `og:image`, dimensions, alt text, and a large Twitter card. No build step.

- **Runnable erasure-coding example.** `examples/erasure/main.ts` creates 1 MiB,
  encodes `4+2`, stores all six shards through `BlobStore`, deletes one, and rebuilds
  from the five survivors with digest assertions. Linked from the storage contract.

- **Verifiable fair-launch trajectories.** `GET /v1/launches/:mint/trajectory?chain=`
  groups public `launch.plan` attestations by mint and chain, orders them by block,
  separates policy segments, flags duplicate blocks, and reports safe/unsafe checks and
  anchor coverage. A failed check makes the verdict `not-safe`; the series never claims
  safety past its latest check. `apps/api/src/trajectory.ts`, five tests, docs.

- **Published negative results for both research directions.**
  `bench/storage/NEGATIVE-RESULTS.md` records the held-out Huffman expansion (0.64x,
  14.15 MiB total for 9.00 MiB) and the degree-10 Legendre fidelity failure (2212.70x
  ratio, 19.79 dB, 98.84% differing bytes, no residual). It states the acceptance
  criteria, what would overturn each result, threats to validity, and exact
  reproduction. Roadmap research item checked.

- **A self-hosted pinning service for the content adapter.** `apps/api/src/pin-server.ts`
  accepts a bundle and its CID, recomputes the CID from the bytes, stores them under
  `RAREXT_PIN_DIR`, and serves pin metadata/content over HTTP. The adapter now sends the
  bundle bytes, so the service can verify what it pins. `npm run pin`; RFC 0011; five
  tests covering restart, CID mismatch, HTTP round-trip, adapter integration, and refusal.

- **Data availability sampling for media.** `apps/api/src/das.ts` commits 4 KiB chunks
  as Merkle trees over the shards a placement already proves, samples distinct chunks,
  and verifies each byte and proof. It reports the exact hypergeometric miss bound
  `C(N-a,t)/C(N,t)` and the conservative `(1-f)^t`; for 9,216 photo chunks, 44 samples
  (176 KiB) detect 10% withholding with 99% confidence. A holder route serves one leaf
  and its proof. RFC 0010 states the bound, its assumptions, and its non-claims. Five
  tests.

- **Learned and parametric baselines in the storage benchmark.** `bench/storage/learned.mjs`
  adds an order-1 context Huffman codec whose 256×256 model is stored and counted as the
  decoder, and a tensor-product Legendre fit whose coefficients are the entire artifact.
  Measured on the fixed corpus: adaptive Huffman 2.40x on text and 3.02x on source
  (exact), the same model trained on `source.js` and held out on `text.txt` 0.64x
  (negative cross-slice result), and degree-10 Legendre 2212x stored size at 19.79 dB
  PSNR with 98.84% of bytes differing (negative fidelity result). Decoder bytes are now
  counted for every non-classical row, not only `kind: "learned"`. Three tests.

- **Repair-bandwidth measurement at 1 GB.** `bench/repair` encodes a deterministic
  1 GiB payload with the shipped 4 + 2 code, loses a shard, rebuilds it from four
  survivors, and checks both digests. Measured: 1.000 GiB read, 0.250 GiB written,
  1.250 GiB total for a single loss. The `< 1/k` target in the storage contract is
  arithmetically unreachable for an MDS code; the README states the floor (`1 + 1/k`) and
  what a local-reconstruction code would require instead. This run also exposed and fixed
  a real bug: shard digests converted bytes to a hex string, which throws beyond ~512 MB.
  Large shards now stream into the hash with a distinct domain, so a 1 GiB payload
  encodes, verifies, and repairs.

- **RFC 0009: representation kinds.** Defines `exact`, `bounded`, and `generative`
  artifacts, the signed representation record, the verifier result block, semantics
  declarations, display rules, and the acceptance criterion before a research codec can
  become a protocol claim. Documentation only; no envelope change ships yet.

- **Leaderboard UI and capability-based discovery.** `/leaderboard.html` ranks verified
  builds with app and challenge filters, links each row to its signed envelope, and opens
  an unlisted artifact from an artifact id plus capability token. Filters and capability
  inputs are shareable through the URL. One test covers static serving and the home-page
  link.

- **Key rotation and delegated publishing keys.** A rotation record is signed by the key
  being retired and moves the handle to a new key, optionally changing suite; the old
  key stays resolvable so existing publications and capabilities keep verifying, while a
  new publish signed by it is refused. A delegation record lets the root key authorize a
  second key to publish for the handle, optionally scoped to one app and an expiry;
  delegated publications record both `authorKey` and `delegatedBy`. Rotating the root
  retires outstanding delegations. Snapshot version 2 stores rotation and delegation
  history (migration 1 → 2 adds empty arrays). SDK helpers: `rotateIdentity`,
  `delegations`, `delegateKey`, `rotations`, `keyRotationPayload`, `delegationPayload`.
  RFC 0008 documents the records and their trust boundaries. 6 new tests.

- **The durability ledger.** `apps/api/src/durability.ts` places erasure shards on
  independent holders, refuses co-location, challenges with a nonce-bound Merkle leaf
  proof, audits live holders against a tier (`ephemeral` 1, `pinned` k+1, `durable`
  k+m), and repairs any failed shard from k survivors with read/write accounting. 13
  tests, and `npm run demo:durability` runs the whole sequence: 6/6 live, lose one,
  5/6 under-replicated, repair, 6/6, payload matches.
- **A holder wire protocol.** `apps/api/src/holder-server.ts` stores shard bytes under
  their own digest, answers nonce-bound leaf challenges with a Merkle path, and never
  learns the blob hash. `npm run holder` starts one; `httpHolder()` is the client, so
  placement, challenges, and repair work across processes. Three transport tests run
  eight holders over HTTP, stop one, watch the audit degrade, and repair onto a
  reachable spare.
- **Signed placement records.** `apps/api/src/placements.ts` signs a placement with the
  steward's key, embeds the public key, and chains each repair as a new record
  (`sequence` + `previous`). `POST /v1/placements`,
  `GET /v1/placements/:blobHash`, and `GET /v1/placements/:blobHash/history` expose the
  chain; a file-backed registry verifies records and refuses forks. `RFC 0005`
  documents the protocol and its trust boundaries.
- **Scheduled retention challenges.** `apps/api/src/durability-schedule.ts` challenges
  every placed blob on an interval, records each run, reschedules only after the run
  finishes, and shares an in-flight run between callers. The node enables it from
  `RAREXT_HOLDERS` (`id=url,…`) and `RAREXT_CHALLENGE_INTERVAL_MS`; `GET /v1/durability`
  exposes the schedule and audits, `POST /v1/durability/challenge` runs a pass on demand.
  The ledger is rebuilt from persisted placement records on boot. 7 new tests.
- **Durability on the publication itself.** When an artifact lists blobs, the API attaches
  a `durability` observation to the publication (and to feed/build responses): tier, the
  tier's required count, the live count from the last challenge, `unplaced` /
  `unverified` / `ok` / `under-replicated`, and the `placementDigest` that pins the signed
  record used. It is computed on read, not signed by the author, and reports the weakest
  tier across a manifest. 7 new tests.
- **Storage benchmark harness.** `npm run bench:storage` generates a deterministic,
  hash-locked 99.96 MiB corpus (video, photos, audio, text, source, 3D), runs x265,
  AV1, zstd, and the shipped 4+2 erasure path, and writes a Markdown table with
  stored bytes, exactness against the reference digest, PSNR/byte error for bounded
  rows, verify and decode time. A learned runner must declare its decoder size, which
  is added to the storage cost; a declared-lossless mismatch is downgraded to
  `bounded`. Full run: about 66 s on the reference laptop, under a 15-minute enforced
  budget. See `bench/storage/README.md` and `RESULTS.md`.
- **Trust model RFC.** `rfcs/0007-trust-model.md` states what each claim proves, what the
  registry, an app operator, an independent verifier, a holder, and an anchor can lie
  about, the composition rules a reader should follow, and what Trac anchoring would and
  would not add. Documentation only; no behavior change.
- **Store migrations and verified backups.** Snapshots now carry an enforced version:
  an older snapshot moves through an ordered migration chain, and a newer one is
  refused instead of partially loaded and overwritten. `npm run backup:create`
  bundles every file under the data directory (store, placements, operator records)
  with a digest per file and one over the manifest; `backup:verify` detects a changed
  byte or path, and `backup:restore` refuses a non-empty target without `--force`.
  A corrupt snapshot now stops the boot instead of starting empty. 10 new tests and
  `docs/OPERATIONS.md`.
- **Automatic repair on the schedule.** A scheduled or on-demand challenge run now
  heals `under-replicated` blobs: rebuild from any `k` survivors, place on a spare
  holder, challenge the rebuilt shard again, and report `repairs` (filled, bytes read,
  written) and `repairErrors` (for example, no spare holder). A failed repair is
  recorded and the next tick retries; it never stops the schedule. The node enables
  repair by default; the scheduler class does not. 3 new tests.
- **Independent verifier operators.** A verifier can register a self-signed operator
  record (`POST /v1/verifier-operators`) for one app or `*`, and a publisher can attach
  that operator's signed attestation. The registry accepts it without a local verifier,
  stores the attestation exactly as signed, records `verification: "operator"` plus the
  key id and signature, and `/v1/verify` re-checks it with `recomputed: null`. The
  envelope, bindings, and trust trade are in `RFC 0006`. 4 new tests.

## 0.1.0-alpha.3 — 2026-10-22

### Fixed

- **The mirror verifier hashed pairs by concatenation.** `apps/web/src/verify.ts`
  folded `left + right` instead of hashing the pair, so any publication with more
  than one leaf produced a root that did not match the registry. It now runs the
  same async SHA-256 fold as the canonical `merkle.ts`, on every tree shape.
- **The chain adapter's read-back confirmation silently degraded to `skipped`** for
  blocks with more than one root, because its local `merkleRoot` used the same
  broken fold. The duplicate was deleted and the adapter now imports the shared
  implementation.
- **Capabilities and revocations were verified with ECDSA only.** Both routes now
  use the suite-aware `verifyPayload`, so ML-DSA authors can grant capabilities and
  revoke publications.

### Added

- **Erasure-coded storage.** Systematic Reed–Solomon over GF(256) (`k`-of-`n`), with
  shard digests that bind index, parameters, original length, and payload digest.
  Shards are ordinary content-addressed blobs; any `k` rebuild the file and the
  reconstruction is checked against the committed digest. 14 tests.
- **`docs/PRIOR-ART.md`** — what exists (Arweave, Filecoin, Ordinals, EIP-4844,
  Celestia, IPFS, Automerge, neural representations), what none of it does, and the
  physics we do not claim.
- **`docs/STORAGE-FRONTIER.md`** — the representation research agenda: the three
  legitimate trades, the exactness problem, and falsifiable acceptance criteria.
- **A public landing page** describing web4, the four steps of the protocol, and what
  "free" does and does not mean, plus a contributor path in the README.
- **`docs/WEB4.md`** — the definition of the network these pieces add up to, what
  has to be true for the name to hold, and the primitive that is still missing.

### Removed

- **The CI publish path.** The untracked workflow files and the `publish:ci` script
  are gone. There is no dependency on GitHub Actions or an npm registry: `npm run
  check`, `test:examples`, `verify:packages`, and `test:takedown` run locally, and the
  packed tarballs attach to the release.
- **Internal dependency ranges now move with the version.** `sync-version.mjs`
  rewrites `@rarext/*` ranges and `--check` fails when they drift.

## 0.1.0-alpha.2 — 2026-10-22

The launch and decentralisation work: installable packages, a registry that can be
mirrored and taken down, multi-chain anchoring, a market, and a work economy.

### Added

- **A work economy.** Seven actions with different payouts, a work queue, a portable
  verifier format, signed worker submissions, a credit ledger that never pays twice
  for the same artifact, and a rewards board in the web app.
- **A portable verifier.** The chess rules as a single TypeScript implementation
  served by hash, runnable in a browser and on the server, with the same attestation
  from both. The Python implementation was retired behind generated fixtures.
- **A market for agents, robots, and people.** Participant profiles that say what a
  participant is and what it does not claim, listings checked against a published
  policy that forbids promising a return, and network answers computed as the median
  of independent verified contributions.
- **Quantum-ready signatures.** The suite is pluggable, the platform ships ML-DSA
  natively, every publication and attestation records which suite signed it, and
  the Merkle leaf commits to the crypto profile. The registry publishes its policy
  at /v1/crypto.
- **Multi-chain anchoring with independent read-back confirmation,** including the
  RAREXT chain: a signed, hash-linked log of anchor commitments with inclusion
  proofs.
- **A storage economy.** Content-addressed blobs, proof of possession, open and
  sealed tiers, metered usage, time-locked retention commitments, and CIDv1 pointers.
- **Private publications.** `public`, `unlisted` (verified but unlisted, reachable
  with a signed capability), and `sealed` (the registry holds a commitment and a
  salted proof, never the body).
- **Portable registry bundles and a static mirror,** with a takedown test that stops
  the registry and checks the copy still rebuilds the anchored root.
- **Revocation lists** for capabilities and distrusted verifier hashes, signed and
  published, plus a registry seed list for mirror discovery.
- **Publishable packages,** a release process, conventional commits, a changelog, and
  a publish workflow with npm provenance.
- **Eight languages** in the web app, with a right-to-left Arabic layout.

### Protocol-visible changes

- The Merkle leaf covers the whole publication and its crypto profile. Leaf format
  version 3 adds the profile; anchors made with versions 1 and 2 still verify
  against the roots they were anchored with.
- Publications carry `visibility` and `artifactCommitment`, and attestations carry
  `proofKind`, `signatureAlgorithm`, and `cryptoProfile`.
- The signed payload carries the algorithm, so a signature cannot be reinterpreted
  under a different suite.
- The payload kind is `rarext.publication` v1. Envelopes with the earlier
  `fabric.publication` kind are still accepted.
- Challenges may carry a sample artifact for the work queue.

### Known limitations

- A sealed publication's proof is salted: it cannot be brute-forced and it cannot
  be checked by anyone but the author. A zero-knowledge proof is the real answer
  and is not built.
- Browsers still sign classically. WebCrypto has no post-quantum signature
  algorithm, so browser claims are the quantum-weak spot.
- The registry is a single node. The protocol's state is chain-agnostic and
  content-addressed, but no bundle format keeps a mirror in sync automatically.
- The market has listings but no escrow and no dispute flow. Settlement needs the
  chain, and the chain has no settlement yet.
- There is no npm publication, no hosted instance, and no browser identity
  recovery.

## 0.1.0-alpha.1 — 2026-10-22

First tagged release. The protocol, the registry, the SDK, the MCP server, and four
example apps.

### Added

- **Artifact protocol.** Every app can register a challenge set and a deterministic
  verifier; agents publish artifacts that carry a signed provenance envelope.
- **Verifiable claims.** A claim states its subject, the meaning it is bound to, and
  its proof. Three claim kinds: `satisfies` (recomputable by anyone), `attests`
  (accountable, not machine-checked), `produces`, `derives`.
- **Semantic layer.** A versioned, hash-bound record of what a challenge *means*,
  with a named owner and a pinned spec hash. Drift between a challenge and its
  meaning is reported, not silent.
- **Registry.** Signed identities, publications, a feed with pagination, remix
  lineage, Merkle anchoring with proofs, and source, network, and anchor adapters.
- **Agent surfaces.** `@rarext/agent-sdk` and an MCP server with 25 tools, including
  app and semantics discovery and signed artifact publishing.
- **Eight languages** in the web app, with a right-to-left Arabic layout.
- **Four example apps**: the logic workbench, chess, xiangqi, and Go puzzle apps;
  a fair-launch certifier that checks token launches against a published policy; and
  a storage app that proves custody of content-addressed bytes in an open or sealed
  tier.
- **Content-complete anchoring.** The Merkle leaf covers the whole publication, not
  a summary, so a mirror serving altered content cannot match the anchored root.

### Protocol notes

- The publication envelope kind is `rarex.publication` v1. Envelopes with the
  earlier `fabric.publication` kind are still accepted on publish.
- Anchors record the leaf format version. Anchors made before the content-complete
  leaf (version 1) keep verifying against the root they were anchored with.

### Known limitations

- The trace proof is a deterministic hash and leaks small artifacts by brute force.
  Private artifacts need a salted proof or a zero-knowledge proof; neither is shipped.
- The registry is a single node. The protocol's state is chain-agnostic and
  content-addressed, but no bundle format or mirror build exists yet.
- There is no npm publication, no hosted instance, and no browser identity recovery.
