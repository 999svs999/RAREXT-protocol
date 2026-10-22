#!/usr/bin/env python3
"""Generate ground-truth fixtures for the portable chess verifier.

    python3 examples/board-games/make_fixtures.py

The fixtures are produced by the Python implementation that is being retired, so
the TypeScript port can be checked against real behaviour instead of a
hand-written expectation. Once the port passes, the fixtures are the regression
net and there is only ever one implementation of the rules.

Every fixture is a position, a list of candidate move lines, and what the
verifier said about each one.
"""

import json
import os

import chess_rules

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(
    os.path.dirname(os.path.dirname(HERE)), "apps", "verifiers", "chess", "fixtures.json"
)

POSITIONS = [
    (
        "Back-rank mate in one",
        "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1",
        [["a1a8"], ["a1a7"], ["a1b1"], ["h2h4"], ["g2g3"]],
    ),
    (
        "Scholar's mate",
        "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2",
        [["e8e7", "f3e5"], ["d7d5"], ["e5d7"]],
    ),
    (
        "Fool's mate",
        "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2",
        [["d8h4"], ["e5e4", "d8h4"]],
    ),
    (
        "Stalemate",
        "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
        [["h8h7"], ["f7f8"]],
    ),
    (
        "Castling both sides",
        "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1",
        [["e1g1"], ["e1c1"], ["a1b1"], ["h1f1"], ["e1d2"]],
    ),
    (
        "En passant",
        "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
        [["e5d6"], ["e5e6"], ["e1e2"]],
    ),
    (
        "Promotion",
        "8/P6k/8/8/8/8/8/K7 w - - 0 1",
        [["a7a8q"], ["a7a8n"], ["a7a7"], ["b1b2"]],
    ),
    (
        "Pinned piece",
        "4k3/8/8/8/8/8/4R3/4K3 b - - 0 1",
        [["e8e7"], ["e8f7"]],
    ),
    (
        "Double check",
        "4k3/8/8/8/8/2n5/8/4K3 w - - 0 1",
        [["e1e2"], ["e1d1"], ["e1f1"]],
    ),
    (
        "King cannot step into check",
        "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1",
        [["e1e2"], ["e1d1"], ["e1f1"], ["e1d2"]],
    ),
    (
        "No legal moves",
        "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1",
        [["g6h6"], ["f7g7"], ["g6f6"]],
    ),
    (
        "Normal opening",
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        [["e2e4"], ["d2d4"], ["g1f3"], ["e2e3"], ["b1c3"]],
    ),
    (
        "Mate in two",
        "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1",
        [["f2f4"], ["a1a8"], ["h2h3"], ["g2g4"]],
    ),
    (
        "Illegal move",
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        [["e2e5"], ["a1a8"], ["b1b8"], ["e1e2"]],
    ),
]


def main():
    fixtures = []

    for title, fen, lines in POSITIONS:
        challenge = {
            "id": "fixture",
            "app": "chess",
            "spec": {"fen": fen, "objective": "mate", "maxPlies": 3},
        }

        for moves in lines:
            artifact = {
                "app": "chess",
                "kind": "chess.moves",
                "version": 1,
                "mediaType": "application/json",
                "body": {"moves": moves},
            }

            try:
                result = chess_rules.verify(artifact, challenge)
                fixtures.append(
                    {
                        "title": title,
                        "fen": fen,
                        "moves": moves,
                        "correct": bool(result["correct"]),
                        "score": int(result["score"]),
                        "proof": result["proof"],
                        "details": result["details"],
                    }
                )
            except Exception as error:  # noqa: BLE001 - the fixture records the failure
                fixtures.append(
                    {
                        "title": title,
                        "fen": fen,
                        "moves": moves,
                        "error": str(error),
                    }
                )

    os.makedirs(os.path.dirname(OUT), exist_ok=True)

    with open(OUT, "w", encoding="utf-8") as handle:
        json.dump({"cases": fixtures}, handle, indent=2, sort_keys=True)
        handle.write("\n")

    print(f"wrote {len(fixtures)} fixtures to {OUT}")


if __name__ == "__main__":
    main()
