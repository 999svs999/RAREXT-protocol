export type TournamentFormat = "single_elimination" | "round_robin";

export interface TournamentParticipant {
  id: string;
  name: string;
}

export interface TournamentMatchResult {
  matchId: string;
  winnerParticipantId: string;
  loserParticipantId: string;
  score?: string; // e.g., "2-1", "win by forfeit"
}

export interface SingleEliminationMatch {
  id: string;
  round: number;
  matchNumber: number;
  player1: TournamentParticipant | null;
  player2: TournamentParticipant | null;
  winner: TournamentParticipant | null;
  nextMatchId: string | null; // ID of the match the winner proceeds to
}

export interface SingleEliminationBracket {
  rounds: SingleEliminationMatch[][];
}

export interface RoundRobinTableEntry {
  participant: TournamentParticipant;
  wins: number;
  losses: number;
  draws: number;
  points: number; // e.g., 3 for win, 1 for draw, 0 for loss
}

export interface RoundRobinMatchResult {
  id: string;
  player1: TournamentParticipant;
  player2: TournamentParticipant;
  winner: TournamentParticipant | null; // null for a draw
  score?: string;
  played: boolean;
}

export interface RoundRobinTable {
  matches: RoundRobinMatchResult[];
  standings: RoundRobinTableEntry[];
}

export type TournamentState = SingleEliminationBracket | RoundRobinTable;

export interface Tournament {
  name: string;
  format: TournamentFormat;
  participants: TournamentParticipant[];
  state: TournamentState;
  winner: TournamentParticipant | null; // Only for single elimination
  createdAt: string;
}

export const MAX_TOURNAMENT_PARTICIPANTS = 1024;

export class TournamentService {
  private readonly tournaments = new Map<string, Tournament>();

  constructor(initialTournaments: Tournament[] = []) {
    for (const tournament of initialTournaments) {
      this.tournaments.set(tournament.name, tournament);
    }
  }

  createTournament(
    name: string,
    format: TournamentFormat,
    participants: TournamentParticipant[],
  ): Tournament {
    if (this.tournaments.has(name)) {
      throw new Error(`Tournament with name "${name}" already exists`);
    }
    if (participants.length < 2) {
      throw new Error("A tournament requires at least two participants");
    }
    if (participants.length > MAX_TOURNAMENT_PARTICIPANTS) {
      throw new Error(
        `A tournament supports at most ${MAX_TOURNAMENT_PARTICIPANTS} participants`,
      );
    }

    let state: TournamentState;
    let winner: TournamentParticipant | null = null;

    if (format === "single_elimination") {
      state = this.createSingleEliminationBracket(participants);
    } else if (format === "round_robin") {
      state = this.createRoundRobinTable(participants);
    } else {
      throw new Error(`Unsupported tournament format: ${format}`);
    }

    const newTournament: Tournament = {
      name,
      format,
      participants,
      state,
      winner,
      createdAt: new Date().toISOString(),
    };

    this.tournaments.set(name, newTournament);
    return newTournament;
  }

  recordMatchResult(tournamentName: string, result: TournamentMatchResult): Tournament {
    const tournament = this.tournaments.get(tournamentName);
    if (!tournament) {
      throw new Error(`Tournament with name "${tournamentName}" not found`);
    }

    if (tournament.format === "single_elimination") {
      this.updateSingleEliminationBracket(tournament, result);
    } else if (tournament.format === "round_robin") {
      this.updateRoundRobinTable(tournament, result);
    } else {
      throw new Error(`Unsupported tournament format: ${tournament.format}`);
    }

    // Recalculate winner for single elimination after updating state
    if (tournament.format === "single_elimination") {
      const bracket = tournament.state as SingleEliminationBracket;
      const finalMatch = bracket.rounds[bracket.rounds.length - 1]?.[0];
      tournament.winner = finalMatch?.winner ?? null;
    }

    return tournament;
  }

  getTournament(name: string): Tournament | null {
    return this.tournaments.get(name) ?? null;
  }

  listTournaments(): Tournament[] {
    return Array.from(this.tournaments.values());
  }

  private createSingleEliminationBracket(
    participants: TournamentParticipant[],
  ): SingleEliminationBracket {
    const numParticipants = participants.length;
    const numRounds = Math.ceil(Math.log2(numParticipants));
    const numMatchesInFirstRound = Math.pow(2, numRounds) / 2;

    const rounds: SingleEliminationMatch[][] = [];

    // Create first round matches (with byes if necessary)
    let currentParticipants = [...participants];
    while (currentParticipants.length < numMatchesInFirstRound * 2) {
      currentParticipants.push({ id: `bye-${currentParticipants.length}`, name: `Bye` });
    }
    this.shuffleArray(currentParticipants); // Randomize participant order

    let roundMatches: SingleEliminationMatch[] = [];
    for (let i = 0; i < numMatchesInFirstRound; i++) {
      const player1 = currentParticipants.shift() || null;
      const player2 = currentParticipants.shift() || null;
      roundMatches.push({
        id: `R0M${i + 1}`,
        round: 0,
        matchNumber: i + 1,
        player1,
        player2,
        winner: null,
        nextMatchId: null, // Will be filled in later
      });
    }
    rounds.push(roundMatches);

    // Create subsequent rounds
    for (let r = 1; r < numRounds; r++) {
      const prevRoundMatches = rounds[r - 1];
      roundMatches = [];
      for (let i = 0; i < prevRoundMatches.length / 2; i++) {
        roundMatches.push({
          id: `R${r}M${i + 1}`,
          round: r,
          matchNumber: i + 1,
          player1: null,
          player2: null,
          winner: null,
          nextMatchId: null,
        });
      }
      rounds.push(roundMatches);
    }

    // Link matches to their nextMatchId
    for (let r = 0; r < rounds.length - 1; r++) {
      const currentRound = rounds[r];
      const nextRound = rounds[r + 1];
      for (let i = 0; i < currentRound.length; i++) {
        const match = currentRound[i];
        match.nextMatchId = nextRound[Math.floor(i / 2)].id;
      }
    }

    return { rounds };
  }

