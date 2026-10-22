"""Small dependency-free chess verifier for RAREXT mate puzzles.

It supports standard piece movement, promotion, en passant, castling, check,
checkmate, and stalemate. It intentionally does not implement draw rules such
as threefold repetition or the fifty-move rule.
"""

import re

FILES = "abcdefgh"
START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
UCI = re.compile(r"^([a-h][1-8])([a-h][1-8])([qrbn])?$")
KNIGHT_STEPS = ((-2, -1), (-2, 1), (-1, -2), (-1, 2), (1, -2), (1, 2), (2, -1), (2, 1))
BISHOP_DIRS = ((-1, -1), (-1, 1), (1, -1), (1, 1))
ROOK_DIRS = ((-1, 0), (1, 0), (0, -1), (0, 1))
KING_DIRS = BISHOP_DIRS + ROOK_DIRS
PIECES = set("pnbrqkPNBRQK")


def color_of(piece):
    return "w" if piece and piece.isupper() else "b"


def opposite(color):
    return "b" if color == "w" else "w"


class Position:
    def __init__(self, board, side, castling="", ep=None):
        self.board = list(board)
        self.side = side
        self.castling = castling
        self.ep = ep

    def copy(self):
        return Position(self.board, self.side, self.castling, self.ep)


def square_index(name):
    if not re.fullmatch(r"[a-h][1-8]", name):
        raise ValueError(f"invalid square: {name}")
    return (8 - int(name[1])) * 8 + (ord(name[0]) - ord("a"))


def square_name(index):
    return f"{FILES[index % 8]}{8 - index // 8}"


def parse_fen(fen):
    fields = fen.split()
    if len(fields) < 4:
        raise ValueError("FEN must contain at least 4 fields")

    rows = fields[0].split("/")
    if len(rows) != 8:
        raise ValueError("FEN board must have 8 ranks")

    board = []
    for row in rows:
        count = 0
        for char in row:
            if char.isdigit():
                count += int(char)
                board.extend([None] * int(char))
            elif char in PIECES:
                count += 1
                board.append(char)
            else:
                raise ValueError(f"invalid FEN piece: {char}")
        if count != 8:
            raise ValueError("each FEN rank must contain 8 squares")

    side = fields[1]
    if side not in ("w", "b"):
        raise ValueError("FEN side must be w or b")

    castling = "" if fields[2] == "-" else fields[2]
    if any(char not in "KQkq" for char in castling):
        raise ValueError("invalid FEN castling rights")

    ep = None if fields[3] == "-" else square_index(fields[3])

    if board.count("K") != 1 or board.count("k") != 1:
        raise ValueError("FEN must contain exactly one king per side")

    return Position(board, side, castling, ep)


def to_fen(position):
    rows = []
    for row in range(8):
        empty = 0
        text = ""
        for col in range(8):
            piece = position.board[row * 8 + col]
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
    castling = position.castling or "-"
    ep = "-" if position.ep is None else square_name(position.ep)
    return f"{'/'.join(rows)} {position.side} {castling} {ep} 0 1"


def find_king(position, color):
    target = "K" if color == "w" else "k"
    for index, piece in enumerate(position.board):
        if piece == target:
            return index
    raise ValueError("king is missing")


def on_board(row, col):
    return 0 <= row < 8 and 0 <= col < 8


def is_attacked(position, index, by_color):
    row, col = divmod(index, 8)
    board = position.board

    pawn_row = row + 1 if by_color == "w" else row - 1
    pawn = "P" if by_color == "w" else "p"
    for pawn_col in (col - 1, col + 1):
        if on_board(pawn_row, pawn_col):
            if board[pawn_row * 8 + pawn_col] == pawn:
                return True

    knight = "N" if by_color == "w" else "n"
    for dr, dc in KNIGHT_STEPS:
        r, c = row + dr, col + dc
        if on_board(r, c) and board[r * 8 + c] == knight:
            return True

    king = "K" if by_color == "w" else "k"
    for dr, dc in KING_DIRS:
        r, c = row + dr, col + dc
        if on_board(r, c) and board[r * 8 + c] == king:
            return True

    bishop = "B" if by_color == "w" else "b"
    rook = "R" if by_color == "w" else "r"
    queen = "Q" if by_color == "w" else "q"

    for dr, dc in BISHOP_DIRS:
        r, c = row + dr, col + dc
        while on_board(r, c):
            piece = board[r * 8 + c]
            if piece is not None:
                if piece in (bishop, queen):
                    return True
                break
            r += dr
            c += dc

    for dr, dc in ROOK_DIRS:
        r, c = row + dr, col + dc
        while on_board(r, c):
            piece = board[r * 8 + c]
            if piece is not None:
                if piece in (rook, queen):
                    return True
                break
            r += dr
            c += dc

    return False


