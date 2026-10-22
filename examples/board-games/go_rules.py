"""Dependency-free Go verifier for RAREXT capture puzzles.

Supports board setup, alternating moves, passes, captures, suicide prevention,
and positional superko. Territory scoring and komi are intentionally out of
scope; this verifier settles capture objectives.
"""

import re

POINT = re.compile(r"^([A-S])([1-9]|1[0-9])$")
COLORS = {"black": "b", "white": "w", "b": "b", "w": "w"}
NEIGHBORS = ((0, 1), (0, -1), (1, 0), (-1, 0))


def opposite(color):
    return "w" if color == "b" else "b"


def point_index(text, size):
    match = POINT.fullmatch(text.strip().upper())
    if not match:
        raise ValueError(f"invalid Go point: {text}")
    col = ord(match.group(1)) - ord("A")
    rank = int(match.group(2))
    if col >= size or rank > size:
        raise ValueError(f"point {text} is outside a {size}x{size} board")
    return (size - rank) * size + col


def point_name(index, size):
    return f"{chr(ord('A') + index % size)}{size - index // size}"


class Position:
    def __init__(self, board, size, side, history=None):
        self.board = list(board)
        self.size = size
        self.side = side
        self.history = list(history or [])

    def copy(self):
        return Position(self.board, self.size, self.side, self.history)


def group_and_liberties(board, index, size):
    color = board[index]
    stack = [index]
    group = set()
    liberties = set()

    while stack:
        current = stack.pop()
        if current in group:
            continue
        group.add(current)
        row, col = divmod(current, size)
        for dr, dc in NEIGHBORS:
            r, c = row + dr, col + dc
            if not (0 <= r < size and 0 <= c < size):
                continue
            neighbor = r * size + c
            if board[neighbor] is None:
                liberties.add(neighbor)
            elif board[neighbor] == color and neighbor not in group:
                stack.append(neighbor)

    return group, liberties


def place(position, index):
    if position.board[index] is not None:
        raise ValueError(f"point is occupied: {point_name(index, position.size)}")

    board = list(position.board)
    board[index] = position.side
    opponent = opposite(position.side)
    captured = []

    row, col = divmod(index, position.size)
    for dr, dc in NEIGHBORS:
        r, c = row + dr, col + dc
        if not (0 <= r < position.size and 0 <= c < position.size):
            continue
        neighbor = r * position.size + c
        if board[neighbor] != opponent:
            continue
        group, liberties = group_and_liberties(board, neighbor, position.size)
        if not liberties:
            for stone in group:
                board[stone] = None
                captured.append(stone)

    group, liberties = group_and_liberties(board, index, position.size)
    if not liberties:
        raise ValueError("suicide is not allowed")

    board_key = tuple(board)
    if board_key in position.history:
        raise ValueError("move repeats a previous board position")

    return Position(
        board,
        position.size,
        opponent,
        position.history + [board_key],
    ), captured


def legal_points(position):
    points = []
    for index in range(len(position.board)):
        if position.board[index] is not None:
            continue
        try:
            place(position, index)
            points.append(index)
        except ValueError:
            pass
    return points


def verify(artifact, challenge):
    body = artifact.get("body")
    if not isinstance(body, dict):
        raise ValueError("Go artifact body must be an object")
    moves = body.get("moves")
    if not isinstance(moves, list):
        raise ValueError("Go body.moves must be a list")

    spec = challenge.get("spec")
    if not isinstance(spec, dict):
        raise ValueError("Go challenge spec must be an object")
    if spec.get("objective", "capture") != "capture":
        raise ValueError("Go objective must be capture")

    size = spec.get("size", 9)
    if not isinstance(size, int) or not 2 <= size <= 19:
        raise ValueError("Go size must be an integer from 2 to 19")

    max_moves = spec.get("maxMoves", 10)
    if not isinstance(max_moves, int) or not 1 <= max_moves <= 200:
        raise ValueError("maxMoves must be an integer from 1 to 200")

    side = COLORS.get(spec.get("next", "black"))
    if side is None:
        raise ValueError("next must be black or white")

    board = [None] * (size * size)
    initial = spec.get("initial", [])
    if not isinstance(initial, list):
        raise ValueError("initial must be a list of stones")

    for stone in initial:
        if not isinstance(stone, dict):
            raise ValueError("each initial stone must be an object")
        color = COLORS.get(stone.get("color"))
        if color is None:
            raise ValueError("stone color must be black or white")
        index = point_index(str(stone.get("point", "")), size)
        if board[index] is not None:
            raise ValueError("initial stones overlap")
        board[index] = color

    target = spec.get("target")
    if not isinstance(target, dict):
        raise ValueError("Go challenge requires a target group")
    target_color = COLORS.get(target.get("color"))
    if target_color is None:
        raise ValueError("target color must be black or white")
    points = target.get("points")
    if not isinstance(points, list) or not points:
        raise ValueError("target.points must be a non-empty list")
    target_indices = [point_index(str(point), size) for point in points]
    if any(board[index] != target_color for index in target_indices):
        raise ValueError("every target point must start with a target stone")

    position = Position(board, size, side, [tuple(board)])
    captured_total = 0
    played = []

    for move in moves:
        if not isinstance(move, str):
            raise ValueError("every Go move must be a string")
        text = move.strip()
        played.append(text)

        if text.lower() == "pass":
            position = Position(
                position.board,
                size,
                opposite(position.side),
                position.history + [tuple(position.board)],
            )
            continue

        index = point_index(text, size)
        position, captured = place(position, index)
        captured_total += len(captured)

    target_captured = all(position.board[index] is None for index in target_indices)
    correct = target_captured and len(played) <= max_moves
    score = max(1, round(1000 * (max_moves - len(played) + 1) / max_moves)) if correct else 0

    rows = []
    for row in range(size):
        rows.append(
            "".join(
                "." if position.board[row * size + col] is None else position.board[row * size + col]
                for col in range(size)
            )
        )

    return {
        "correct": correct,
        "score": score,
        "gateCount": 0,
        "proof": {
            "game": "go",
            "size": size,
            "plies": len(played),
            "captured": captured_total,
            "targetCaptured": target_captured,
            "finalBoard": rows,
        },
        "details": {
            "targetColor": target_color,
            "targetPoints": [point_name(index, size) for index in target_indices],
        },
    }
