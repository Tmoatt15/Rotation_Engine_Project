import unittest
import builtins
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch

from rotation_engine.models import Game, Player
from rotation_engine.quotas import apply_block_limits, compute_block_targets
from rotation_engine.timeline import (
    assign_exact_slots,
    backup_eligible_players,
    continuity_priority,
    eligible_players,
    group_priority,
    hard_minimum_priority,
    plan_position_group,
    position_assignment_order,
    positional_priority,
    position_minimum_priority,
    formation_slots,
    parse_formation,
)
from rotation_engine.season import GAME_FORMATS, SeasonSetup
from simulator import (
    create_roster_from_inputs,
    game_from_season,
    load_roster_from_json,
    prompt_unavailable_players,
    roster_position_counts,
    regenerate_schedule,
    run_rotation_engine,
)

TEST_ROSTER_PATH = "tests/fixtures/test_roster.json"


class RotationEngineTests(unittest.TestCase):
    def test_roster_position_counts_map_specific_positions_to_groups(self):
        counts = roster_position_counts([
            Player(
                "Specialist",
                "core",
                general_positions=["D"],
                primary_positions=["RCM"],
                backup_positions=["CB"],
            )
        ])

        self.assertEqual(counts["Primary"]["M"], 1)
        self.assertEqual(counts["General"]["D"], 1)
        self.assertEqual(counts["Backup"]["D"], 1)
    def test_gui_roster_inputs_create_normalized_records(self):
        roster = create_roster_from_inputs([
            {"name": "  Casey  ", "group": "CORE", "general_position": "m"},
            {"name": "Jordan", "group": "rotational", "general_position": "D"},
        ])

        self.assertEqual(
            [(player.name, player.group, player.general_positions, player.primary_positions)
             for player in roster],
            [
                ("Casey", "core", ["M"], ["M"]),
                ("Jordan", "rotational", ["D"], ["D"]),
            ],
        )

    def test_backup_position_is_preserved_in_gui_roster_input(self):
        roster = create_roster_from_inputs([
            {
                "name": "Casey",
                "group": "rotational",
                "general_position": "M",
                "backup_positions": "F",
            }
        ])

        self.assertEqual(roster[0].backup_positions, ["F"])

    def test_gui_roster_inputs_reject_an_invalid_group(self):
        with self.assertRaisesRegex(ValueError, "unsupported group"):
            create_roster_from_inputs([
                {"name": "Casey", "group": "starter", "general_position": "M"}
            ])

    def make_game(self):
        return Game(
            total_blocks=10,
            formation="4-4-2",
            gk_assignment="Cameron",
        )

    def make_roster(self):
        return [
            Player("Max", "core", "F", backup_positions=["M"]),
            Player("Sawyer", "core", "F"),
            Player("Alvin", "core", "M"),
            Player("Hanshith", "core", "F", backup_positions=["M"]),
            Player("Dane", "core", "M"),
            Player("Jonathan", "core", "D"),
            Player("Everett", "core", "D"),
            Player("Blake", "core", "D"),
            Player("Thanish", "developing", "M"),
            Player("Yash", "developing", "D"),
            Player("Ryan", "rotational", "D"),
            Player("Mahaswin", "developing", "M"),
            Player("Cameron", "rotational", "M", primary_positions=["M", "GK"]),
            Player("Brad", "developing", "M"),
            Player("Artur", "rotational", "M"),
            Player("Sid", "rotational", "D"),
            Player("Prerith", "rotational", "M"),
            Player("Eitan", "rotational", "D", primary_positions=["D", "GK"]),
            Player("Frank", "rotational", "D", backup_positions=["M"]),
        ]

    def test_four_four_two_creates_ten_blocks(self):
        result = run_rotation_engine(self.make_game(), self.make_roster())

        self.assertEqual(len(result.timeline), 10)

    def test_every_block_has_the_four_four_two_shape(self):
        game = self.make_game()
        game.allow_emergency_positions = True
        result = run_rotation_engine(game, self.make_roster())

        for block in result.timeline:
            self.assertIsNotNone(block["GK"])
            self.assertEqual(len(block["D"]), 4)
            self.assertEqual(len(block["M"]), 4)
            self.assertEqual(len(block["F"]), 2)

    def test_timeline_reports_exact_slots_for_the_formation(self):
        result = run_rotation_engine(self.make_game(), self.make_roster())

        self.assertEqual(
            list(result.timeline[0]["positions"]),
            ["GK", "LB", "LCB", "RCB", "RB", "LM", "LCM", "RCM", "RM", "LF", "RF"],
        )
        self.assertEqual(
            set(result.timeline[0]["positions"].values()),
            {result.timeline[0]["GK"], *result.timeline[0]["D"], *result.timeline[0]["M"], *result.timeline[0]["F"]},
        )

    def test_timeline_uses_formation_specific_slots(self):
        roster = [
            Player("Keeper", "rotational_gk", "GK"),
            Player("Left Wing Back", "core", "D", general_position="D"),
            Player("Center Back", "core", "D", general_position="D"),
            Player("Right Wing Back", "core", "D", general_position="D"),
            Player("Left Midfielder", "core", "M", general_position="M"),
            Player("Center Midfielder", "core", "M", general_position="M"),
            Player("Right Midfielder", "core", "M", general_position="M"),
            Player("Left Striker", "core", "F", general_position="F"),
            Player("Right Striker", "core", "F", general_position="F"),
        ]
        result = run_rotation_engine(Game(1, "3-3-2"), roster)

        self.assertEqual(
            list(result.timeline[0]["positions"]),
            ["GK", "LB", "CB", "RB", "LM", "CM", "RM", "LF", "RF"],
        )

    def test_exact_backup_position_is_preferred_over_general_position(self):
        flexible_defender = Player(
            "Flexible Defender",
            "core",
            "D",
            backup_positions=["RB"],
            general_position="D",
        )
        generic_defender = Player("Generic Defender", "core", "D")

        assignments = assign_exact_slots(
            {
                flexible_defender.name: flexible_defender,
                generic_defender.name: generic_defender,
            },
            [flexible_defender.name, generic_defender.name],
            ["LB", "RB"],
            "D",
        )

        self.assertEqual(assignments["RB"], "Flexible Defender")

    def test_exact_primary_position_is_preferred_over_general_position(self):
        specialist = Player(
            "Right Back Specialist",
            "core",
            general_positions=["D"],
            primary_positions=["RCB"],
        )
        general_defender = Player(
            "General Defender",
            "core",
            general_positions=["D"],
            primary_positions=["D"],
        )

        assignments = assign_exact_slots(
            {
                specialist.name: specialist,
                general_defender.name: general_defender,
            },
            [specialist.name, general_defender.name],
            ["LCB", "RCB"],
            "D",
        )

        self.assertEqual(assignments["RCB"], "Right Back Specialist")

    def test_specific_slot_continuity_is_preferred_for_equal_candidates(self):
        left_player = Player(
            "Left Defender",
            "core",
            general_positions=["D"],
            primary_positions=["D"],
        )
        right_player = Player(
            "Right Defender",
            "core",
            general_positions=["D"],
            primary_positions=["D"],
        )

        assignments = assign_exact_slots(
            {
                left_player.name: left_player,
                right_player.name: right_player,
            },
            [left_player.name, right_player.name],
            ["LCB", "RCB"],
            "D",
            previous_slots={
                left_player.name: "LCB",
                right_player.name: "RCB",
            },
        )

        self.assertEqual(assignments, {
            "LCB": "Left Defender",
            "RCB": "Right Defender",
        })

    def test_players_receive_correct_quota_targets(self):
        roster = self.make_roster()
        run_rotation_engine(self.make_game(), roster)
        core_targets = [player.target_blocks for player in roster if player.group == "core"]
        self.assertEqual(core_targets.count(8), 4)
        self.assertEqual(core_targets.count(7), 4)
        developing_targets = [player.target_blocks for player in roster if player.group == "developing"]
        self.assertEqual(developing_targets.count(5), 2)
        self.assertEqual(developing_targets.count(4), 2)
        rotational_targets = [
            player.target_blocks for player in roster
            if player.group == "rotational" and player.name not in {"Cameron", "Eitan"}
        ]
        self.assertEqual(rotational_targets.count(6), 2)
        self.assertEqual(rotational_targets.count(5), 3)

    def test_players_receive_correct_quota_bounds(self):
        players = [
            Player("Core A", "core_a", "D"),
            Player("Core B", "core_b", "D"),
            Player("Rotational", "rotational", "M"),
            Player("Developing", "developing", "F"),
            Player("Goalkeeper", "rotational_gk", "GK"),
        ]

        game = Game(total_blocks=10, formation="4-4-2")
        game.core_high_names = ["Core A"]
        run_rotation_engine(game, players)

        self.assertEqual((players[0].target_blocks, players[0].minimum_blocks, players[0].maximum_blocks), (8, 7, 8))
        self.assertEqual((players[1].target_blocks, players[1].minimum_blocks, players[1].maximum_blocks), (7, 7, 7))
        self.assertIn((players[2].target_blocks, players[2].minimum_blocks, players[2].maximum_blocks), {(5, 5, 6), (6, 5, 6)})
        self.assertIn((players[3].target_blocks, players[3].minimum_blocks, players[3].maximum_blocks), {(4, 4, 5), (5, 4, 5)})
        self.assertEqual((players[4].target_blocks, players[4].minimum_blocks, players[4].maximum_blocks), (8, 8, 8))

    def test_core_players_reach_seven_block_minimum(self):
        roster = self.make_roster()
        result = run_rotation_engine(self.make_game(), roster)

        self.assertEqual(result.errors, [])
        for player in roster:
            if player.group == "core":
                self.assertGreaterEqual(player.block_count, 5)

    def test_all_available_core_players_start_the_first_block(self):
        roster = [
            Player("Core Defender", "core", "D"),
            Player("Core Midfielder", "core", "M"),
            Player("Core Forward", "core", "F"),
            Player("Keeper", "rotational_gk", "GK"),
            Player("Rotational Defender", "rotational", "D"),
            Player("Rotational Midfielder", "rotational", "M"),
            Player("Rotational Forward", "rotational", "F"),
        ]
        result = run_rotation_engine(
            Game(2, "1-1-1", gk_assignment="Keeper"), roster
        )

        first_block_players = {
            name
            for position in ("D", "M", "F")
            for name in result.timeline[0][position]
        }
        self.assertTrue(
            {"Core Defender", "Core Midfielder", "Core Forward"}
            <= first_block_players
        )

    def test_unavailable_players_do_not_reduce_core_players_below_minimum(self):
        roster = [
            player
            for player in load_roster_from_json(TEST_ROSTER_PATH)
            if player.name not in {"Mahaswin", "Yash"}
        ]
        run_rotation_engine(self.make_game(), roster)

        for player in roster:
            if player.group == "core":
                self.assertGreaterEqual(player.block_count, 5)

    def test_final_block_has_the_most_core_players_in_the_second_half(self):
        roster = [
            player
            for player in load_roster_from_json(TEST_ROSTER_PATH)
            if player.name not in {"Mahaswin", "Yash"}
        ]
        result = run_rotation_engine(self.make_game(), roster)
        core_names = {player.name for player in roster if player.group == "core"}

        second_half_core_counts = []
        for block in result.timeline[5:]:
            field_players = {
                name
                for position in ("D", "M", "F")
                for name in block[position]
            }
            second_half_core_counts.append(len(core_names & field_players))

        self.assertEqual(second_half_core_counts[-1], max(second_half_core_counts))

    def test_final_block_core_priority_does_not_duplicate_players(self):
        roster = [
            player
            for player in load_roster_from_json(TEST_ROSTER_PATH)
            if player.name not in {"Mahaswin", "Yash"}
        ]
        result = run_rotation_engine(self.make_game(), roster)

        for block in result.timeline:
            assigned_names = [
                block["GK"],
                *(name for position in ("D", "M", "F") for name in block[position]),
            ]
            self.assertEqual(len(assigned_names), len(set(assigned_names)))

    def test_invalid_player_group_produces_an_error(self):
        game = Game(total_blocks=10, formation="4-4-2")
        roster = [Player("Test Player", "not_a_real_group", "M")]

        result = run_rotation_engine(game, roster)

        self.assertTrue(any("Unknown group" in error for error in result.errors))

    def test_roster_json_loads_into_players(self):
        roster = load_roster_from_json(TEST_ROSTER_PATH)

        self.assertEqual(len(roster), 19)
        self.assertEqual(roster[0].name, "Max")
        self.assertEqual(roster[0].group, "core")
        self.assertEqual(roster[0].general_position, "F")
        self.assertEqual(roster[0].primary_position, "LF")
        self.assertEqual(roster[12].name, "Cameron")
        self.assertEqual(roster[12].group, "rotational")
        self.assertEqual(roster[12].primary_position, "M")
        self.assertIn("GK", roster[12].primary_positions)
        self.assertEqual(roster[17].name, "Eitan")
        self.assertEqual(roster[17].group, "rotational")
        self.assertEqual(roster[17].primary_position, "D")
        self.assertIn("GK", roster[17].primary_positions)

    def test_two_goalkeepers_share_the_game(self):
        result = run_rotation_engine(self.make_game(), self.make_roster())

        goalkeeper_counts = {
            name: sum(block["GK"] == name for block in result.timeline)
            for name in {block["GK"] for block in result.timeline}
        }
        self.assertEqual(goalkeeper_counts, {"Cameron": 5, "Eitan": 5})

    def test_single_goalkeeper_can_play_all_blocks(self):
        roster = [player for player in self.make_roster() if player.name != "Eitan"]
        result = run_rotation_engine(self.make_game(), roster)

        self.assertEqual(
            [block["GK"] for block in result.timeline],
            ["Cameron"] * 10,
        )

    def test_dual_role_goalkeepers_get_two_to_three_field_blocks(self):
        roster = self.make_roster()
        run_rotation_engine(self.make_game(), roster)

        cameron = next(player for player in roster if player.name == "Cameron")
        eitan = next(player for player in roster if player.name == "Eitan")

        self.assertEqual(cameron.gk_blocks, 5)
        self.assertTrue(2 <= cameron.field_blocks <= 3)
        self.assertEqual(eitan.gk_blocks, 5)
        self.assertTrue(2 <= eitan.field_blocks <= 3)

    def test_missing_goalkeeper_name_uses_automatic_rotation(self):
        result = run_rotation_engine(
            Game(total_blocks=10, formation="4-4-2"),
            load_roster_from_json(TEST_ROSTER_PATH),
        )

        self.assertEqual(
            [block["GK"] for block in result.timeline],
            ["Cameron"] * 5 + ["Eitan"] * 5,
        )

    def test_example_menu_option_runs_json_roster(self):
        from simulator import run_menu

        responses = iter(["2", "", "7"])
        output = StringIO()
        original_input = builtins.input
        builtins.input = lambda prompt="": next(responses)
        try:
            setup = SeasonSetup(
                game_length_minutes=60,
                game_format="11v11",
                total_blocks=10,
                formation="4-4-2",
            )
            with patch("simulator.load_season_setup", return_value=setup):
                with redirect_stdout(output):
                    with patch(
                        "simulator.load_roster_from_json",
                        return_value=load_roster_from_json(TEST_ROSTER_PATH),
                    ):
                        run_menu()
        finally:
            builtins.input = original_input

        self.assertIn("Running example simulation...", output.getvalue())
        self.assertRegex(output.getvalue(), r"Block 1:\n  LF: \S+")
        self.assertIn("RCM: Dane", output.getvalue())
        self.assertIn("LCB: Eitan", output.getvalue())
        self.assertIn("\n  GK: Cameron", output.getvalue())
        self.assertNotIn("\n  D: ", output.getvalue())
        self.assertNotIn("\n  M: ", output.getvalue())
        self.assertNotIn("\n  F: ", output.getvalue())
        self.assertIn("\n  Bench: ", output.getvalue())

    def test_example_menu_uses_saved_season_formation(self):
        from simulator import run_menu

        setup = SeasonSetup(
            game_length_minutes=60,
            game_format="9v9",
            total_blocks=10,
            formation="3-3-2",
        )
        responses = iter(["2", "mahaswin, yash, ryan, thanish, brad", "7"])
        output = StringIO()
        original_input = builtins.input
        builtins.input = lambda prompt="": next(responses)
        try:
            with patch("simulator.load_season_setup", return_value=setup):
                with redirect_stdout(output):
                    with patch(
                        "simulator.load_roster_from_json",
                        return_value=load_roster_from_json(TEST_ROSTER_PATH),
                    ):
                        run_menu()
        finally:
            builtins.input = original_input

        text = output.getvalue()
        self.assertIn("formation 3-3-2", text)
        self.assertNotIn("formation 4-4-2", text)
        self.assertNotIn("M requires 3 players", text)

    def test_unavailable_players_are_removed_from_game_roster(self):
        responses = iter(["Max, eitan"])
        original_input = builtins.input
        builtins.input = lambda prompt="": next(responses)
        try:
            available, unavailable = prompt_unavailable_players(
                load_roster_from_json(TEST_ROSTER_PATH)
            )
        finally:
            builtins.input = original_input

        self.assertNotIn("Max", {player.name for player in available})
        self.assertNotIn("Eitan", {player.name for player in available})
        self.assertEqual(
            {player.name for player in unavailable},
            {"Max", "Eitan"},
        )

    def test_core_high_quota_split_is_balanced_across_season(self):
        high_counts = {player.name: 0 for player in self.make_roster() if player.group == "core"}
        for game_number in range(1, 5):
            roster = self.make_roster()
            game = Game(
                total_blocks=10,
                formation="4-4-2",
                season_total_games=4,
                season_game_number=game_number,
            )
            run_rotation_engine(game, roster)
            for player in roster:
                if player.group == "core" and player.target_blocks == 8:
                    high_counts[player.name] += 1

        self.assertEqual(set(high_counts.values()), {2})

    def test_game_number_rotates_field_player_band_targets(self):
        first_game_roster = self.make_roster()
        second_game_roster = self.make_roster()
        run_rotation_engine(Game(10, "4-4-2", season_game_number=1), first_game_roster)
        run_rotation_engine(Game(10, "4-4-2", season_game_number=2), second_game_roster)

        first_targets = {
            player.name: player.target_blocks
            for player in first_game_roster
            if player.group in {"rotational", "developing"} and "GK" not in player.primary_positions
        }
        second_targets = {
            player.name: player.target_blocks
            for player in second_game_roster
            if player.group in {"rotational", "developing"} and "GK" not in player.primary_positions
        }

        self.assertTrue(any(first_targets[name] != second_targets[name] for name in first_targets))

    def test_game_number_rotates_non_core_starters(self):
        starter_sets = []
        for game_number in (1, 2):
            result = run_rotation_engine(
                Game(10, "4-4-2", season_game_number=game_number),
                self.make_roster(),
            )
            starter_sets.append(set(result.timeline[0]["positions"].values()))

        self.assertNotEqual(starter_sets[0], starter_sets[1])

    def test_unavailable_brad_and_sid_do_not_leave_a_position_empty(self):
        roster = load_roster_from_json(TEST_ROSTER_PATH)
        roster = [player for player in roster if player.name not in {"Brad", "Sid"}]
        game = Game(10, "4-4-2", "Cameron", allow_emergency_positions=True)
        result = run_rotation_engine(game, roster)

        for block in result.timeline:
            self.assertEqual(len(block["D"]), 4)
            self.assertEqual(len(block["M"]), 4)
            self.assertEqual(len(block["F"]), 2)

    def test_unavailable_example_players_keep_every_block_full(self):
        roster = load_roster_from_json(TEST_ROSTER_PATH)
        blake = next(player for player in roster if player.name == "Blake")
        blake.backup_positions = [
            position for position in blake.backup_positions if position != "F"
        ]
        unavailable = {"Mahaswin", "Yash", "Thanish", "Ryan"}
        roster = [player for player in roster if player.name not in unavailable]
        result = run_rotation_engine(Game(10, "4-4-2", "Cameron"), roster)

        self.assertEqual(result.errors, [])
        for block in result.timeline:
            self.assertEqual(len(block["D"]), 4)
            self.assertEqual(len(block["M"]), 4)
            self.assertEqual(len(block["F"]), 2)

    def test_unavailable_example_players_keep_nine_v_nine_full(self):
        roster = load_roster_from_json(TEST_ROSTER_PATH)
        blake = next(player for player in roster if player.name == "Blake")
        blake.backup_positions = [
            position for position in blake.backup_positions if position != "F"
        ]
        unavailable = {"Mahaswin", "Yash", "Thanish", "Ryan"}
        roster = [player for player in roster if player.name not in unavailable]
        result = run_rotation_engine(Game(10, "3-3-2", "Cameron"), roster)

        self.assertEqual(result.errors, [])
        for block in result.timeline:
            self.assertEqual(len(block["D"]), 3)
            self.assertEqual(len(block["M"]), 3)
            self.assertEqual(len(block["F"]), 2)

    def test_three_four_three_keeps_forward_group_covered(self):
        result = run_rotation_engine(
            Game(10, "3-4-3", "Cameron"),
            load_roster_from_json(TEST_ROSTER_PATH),
        )

        self.assertEqual(result.errors, [])
        self.assertTrue(all(len(block["F"]) == 3 for block in result.timeline))

    def test_three_four_three_warns_when_position_has_no_spare_player(self):
        roster = load_roster_from_json(TEST_ROSTER_PATH)
        blake = next(player for player in roster if player.name == "Blake")
        blake.backup_positions = [
            position for position in blake.backup_positions if position != "F"
        ]
        result = run_rotation_engine(
            Game(10, "3-4-3", "Cameron"),
            roster,
        )

        self.assertTrue(any("at least 4 F-eligible players" in warning
                            for warning in result.warnings))
        self.assertEqual(result.errors, [])

    def test_position_warning_does_not_block_schedule(self):
        roster = [
            Player("Keeper", "rotational_gk", "GK"),
            Player("Defender One", "core", "D"),
            Player("Defender Two", "core", "D"),
            Player("Defender Three", "core", "D"),
            Player("Midfielder One", "core", "M"),
            Player("Midfielder Two", "core", "M"),
            Player("Midfielder Three", "core", "M"),
            Player("Forward One", "core", "F"),
            Player("Forward Two", "core", "F"),
            Player("Forward Three", "core", "F"),
        ]

        result = run_rotation_engine(Game(2, "3-3-3", "Keeper"), roster)

        self.assertTrue(result.warnings)
        self.assertEqual(len(result.timeline), 2)

    def test_developing_players_reach_hard_minimum(self):
        roster = self.make_roster()
        run_rotation_engine(self.make_game(), roster)

        for player in roster:
            if player.group == "developing":
                self.assertGreaterEqual(player.block_count, 4)

    def test_most_constrained_position_is_assigned_first(self):
        roster = [
            Player("Defender", "core", "D"),
            Player("Midfielder", "core", "M"),
            Player("Forward One", "core", "F"),
            Player("Forward Two", "core", "F"),
        ]

        order = position_assignment_order(
            {"D": 1, "M": 1, "F": 1},
            roster,
        )

        self.assertEqual(order[0], "D")

    def test_primary_position_has_priority_over_flexible_positions(self):
        defender = Player("Defender", "core", "D")
        forward = Player("Forward", "core", "F")

        self.assertEqual(positional_priority(defender, "D"), 0)
        self.assertEqual(positional_priority(forward, "D", True), 3)

    def test_backup_position_has_priority_over_emergency_position(self):
        backup_forward = Player(
            "Backup Forward",
            "rotational",
            "F",
            backup_positions=["D"],
        )
        emergency_forward = Player("Emergency Forward", "rotational", "F")

        self.assertEqual(positional_priority(backup_forward, "D", True), 2)
        self.assertEqual(positional_priority(emergency_forward, "D", True), 3)

    def test_only_general_and_backup_positions_are_eligible(self):
        midfielder = Player("Midfielder", "rotational", "M", backup_positions=["F"])
        defender = Player("Defender", "rotational", "D")

        self.assertNotIn(midfielder, eligible_players([midfielder], "F"))
        self.assertIn(midfielder, backup_eligible_players([midfielder], "F"))
        self.assertEqual(positional_priority(defender, "F", True), 3)
        self.assertEqual(positional_priority(midfielder, "F"), 2)

    def test_multiple_general_positions_and_exclusions_are_supported(self):
        player = Player(
            "Flexible Player",
            "rotational",
            general_positions=["D", "M"],
            primary_positions=["D"],
            excluded_positions=["F"],
        )

        self.assertIn(player, eligible_players([player], "D"))
        self.assertIn(player, eligible_players([player], "M"))
        self.assertNotIn(player, eligible_players([player], "F"))

    def test_backup_position_is_excluded_until_last_resort(self):
        backup = Player(
            "Backup Midfielder",
            "rotational",
            "M",
            backup_positions="F",
        )

        self.assertNotIn(backup, eligible_players([backup], "F", True))
        self.assertIn(backup, backup_eligible_players([backup], "F"))

    def test_backup_position_fills_only_when_normal_player_cannot_continue(self):
        roster = [
            Player("Keeper", "rotational_gk", "GK"),
            Player("Defender One", "core", "D"),
            Player("Defender Two", "core", "D"),
            Player("Forward", "rotational", "F"),
            Player("Backup Midfielder", "rotational", "M", backup_positions="F"),
        ]

        result = run_rotation_engine(Game(5, "2-0-1", "Keeper"), roster)

        self.assertEqual(result.errors, [])
        self.assertEqual(result.timeline[0]["F"], ["Forward"])
        self.assertEqual(result.timeline[1]["F"], ["Forward"])
        self.assertEqual(result.timeline[3]["F"], ["Forward"])
        self.assertEqual(result.timeline[2]["F"], ["Backup Midfielder"])
        self.assertEqual(result.timeline[4]["F"], ["Forward"])

    def test_backup_fills_three_forward_blocks_each_half(self):
        roster = self.make_roster()
        blake = next(player for player in roster if player.name == "Blake")
        blake.backup_positions = ["F"]
        roster = [
            player for player in roster
            if player.name.casefold() not in {"mahaswin", "yash", "thanish"}
        ]

        result = run_rotation_engine(
            Game(10, "3-4-3", "Cameron"),
            roster,
        )

        blake_forward_blocks = [
            block_number
            for block_number, block in enumerate(result.timeline, start=1)
            if "Blake" in block["F"]
        ]
        self.assertEqual(blake_forward_blocks, [3, 4, 5, 8, 9, 10])
        self.assertTrue(all(len(block["F"]) == 3 for block in result.timeline))
        self.assertEqual(result.errors, [])

    def test_emergency_coverage_fills_empty_slot_and_warns(self):
        roster = [
            Player("Keeper", "rotational_gk", "GK"),
            Player("Defender", "rotational", "D"),
            Player("Midfielder", "rotational", "M"),
            Player("Emergency Player", "rotational", "D"),
        ]

        result = run_rotation_engine(Game(1, "1-1-1", "Keeper"), roster)

        self.assertEqual(result.timeline[0]["F"], ["Emergency Player"])
        self.assertTrue(any(
            "Emergency Player" in warning
            and "F slot ST" in warning
            and "block 1" in warning
            for warning in result.warnings
        ))
        self.assertEqual(result.errors, [])

    def test_forbidden_position_is_not_eligible(self):
        player = Player("Restricted", "rotational", "M", forbidden_positions=["F"])

        self.assertNotIn(player, eligible_players([player], "F"))
        self.assertEqual(positional_priority(player, "F"), 3)

    def test_emergency_positions_are_off_by_default(self):
        defender = Player("Defender", "rotational", "D")

        self.assertNotIn(defender, eligible_players([defender], "F"))
        self.assertIn(defender, eligible_players([defender], "F", True))

    def test_backup_position_can_protect_hard_minimum(self):
        forward = Player("Forward", "core", "F", backup_positions=["M"])
        apply_block_limits(forward, 10)
        forward.block_count = 6

        self.assertEqual(position_minimum_priority(forward, "M"), (-1, 2))

    def test_rotational_players_have_five_block_hard_minimum(self):
        player = Player("Rotational", "rotational", "M")
        apply_block_limits(player, 10)

        self.assertEqual(hard_minimum_priority(player), 5)

    def test_hard_limits_scale_with_block_count(self):
        """A short game must not demand 10-block quotas."""
        core = Player("Core", "core", "M")
        developing = Player("Developing", "developing", "M")
        rotational = Player("Rotational", "rotational", "M")

        for player in (core, developing, rotational):
            apply_block_limits(player, 6)

        # 6 blocks: core 70% -> 4, developing 40% -> 2, rotational 50% -> 3.
        self.assertEqual(core.hard_minimum_blocks, 4)
        self.assertEqual(developing.hard_minimum_blocks, 2)
        self.assertEqual(rotational.hard_minimum_blocks, 3)
        # Nobody may exceed 80% of a 6-block game.
        self.assertEqual(core.hard_maximum_blocks, 5)

    def test_percentage_limits_never_exceed_the_game(self):
        for total_blocks in range(2, 21):
            player = Player("Core", "core", "M")
            apply_block_limits(player, total_blocks)

            self.assertGreaterEqual(player.hard_minimum_blocks, 1)
            self.assertLessEqual(
                player.hard_minimum_blocks, player.hard_maximum_blocks
            )
            self.assertLessEqual(player.hard_maximum_blocks, total_blocks)
            self.assertGreaterEqual(player.max_blocks_per_half, 1)

    def test_position_group_planner_returns_one_plan_per_block(self):
        roster = [
            Player("Forward One", "core", "F"),
            Player("Forward Two", "core", "F"),
            Player("Forward Three", "core", "F"),
            Player("Forward Four", "rotational", "F"),
        ]
        compute_block_targets(Game(10, "4-4-2"), roster)

        plan = plan_position_group("F", 2, 10, roster)

        self.assertEqual(len(plan), 10)
        self.assertTrue(all(len(block) == 2 for block in plan))
        allowed_names = {player.name for player in roster}
        self.assertEqual(sum(len(block) for block in plan), 20)
        self.assertTrue(
            all(player in allowed_names for block in plan for player in block)
        )

    def test_timeline_reports_a_short_position(self):
        roster = [Player("Only Forward", "core", "F")]
        result = run_rotation_engine(Game(10, "4-4-2"), roster)

        self.assertTrue(any("F requires 2 players" in error for error in result.errors))
        self.assertTrue(any("no goalkeeper" in error for error in result.errors))

    def test_group_priority_and_maximum_are_applied(self):
        core = Player("Core", "core", "M")
        developing = Player("Developing", "developing", "M")
        rotational = Player("Rotational", "rotational", "M")
        for player in (core, developing, rotational):
            player.minimum_blocks = 0
            player.maximum_blocks = 6

        self.assertLess(group_priority(core), group_priority(developing))
        self.assertLess(group_priority(developing), group_priority(rotational))

    def test_player_at_maximum_is_ranked_after_player_with_room(self):
        maxed = Player("Maxed", "core", "D")
        available = Player("Available", "rotational", "M")
        maxed.minimum_blocks = maxed.maximum_blocks = 8
        available.minimum_blocks = 5
        available.maximum_blocks = 6
        maxed.block_count = 8
        available.block_count = 4

        self.assertGreater(
            (
                0 if maxed.block_count < maxed.maximum_blocks else 1,
                positional_priority(maxed, "M"),
            ),
            (
                0 if available.block_count < available.maximum_blocks else 1,
                positional_priority(available, "M"),
            ),
        )

    def test_player_who_just_started_is_prioritized_for_second_block(self):
        continuing = Player("Continuing", "rotational", "M")
        benched = Player("Benched", "rotational", "M")
        continuing.last_two = ["bench", "play"]

        self.assertLess(continuity_priority(continuing), continuity_priority(benched))

    def test_field_players_obey_four_per_half_and_eight_total(self):
        roster = self.make_roster()
        run_rotation_engine(self.make_game(), roster)

        for player in roster:
            if player.primary_position != "GK":
                self.assertGreaterEqual(player.block_count, 4)
                self.assertLessEqual(player.block_count, 8)
                self.assertLessEqual(player.blocks_by_half[0], 4)
                self.assertLessEqual(player.blocks_by_half[1], 4)

    def test_goalkeeper_name_matching_ignores_case_and_spaces(self):
        game = Game(total_blocks=10, formation="4-4-2", gk_assignment="  cameron ")
        result = run_rotation_engine(game, self.make_roster() + [
            Player("Jordan", "rotational_gk", "GK")
        ])

        self.assertEqual(result.timeline[0]["GK"], "Cameron")
        self.assertEqual(result.timeline[5]["GK"], "Eitan")

    def test_unavailable_mid_game_removes_player_from_remaining_blocks(self):
        roster = self.make_roster()
        game = self.make_game()
        result = run_rotation_engine(game, roster)
        pulled_player = result.timeline[2]["D"][0]
        original_maximums = {
            player.name: player.maximum_blocks for player in roster
        }

        updated = regenerate_schedule(
            game, roster, result.timeline,
            changes=[(pulled_player, "unavailable", 3)],
        )

        self.assertEqual(updated.timeline[0], result.timeline[0])
        self.assertEqual(updated.timeline[1], result.timeline[1])
        original_block_players = set(
            result.timeline[2]["D"]
            + result.timeline[2]["M"]
            + result.timeline[2]["F"]
        )
        updated_block_players = set(
            updated.timeline[2]["D"]
            + updated.timeline[2]["M"]
            + updated.timeline[2]["F"]
        )
        self.assertNotIn(pulled_player, updated_block_players)
        self.assertEqual(
            len(original_block_players), len(updated_block_players)
        )
        self.assertEqual(
            original_block_players - {pulled_player},
            updated_block_players & original_block_players,
        )
        replacement_names = updated_block_players - original_block_players
        self.assertEqual(len(replacement_names), 1)
        replacement_name = next(iter(replacement_names))
        replacement_player = next(
            player for player in roster if player.name == replacement_name
        )
        self.assertEqual(
            replacement_player.maximum_blocks,
            original_maximums[replacement_name] + 1,
        )
        played_before_replacement = sum(
            pulled_player in (
                block["D"] + block["M"] + block["F"]
            )
            or block["GK"] == pulled_player
            for block in result.timeline[:2]
        )
        self.assertEqual(
            updated.block_counts[pulled_player], played_before_replacement + 1
        )
        for block in updated.timeline[3:]:
            self.assertNotIn(pulled_player, block["D"])
            self.assertNotIn(pulled_player, block["M"])
            self.assertNotIn(pulled_player, block["F"])
            self.assertNotEqual(block["GK"], pulled_player)

    def test_available_again_returns_at_next_block(self):
        roster = self.make_roster()
        game = self.make_game()
        result = run_rotation_engine(game, roster)
        pulled_player = result.timeline[2]["D"][0]

        pulled_out = regenerate_schedule(
            game, roster, result.timeline,
            changes=[(pulled_player, "unavailable", 3)],
        )
        returned = regenerate_schedule(
            game, roster, pulled_out.timeline,
            changes=[(pulled_player, "available", 5)],
        )

        for block in returned.timeline[3:5]:
            self.assertNotIn(pulled_player, block["D"])
            self.assertNotIn(pulled_player, block["M"])
            self.assertNotIn(pulled_player, block["F"])

        appears_again = any(
            pulled_player in block["D"] + block["M"] + block["F"]
            for block in returned.timeline[5:]
        )
        self.assertTrue(appears_again)

        pulled_player_record = next(
            player for player in roster if player.name == pulled_player
        )
        self.assertEqual(pulled_player_record.hard_minimum_blocks, 0)
        self.assertEqual(
            pulled_player_record.hard_maximum_blocks, game.total_blocks
        )
        self.assertEqual(pulled_player_record.minimum_blocks, 0)
        self.assertEqual(
            pulled_player_record.maximum_blocks, game.total_blocks
        )
        self.assertEqual(pulled_player_record.target_blocks, 0)

        expected_bench_count = sum(
            pulled_player in block["bench"]
            for block_number, block in enumerate(returned.timeline, start=1)
            if not 3 <= block_number <= 5
        )
        self.assertEqual(
            pulled_player_record.bench_count, expected_bench_count
        )

    def test_available_block_number_is_independent_of_unavailable_block(self):
        """Marking a player unavailable at block 2 should not force them
        back at block 3; the coach can choose any later return block."""
        roster = self.make_roster()
        game = self.make_game()
        result = run_rotation_engine(game, roster)
        pulled_player = result.timeline[1]["D"][0]

        pulled_out = regenerate_schedule(
            game, roster, result.timeline,
            changes=[(pulled_player, "unavailable", 2)],
        )
        returned = regenerate_schedule(
            game, roster, pulled_out.timeline,
            changes=[(pulled_player, "available", 6)],
        )

        self.assertNotIn(
            pulled_player,
            returned.timeline[1]["D"]
            + returned.timeline[1]["M"]
            + returned.timeline[1]["F"],
        )
        for block in returned.timeline[2:6]:
            self.assertNotIn(pulled_player, block["D"])
            self.assertNotIn(pulled_player, block["M"])
            self.assertNotIn(pulled_player, block["F"])

        appears_again = any(
            pulled_player in block["D"] + block["M"] + block["F"]
            for block in returned.timeline[6:]
        )
        self.assertTrue(appears_again)

        players_by_name = {player.name: player for player in roster}
        self.assertTrue(players_by_name[pulled_player].available)


