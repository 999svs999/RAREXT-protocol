import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  MAX_TOURNAMENT_PARTICIPANTS,
  TournamentService,
  type SingleEliminationBracket,
  type RoundRobinTable,
  type TournamentFormat,
  type TournamentParticipant,
} from "../src/tournament.ts";
import { RarextStore } from "../src/store.ts";
import { start, stop, post } from "./helpers.ts";

interface TournamentFixture {
  name: string;
  format: TournamentFormat;
  participants: TournamentParticipant[];
}

function loadFixture(file: string): TournamentFixture {
  const raw = fs.readFileSync(
    path.resolve("apps/api/test/fixtures", file),
    "utf-8",
  );
  return JSON.parse(raw) as TournamentFixture;
}

/** Drive a bracket to completion, always advancing `favouredId` when present. */
function playBracket(
  service: TournamentService,
  name: string,
  favouredId: string,
): void {
  const tournament = service.getTournament(name);
  assert.ok(tournament, "tournament should exist");
  const bracket = tournament.state as SingleEliminationBracket;

  for (const round of bracket.rounds) {
    for (const match of round) {
      if (match.winner) continue;
      assert.ok(match.player1 && match.player2, `match ${match.id} is populated`);
      const winner =
        match.player1.id === favouredId
          ? match.player1
          : match.player2.id === favouredId
            ? match.player2
            : match.player1;
      const loser = winner.id === match.player1.id ? match.player2 : match.player1;
      service.recordMatchResult(name, {
        matchId: match.id,
        winnerParticipantId: winner.id,
        loserParticipantId: loser.id,
      });
    }
  }
}

test("single elimination: a 4-player bracket plays to a known winner", () => {
  const fixture = loadFixture("tournament-single-elimination-4-player.json");
  const service = new TournamentService();
  service.createTournament(fixture.name, fixture.format, fixture.participants);

  const created = service.getTournament(fixture.name);
  assert.ok(created);
  const bracket = created.state as SingleEliminationBracket;
  assert.equal(bracket.rounds.length, 2, "4 players means two rounds");
  assert.equal(bracket.rounds[0].length, 2, "two semi-finals");
  assert.equal(bracket.rounds[1].length, 1, "one final");
  assert.equal(created.winner, null, "no winner before any match is played");

  playBracket(service, fixture.name, "p1");

  const finished = service.getTournament(fixture.name);
  assert.ok(finished);
  const finalBracket = finished.state as SingleEliminationBracket;
  const final = finalBracket.rounds[finalBracket.rounds.length - 1][0];

  assert.ok(final.winner, "the final has a winner");
  assert.equal(final.winner.id, "p1", "the favoured participant takes the title");
  assert.ok(finished.winner, "the tournament reports a champion");
  assert.equal(finished.winner.id, "p1");
  // The champion is a real participant, never an injected bye placeholder.
  assert.ok(
    fixture.participants.some((p) => p.id === finished.winner?.id),
    "champion is one of the entered participants",
  );

  // Every match in the bracket is decided.
  for (const round of finalBracket.rounds) {
    for (const match of round) {
      assert.ok(match.winner, `match ${match.id} has a winner`);
    }
  }
});

test("single elimination: replaying a decided match is rejected", () => {
  const fixture = loadFixture("tournament-single-elimination-4-player.json");
  const service = new TournamentService();
  service.createTournament(fixture.name, fixture.format, fixture.participants);

  const bracket = (service.getTournament(fixture.name)!.state as SingleEliminationBracket);
  const match = bracket.rounds[0][0];
  const p1 = match.player1;
  const p2 = match.player2;
  assert.ok(p1 && p2, "the first match is fully populated");
  service.recordMatchResult(fixture.name, {
    matchId: match.id,
    winnerParticipantId: p1.id,
    loserParticipantId: p2.id,
  });

  assert.throws(
    () =>
      service.recordMatchResult(fixture.name, {
        matchId: match.id,
        winnerParticipantId: p2.id,
        loserParticipantId: p1.id,
      }),
    /already has a winner/,
  );
});

