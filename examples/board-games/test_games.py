import unittest

import chess_rules
import go_rules
import xiangqi_rules


def artifact(app, kind, moves):
    return {
        "app": app,
        "kind": kind,
        "version": 1,
        "mediaType": "application/json",
        "body": {"moves": moves},
    }


class ChessTests(unittest.TestCase):
    def setUp(self):
        self.challenge = {
            "id": "chess-mate-1",
            "app": "chess",
            "spec": {
                "fen": "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1",
                "objective": "mate",
                "maxPlies": 3,
            },
        }

    def test_back_rank_mate(self):
        result = chess_rules.verify(
            artifact("chess", "chess.moves", ["a1a8"]),
            self.challenge,
        )
        self.assertTrue(result["correct"])
        self.assertTrue(result["proof"]["checkmate"])

    def test_non_mate_is_rejected(self):
        result = chess_rules.verify(
            artifact("chess", "chess.moves", ["a1a7"]),
            self.challenge,
        )
        self.assertFalse(result["correct"])

    def test_illegal_move_is_rejected(self):
        with self.assertRaises(ValueError):
            chess_rules.verify(
                artifact("chess", "chess.moves", ["a1b2"]),
                self.challenge,
            )


class XiangqiTests(unittest.TestCase):
    def setUp(self):
        self.challenge = {
            "id": "xiangqi-mate-1",
            "app": "xiangqi",
            "spec": {
                "fen": "R2aka3/4p4/9/9/9/9/9/9/9/3K5 w - - 0 1",
                "objective": "win",
                "maxPlies": 3,
            },
        }

    def test_palace_mate(self):
        result = xiangqi_rules.verify(
            artifact("xiangqi", "xiangqi.moves", ["a9d9"]),
            self.challenge,
        )
        self.assertTrue(result["correct"])
        self.assertTrue(result["proof"]["noLegalMoves"])

    def test_non_mate_is_rejected(self):
        result = xiangqi_rules.verify(
            artifact("xiangqi", "xiangqi.moves", ["a9a8"]),
            self.challenge,
        )
        self.assertFalse(result["correct"])


class GoTests(unittest.TestCase):
    def setUp(self):
        self.challenge = {
            "id": "go-capture-1",
            "app": "go",
            "spec": {
                "size": 9,
                "next": "black",
                "objective": "capture",
                "maxMoves": 5,
                "initial": [
                    {"color": "white", "point": "E5"},
                    {"color": "black", "point": "D5"},
                    {"color": "black", "point": "F5"},
                    {"color": "black", "point": "E6"},
                ],
                "target": {"color": "white", "points": ["E5"]},
            },
        }

    def test_capture(self):
        result = go_rules.verify(
            artifact("go", "go.moves", ["E4"]),
            self.challenge,
        )
        self.assertTrue(result["correct"])
        self.assertTrue(result["proof"]["targetCaptured"])
        self.assertEqual(result["proof"]["captured"], 1)

    def test_missing_capture_is_rejected(self):
        result = go_rules.verify(
            artifact("go", "go.moves", ["E7"]),
            self.challenge,
        )
        self.assertFalse(result["correct"])

    def test_occupied_point_is_rejected(self):
        with self.assertRaises(ValueError):
            go_rules.verify(
                artifact("go", "go.moves", ["E5"]),
                self.challenge,
            )


if __name__ == "__main__":
    unittest.main()