class SeasonSetupTests(unittest.TestCase):
    def test_11v11_three_four_three_uses_requested_slots(self):
        setup = SeasonSetup(
            game_length_minutes=60,
            game_format="11v11",
            total_blocks=10,
            formation="3-4-3",
        )

        self.assertIsNone(setup.validate_formation())
        self.assertEqual(
            formation_slots(parse_formation("3-4-3")),
            {
                "D": ["LB", "CB", "RB"],
                "M": ["LM", "LCM", "RCM", "RM"],
                "F": ["LF", "CF", "RF"],
            },
        )

    def test_block_count_derives_block_length(self):
        setup = SeasonSetup(
            game_length_minutes=60, game_format="11v11", total_blocks=10
        )

        self.assertEqual(setup.total_blocks, 10)
        self.assertEqual(setup.block_length_minutes, 6)
        self.assertTrue(setup.blocks_divide_evenly)

    def test_block_length_derives_block_count(self):
        setup = SeasonSetup(
            game_length_minutes=60, game_format="11v11", block_length_minutes=6
        )

        self.assertEqual(setup.total_blocks, 10)
        self.assertEqual(setup.block_length_minutes, 6)

    def test_requires_exactly_one_block_setting(self):
        with self.assertRaises(ValueError):
            SeasonSetup(game_length_minutes=60, game_format="11v11")
        with self.assertRaises(ValueError):
            SeasonSetup(
                game_length_minutes=60, game_format="11v11",
                total_blocks=10, block_length_minutes=6,
            )

    def test_rejects_unknown_game_format(self):
        with self.assertRaises(ValueError):
            SeasonSetup(
                game_length_minutes=60, game_format="6v6", total_blocks=10
            )

    def test_each_format_reports_field_players(self):
        expected = {"4v4": 4, "5v5": 4, "7v7": 6, "9v9": 8, "11v11": 10}

        for game_format, field_players in expected.items():
            setup = SeasonSetup(
                game_length_minutes=60, game_format=game_format, total_blocks=10
            )
            self.assertEqual(setup.field_players, field_players)
            self.assertIsNone(setup.validate_formation())

    def test_default_formations_match_every_supported_format(self):
        for game_format in GAME_FORMATS:
            setup = SeasonSetup(
                game_length_minutes=60, game_format=game_format, total_blocks=8
            )
            self.assertIsNone(setup.validate_formation())

    def test_five_v_five_uses_supported_default_formation(self):
        setup = SeasonSetup(
            game_length_minutes=40,
            game_format="5v5",
            total_blocks=8,
        )

        self.assertEqual(setup.formation, "1-2-1")
        self.assertIsNone(setup.validate_formation())

        result = run_rotation_engine(
            Game(total_blocks=1, formation="1-2-1"),
            [
                Player("Defender One", "core", "D"),
                Player("Defender Two", "core", "D"),
                Player("Forward One", "core", "F"),
                Player("Forward Two", "core", "F"),
            ],
        )
        self.assertEqual(len(result.timeline[0]["D"]), 1)
        self.assertEqual(len(result.timeline[0]["M"]), 2)
        self.assertEqual(len(result.timeline[0]["F"]), 1)

    def test_five_v_five_accepts_explicit_three_part_formation(self):
        setup = SeasonSetup(
            game_length_minutes=40,
            game_format="5v5",
            total_blocks=8,
            formation="1-2-1",
        )

        self.assertIsNone(setup.validate_formation())

    def test_formation_must_match_game_format(self):
        setup = SeasonSetup(
            game_length_minutes=60, game_format="7v7",
            total_blocks=10, formation="4-4-2",
        )

        self.assertIn("not available for 7v7", setup.validate_formation())

    def test_uneven_blocks_round_down_and_extend_last_block_of_each_half(self):
        setup = SeasonSetup(
            game_length_minutes=50, game_format="11v11", total_blocks=8
        )

        self.assertEqual(setup.block_length_minutes, 6.0)
        self.assertFalse(setup.blocks_divide_evenly)
        self.assertEqual(setup.extended_block_numbers, [4, 8])
        self.assertEqual(
            setup.block_lengths_minutes,
            [6.0, 6.0, 6.0, 7.0, 6.0, 6.0, 6.0, 7.0],
        )
        self.assertEqual(sum(setup.block_seconds), 50 * 60)

    def test_block_length_rounds_down_to_thirty_seconds(self):
        setup = SeasonSetup(
            game_length_minutes=45, game_format="11v11", total_blocks=7
        )

        # 45/7 = 6:25.7, which rounds down to 6:00.
        self.assertEqual(setup.base_block_seconds, 360)
        self.assertEqual(setup.extended_block_numbers, [4, 7])
        self.assertEqual(sum(setup.block_seconds), 45 * 60)

    def test_block_lengths_always_total_the_game_length(self):
        for game_length in (40, 45, 50, 60, 64, 90):
            for blocks in range(2, 13):
                setup = SeasonSetup(
                    game_length_minutes=game_length,
                    game_format="11v11",
                    total_blocks=blocks,
                )
                self.assertEqual(
                    sum(setup.block_seconds), round(game_length * 60)
                )
                self.assertEqual(setup.base_block_seconds % 30, 0)

    def test_evenly_divided_blocks_are_all_the_same_length(self):
        setup = SeasonSetup(
            game_length_minutes=60, game_format="11v11", total_blocks=10
        )

        self.assertTrue(setup.blocks_divide_evenly)
        self.assertEqual(setup.extended_block_numbers, [])
        self.assertEqual(setup.block_lengths_minutes, [6.0] * 10)

    def test_round_trip_through_dict(self):
        setup = SeasonSetup(
            game_length_minutes=48, game_format="9v9",
            total_blocks=6, total_games=12,
        )

        restored = SeasonSetup.from_dict(setup.to_dict())

        self.assertEqual(restored.game_length_minutes, 48)
        self.assertEqual(restored.game_format, "9v9")
        self.assertEqual(restored.total_blocks, 6)
        self.assertEqual(restored.block_length_minutes, 8)
        self.assertEqual(restored.formation, "3-3-2")
        self.assertEqual(restored.total_games, 12)

    def test_game_from_season_uses_season_settings(self):
        setup = SeasonSetup(
            game_length_minutes=60, game_format="7v7",
            total_blocks=10, total_games=14,
        )

        game = game_from_season(setup, game_number=3, gk_assignment="Cameron")

        self.assertEqual(game.total_blocks, 10)
        self.assertEqual(game.formation, "2-3-1")
        self.assertEqual(game.gk_assignment, "Cameron")
        self.assertEqual(game.season_total_games, 14)
        self.assertEqual(game.season_game_number, 3)


if __name__ == "__main__":
    unittest.main()