  private updateSingleEliminationBracket(
    tournament: Tournament,
    result: TournamentMatchResult,
  ): void {
    const bracket = tournament.state as SingleEliminationBracket;
    let foundMatch = false;

    for (const round of bracket.rounds) {
      for (const match of round) {
        if (match.id === result.matchId) {
          if (!match.player1 || !match.player2) {
            throw new Error(`Match ${match.id} is not fully populated yet`);
          }
          if (match.winner) {
            throw new Error(`Match ${match.id} already has a winner`);
          }
          validateResultForMatch(
            { id: match.id, player1: match.player1, player2: match.player2 },
            result,
            tournament.participants,
          );

          const winner = tournament.participants.find(
            (p) => p.id === result.winnerParticipantId,
          );
          if (!winner) {
            throw new Error(
              `Winner participant ${result.winnerParticipantId} not found`,
            );
          }

          match.winner = winner;
          foundMatch = true;

          // Advance winner to the next match
          if (match.nextMatchId) {
            for (const nextRound of bracket.rounds) {
              for (const nextMatch of nextRound) {
                if (nextMatch.id === match.nextMatchId) {
                  if (match.matchNumber % 2 === 1) {
                    nextMatch.player1 = winner;
                  } else {
                    nextMatch.player2 = winner;
                  }
                  return; // Match updated, exit
                }
              }
            }
          }
          return; // Final match or no next match
        }
      }
    }

    if (!foundMatch) {
      throw new Error(`Match with ID "${result.matchId}" not found`);
    }
  }

  private createRoundRobinTable(
    participants: TournamentParticipant[],
  ): RoundRobinTable {
    const matches: RoundRobinMatchResult[] = [];
    const standings: RoundRobinTableEntry[] = participants.map((p) => ({
      participant: p,
      wins: 0,
      losses: 0,
      draws: 0,
      points: 0,
    }));

    for (let i = 0; i < participants.length; i++) {
      for (let j = i + 1; j < participants.length; j++) {
        matches.push({
          id: `RR_M_${participants[i].id}_vs_${participants[j].id}`,
          player1: participants[i],
          player2: participants[j],
          winner: null,
          played: false,
        });
      }
    }

    return { matches, standings };
  }

  private updateRoundRobinTable(
    tournament: Tournament,
    result: TournamentMatchResult,
  ): void {
    const table = tournament.state as RoundRobinTable;
    const match = table.matches.find((m) => m.id === result.matchId);

    if (!match) {
      throw new Error(`Match with ID "${result.matchId}" not found`);
    }
    if (match.played) {
      throw new Error(`Match ${match.id} already played`);
    }

    validateResultForMatch(match, result, tournament.participants);

    const winner = tournament.participants.find(
      (p) => p.id === result.winnerParticipantId,
    );
    if (!winner) {
      throw new Error(
        `Winner participant ${result.winnerParticipantId} not found`,
      );
    }

    match.winner = winner;
    match.score = result.score;
    match.played = true;

    const player1Entry = table.standings.find((s) => s.participant.id === match.player1.id);
    const player2Entry = table.standings.find((s) => s.participant.id === match.player2.id);

    if (!player1Entry || !player2Entry) {
      throw new Error("Participants not found in standings");
    }

    if (winner.id === match.player1.id) {
      player1Entry.wins++;
      player1Entry.points += 3;
      player2Entry.losses++;
    } else {
      player2Entry.wins++;
      player2Entry.points += 3;
      player1Entry.losses++;
    }

    // Sort standings by points (descending), then wins (descending), then losses (ascending)
    table.standings.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.losses - b.losses;
    });
  }

  private shuffleArray<T>(array: T[]): void {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
}

/**
 * A recorded result must name the two participants of the match it settles:
 * the winner must be one of them and the loser the other. Anything else is
 * a malformed result, and rejecting it keeps the bracket and standings
 * reachable only from the entries that created them.
 */
function validateResultForMatch(
  match: {
    id: string;
    player1: TournamentParticipant;
    player2: TournamentParticipant;
  },
  result: TournamentMatchResult,
  participants: TournamentParticipant[],
): void {
  const ids = [match.player1.id, match.player2.id];
  const known = participants.some((p) => ids.includes(p.id));

  if (!known) {
    throw new Error(`Match ${match.id} is not between its declared participants`);
  }
  if (!ids.includes(result.winnerParticipantId)) {
    throw new Error(
      `Winner ${result.winnerParticipantId} is not a participant in match ${match.id}`,
    );
  }
  if (result.loserParticipantId !== ids.find((id) => id !== result.winnerParticipantId)) {
    throw new Error(
      `Loser ${result.loserParticipantId} does not match the other participant of ${match.id}`,
    );
  }
}

export const defaultTournamentService = new TournamentService();
