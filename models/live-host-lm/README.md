# rarext-live-host-lm

RAREXT's own model for the BAPECLUB live host: a 1,312,512-parameter byte-level
transformer trained on exactly one job — read the price out of one `rows:` line
and say it once. It replaced a 0.5B general chat model that answered price
questions with product descriptions, never emitted EOS, and took seconds per
token.

```
train.py    dataset, model (RMSNorm / NeoX RoPE / tied embeddings), training loop,
            evaluation, checkpointing; --export-only re-exports a checkpoint
gguf.py     ~120-line GGUF v3 writer (float32) — the layout the engine reads
engine_check.mjs   runs a GGUF through RAREXT's engine and scores exact match
```

Train, export, and prove the engine reproduces the trainer:

```bash
python3.11 train.py --steps 6000 --layers 6 --out live-host-lm.gguf
python3.11 train.py --export-only live-host-lm.pt --out live-host-lm.gguf
node engine_check.mjs live-host-lm.gguf prompts.json
```

Held-out at the exported checkpoint (prices unseen at training time; two of the
three sets also use item names never trained on): 100.0% exact on 120
same-distribution samples, 12 unseen-name samples, 12 generic-question samples,
and 12/12 through the RAREXT engine on both prompt sets with `finish=stop`.

The prompt contract (the provider sends the last user turn verbatim, so this is
byte-exact on the wire):

```
rows: -BAPE STA low white|$329
q: how much is the bape sta?
a: 
```

See `docs/MODEL-RUNTIME.md` ("A model trained here, served here") and the
BAPECLUB repo's `docs/live-host-rarext-ai.md` for the serving side.
