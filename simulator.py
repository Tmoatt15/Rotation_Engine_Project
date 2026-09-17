import copy
import json

from rotation_engine.models import Game, Player, RotationResult
from rotation_engine.quotas import compute_block_targets
from rotation_engine.season import GAME_FORMATS, SeasonSetup
from rotation_engine.surplus import compute_surplus
from rotation_engine.timeline import build_timeline, eligible_players, replay_timeline

SEASON_FILE = "season.json"
DEFAULT_ROSTER_FILE = "roster.json"
DEFAULT_SEASON_ROSTER_FILE = "season_roster.json"
VALID_PLAYER_GROUPS = {
    "core",
    "core_a",
    "core_b",
    "developing",
    "developmental",
    "rotational",
    "rotational_gk",
}
VALID_GENERAL_POSITIONS = {"GK", "D", "M", "F"}
POSITION_GROUPS = ("GK", "D", "M", "F")


def position_group(position):
    """Map an exact position label to its general position group."""
    position = position.strip().upper()
    if position in POSITION_GROUPS:
        return position
    if position == "GK" or position.endswith("GK"):
        return "GK"
    if position in {"LF", "RF", "CF", "LW", "LS", "RS", "RW", "ST"}:
        return "F"
    if position in {
        "LM", "CM", "RM", "LCM", "RCM",
    }:
        return "M"
    if position in {
        "LB", "CB", "RB", "LCB", "RCB",
        "LWB", "RWB",
    }:
        return "D"
    return None


def roster_position_counts(roster):
    """Count unique players by position tier and general position group."""
    counts = {
        tier: {group: 0 for group in POSITION_GROUPS}
        for tier in ("Primary", "General", "Backup")
    }
    for player in roster:
        tier_positions = {
            "Primary": player.primary_positions,
            "General": player.general_positions,
            "Backup": player.backup_positions,
        }
        for tier, positions in tier_positions.items():
            groups = {position_group(position) for position in positions}
            for group in groups - {None}:
                counts[tier][group] += 1
    return counts


def print_roster_position_counts(roster):
    """Print roster position-group counts for the menu."""
    counts = roster_position_counts(roster)
    print("\nRoster position-group counts")
    print("Specific positions are counted under their general group.")
    for tier in ("Primary", "General", "Backup"):
        print(f"\n{tier} positions:")
        for group in POSITION_GROUPS:
            print(f"  {tier} {group} = {counts[tier][group]}")


def create_roster_from_inputs(player_inputs):
    """Build a roster from the name, group, and general position fields."""
    if not isinstance(player_inputs, list):
        raise ValueError("Player inputs must be a list.")

    roster = []
    names = set()
    for number, player_input in enumerate(player_inputs, start=1):
        if not isinstance(player_input, dict):
            raise ValueError(f"Player {number} must be a record.")

        name = str(player_input.get("name", "")).strip()
        group = str(player_input.get("group", "")).strip().lower()
        general_positions = player_input.get(
            "general_positions", player_input.get("general_position", [])
        )
        if isinstance(general_positions, str):
            general_positions = [general_positions]
        general_positions = [position.strip().upper() for position in general_positions]

        if not name:
            raise ValueError(f"Player {number} needs a name.")
        if name.casefold() in names:
            raise ValueError(f"Player names must be unique: {name}.")
        if group not in VALID_PLAYER_GROUPS:
            raise ValueError(f"Player {number} has an unsupported group: {group}.")
        if not general_positions or any(
            position not in VALID_GENERAL_POSITIONS for position in general_positions
        ):
            raise ValueError(
                f"Player {number} needs general position GK, D, M, or F."
            )

        names.add(name.casefold())
        roster.append(
            Player(
                name=name,
                group=group,
                primary_positions=player_input.get(
                    "primary_positions", general_positions
                ),
                general_positions=general_positions,
                backup_positions=player_input.get("backup_positions", []),
                excluded_positions=player_input.get("excluded_positions", []),
            )
        )

    return roster


