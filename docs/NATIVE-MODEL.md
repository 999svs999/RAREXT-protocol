# A model RAREXT grows itself

The capability audit says the quiet part plainly: **RAREXT AI is a runtime and a
protocol, not a model.** That is accurate today, and it is the dependency this
document removes. Until now the capable model on the path — the one a demo, an
audit, or a benchmark actually ran — was borrowed: Qwen2.5-0.5B, built and
trained by Alibaba, a checkpoint trained for a purpose and on a corpus that have
nothing to do with RAREXT. RAREXT could verify that checkpoint and receipt it,
but it could not *make* one. That is the gap.

A borrowed open-weights model is still a third party. It carries someone else's
tokenizer, someone else's training data, someone else's architecture choices, and
someone else's idea of what an AI is. RAREXT's own AI should carry none of those.

This document is the record of RAREXT growing its own: a language model trained
from a seeded initialization on RAREXT's own documents, reproduced byte for byte,
content-addressed, and run by RAREXT's own engine. It is small. It is honest about
being small. What it is *not* is someone else's.

## What was built

| piece | what it is | where |
| --- | --- | --- |
| corpus | RAREXT's own prose, snapshotted once and frozen | `bench/native/corpus.txt` · 321,246 bytes · `sha256:1eddb9f745964ef6…` |
| trainer | pure-JS training, seeded xorshift32 init, hand-written backprop | `scripts/train-native-lm.mjs` |
| container | `rarext.native-lm.v1` (magic `RNLM`): header JSON + float32 tensors | `bench/native/rarext-native-1.rnlm` · 399,101 bytes · `sha256:615fb449c4a5a2bd…` |
| engine | RAREXT engine artifact, no imports, run in a no-`require` `node:vm` | `apps/runtime/engines/rarext-native-lm-engine.js` |
| demo | every claim checked end to end | `scripts/demo-native-ai.mjs` · `npm run demo:native` |
| tests | lineage, determinism, replay, tamper, training reproducibility | `apps/runtime/test/native-lm.test.ts` |

The model the demo runs is **99,418 parameters**. Small on purpose: it has to
train on four cores. The architecture is a byte-level context model — the last 24
bytes each contribute a learned embedding, concatenated, through `tanh` into a
softmax over the 121 bytes RAREXT's prose uses. Token ids **are** byte values, so
`encode` is UTF-8 encoding and `decode` is UTF-8 decoding. There is no borrowed
tokenizer, because there is no borrowed anything.

## Nothing is borrowed, and you can check it

```console
$ npm run demo:native
RAREXT AI · a model RAREXT trained itself

  [ok  ] container declares its own kind   rarext.native-lm.v1
  [ok  ] not a pretrained model   pretrained=false
  [ok  ] zero external model bytes on the path   0
  [ok  ] container holds no third-party model vocabulary
  [ok  ] container matches its training report   615fb449c4a5a2bd…
  [ok  ] trained on RAREXT's own corpus snapshot   sha256 1eddb9f745964ef6…
  [ok  ] greedy run is deterministic
  [ok  ] sampled run replays byte-for-byte from its seed
  [ok  ] a different seed changes the run
  [ok  ] logprobs align with the decode trace   96 scored
  [ok  ] pinnedTokens fix the emitted bytes   "RAREXT"
  [ok  ] stop sequence ends the run   finish=stop
  [ok  ] embeddings come from the model's own weights and are reproducible
```

Three of those checks are the ones that matter for the dependency question:

1. **`pretrained=false` and `externalModelBytes=0`** are written into the
   container by the trainer and read back by the engine. A reviewer does not have
   to trust the claim; the bytes carry their own lineage.
2. **The corpus digest is recomputed** from `bench/native/corpus.txt` and matched
   against both the container header and the training report. The model is a
   function of RAREXT's text.
3. **The container holds no third-party model vocabulary** — the bytes are
   searched for `GGUF`, `safetensors`, `qwen`, `llama.cpp`, `ollama`. There is
   nothing to find.

And the training itself is reproducible. Two independent runs of the same
configuration produce byte-identical containers:

```console
$ node scripts/train-native-lm.mjs --steps 400 --hidden 64 --dim 8 --context 16 --label det --out <A>
$ node scripts/train-native-lm.mjs --steps 400 --hidden 64 --dim 8 --context 16 --label det --out <B>
A: d133d99243ab3a19a5947858360add44515fbf23fc702f3c11eb10aa312b1682
B: d133d99243ab3a19a5947858360add44515fbf23fc702f3c11eb10aa312b1682
IDENTICAL - training is reproducible
```

That property is asserted as a test (`training the native model is reproducible:
two runs are byte-identical`), so it cannot silently drift.

## It also runs on the network, with no third party on the path

The engine and the weights are both RAREXT artifacts, so the model can be served
the way the protocol serves any AI: sharded into RAREXT, fetched and verified by
independent nodes, and never executed on the caller's machine.
`npm run demo:native-web4` runs exactly that with RAREXT's own model:

```console
$ npm run demo:native-web4
The AI lives on RAREXT, purely — weights and engine are network artifacts

  [OK] commit — weights sha256:615fb449c4a… and engine sha256:57d2ba48811… are RAREXT shards
  [OK] nodes — 2 node(s) fetched and verified the shards from RAREXT and serve ai-on-rarext
  [OK] infer — both nodes answered "inster i" from the committed weights
  [OK] agree — the same canonical trace 97e793f6f50549e216… on every node
  [OK] replay — a re-run on node A reproduced trace 97e793f6f50549e216…
  [OK] weights — perturbing 24855 committed weight bytes changed the run (97e793f6f505… -> 75735583717e…)
```

Two nodes fetched the model *and the engine* from RAREXT, verified both digests,
ran the model on a sandboxed worker with no `require` and no filesystem, agreed on
the trace, replayed it, and produced a *different* answer when the committed
weights were perturbed. No Ollama, no llama.cpp, no container runtime, no GPU, no
borrowed checkpoint.

## The hardware is a dial, not a wall

The old answer to "make it as good as the frontier" was "the model does not fit
this box." That answer belonged to a world where RAREXT had to serve someone
else's 0.5B checkpoint. A model RAREXT grows is a different kind of object: it has
a **loss curve**, and the curve is a function of compute RAREXT controls.

Same architecture, more training steps, measured on this host
(`npm run bench:native`, `bench/native/scaling.json`):

| run | params | steps | compute (params × steps) | held nats/byte | bits/byte | wall time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `scale-s` | 99,418 | 1,000 | 99.4 M | 2.4534 | 3.539 | 36 s |
| `scale-m` | 99,418 | 4,000 | 397.7 M | 2.3218 | 3.350 | 125 s |
| `rarext-native-1` | 99,418 | 12,000 | 1.193 B | **2.0552** | **2.965** | 362 s |

The loss falls monotonically with compute, on four cores, with no borrowed
weights anywhere in the loop. Give RAREXT more cores, or more hours, and this
table has more points and a lower floor. That is the honest sense in which the
hardware does not *limit* RAREXT AI: it sets the slope, not the ceiling.

**One result that did not go the way a scaling story wants.** A wider model
(`rarext-wide-1` · 246,722 params · 32-byte context · 6,000 steps · 1.48 B
compute) scored **2.3669** nats/byte — worse than the narrow model at 12,000
steps, and barely better than the narrow model at 4,000. More parameters at
comparable compute did not help; they need more steps to pay for themselves. This
is recorded because it is the truth of this run, not the truth a scaling plot
prefers.

## What the model says

Greedy, from the prompt `"RAREXT is "`:

```text
"inster in the dectide inded to not the recompt the server the recompt the and the recorded in in"
```

That is a byte-level model at 2.97 bits/byte: it has learned RAREXT's vocabulary —
*server*, *recorded*, *deploy*, *protocol* surface constantly — and the local
shape of its sentences, and nothing more. It does not answer questions. It cannot
be told it is wrong. Anyone who reads a fluent completion into it is reading
optimism, not the output.

**This is not a frontier model and this document will not pretend otherwise.**
RAREXT-native-1 is 99,418 parameters at ~3 bits/byte. Qwen2.5-0.5B is 494 M
parameters — five thousand times larger — trained on trillions of tokens of the
web. On capability, RAREXT-native-1 loses, and it will keep losing until RAREXT
spends scale on it. The claim here is narrower and it is the whole point:

> The capable model on RAREXT's path no longer has to be someone else's. RAREXT
> can grow one, it can prove it grew it, and it can point at the curve that makes
> it better.

## What this does and does not change

- **Does**: remove the third-party-model dependency from RAREXT's own AI. The
  default model a reader can train, run, verify, and replay is RAREXT's.
- **Does**: turn "the model does not fit" into "the model has a loss curve."
- **Does not**: make RAREXT better than frontier AI. It does not, and claiming it
  would be the unverifiable assertion this project exists to refuse.
- **Does not**: remove the GGUF/RXHF engine. Importing a checkpoint is still
  supported and still useful — it is now an *option*, not the substance.

The GGUF engine (`apps/runtime/engines/rarext-gguf-engine.js`) and the native
engine are the same kind of object to the protocol: a content-addressed engine
artifact that reads content-addressed weights. One reads weights RAREXT grew; one
reads weights someone else grew. RAREXT's AI is the one that runs the first.

## Reproduce

The corpus snapshot is **frozen**: a trained model names its digest in its header,
so editing a source document and regenerating the snapshot would silently
invalidate every model grown from the old bytes. `npm run native:corpus` therefore
refuses to overwrite an existing snapshot unless the digest is unchanged, or you
pass `--force` — and if you force it, you retrain.

```sh
npm run native:corpus     # freeze RAREXT's own text into bench/native/corpus.txt (refuses to overwrite a changed snapshot)
npm run train:native      # grow the model from a seeded init (no network, no framework)
npm run demo:native       # run it through RAREXT's engine and check every claim
npm run demo:native-web4  # serve it over the network: weights and engine as RAREXT shards
npm run bench:native      # collect the runs into bench/native/scaling.json

# a specific run
node scripts/train-native-lm.mjs --steps 12000 --hidden 192 --dim 16 --context 24 --label rarext-native-1
```

Nothing in the pipeline reaches the network. The trainer reads one local file
(the corpus) and writes one local file (the container). The engine is evaluated
in a `node:vm` context with no `require` and no filesystem. The only third-party
software involved is Node itself.
