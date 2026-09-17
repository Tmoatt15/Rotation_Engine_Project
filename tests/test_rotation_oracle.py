import json
import hashlib
import unittest
from pathlib import Path

from rotation_engine.models import Game, Player
from simulator import run_rotation_engine


CASES_PATH = Path(__file__).parent / "fixtures" / "rotation_oracle_cases.json"


def load_cases():
    with CASES_PATH.open(encoding="utf-8") as cases_file:
        return json.load(cases_file)


def build_game(game_data):
    return Game(**game_data)


def build_roster(player_data):
    return [Player(**player) for player in player_data]


def result_fingerprint(result):
    payload = {
        "timeline": result.timeline,
        "block_counts": result.block_counts,
        "gk_summary": result.gk_summary,
        "position_summary": result.position_summary,
        "metadata": result.metadata,
        "warnings": result.warnings,
        "errors": result.errors,
    }
    serialized = json.dumps(
        payload,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(serialized).hexdigest()


class RotationOracleTests(unittest.TestCase):
    def test_representative_cases_preserve_observable_schedule_contract(self):
        for case in load_cases():
            with self.subTest(case=case["id"]):
                result = run_rotation_engine(
                    build_game(case["game"]),
                    build_roster(case["players"]),
                )
                expected = case["expect"]

                self.assertEqual(
                    result_fingerprint(result),
                    expected["oracle_sha256"],
                )
                self.assertEqual(len(result.timeline), expected["timeline_blocks"])
                self.assertEqual(
                    any(
                        block.get("GK") not in {None, "NO GK AVAILABLE"}
                        for block in result.timeline
                    ),
                    expected["has_goalkeeper"],
                )
                for block in result.timeline:
                    assigned = {
                        block.get("GK"),
                        *block.get("D", []),
                        *block.get("M", []),
                        *block.get("F", []),
                    }
                    assigned -= {None, "NO GK AVAILABLE"}
                    self.assertEqual(len(assigned), expected["field_player_count"])

                if "assigned_goalkeeper" in expected:
                    self.assertTrue(all(
                        block.get("GK") == expected["assigned_goalkeeper"]
                        for block in result.timeline
                    ))
                if "first_goalkeeper" in expected:
                    midpoint = expected["timeline_blocks"] // 2
                    self.assertEqual(
                        result.timeline[0].get("GK"), expected["first_goalkeeper"]
                    )
                    self.assertEqual(
                        result.timeline[midpoint].get("GK"), expected["second_goalkeeper"]
                    )


if __name__ == "__main__":
    unittest.main()