def run_rotation_engine(game, roster, start_block=1, frozen_timeline=None):
    """
    Orchestrates the full rotation engine:

    1. Compute block targets (quotas)
    2. Build block-by-block timeline
    3. Compute surplus/deficit and summaries
    4. Return final RotationResult and diagnostics

    start_block and frozen_timeline let you regenerate only the remaining
    part of a game already in progress (see regenerate_schedule below).
    """

    # --- 1. Compute block targets (quotas) -------------------------------
    quota_result = compute_block_targets(game, roster)

    # --- 2. Build timeline -----------------------------------------------
    timeline_result = build_timeline(
        game, roster, start_block=start_block, frozen_timeline=frozen_timeline
    )

    # --- 3. Compute surplus/deficit --------------------------------------
    surplus_data = compute_surplus(game, roster)
    surplus_result = surplus_data["result"]

    # --- 4. Merge timeline + surplus into a single RotationResult --------
    final_result = RotationResult()

    final_result.timeline = timeline_result.timeline
    final_result.block_counts = surplus_result.block_counts
    final_result.gk_summary = surplus_result.gk_summary
    final_result.position_summary = surplus_result.position_summary
    final_result.metadata = surplus_result.metadata
    final_result.warnings = (
        quota_result.warnings
        + timeline_result.warnings
        + surplus_result.warnings
    )
    final_result.errors = (
        quota_result.errors
        + timeline_result.errors
        + surplus_result.errors
    )

    return final_result


def regenerate_schedule(game, roster, previous_timeline, changes):
    """
    Apply mid-game availability changes and regenerate the remaining
    schedule from the earliest affected block onward.

    changes is a list of (player_name, action, block) tuples, where action
    is "unavailable" or "available" and block is the block number that
    change takes effect for that specific player:

        - "unavailable" replaces that player inside block N, while crediting
            them for having played block N, then regenerates from block N + 1.
    - "available" returns that player starting at block + 1 (the rule you
      asked for: marked available in block N returns starting block N+1).
            Once a player has been unavailable, their remaining-game quotas are
            ignored: returning them does not create make-up playing time.

    Each change can use a different block number, so a player marked
    unavailable in block 2 does not have to return until whichever later
    block you specify (e.g. block 7), instead of the very next block.

    previous_timeline is the schedule as generated so far (a list of block
    assignment dicts). Returns the updated RotationResult, with blocks
    before the earliest affected block left unchanged.
    """
    players_by_name = {player.name: player for player in roster}

    earliest_start = game.total_blocks + 1
    updated_timeline = list(previous_timeline)
    for name, action, block in changes:
        player = players_by_name.get(name)
        if player is None:
            continue
        if action == "unavailable":
            if not player.available:
                continue
            if block < 1 or block > len(updated_timeline):
                raise ValueError("Unavailable block must already exist in the timeline.")
            original_block = updated_timeline[block - 1]
            replacement_position = None
            if original_block.get("GK") == player.name:
                replacement_position = "GK"
            else:
                for position in ("D", "M", "F"):
                    if player.name in original_block.get(position, []):
                        replacement_position = position
                        break
            if replacement_position is None:
                raise ValueError(
                    f"{player.name} is not playing in block {block}."
                )

            player.available = False
            game.quota_exempt_players.add(player.name)
            if not any(
                change["player"] == player.name
                and change["action"] == "unavailable"
                and change["block"] == block
                for change in game.availability_changes
            ):
                game.availability_changes.append({
                    "player": player.name,
                    "action": "unavailable",
                    "block": block,
                })
            prefix = updated_timeline[:block - 1]
            replay_timeline(roster, prefix, game)
            compute_block_targets(game, roster)

            assigned_names = {
                original_block.get("GK"),
                *original_block.get("D", []),
                *original_block.get("M", []),
                *original_block.get("F", []),
            }
            bench_names = set(original_block.get("bench", []))
            if replacement_position == "GK":
                candidates = [
                    candidate for candidate in roster
                    if candidate.available
                    and "GK" in candidate.primary_positions
                    and candidate.name not in assigned_names
                ]
            else:
                candidates = [
                    candidate for candidate in eligible_players(
                        roster, replacement_position, game.allow_emergency_positions
                    )
                    if candidate.name not in assigned_names
                ]
            candidates.sort(
                key=lambda candidate: (
                    0 if candidate.name in bench_names else 1,
                    candidate.block_count,
                    max(0, candidate.target_blocks - candidate.block_count),
                    candidate.name,
                )
            )
            if not candidates:
                player.available = True
                raise ValueError(
                    f"No available replacement can cover {replacement_position} "
                    f"in block {block}."
                )

            replacement = candidates[0]
            replacement_block = copy.deepcopy(original_block)
            if replacement_position == "GK":
                replacement_block["GK"] = replacement.name
            else:
                replacement_block[replacement_position].remove(player.name)
                replacement_block[replacement_position].append(replacement.name)
            replacement_block["bench"] = [
                name for name in replacement_block.get("bench", [])
                if name != replacement.name
            ] + [player.name]
            updated_timeline[block - 1] = replacement_block

            credit = {
                "player": player.name,
                "block": block,
                "position": replacement_position,
                "half_index": 0 if block <= (game.total_blocks + 1) // 2 else 1,
            }
            if not any(
                existing["player"] == player.name
                and existing["block"] == block
                for existing in game.replacement_credits
            ):
                game.replacement_credits.append(credit)
                game.replacement_bonuses[replacement.name] = (
                    game.replacement_bonuses.get(replacement.name, 0) + 1
                )
            earliest_start = min(earliest_start, block + 1)
        elif action == "available":
            player.available = True
            game.quota_exempt_players.add(player.name)
            if not any(
                change["player"] == player.name
                and change["action"] == "available"
                and change["block"] == block
                for change in game.availability_changes
            ):
                game.availability_changes.append({
                    "player": player.name,
                    "action": "available",
                    "block": block,
                })
            earliest_start = min(earliest_start, block + 1)

    earliest_start = max(1, min(earliest_start, game.total_blocks + 1))
    frozen_timeline = updated_timeline[:earliest_start - 1]
    replay_timeline(roster, frozen_timeline, game)

    return run_rotation_engine(
        game, roster, start_block=earliest_start, frozen_timeline=frozen_timeline
    )


