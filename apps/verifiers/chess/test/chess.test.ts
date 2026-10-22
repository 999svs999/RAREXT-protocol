import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { verify } from "../chess.ts";

const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures.json", import.meta.url)),
    "utf8",
  ),
) as {
  cases: {
    title: string;
    fen: string;
    moves: string[];
    correct?: boolean;
    score?: number;
    proof?: Record<string, unknown>;
    details?: Record<string, unknown>;
    error?: string;
  }[];
};

function artifact(moves: string[]): unknown {
  return {
    app: "chess",
    kind: "chess.moves",
    version: 1,
    mediaType: "application/json",
    body: { moves },
  };
}

function challenge(fen: string, maxPlies = 3): unknown {
  return {
    id: "fixture",
    app: "chess",
    spec: { fen, objective: "mate", maxPlies },
  };
}

test("the port agrees with every recorded fixture", () => {
  assert.ok(fixtures.cases.length > 30, "the fixture set should be broad");

  for (const fixture of fixtures.cases) {
    const label = `${fixture.title} ${fixture.moves.join(" ")}`;

    if (fixture.error !== undefined) {
      assert.throws(
        () => verify(artifact(fixture.moves), challenge(fixture.fen)),
        (error: Error) => {
          assert.match(error.message, new RegExp(fixture.error!.slice(0, 20)));
          return true;
        },
        `${label} should still fail the same way`,
      );
      continue;
    }

    const result = verify(artifact(fixture.moves), challenge(fixture.fen));

    assert.equal(result.correct, fixture.correct, `${label} correct`);
    assert.equal(result.score, fixture.score, `${label} score`);
    assert.deepEqual(result.proof, fixture.proof, `${label} proof`);
    assert.deepEqual(result.details, fixture.details, `${label} details`);
  }
});

test("the back-rank mate is mate, and the quiet move is not", () => {
  const fen = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1";

  const mate = verify(artifact(["a1a8"]), challenge(fen));
  assert.equal(mate.correct, true);
  assert.equal(mate.proof.checkmate, true);
  assert.equal(mate.proof.stalemate, false);
  assert.equal(mate.proof.finalFen, "R5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1");

  const quiet = verify(artifact(["h2h4"]), challenge(fen));
  assert.equal(quiet.correct, false);
  assert.equal(quiet.score, 0);
});

test("the score falls as the mate takes longer", () => {
  const fen = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1";

  const quick = verify(artifact(["a1a8"]), challenge(fen, 3));
  const slow = verify(artifact(["g2g4", "g8h8", "a1a8"]), challenge(fen, 3));

  assert.equal(quick.correct, true);
  assert.equal(slow.correct, true);
  assert.equal(quick.proof.plies, 1);
  assert.equal(slow.proof.plies, 3);
  assert.equal(quick.score, 1000);
  assert.equal(slow.score, 333);
  assert.ok(slow.score < quick.score, "a slower mate is worth less");
});

test("an illegal move is refused", () => {
  const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  assert.throws(() => verify(artifact(["e2e5"]), challenge(fen)), /illegal move/);
  assert.throws(() => verify(artifact(["zzz"]), challenge(fen)), /invalid UCI move/);
  assert.throws(() => verify(artifact([]), challenge(fen)), /non-empty list/);
});
