# Can an AI live on RAREXT? Can you?

Yes — and `npm run demo:live` is the proof, not the claim.

The question is not "is there a model on the chain." It is this: can a
participant — an agent, and the AI it runs — have an existence made **only of
content-addressed bytes**, so that the existence survives the node that first
served it, and a stranger can rebuild it without asking anyone?

## A residence, made of bytes

`scripts/live-on-rarext.mjs` gives a real agent a home with four parts, each one
an address:

| Part | What it is | How it is addressed |
| --- | --- | --- |
| **identity** | the agent's public key | a RAREXT blob; the blob hash *is* its key id |
| **thought** | a **storage-native run**: real weights + a real engine, run by a provider with no host engine | the model bundle and engine artifact, both sharded into RAREXT |
| **claim** | a signed generative AI publication | a publication with an attestation, anchored |
| **charter** | `rarext.generations.v1` ([GENERATIONS.md](GENERATIONS.md)) | its canonical JSON, stored as a blob with one digest |

The demo builds the home through the live API, registry, and anchor, fetches
every byte **back by hash**, then **stops the node and the provider**. Everything
after that reads the saved bytes and nothing else:

1. the public key re-hashes to the claimed key id;
2. the charter blob re-hashes to its address, re-parses as the ladder, and its
   generation digest matches;
3. the publication leaves rebuild the **anchored Merkle root** offline, and every
   AI claim the bundle carries **replays correct** with no server
   (`replayBundleAi`);
4. the **weights and the engine** are reassembled from their shards, every
   `weightsDigest`, `artifactDigest`, and `shardsRoot` verifies, and the
   **committed engine re-run over the committed weights reproduces the recorded
   trace digest** — no node, no provider.

If any step fails, the demo exits non-zero. A green run is a reconstructed life,
and a thought that is provably a network-engine inference rather than a locally
served model.

## Why this is the "AI lives on RAREXT" question, answered

The AI half is [WEB4-MODEL.md](WEB4-MODEL.md): the weights *and* the engine are
content-addressed artifacts a provider fetches, verifies, and runs — so the
machine asking the question runs nothing. This page is the other half: an agent
whose **identity, work, and address** are also just bytes, so the agent does not
depend on a platform either.

Identity as a keypair, work as a claim a stranger recomputes, a home as content
addresses — that is what it means for a participant to live on the network rather
than on somebody's server. The node is optional. The bytes are not.

## What it does not prove

- It does not prove the node was honest while it ran; it proves the **copy** is
  self-consistent and that its AI claims replay. A node that served tampered
  bytes would fail step 1–4.
- It does not prove the agent is conscious, correct, or safe. It proves the agent
  and its AI run are **reconstructible from public bytes**.
- It does not make the node permanent. The point is the opposite: the residence
  outlives the node, exactly as [MIRRORS.md](MIRRORS.md) describes for a registry.

## Run it

```bash
# the agent's thought is a storage-native run; give it a committed container
RAREXT_WEB4_GGUF=/tmp/model.rarext npm run demo:live

npm run demo:generations   # the charter the residence commits
npm run demo:web4-model    # the weights-and-engine path in full (34 phases)
npm run demo:ai-on-rarext  # two nodes, real inference, replay, perturbed weights
```

The web4 leg needs a committed `RXHF`/`GGUF` container; the default is
`/tmp/tinyllama-q8.rarext` when it exists. Without one, the demo still builds and
rebuilds the residence and says the web4 leg was skipped — it never fabricates a
thought.