# ---------------------------------------------------------
# REAL GAME (this is the simulation you want to run)
# ---------------------------------------------------------

game = Game(
    total_blocks=10,
    formation="4-4-2",
    gk_assignment="Cameron",
    allow_emergency_positions=False,
)

def read_positive_int(prompt, default=None):
    """Read a positive whole number from the command line.

    If default is given, pressing Enter with no input returns it.
    """
    while True:
        value = input(prompt).strip()
        if not value and default is not None:
            return default
        try:
            number = int(value)
        except ValueError:
            print("Please enter a whole number.")
            continue

        if number > 0:
            return number
        print("Please enter a number greater than zero.")


def read_positive_number(prompt, default=None):
    """Read a positive number (whole or decimal) from the command line."""
    while True:
        value = input(prompt).strip()
        if not value and default is not None:
            return default
        try:
            number = float(value)
        except ValueError:
            print("Please enter a number.")
            continue

        if number > 0:
            return number
        print("Please enter a number greater than zero.")


def prompt_season_setup():
    """Collect the season-wide settings used to build every game schedule."""
    print("\nSeason Setup")

    game_length = read_positive_number("Game length in total minutes: ")

    formats = ", ".join(GAME_FORMATS)
    while True:
        game_format = input(f"Game format ({formats}): ").strip().lower().replace(" ", "")
        if game_format in GAME_FORMATS:
            break
        print(f"Please choose one of: {formats}.")

    while True:
        choice = input(
            "Set substitution blocks by (b)lock count or block (l)ength? [b/l]: "
        ).strip().casefold()
        if choice in {"b", "block", "blocks", "l", "length"}:
            break
        print("Please enter 'b' or 'l'.")

    total_blocks = block_length = None
    if choice.startswith("b"):
        total_blocks = read_positive_int("Number of substitution blocks: ")
    else:
        block_length = read_positive_number("Length of each block in minutes: ")

    details = GAME_FORMATS[game_format]
    field_players = details["players_on_field"] - (1 if details["has_goalkeeper"] else 0)
    default_formation = details["default_formation"]

    while True:
        formation = input(
            f"Formation for {field_players} field players [{default_formation}]: "
        ).strip() or default_formation
        setup = SeasonSetup(
            game_length_minutes=game_length,
            game_format=game_format,
            total_blocks=total_blocks,
            block_length_minutes=block_length,
            formation=formation,
        )
        error = setup.validate_formation()
        if error is None:
            break
        print(error)

    setup.total_games = read_positive_int("Total games in the season [1]: ", default=1)

    print("\n" + setup.summary())
    return setup


