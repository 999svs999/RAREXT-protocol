/**
 * The chess verifier, as a portable module.
 *
 * This runs in three places: the verifier service, the browser worker, and the
 * tests. It is the only implementation of the rules — the fixtures in
 * `fixtures.json` were generated from the previous Python implementation and
 * are what proves this port behaves identically.
 *
 * The shape it returns is the verifier ABI:
 *
 *   verify(artifact, challenge) -> { correct, score, gateCount, proof, details }
 *
 * The `proof` object is the trace. The protocol hashes it with the same
 * canonical JSON it uses everywhere else, so a browser and the server produce
 * byte-identical attestations for the same artifact.
 *
 * It supports standard piece movement, promotion, en passant, castling, check,
 * checkmate, and stalemate. It intentionally does not implement draw rules such
 * as threefold repetition or the fifty-move rule.
 */

export const FILES = "abcdefgh";
export const START_FEN =
  "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const KNIGHT_STEPS: [number, number][] = [
  [-2, -1],
  [-2, 1],
  [-1, -2],
  [-1, 2],
  [1, -2],
  [1, 2],
  [2, -1],
  [2, 1],
];
const BISHOP_DIRS: [number, number][] = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];
const ROOK_DIRS: [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
const KING_DIRS: [number, number][] = [...BISHOP_DIRS, ...ROOK_DIRS];
const PIECES = new Set("pnbrqkPNBRQK");

export type Move = [number, number, string | null];

export interface Position {
  board: (string | null)[];
  side: string;
  castling: string;
  ep: number | null;
}

export interface ChessProof {
  game: string;
  plies: number;
  finalFen: string;
  checkmate: boolean;
  stalemate: boolean;
}

export interface ChessDetails {
  maxPlies: number;
  sideToMove: string;
}

export interface VerificationResult {
  correct: boolean;
  score: number;
  gateCount: number;
  proof: ChessProof;
  details: ChessDetails;
}

function colorOf(piece: string | null): string {
  return piece && piece === piece.toUpperCase() ? "w" : "b";
}

function opposite(color: string): string {
  return color === "w" ? "b" : "w";
}

function copyPosition(position: Position): Position {
  return {
    board: [...position.board],
    side: position.side,
    castling: position.castling,
    ep: position.ep,
  };
}

export function squareIndex(name: string): number {
  if (!/^[a-h][1-8]$/.test(name)) {
    throw new Error(`invalid square: ${name}`);
  }
  return (8 - Number(name[1])) * 8 + (name.charCodeAt(0) - "a".charCodeAt(0));
}

export function squareName(index: number): string {
  return `${FILES[index % 8]}${8 - Math.floor(index / 8)}`;
}

export function parseFen(fen: string): Position {
  const fields = fen.trim().split(/\s+/);

  if (fields.length < 4) {
    throw new Error("FEN must contain at least 4 fields");
  }

  const rows = fields[0]!.split("/");

  if (rows.length !== 8) {
    throw new Error("FEN board must have 8 ranks");
  }

  const board: (string | null)[] = [];

  for (const row of rows) {
    let count = 0;

    for (const character of row) {
      if (/[0-9]/.test(character)) {
        count += Number(character);
        for (let index = 0; index < Number(character); index += 1) board.push(null);
      } else if (PIECES.has(character)) {
        count += 1;
        board.push(character);
      } else {
        throw new Error(`invalid FEN piece: ${character}`);
      }
    }

    if (count !== 8) {
      throw new Error("each FEN rank must contain 8 squares");
    }
  }

  const side = fields[1]!;

  if (side !== "w" && side !== "b") {
    throw new Error("FEN side must be w or b");
  }

  const castling = fields[2] === "-" ? "" : fields[2]!;

  if ([...castling].some((character) => !"KQkq".includes(character))) {
    throw new Error("invalid FEN castling rights");
  }

  const ep = fields[3] === "-" ? null : squareIndex(fields[3]!);

  if (board.filter((piece) => piece === "K").length !== 1) {
    throw new Error("FEN must contain exactly one king per side");
  }

  if (board.filter((piece) => piece === "k").length !== 1) {
    throw new Error("FEN must contain exactly one king per side");
  }

  return { board, side, castling, ep };
}

export function toFen(position: Position): string {
  const rows: string[] = [];

  for (let row = 0; row < 8; row += 1) {
    let empty = 0;
    let text = "";

    for (let col = 0; col < 8; col += 1) {
      const piece = position.board[row * 8 + col] ?? null;

      if (piece === null) {
        empty += 1;
      } else {
        if (empty) {
          text += String(empty);
          empty = 0;
        }
        text += piece;
      }
    }

    if (empty) text += String(empty);
    rows.push(text);
  }

  const castling = position.castling || "-";
  const ep = position.ep === null ? "-" : squareName(position.ep);

  return `${rows.join("/")} ${position.side} ${castling} ${ep} 0 1`;
}

function findKing(position: Position, color: string): number {
  const target = color === "w" ? "K" : "k";
  const index = position.board.indexOf(target);

  if (index === -1) throw new Error("king is missing");
  return index;
}

function onBoard(row: number, col: number): boolean {
  return row >= 0 && row < 8 && col >= 0 && col < 8;
}

export function isAttacked(
  position: Position,
  index: number,
  byColor: string,
): boolean {
  const row = Math.floor(index / 8);
  const col = index % 8;
  const board = position.board;

  const pawnRow = row + (byColor === "w" ? 1 : -1);
  const pawn = byColor === "w" ? "P" : "p";

  for (const pawnCol of [col - 1, col + 1]) {
    if (!onBoard(pawnRow, pawnCol)) continue;
    if (board[pawnRow * 8 + pawnCol] === pawn) return true;
  }

  const knight = byColor === "w" ? "N" : "n";

  for (const [dr, dc] of KNIGHT_STEPS) {
    const r = row + dr;
    const c = col + dc;
    if (onBoard(r, c) && board[r * 8 + c] === knight) return true;
  }

  const king = byColor === "w" ? "K" : "k";

  for (const [dr, dc] of KING_DIRS) {
    const r = row + dr;
    const c = col + dc;
    if (onBoard(r, c) && board[r * 8 + c] === king) return true;
  }

  const bishop = byColor === "w" ? "B" : "b";
  const rook = byColor === "w" ? "R" : "r";
  const queen = byColor === "w" ? "Q" : "q";

  for (const [dr, dc] of BISHOP_DIRS) {
    let r = row + dr;
    let c = col + dc;

    while (onBoard(r, c)) {
      const piece = board[r * 8 + c] ?? null;

      if (piece !== null) {
        if (piece === bishop || piece === queen) return true;
        break;
      }

      r += dr;
      c += dc;
    }
  }

  for (const [dr, dc] of ROOK_DIRS) {
    let r = row + dr;
    let c = col + dc;

    while (onBoard(r, c)) {
      const piece = board[r * 8 + c] ?? null;

      if (piece !== null) {
        if (piece === rook || piece === queen) return true;
        break;
      }

      r += dr;
      c += dc;
    }
  }

  return false;
}

export function inCheck(position: Position, color: string): boolean {
  return isAttacked(position, findKing(position, color), opposite(color));
}

function addStep(
  moves: Move[],
  position: Position,
  color: string,
  start: number,
  row: number,
  col: number,
): void {
  if (!onBoard(row, col)) return;

  const target = position.board[row * 8 + col] ?? null;

  if (target === null || colorOf(target) !== color) {
    moves.push([start, row * 8 + col, null]);
  }
}

function addSlides(
  moves: Move[],
  position: Position,
  color: string,
  start: number,
  directions: [number, number][],
): void {
  const row = Math.floor(start / 8);
  const col = start % 8;

  for (const [dr, dc] of directions) {
    let r = row + dr;
    let c = col + dc;

    while (onBoard(r, c)) {
      const index = r * 8 + c;
      const target = position.board[index] ?? null;

      if (target === null) {
        moves.push([start, index, null]);
      } else {
        if (colorOf(target) !== color) {
          moves.push([start, index, null]);
        }
        break;
      }

      r += dr;
      c += dc;
    }
  }
}

function addCastling(
  moves: Move[],
  position: Position,
  color: string,
): void {
  const homeRow = color === "w" ? 7 : 0;

  if (position.side !== color) return;

  const king = color === "w" ? "K" : "k";
  const rook = color === "w" ? "R" : "r";

  if (position.board[homeRow * 8 + 4] !== king) return;

  const kingRight = color === "w" ? "K" : "k";
  const queenRight = color === "w" ? "Q" : "q";

  if (
    kingRight.includes(position.castling) &&
    position.board[homeRow * 8 + 7] === rook
  ) {
    const empty = [5, 6];
    const safe = [4, 5, 6];

    if (empty.every((col) => position.board[homeRow * 8 + col] === null)) {
      if (
        !safe.some((col) =>
          isAttacked(position, homeRow * 8 + col, opposite(color)),
        )
      ) {
        moves.push([homeRow * 8 + 4, homeRow * 8 + 6, "castle-k"]);
      }
    }
  }

  if (
    queenRight.includes(position.castling) &&
    position.board[homeRow * 8] === rook
  ) {
    const empty = [1, 2, 3];
    const safe = [4, 3, 2];

    if (empty.every((col) => position.board[homeRow * 8 + col] === null)) {
      if (
        !safe.some((col) =>
          isAttacked(position, homeRow * 8 + col, opposite(color)),
        )
      ) {
        moves.push([homeRow * 8 + 4, homeRow * 8 + 2, "castle-q"]);
      }
    }
  }
}

export function pseudoMoves(position: Position, color: string): Move[] {
  const moves: Move[] = [];
  const board = position.board;

  for (let start = 0; start < board.length; start += 1) {
    const piece = board[start] ?? null;

    if (piece === null || colorOf(piece) !== color) continue;

    const row = Math.floor(start / 8);
    const col = start % 8;
    const kind = piece.toLowerCase();

    if (kind === "p") {
      const direction = color === "w" ? -1 : 1;
      const nextRow = row + direction;
      const promotable = nextRow === 0 || nextRow === 7;

      if (
        onBoard(nextRow, col) &&
        (board[nextRow * 8 + col] ?? null) === null
      ) {
        if (promotable) {
          for (const promo of "qrbn") {
            moves.push([start, nextRow * 8 + col, promo]);
          }
        } else {
          moves.push([start, nextRow * 8 + col, null]);
          const doubleRow = row + 2 * direction;

          if (
            row === (color === "w" ? 6 : 1) &&
            (board[doubleRow * 8 + col] ?? null) === null
          ) {
            moves.push([start, doubleRow * 8 + col, null]);
          }
        }
      }

      for (const targetCol of [col - 1, col + 1]) {
        if (!onBoard(nextRow, targetCol)) continue;

        const targetIndex = nextRow * 8 + targetCol;
        const target = board[targetIndex] ?? null;

        if (
          (target !== null && colorOf(target) !== color) ||
          targetIndex === position.ep
        ) {
          if (promotable) {
            for (const promo of "qrbn") {
              moves.push([start, targetIndex, promo]);
            }
          } else {
            moves.push([start, targetIndex, null]);
          }
        }
      }
    } else if (kind === "n") {
      for (const [dr, dc] of KNIGHT_STEPS) {
        addStep(moves, position, color, start, row + dr, col + dc);
      }
    } else if (kind === "b") {
      addSlides(moves, position, color, start, BISHOP_DIRS);
    } else if (kind === "r") {
      addSlides(moves, position, color, start, ROOK_DIRS);
    } else if (kind === "q") {
      addSlides(moves, position, color, start, KING_DIRS);
    } else if (kind === "k") {
      for (const [dr, dc] of KING_DIRS) {
        addStep(moves, position, color, start, row + dr, col + dc);
      }
      addCastling(moves, position, color);
    }
  }

  return moves;
}

export function applyMove(position: Position, move: Move): Position {
  const [start, target, promo] = move;
  const piece = position.board[start] ?? null;

  if (piece === null) throw new Error("cannot move from an empty square");

  const color = colorOf(piece);
  const next = copyPosition(position);
  const board = next.board;
  let capturedIndex = target;

  if (
    piece.toLowerCase() === "p" &&
    target === position.ep &&
    (board[target] ?? null) === null
  ) {
    capturedIndex = target + (color === "w" ? 8 : -8);
  }

  if (promo === "castle-k") {
    const row = Math.floor(start / 8);
    board[target] = piece;
    board[start] = null;
    board[row * 8 + 5] = board[row * 8 + 7] ?? null;
    board[row * 8 + 7] = null;
  } else if (promo === "castle-q") {
    const row = Math.floor(start / 8);
    board[target] = piece;
    board[start] = null;
    board[row * 8 + 3] = board[row * 8] ?? null;
    board[row * 8] = null;
  } else {
    board[target] = piece;
    board[start] = null;

    if (promo === "q" || promo === "r" || promo === "b" || promo === "n") {
      board[target] = color === "w" ? promo.toUpperCase() : promo;
    }

    if (capturedIndex !== target) {
      board[capturedIndex] = null;
    }
  }

  next.ep = null;

  if (piece.toLowerCase() === "p" && Math.abs(target - start) === 16) {
    next.ep = (start + target) / 2;
  }

  let rights = position.castling;

  if (piece === "K") {
    rights = rights.replace("K", "").replace("Q", "");
  } else if (piece === "k") {
    rights = rights.replace("k", "").replace("q", "");
  } else if (piece === "R") {
    if (start === 63) rights = rights.replace("K", "");
    else if (start === 56) rights = rights.replace("Q", "");
  } else if (piece === "r") {
    if (start === 7) rights = rights.replace("k", "");
    else if (start === 0) rights = rights.replace("q", "");
  }

  if (capturedIndex === 63) rights = rights.replace("K", "");
  else if (capturedIndex === 56) rights = rights.replace("Q", "");
  else if (capturedIndex === 7) rights = rights.replace("k", "");
  else if (capturedIndex === 0) rights = rights.replace("q", "");

  next.castling = rights;
  next.side = opposite(color);

  return next;
}

export function legalMoves(position: Position): Move[] {
  const legal: Move[] = [];

  for (const move of pseudoMoves(position, position.side)) {
    const candidate = applyMove(copyPosition(position), move);
    if (!inCheck(candidate, position.side)) legal.push(move);
  }

  return legal;
}

function sameMove(a: Move, b: Move): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function normalizeMove(position: Position, text: string): Move {
  const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(text.trim().toLowerCase());

  if (!match) {
    throw new Error(`invalid UCI move: ${text}`);
  }

  const start = squareIndex(match[1]!);
  const target = squareIndex(match[2]!);
  let promo: string | null = match[3] ?? null;
  const piece = position.board[start] ?? null;

  if (piece === null) {
    throw new Error(`no piece on ${match[1]}`);
  }

  if (piece.toLowerCase() === "p" && (target === 0 || target >= 56) && promo === null) {
    promo = "q";
  }

  const requested: Move = [start, target, promo];
  const legal = legalMoves(position);

  if (!legal.some((move) => sameMove(move, requested))) {
    throw new Error(`illegal move: ${text}`);
  }

  return requested;
}

export function verify(
  artifact: unknown,
  challenge: unknown,
): VerificationResult {
  const body = (artifact as { body?: unknown })?.body;

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("chess artifact body must be an object");
  }

  const moves = (body as { moves?: unknown }).moves;

  if (!Array.isArray(moves) || moves.length === 0) {
    throw new Error("chess body.moves must be a non-empty list");
  }

  if (!moves.every((move) => typeof move === "string")) {
    throw new Error("every chess move must be a string");
  }

  const spec = (challenge as { spec?: unknown })?.spec;

  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new Error("chess challenge spec must be an object");
  }

  const record = spec as Record<string, unknown>;

  if ((record.objective ?? "mate") !== "mate") {
    throw new Error("chess objective must be mate");
  }

  const maxPlies = record.maxPlies ?? 5;

  if (typeof maxPlies !== "number" || !Number.isInteger(maxPlies) || maxPlies < 1 || maxPlies > 100) {
    throw new Error("maxPlies must be an integer from 1 to 100");
  }

  const fen = record.fen ?? START_FEN;

  if (typeof fen !== "string") {
    throw new Error("challenge fen must be a string");
  }

  let position = parseFen(fen);
  const played: string[] = [];

  for (const text of moves) {
    const move = normalizeMove(position, text);
    position = applyMove(position, move);
    played.push(text.trim().toLowerCase());
  }

  const legal = legalMoves(position);
  const checkmate = legal.length === 0 && inCheck(position, position.side);
  const stalemate = legal.length === 0 && !checkmate;
  const correct = checkmate && played.length <= maxPlies;

  const score = correct
    ? Math.max(1, Math.round((1000 * (maxPlies - played.length + 1)) / maxPlies))
    : 0;

  return {
    correct,
    score,
    gateCount: 0,
    proof: {
      game: "chess",
      plies: played.length,
      finalFen: toFen(position),
      checkmate,
      stalemate,
    },
    details: {
      maxPlies,
      sideToMove: position.side,
    },
  };
}