def in_check(position, color):
    return is_attacked(position, find_king(position, color), opposite(color))


def add_step(moves, position, color, start, row, col):
    if not on_board(row, col):
        return
    target = position.board[row * 8 + col]
    if target is None or color_of(target) != color:
        moves.append((start, row * 8 + col, None))


def add_slides(moves, position, color, start, directions):
    row, col = divmod(start, 8)
    for dr, dc in directions:
        r, c = row + dr, col + dc
        while on_board(r, c):
            index = r * 8 + c
            target = position.board[index]
            if target is None:
                moves.append((start, index, None))
            else:
                if color_of(target) != color:
                    moves.append((start, index, None))
                break
            r += dr
            c += dc


def pseudo_moves(position, color):
    moves = []
    board = position.board

    for start, piece in enumerate(board):
        if piece is None or color_of(piece) != color:
            continue
        row, col = divmod(start, 8)
        kind = piece.lower()

        if kind == "p":
            direction = -1 if color == "w" else 1
            next_row = row + direction
            promotable = next_row in (0, 7)

            if on_board(next_row, col) and board[next_row * 8 + col] is None:
                if promotable:
                    for promo in "qrbn":
                        moves.append((start, next_row * 8 + col, promo))
                else:
                    moves.append((start, next_row * 8 + col, None))
                    double_row = row + 2 * direction
                    if row == (6 if color == "w" else 1) and board[double_row * 8 + col] is None:
                        moves.append((start, double_row * 8 + col, None))

            for target_col in (col - 1, col + 1):
                if not on_board(next_row, target_col):
                    continue
                target_index = next_row * 8 + target_col
                target = board[target_index]
                if (target is not None and color_of(target) != color) or target_index == position.ep:
                    if promotable:
                        for promo in "qrbn":
                            moves.append((start, target_index, promo))
                    else:
                        moves.append((start, target_index, None))

        elif kind == "n":
            for dr, dc in KNIGHT_STEPS:
                add_step(moves, position, color, start, row + dr, col + dc)

        elif kind == "b":
            add_slides(moves, position, color, start, BISHOP_DIRS)

        elif kind == "r":
            add_slides(moves, position, color, start, ROOK_DIRS)

        elif kind == "q":
            add_slides(moves, position, color, start, KING_DIRS)

        elif kind == "k":
            for dr, dc in KING_DIRS:
                add_step(moves, position, color, start, row + dr, col + dc)
            add_castling(moves, position, color)

    return moves


def add_castling(moves, position, color):
    home_row = 7 if color == "w" else 0
    if position.side != color:
        return
    king = "K" if color == "w" else "k"
    rook = "R" if color == "w" else "r"
    if position.board[home_row * 8 + 4] != king:
        return

    king_right = "K" if color == "w" else "k"
    queen_right = "Q" if color == "w" else "q"

    if king_right in position.castling and position.board[home_row * 8 + 7] == rook:
        empty = (5, 6)
        safe = (4, 5, 6)
        if all(position.board[home_row * 8 + col] is None for col in empty):
            if not any(is_attacked(position, home_row * 8 + col, opposite(color)) for col in safe):
                moves.append((home_row * 8 + 4, home_row * 8 + 6, "castle-k"))

    if queen_right in position.castling and position.board[home_row * 8] == rook:
        empty = (1, 2, 3)
        safe = (4, 3, 2)
        if all(position.board[home_row * 8 + col] is None for col in empty):
            if not any(is_attacked(position, home_row * 8 + col, opposite(color)) for col in safe):
                moves.append((home_row * 8 + 4, home_row * 8 + 2, "castle-q"))