def save_season_setup(setup, file_path=SEASON_FILE):
    """Write the season setup so later games reuse the same settings."""
    with open(file_path, "w", encoding="utf-8") as season_file:
        json.dump(setup.to_dict(), season_file, indent=2)


def load_season_setup(file_path=SEASON_FILE):
    """Load a previously saved season setup, or None if there isn't one."""
    try:
        with open(file_path, encoding="utf-8") as season_file:
            return SeasonSetup.from_dict(json.load(season_file))
    except (OSError, json.JSONDecodeError, KeyError, ValueError):
        return None


def game_from_season(
    setup,
    game_number=1,
    gk_assignment=None,
    first_half_gk=None,
    second_half_gk=None,
    allow_emergency_positions=False,
):
    """Build a Game for one fixture using the saved season settings."""
    return Game(
        total_blocks=setup.total_blocks,
        formation=setup.formation,
        gk_assignment=gk_assignment,
        first_half_gk=first_half_gk,
        second_half_gk=second_half_gk,
        season_total_games=setup.total_games,
        season_game_number=game_number,
        allow_emergency_positions=allow_emergency_positions,
    )


def prompt_custom_game():
    """Collect game settings from the user."""
    total_blocks = read_positive_int("Number of blocks [10]: ", default=10)
    formation = input("Formation [4-4-2]: ").strip() or "4-4-2"
    gk_assignment = input("Goalkeeper name (optional): ").strip() or None
    if gk_assignment is None:
        print("No goalkeeper entered; the engine will rotate available GKs automatically.")
    season_total_games = read_positive_int("Total games in season [1]: ", default=1)
    season_game_number = read_positive_int("This game's number [1]: ", default=1)
    return Game(
        total_blocks=total_blocks,
        formation=formation,
        gk_assignment=gk_assignment,
        season_total_games=season_total_games,
        season_game_number=season_game_number,
        allow_emergency_positions=False,
    )


def prompt_custom_roster():
    """Collect a roster from the user."""
    player_count = read_positive_int("Number of players: ")
    custom_roster = []

    for number in range(1, player_count + 1):
        print(f"\nPlayer {number}")
        name = input("Name: ").strip()
        while not name:
            print("Name cannot be empty.")
            name = input("Name: ").strip()

        group = input("Group (core, developing, rotational, rotational_gk): ").strip()
        while group not in VALID_PLAYER_GROUPS:
            print("Unknown group. Please choose a supported group.")
            group = input("Group: ").strip()

        position = input("Position (GK, D, M, F): ").strip().upper()
        while position not in VALID_GENERAL_POSITIONS:
            print("Unknown position. Please choose GK, D, M, or F.")
            position = input("Position: ").strip().upper()

        custom_roster.append(Player(name, group, position))

    return custom_roster


def load_roster_from_json(
    file_path=DEFAULT_ROSTER_FILE,
    season_roster_path=DEFAULT_SEASON_ROSTER_FILE,
):
    """Combine the team player list with the selected season roster data."""
    with open(file_path, encoding="utf-8") as roster_file:
        team_players = json.load(roster_file)

    if not isinstance(team_players, list):
        raise ValueError("Roster JSON must contain a list of players.")

    # Accept the previous combined format during migration.
    if any(
        key in player
        for player in team_players
        if isinstance(player, dict)
        for key in (
            "group", "general_positions", "primary_positions",
            "backup_positions", "excluded_positions",
        )
    ):
        season_players = team_players
    else:
        with open(season_roster_path, encoding="utf-8") as season_file:
            season_players = json.load(season_file)

    return load_roster_from_data(team_players, season_players)