test("round robin: a 4-player table plays to a known final table", () => {
  const fixture = loadFixture("tournament-round-robin-4-player.json");
  const service = new TournamentService();
  service.createTournament(fixture.name, fixture.format, fixture.participants);

  const created = service.getTournament(fixture.name);
  assert.ok(created);
  const table = created.state as RoundRobinTable;
  assert.equal(table.matches.length, 6, "four players means six pairings");
  assert.equal(table.standings.length, 4);

  // Always award the match to player1; the table order is then fully determined.
  for (const match of table.matches) {
    service.recordMatchResult(fixture.name, {
      matchId: match.id,
      winnerParticipantId: match.player1.id,
      loserParticipantId: match.player2.id,
    });
  }

  const finished = service.getTournament(fixture.name)!;
  const finalTable = finished.state as RoundRobinTable;
  assert.ok(finalTable.matches.every((m) => m.played), "every pairing was played");

  const order = finalTable.standings.map((entry) => ({
    id: entry.participant.id,
    wins: entry.wins,
    losses: entry.losses,
    points: entry.points,
  }));

  assert.deepEqual(order, [
    { id: "pA", wins: 3, losses: 0, points: 9 },
    { id: "pB", wins: 2, losses: 1, points: 6 },
    { id: "pC", wins: 1, losses: 2, points: 3 },
    { id: "pD", wins: 0, losses: 3, points: 0 },
  ]);
});

test("service rejects a duplicate name, a one-player field, and an oversized field", () => {
  const service = new TournamentService();
  service.createTournament("duplicate", "round_robin", [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ]);

  assert.throws(
    () =>
      service.createTournament("duplicate", "round_robin", [
        { id: "c", name: "C" },
        { id: "d", name: "D" },
      ]),
    /already exists/,
  );

  assert.throws(
    () => service.createTournament("too-small", "round_robin", [{ id: "a", name: "A" }]),
    /at least two participants/,
  );

  const oversized = Array.from(
    { length: MAX_TOURNAMENT_PARTICIPANTS + 1 },
    (_, i) => ({ id: `p${i}`, name: `P${i}` }),
  );
  assert.throws(
    () => service.createTournament("too-big", "round_robin", oversized),
    new RegExp(`at most ${MAX_TOURNAMENT_PARTICIPANTS} participants`),
  );
});

test("service rejects a result that names a winner who is not in the match", () => {
  const fixture = loadFixture("tournament-round-robin-4-player.json");
  const service = new TournamentService();
  service.createTournament(fixture.name, fixture.format, fixture.participants);

  const table = service.getTournament(fixture.name)!.state as RoundRobinTable;
  const match = table.matches[0]; // pA vs pB
  assert.equal(match.player1.id, "pA");
  assert.equal(match.player2.id, "pB");

  assert.throws(
    () =>
      service.recordMatchResult(fixture.name, {
        matchId: match.id,
        winnerParticipantId: "pC",
        loserParticipantId: "pA",
      }),
    /Winner pC is not a participant in match/,
  );
});

test("service rejects a result whose loser is not the match's other participant", () => {
  const fixture = loadFixture("tournament-single-elimination-4-player.json");
  const service = new TournamentService();
  service.createTournament(fixture.name, fixture.format, fixture.participants);

  const bracket = service.getTournament(fixture.name)!.state as SingleEliminationBracket;
  const match = bracket.rounds[0][0];
  const p1 = match.player1;
  const p2 = match.player2;
  assert.ok(p1 && p2, "the first match is fully populated");

  assert.throws(
    () =>
      service.recordMatchResult(fixture.name, {
        matchId: match.id,
        winnerParticipantId: p1.id,
        loserParticipantId: "not-in-this-match",
      }),
    /Loser not-in-this-match does not match the other participant/,
  );
});

test("concurrent submissions of the same result record the match exactly once", () => {
  const fixture = loadFixture("tournament-round-robin-4-player.json");
  const service = new TournamentService();
  service.createTournament(fixture.name, fixture.format, fixture.participants);

  const table = service.getTournament(fixture.name)!.state as RoundRobinTable;
  const match = table.matches[0];

  const attempt = () =>
    service.recordMatchResult(fixture.name, {
      matchId: match.id,
      winnerParticipantId: match.player1.id,
      loserParticipantId: match.player2.id,
    });

  attempt();
  // Node's event loop serialises synchronous check-and-write, so a second
  // in-flight submission must be refused, not double-counted.
  assert.throws(() => attempt(), /already played/);

  const standings = service.getTournament(fixture.name)!.state as RoundRobinTable;
  const winnerEntry = standings.standings.find((s) => s.participant.id === match.player1.id)!;
  assert.equal(winnerEntry.wins, 1);
  assert.equal(winnerEntry.points, 3);
});