def apply_move(position, move):
    start, target, promo = move
    piece = position.board[start]
    if piece is None:
        raise ValueError("cannot move from an empty square")

    color = color_of(piece)
    next_position = position.copy()
    board = next_position.board
    captured_index = target

    if piece.lower() == "p" and target == position.ep and board[target] is None:
        captured_index = target + (8 if color == "w" else -8)

    if promo == "castle-k":
        row = start // 8
        board[target] = piece
        board[start] = None
        board[row * 8 + 5] = board[row * 8 + 7]
        board[row * 8 + 7] = None
    elif promo == "castle-q":
        row = start // 8
        board[target] = piece
        board[start] = None
        board[row * 8 + 3] = board[row * 8]
        board[row * 8] = None
    else:
        board[target] = piece
        board[start] = None
        if promo in ("q", "r", "b", "n"):
            board[target] = promo.upper() if color == "w" else promo
        if captured_index != target:
            board[captured_index] = None

    next_position.ep = None
    if piece.lower() == "p" and abs(target - start) == 16:
        next_position.ep = (start + target) // 2

    rights = position.castling
    if piece == "K":
        rights = rights.replace("K", "").replace("Q", "")
    elif piece == "k":
        rights = rights.replace("k", "").replace("q", "")
    elif piece == "R":
        if start == 63:
            rights = rights.replace("K", "")
        elif start == 56:
            rights = rights.replace("Q", "")
    elif piece == "r":
        if start == 7:
            rights = rights.replace("k", "")
        elif start == 0:
            rights = rights.replace("q", "")

    if captured_index == 63:
        rights = rights.replace("K", "")
    elif captured_index == 56:
        rights = rights.replace("Q", "")
    elif captured_index == 7:
        rights = rights.replace("k", "")
    elif captured_index == 0:
        rights = rights.replace("q", "")

    next_position.castling = rights
    next_position.side = opposite(color)
    return next_position


def legal_moves(position):
    color = position.side
    legal = []
    for move in pseudo_moves(position, color):
        candidate = apply_move(position.copy(), move)
        if not in_check(candidate, color):
            legal.append(move)
    return legal


def normalize_move(position, text):
    match = UCI.fullmatch(text.strip().lower())
    if not match:
        raise ValueError(f"invalid UCI move: {text}")
    start = square_index(match.group(1))
    target = square_index(match.group(2))
    promo = match.group(3)
    piece = position.board[start]
    if piece is None:
        raise ValueError(f"no piece on {match.group(1)}")
    if piece.lower() == "p" and target // 8 in (0, 7) and promo is None:
        promo = "q"
    requested = (start, target, promo)
    if requested not in legal_moves(position):
        raise ValueError(f"illegal move: {text}")
    return requested


def verify(artifact, challenge):
    body = artifact.get("body")
    if not isinstance(body, dict):
        raise ValueError("chess artifact body must be an object")
    moves = body.get("moves")
    if not isinstance(moves, list) or not moves:
        raise ValueError("chess body.moves must be a non-empty list")
    if not all(isinstance(move, str) for move in moves):
        raise ValueError("every chess move must be a string")

    spec = challenge.get("spec")
    if not isinstance(spec, dict):
        raise ValueError("chess challenge spec must be an object")
    if spec.get("objective", "mate") != "mate":
        raise ValueError("chess objective must be mate")

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

    legal = legal_moves(position)
    checkmate = not legal and in_check(position, position.side)
    stalemate = not legal and not checkmate
    correct = checkmate and len(played) <= max_plies
    score = max(1, round(1000 * (max_plies - len(played) + 1) / max_plies)) if correct else 0

    return {
        "correct": correct,
        "score": score,
        "gateCount": 0,
        "proof": {
            "game": "chess",
            "plies": len(played),
            "finalFen": to_fen(position),
            "checkmate": checkmate,
            "stalemate": stalemate,
        },
        "details": {
            "maxPlies": max_plies,
            "sideToMove": position.side,
        },
    }