def load_roster_from_data(team_players, season_players):
    """Build a roster from already-loaded team and season roster data."""
    season_by_name = {
        player["name"].strip().casefold(): player
        for player in season_players
    }
    player_data = []
    for team_player in team_players:
        name = team_player["name"] if isinstance(team_player, dict) else team_player
        details = season_by_name.get(str(name).strip().casefold())
        if details is None:
            raise ValueError(f"No season roster entry found for {name}.")
        player_data.append(details)

    return [
        Player(
            name=player["name"],
            group=player["group"],
            primary_position=player.get("primary_position"),
            general_position=player.get("general_position"),
            primary_positions=player.get("primary_positions"),
            general_positions=player.get("general_positions"),
            forbidden_positions=player.get("forbidden_positions"),
            backup_positions=player.get("backup_positions", []),
            excluded_positions=player.get("excluded_positions", []),
        )
        for player in player_data
    ]


# The default roster is the editable roster file; callers can still pass a
# different path when an alternate roster is explicitly requested.
roster = load_roster_from_json()


def prompt_unavailable_players(roster):
    """Remove players selected as unavailable for the current game."""
    player_by_name = {
        player.name.strip().casefold(): player
        for player in roster
    }

    while True:
        value = input(
            "Players unavailable today (comma-separated, or press Enter for none): "
        ).strip()
        if not value:
            return roster, []

        unavailable = []
        unknown_names = []
        seen_names = set()
        for name in (item.strip() for item in value.split(",")):
            if not name:
                continue
            key = name.casefold()
            if key in seen_names:
                continue
            seen_names.add(key)
            player = player_by_name.get(key)
            if player is None:
                unknown_names.append(name)
            else:
                unavailable.append(player)

        if unknown_names:
            print(f"Unknown player(s): {', '.join(unknown_names)}")
            continue

        unavailable_names = {player.name for player in unavailable}
        available = [
            player for player in roster
            if player.name not in unavailable_names
        ]
        return available, unavailable


def print_result(result):
    """Print a readable simulation summary."""
    def format_position_row(positions, player_names):
        entries = [
            f"{position}: {player_name}"
            for position, player_name in positions.items()
            if player_name in player_names
        ]
        return "    ".join(f"{entry:<18}" for entry in entries).rstrip()

    print("\nTimeline:")
    for number, block in enumerate(result.timeline, start=1):
        print(f"\nBlock {number}:")
        positions = block["positions"]
        for player_names in (block["F"], block["M"], block["D"]):
            row = format_position_row(positions, player_names)
            if row:
                print(f"  {row}")
        print(f"  GK: {positions['GK']}")
        print(f"  Bench: {', '.join(block['bench'])}")

    print("\nBlock counts:")
    for name, count in result.block_counts.items():
        print(f"{name}: {count}")

    print("\nPositions played:")
    for name, usage in result.position_summary.items():
        breakdown = " ".join(
            f"{position} {count} blocks"
            for position, count in usage.items()
            if count > 0
        )
        print(f"{name}: {breakdown or 'no blocks played'}")

    print("\nWarnings:")
    for warning in result.warnings:
        print(f"- {warning}")
    if not result.warnings:
        print("None")

    print("\nErrors:")
    for error in result.errors:
        print(f"- {error}")
    if not result.errors:
        print("None")


