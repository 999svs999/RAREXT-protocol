"""Dependency-free Xiangqi verifier for RAREXT win puzzles.

Implements standard piece movement, the palace, the river, horse legs, elephant
eyes, cannon screens, and the flying-general rule. Repetition and tournament
clock rules are intentionally out of scope.
"""

import re

FILES = "abcdefghi"
START_FEN = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1"
ICCS = re.compile(r"^([a-i][0-9])([a-i][0-9])$")
PIECES = set("rnbakcpRNBAKCP")
ORTHO = ((-1, 0), (1, 0), (0, -1), (0, 1))
DIAG = ((-1, -1), (-1, 1), (1, -1), (1, 1))


def color_of(piece):
    return "w" if piece and piece.isupper() else "b"


def opposite(color):
    return "b" if color == "w" else "w"


def in_palace(row, col, color):
    if not 3 <= col <= 5:
        return False
    return 7 <= row <= 9 if color == "w" else 0 <= row <= 2


def on_board(row, col):
    return 0 <= row < 10 and 0 <= col < 9


class Position:
    def __init__(self, board, side):
        self.board = list(board)
        self.side = side

    def copy(self):
        return Position(self.board, self.side)


def square_index(name):
    if not re.fullmatch(r"[a-i][0-9]", name):
        raise ValueError(f"invalid square: {name}")
    return (9 - int(name[1])) * 9 + (ord(name[0]) - ord("a"))


def square_name(index):
    return f"{FILES[index % 9]}{9 - index // 9}"


def parse_fen(fen):
    fields = fen.split()
    if len(fields) < 2:
        raise ValueError("Xiangqi FEN must contain at least 2 fields")
    rows = fields[0].split("/")
    if len(rows) != 10:
        raise ValueError("Xiangqi FEN board must have 10 ranks")

    board = []
    for row in rows:
        count = 0
        for char in row:
            if char.isdigit():
                board.extend([None] * int(char))
                count += int(char)
            elif char in PIECES:
                board.append(char)
                count += 1
            else:
                raise ValueError(f"invalid Xiangqi FEN piece: {char}")
        if count != 9:
            raise ValueError("each Xiangqi rank must contain 9 squares")

    side = fields[1]
    if side not in ("w", "b"):
        raise ValueError("Xiangqi side must be w or b")
    if board.count("K") != 1 or board.count("k") != 1:
        raise ValueError("Xiangqi FEN must contain exactly one general per side")

    return Position(board, side)


def to_fen(position):
    rows = []
    for row in range(10):
        empty = 0
        text = ""
        for col in range(9):
            piece = position.board[row * 9 + col]
            if piece is None:
                empty += 1
            else:
                if empty:
                    text += str(empty)
                    empty = 0
                text += piece
        if empty:
            text += str(empty)
        rows.append(text)
    return f"{'/'.join(rows)} {position.side} - - 0 1"


def find_general(position, color):
    target = "K" if color == "w" else "k"
    for index, piece in enumerate(position.board):
        if piece == target:
            return index
    return None


def generals_face(position):
    red = find_general(position, "w")
    black = find_general(position, "b")
    if red is None or black is None:
        return False
    red_row, red_col = divmod(red, 9)
    black_row, black_col = divmod(black, 9)
    if red_col != black_col:
        return False
    low, high = sorted((red_row, black_row))
    return all(position.board[row * 9 + red_col] is None for row in range(low + 1, high))


def is_attacked(position, index, by_color):
    row, col = divmod(index, 9)
    board = position.board

    pawn = "P" if by_color == "w" else "p"
    pawn_from_row = row + 1 if by_color == "w" else row - 1
    if on_board(pawn_from_row, col) and board[pawn_from_row * 9 + col] == pawn:
        return True
    for dc in (-1, 1):
        if on_board(row, col + dc) and board[row * 9 + col + dc] == pawn:
            if pawn_crossed(row, by_color):
                return True

    horse = "N" if by_color == "w" else "n"
    for dr, dc in ((-2, -1), (-2, 1), (-1, -2), (-1, 2), (1, -2), (1, 2), (2, -1), (2, 1)):
        r, c = row + dr, col + dc
        if not on_board(r, c) or board[r * 9 + c] != horse:
            continue
        leg_row = r + (1 if dr < 0 else -1) if abs(dr) == 2 else r
        leg_col = c + (1 if dc < 0 else -1) if abs(dc) == 2 else c
        if board[leg_row * 9 + leg_col] is None:
            return True

    general = "K" if by_color == "w" else "k"
    for dr, dc in ORTHO:
        r, c = row + dr, col + dc
        if on_board(r, c) and board[r * 9 + c] == general:
            return True

    rook = "R" if by_color == "w" else "r"
    cannon = "C" if by_color == "w" else "c"
    for dr, dc in ORTHO:
        r, c = row + dr, col + dc
        screen = False
        while on_board(r, c):
            piece = board[r * 9 + c]
            if piece is not None:
                if not screen:
                    if piece == rook:
                        return True
                    screen = True
                else:
                    if piece == cannon:
                        return True
                    break
            r += dr
            c += dc

    return False


def pawn_crossed(row, color):
    return row <= 4 if color == "w" else row >= 5


def in_check(position, color):
    general = find_general(position, color)
    if general is None:
        return True
    return is_attacked(position, general, opposite(color)) or generals_face(position)


