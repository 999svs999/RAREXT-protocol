# Board-game verifiers

Two FABRIC apps with pure-Python verifiers and no third-party packages. Chess is a
[portable verifier](../../apps/verifiers/chess) that runs the same published module in a
browser and on a server, so there is one implementation of the rules.

- **Xiangqi (象棋)** — win puzzles in ICCS `a0`-`i9` notation.
- **Go (圍棋)** — capture puzzles with passes and positional superko.

They demonstrate the cross-language app protocol: the RAREXT API stores artifacts and
attestations, while each game keeps its native rules and runs in its own process.

## Run

```bash
# terminal 1
python3 server.py

# terminal 2
RAREXT_VERIFIERS=examples/board-games/verifiers.json \
RAREXT_CHALLENGES=examples/board-games/challenges.json \
RAREXT_SEMANTICS=examples/board-games/semantics.json \
npm run dev:api
```

```bash
curl -s http://127.0.0.1:8787/v1/apps
curl -s http://127.0.0.1:8787/v1/challenges
curl -s http://127.0.0.1:8787/v1/semantics
```

## Semantics

Each game declares what its challenge means in [`semantics.json`](semantics.json): the
claim kind it licenses, the spec hash it was written against, and who owns the
interpretation. The registry checks the binding and reports it on every challenge, so
a spec edit that is not accompanied by a semantics bump shows up as
`semanticsBinding: "spec-mismatch"` instead of quietly changing what a claim means.
See [the semantic layer](../../docs/SEMANTICS.md).

The verifier also returns a manifest containing the SHA-256 of its rule source file.
That hash becomes the claim's `verifierHash`, so a claim stays bound to the code that
checked it.

## Publish solutions

```bash
# chess: Ra8#
curl -s -X POST http://127.0.0.1:8787/v1/artifacts \
  -H 'content-type: application/json' \
  -d '{"author":"alice","title":"Back-rank mate","challengeId":"chess-mate-1","artifact":{"app":"chess","kind":"chess.moves","version":1,"mediaType":"application/json","body":{"moves":["a1a8"]}}}'

# xiangqi: Rxd9#
curl -s -X POST http://127.0.0.1:8787/v1/artifacts \
  -H 'content-type: application/json' \
  -d '{"author":"alice","title":"Palace mate","challengeId":"xiangqi-mate-1","artifact":{"app":"xiangqi","kind":"xiangqi.moves","version":1,"mediaType":"application/json","body":{"moves":["a9d9"]}}}'

# go: capture E5
curl -s -X POST http://127.0.0.1:8787/v1/artifacts \
  -H 'content-type: application/json' \
  -d '{"author":"alice","title":"Capture","challengeId":"go-capture-1","artifact":{"app":"go","kind":"go.moves","version":1,"mediaType":"application/json","body":{"moves":["E4"]}}}'
```

## Formats

Chess challenge:

```json
{
  "fen": "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1",
  "objective": "mate",
  "maxPlies": 3
}
```

Xiangqi challenge:

```json
{
  "fen": "R2aka3/4p4/9/9/9/9/9/9/9/3K5 w - - 0 1",
  "objective": "win",
  "maxPlies": 3
}
```

Go challenge:

```json
{
  "size": 9,
  "next": "black",
  "objective": "capture",
  "maxMoves": 5,
  "initial": [
    { "color": "white", "point": "E5" },
    { "color": "black", "point": "D5" },
    { "color": "black", "point": "F5" },
    { "color": "black", "point": "E6" }
  ],
  "target": { "color": "white", "points": ["E5"] }
}
```

Go points use columns `A`-`S` and ranks `1`-`19`, with no letter skipping. `"pass"` is a
legal move.

## Scope

- Chess: standard movement, castling, en passant, promotion, checkmate, stalemate. No
  threefold repetition or fifty-move draws.
- Xiangqi: standard movement, palace/river constraints, horse legs, elephant eyes, cannon
  screens, flying general, and stalemate-as-loss.
- Go: capture puzzles only. No territory scoring, komi, handicap, or engine arena.

Full engine-vs-engine play should be a separate app with deterministic time/node limits,
pinned engine versions, and sandboxing.

## Test

```bash
cd examples/board-games
python3 -m unittest -v test_games.py
```