def run_live_game(game, roster):
    """Run a game and let the coach mark players unavailable/available
    mid-game, regenerating the remaining schedule after each change."""
    result = run_rotation_engine(game, roster)
    print_result(result)
    player_by_name = {player.name.strip().casefold(): player for player in roster}

    def read_block(prompt):
        while True:
            value = input(prompt).strip()
            try:
                block = int(value)
            except ValueError:
                print("Please enter a whole number.")
                continue
            if 1 <= block <= game.total_blocks:
                return block
            print(f"Block must be between 1 and {game.total_blocks}.")

    while True:
        name_input = input(
            "\nEnter a player name for an availability change, "
            "or press Enter to finish: "
        ).strip()
        if not name_input:
            return result

        player = player_by_name.get(name_input.casefold())
        if player is None:
            print(f"Unknown player: {name_input}")
            continue

        action = input(
            f"Mark {player.name} as (u)navailable or (a)vailable again? [u/a]: "
        ).strip().casefold()
        if action not in {"u", "a", "unavailable", "available"}:
            print("Please enter 'u' or 'a'.")
            continue
        action = "unavailable" if action.startswith("u") else "available"

        if action == "unavailable":
            block = read_block(
                f"After which block is {player.name} unavailable? "
            )
        else:
            block = read_block(
                f"{player.name} was marked available again as of which block? "
                f"(they will return starting the next block): "
            )

        result = regenerate_schedule(
            game, roster, result.timeline,
            changes=[(player.name, action, block)],
        )
        print("\nUpdated schedule:")
        print_result(result)


def run_menu():
    """Run the command-line menu until the user chooses to quit."""
    while True:
        season = load_season_setup()
        print("\nSoccer Rotation Engine")
        if season is None:
            print("No season setup saved yet - choose option 1 to create one.")
        else:
            print(
                f"Season: {season.game_format}, {season.game_length_minutes} min, "
                f"{season.total_blocks} blocks of {season.block_length_minutes} min, "
                f"formation {season.formation}"
            )
        print("1. Season setup")
        print("2. Run the example roster")
        print("3. Enter a custom game and roster")
        print("4. Load roster.json")
        print("5. Live game (mid-game availability changes)")
        print("6. Show roster position counts")
        print("7. Quit")
        choice = input("Choose an option: ").strip()

        if choice == "1":
            setup = prompt_season_setup()
            save_season_setup(setup)
            print(f"\nSaved to {SEASON_FILE}.")
        elif choice == "2":
            try:
                print("Running example simulation...")
                available_roster, unavailable = prompt_unavailable_players(
                    load_roster_from_json()
                )
                if unavailable:
                    print("Unavailable: " + ", ".join(player.name for player in unavailable))
                example_game = (
                    game_from_season(
                        season,
                        gk_assignment="Cameron",
                        allow_emergency_positions=False,
                    )
                    if season is not None
                    else game
                )
                print_result(run_rotation_engine(example_game, available_roster))
            except (OSError, json.JSONDecodeError, KeyError, ValueError) as error:
                print(f"Unable to load roster.json: {error}")
        elif choice == "3":
            custom_game = prompt_custom_game()
            custom_roster = prompt_custom_roster()
            print_result(run_rotation_engine(custom_game, custom_roster))
        elif choice == "4":
            try:
                json_roster = load_roster_from_json()
                json_game = prompt_custom_game()
                available_roster, unavailable = prompt_unavailable_players(json_roster)
                if json_game.gk_assignment and not any(
                    player.name.strip().casefold() == json_game.gk_assignment.strip().casefold()
                    for player in available_roster
                ):
                    print(f"Warning: '{json_game.gk_assignment}' was not found in roster.json.")
                if unavailable:
                    print("Unavailable: " + ", ".join(player.name for player in unavailable))
                print("Running simulation...")
                print_result(run_rotation_engine(json_game, available_roster))
            except (OSError, json.JSONDecodeError, KeyError, ValueError) as error:
                print(f"Unable to load roster.json: {error}")
        elif choice == "5":
            try:
                json_roster = load_roster_from_json()
                json_game = prompt_custom_game()
                available_roster, unavailable = prompt_unavailable_players(json_roster)
                if unavailable:
                    print("Unavailable: " + ", ".join(player.name for player in unavailable))
                run_live_game(json_game, available_roster)
            except (OSError, json.JSONDecodeError, KeyError, ValueError) as error:
                print(f"Unable to load roster.json: {error}")
        elif choice == "6":
            try:
                print_roster_position_counts(load_roster_from_json())
            except (OSError, json.JSONDecodeError, KeyError, ValueError) as error:
                print(f"Unable to load roster.json: {error}")
        elif choice == "7":
            print("Goodbye.")
            return
        else:
            print("Please choose 1, 2, 3, 4, 5, 6, or 7.")


if __name__ == "__main__":
    run_menu()