def pseudo_moves(position, color):
    moves = []
    board = position.board

    for start, piece in enumerate(board):
        if piece is None or color_of(piece) != color:
            continue
        row, col = divmod(start, 9)
        kind = piece.lower()

        if kind == "k":
            for dr, dc in ORTHO:
                r, c = row + dr, col + dc
                if on_board(r, c) and in_palace(r, c, color):
                    target = board[r * 9 + c]
                    if target is None or color_of(target) != color:
                        moves.append((start, r * 9 + c))
        elif kind == "a":
            for dr, dc in DIAG:
                r, c = row + dr, col + dc
                if on_board(r, c) and in_palace(r, c, color):
                    target = board[r * 9 + c]
                    if target is None or color_of(target) != color:
                        moves.append((start, r * 9 + c))
        elif kind == "b":
            for dr, dc in DIAG:
                r, c = row + 2 * dr, col + 2 * dc
                if not on_board(r, c):
                    continue
                if position.board[(row + dr) * 9 + col + dc] is not None:
                    continue
                if color == "w" and r < 5:
                    continue
                if color == "b" and r > 4:
                    continue
                target = board[r * 9 + c]
                if target is None or color_of(target) != color:
                    moves.append((start, r * 9 + c))
        elif kind == "n":
            for dr, dc in ((-2, -1), (-2, 1), (-1, -2), (-1, 2), (1, -2), (1, 2), (2, -1), (2, 1)):
                r, c = row + dr, col + dc
                if not on_board(r, c):
                    continue
                leg_row = row + (1 if dr > 0 else -1) if abs(dr) == 2 else row
                leg_col = col + (1 if dc > 0 else -1) if abs(dc) == 2 else col
                if board[leg_row * 9 + leg_col] is not None:
                    continue
                target = board[r * 9 + c]
                if target is None or color_of(target) != color:
                    moves.append((start, r * 9 + c))
        elif kind == "r":
            for dr, dc in ORTHO:
                r, c = row + dr, col + dc
                while on_board(r, c):
                    target = board[r * 9 + c]
                    if target is None:
                        moves.append((start, r * 9 + c))
                    else:
                        if color_of(target) != color:
                            moves.append((start, r * 9 + c))
                        break
                    r += dr
                    c += dc
        elif kind == "c":
            for dr, dc in ORTHO:
                r, c = row + dr, col + dc
                screen = False
                while on_board(r, c):
                    target = board[r * 9 + c]
                    if not screen:
                        if target is None:
                            moves.append((start, r * 9 + c))
                        else:
                            screen = True
                    elif target is not None:
                        if color_of(target) != color:
                            moves.append((start, r * 9 + c))
                        break
                    r += dr
                    c += dc
        elif kind == "p":
            forward = -1 if color == "w" else 1
            r = row + forward
            if on_board(r, col):
                target = board[r * 9 + col]
                if target is None or color_of(target) != color:
                    moves.append((start, r * 9 + col))
            if pawn_crossed(row, color):
                for dc in (-1, 1):
                    c = col + dc
                    if on_board(row, c):
                        target = board[row * 9 + c]
                        if target is None or color_of(target) != color:
                            moves.append((start, row * 9 + c))

    return moves


def apply_move(position, move):
    start, target = move
    next_position = position.copy()
    next_position.board[target] = next_position.board[start]
    next_position.board[start] = None
    next_position.side = opposite(next_position.side)
    return next_position


def legal_moves(position):
    color = position.side
    legal = []
    for move in pseudo_moves(position, color):
        candidate = apply_move(position, move)
        if not in_check(candidate, color):
            legal.append(move)
    return legal


def normalize_move(position, text):
    match = ICCS.fullmatch(text.strip().lower())
    if not match:
        raise ValueError(f"invalid ICCS move: {text}")
    start = square_index(match.group(1))
    target = square_index(match.group(2))
    if (start, target) not in legal_moves(position):
        raise ValueError(f"illegal move: {text}")
    return start, target


def verify(artifact, challenge):
    body = artifact.get("body")
    if not isinstance(body, dict):
        raise ValueError("xiangqi artifact body must be an object")
    moves = body.get("moves")
    if not isinstance(moves, list) or not moves:
        raise ValueError("xiangqi body.moves must be a non-empty list")
    if not all(isinstance(move, str) for move in moves):
        raise ValueError("every xiangqi move must be a string")

    spec = challenge.get("spec")
    if not isinstance(spec, dict):
        raise ValueError("xiangqi challenge spec must be an object")
    if spec.get("objective", "win") not in ("win", "mate"):
        raise ValueError("xiangqi objective must be win or mate")

    max_plies = spec.get("maxPlies", 5)
    if not isinstance(max_plies, int) or not 1 <= max_plies <= 100:
        raise ValueError("maxPlies must be an integer from 1 to 100")

    fen = spec.get("fen", START_FEN)
    if not isinstance(fen, str):
        raise ValueError("challenge fen must be a string")

    position = parse_fen(fen)
    played = []

    for text in moves:
        move = normalize_move(position, text)
        position = apply_move(position, move)
        played.append(text.strip().lower())

    general_missing = find_general(position, position.side) is None
    legal = [] if general_missing else legal_moves(position)
    no_moves = general_missing or not legal
    correct = no_moves and len(played) <= max_plies
    score = max(1, round(1000 * (max_plies - len(played) + 1) / max_plies)) if correct else 0

    return {
        "correct": correct,
        "score": score,
        "gateCount": 0,
        "proof": {
            "game": "xiangqi",
            "plies": len(played),
            "finalFen": to_fen(position),
            "generalCaptured": general_missing,
            "noLegalMoves": no_moves,
            "inCheck": False if general_missing else in_check(position, position.side),
        },
        "details": {
            "maxPlies": max_plies,
            "sideToMove": position.side,
        },
    }