test("API: create, list, read, and record a result over HTTP", async () => {
  const store = new RarextStore();
  const tournaments = new TournamentService();
  const { server, base } = await start(store, { tournaments });

  try {
    const createRes = await post(base, "/v1/tournaments", {
      name: "api-elim",
      format: "single_elimination",
      participants: [
        { id: "p1", name: "Player 1" },
        { id: "p2", name: "Player 2" },
      ],
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as {
      name: string;
      format: string;
      winner: unknown;
      state: SingleEliminationBracket;
    };
    assert.equal(created.name, "api-elim");
    assert.equal(created.format, "single_elimination");
    assert.equal(created.winner, null);

    const listRes = await fetch(`${base}/v1/tournaments`);
    assert.equal(listRes.status, 200);
    const list = (await listRes.json()) as Array<{ name: string }>;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "api-elim");

    const readRes = await fetch(`${base}/v1/tournaments/api-elim`);
    assert.equal(readRes.status, 200);

    const final = created.state.rounds[created.state.rounds.length - 1][0];
    const resultRes = await post(base, `/v1/tournaments/api-elim/results`, {
      matchId: final.id,
      winnerParticipantId: "p1",
      loserParticipantId: "p2",
    });
    assert.equal(resultRes.status, 200);
    const updated = (await resultRes.json()) as { winner: { id: string } | null };
    assert.ok(updated.winner);
    assert.equal(updated.winner.id, "p1");

    const missingRes = await fetch(`${base}/v1/tournaments/does-not-exist`);
    assert.equal(missingRes.status, 404);

    const badResultRes = await post(base, "/v1/tournaments/does-not-exist/results", {
      matchId: "whatever",
      winnerParticipantId: "p1",
      loserParticipantId: "p2",
    });
    assert.equal(badResultRes.status, 400);

    // Malformed JSON body: readJson rejects it, the app handler's catch-all
    // turns it into a 400 with a message, not a 500.
    const malformed = await fetch(`${base}/v1/tournaments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    assert.equal(malformed.status, 400);
    assert.ok((await malformed.json()).error.includes("invalid JSON body"));

    // A duplicate tournament name over HTTP is a 400, matching the service.
    const dupRes = await post(base, "/v1/tournaments", {
      name: "api-elim",
      format: "single_elimination",
      participants: [
        { id: "p1", name: "Player 1" },
        { id: "p2", name: "Player 2" },
      ],
    });
    assert.equal(dupRes.status, 400);
    assert.ok((await dupRes.json()).error.includes("already exists"));

    // A result that names an unknown match is a 400.
    const unknownMatch = await post(base, "/v1/tournaments/api-elim/results", {
      matchId: "R9M9",
      winnerParticipantId: "p1",
      loserParticipantId: "p2",
    });
    assert.equal(unknownMatch.status, 400);
    assert.ok((await unknownMatch.json()).error.includes("not found"));

    // A winner that is not a participant of the match is a 400.
    const createdAgain = await post(base, "/v1/tournaments", {
      name: "rr",
      format: "round_robin",
      participants: [
        { id: "p1", name: "Player 1" },
        { id: "p2", name: "Player 2" },
        { id: "p3", name: "Player 3" },
      ],
    });
    assert.equal(createdAgain.status, 201);
    const foreignWinner = await post(base, "/v1/tournaments/rr/results", {
      matchId: "RR_M_p1_vs_p2",
      winnerParticipantId: "p3",
      loserParticipantId: "p1",
    });
    assert.equal(foreignWinner.status, 400);
    assert.ok((await foreignWinner.json()).error.includes("not a participant"));
  } finally {
    await stop(server);
  }
});

test("POST /v1/tournaments bounds an oversized participant list at 400", async () => {
  const store = new RarextStore();
  const tournaments = new TournamentService();
  const { server, base } = await start(store, { tournaments });

  try {
    const body = {
      name: "giant",
      format: "round_robin",
      participants: Array.from({ length: MAX_TOURNAMENT_PARTICIPANTS + 1 }, (_, i) => ({
        id: `p${i}`,
        name: `P${i}`,
      })),
    };
    const res = await post(base, "/v1/tournaments", body);
    assert.equal(res.status, 400);
    assert.ok(
      (await res.json()).error.includes(String(MAX_TOURNAMENT_PARTICIPANTS)),
      "the error names the configured cap",
    );
  } finally {
    await stop(server);
  }
});
