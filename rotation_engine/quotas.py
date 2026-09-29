from rotation_engine.models import RotationResult
import random

# Percentage targets (your system)
CORE_A_TARGET = 0.80
CORE_B_TARGET = 0.70
CORE_MIN = 0.70
ROTATIONAL_MIN = 0.50
ROTATIONAL_MAX = 0.60
DEVELOPMENTAL_MIN = 0.40
DEVELOPMENTAL_MAX = 0.50
GK_TARGET = 0.80

# Absolute ceiling on playing time for any single player in a game.
HARD_MAXIMUM = 0.80

# A dual-role goalkeeper still needs real field time in the half they are
# not in goal, but only a small, bounded amount of it.
GK_FIELD_MINIMUM = 0.20
GK_FIELD_MAXIMUM = 0.30

# Percentage of playing time each group must reach, regardless of how many
# blocks a game is divided into.
GROUP_HARD_MINIMUM = {
    "core": CORE_MIN,
    "core_a": CORE_MIN,
    "core_b": CORE_B_TARGET,
    "rotational": ROTATIONAL_MIN,
    "developing": DEVELOPMENTAL_MIN,
    "developmental": DEVELOPMENTAL_MIN,
}


def rotating_high_names(game, players, group):
    ordered_names = sorted(player.name for player in players)
    if not ordered_names:
        return set()
    randomizer = random.Random(f"{game.season_seed}:{group}")
    randomizer.shuffle(ordered_names)
    high_count = len(ordered_names) // 2
    offset = ((game.season_game_number - 1) * high_count) % len(ordered_names)
    return {
        ordered_names[(offset + index) % len(ordered_names)]
        for index in range(high_count)
    }


def rotating_core_bonus_names(game, players, count):
    totals = getattr(game, "season_player_blocks", {})
    ordered = sorted(
        players,
        key=lambda player: (
            totals.get(player.name, 0),
            random.Random(f"{game.season_seed}:{game.season_game_number}:core:{player.name}").random(),
            player.name,
        ),
    )
    return {player.name for player in ordered[:count]}


def blocks_for_percentage(total_blocks, percentage, minimum=1):
    """Convert a playing-time percentage into a whole number of blocks."""
    return max(minimum, min(total_blocks, round(total_blocks * percentage)))


def apply_block_limits(player, total_blocks):
    """Set the percentage-derived hard limits for one player."""
    player.hard_minimum_blocks = blocks_for_percentage(
        total_blocks, GROUP_HARD_MINIMUM.get(player.group, DEVELOPMENTAL_MIN)
    )
    player.hard_maximum_blocks = blocks_for_percentage(total_blocks, HARD_MAXIMUM)
    # Half the game is the natural cap per half, so a player cannot spend
    # their whole allowance in one half of a short game.
    player.max_blocks_per_half = max(1, -(-player.hard_maximum_blocks // 2))
    player.gk_field_minimum_blocks = blocks_for_percentage(
        total_blocks, GK_FIELD_MINIMUM
    )
    player.gk_field_maximum_blocks = blocks_for_percentage(
        total_blocks, GK_FIELD_MAXIMUM
    )



def compute_block_targets(game, roster):
    """
    Computes initial block targets for each player based on:
    - total blocks (default = 10)
    - player group (core, rotational, developmental, rotational_gk)
    - your percentage system
    """

    result = RotationResult()
    total_blocks = game.total_blocks
    core_players = [
        player for player in roster
        if player.group in {"core", "core_a", "core_b"}
    ]
    rotational_players = [
        player for player in roster
        if player.group == "rotational" and "GK" not in player.primary_positions
    ]
    rotational_high_names = rotating_high_names(game, rotational_players, "rotational")
    developing_players = [
        player for player in roster
        if player.group in {"developmental", "developing"}
    ]
    developing_high_names = rotating_high_names(game, developing_players, "developing")

    formation_parts = game.formation.split("-")
    if len(formation_parts) in {2, 3} and all(
        part.isdigit() for part in formation_parts
    ):
        field_slots = total_blocks * sum(int(part) for part in formation_parts)
        requested_field_slots = 0
    else:
        field_slots = 0
        requested_field_slots = 0

    if len(formation_parts) == 2:
        formation_counts = {
            "D": int(formation_parts[0]),
            "M": 0,
            "F": int(formation_parts[1]),
        }
    elif len(formation_parts) == 3 and all(
        part.isdigit() for part in formation_parts
    ):
        formation_counts = {
            "D": int(formation_parts[0]),
            "M": int(formation_parts[1]),
            "F": int(formation_parts[2]),
        }
    else:
        formation_counts = {}

    group_minimums = {}
    for position in ("D", "M", "F"):
        group_minimums[position] = sum(
            round(total_blocks * (CORE_MIN if player.group in {"core", "core_a", "core_b"} else GROUP_HARD_MINIMUM.get(player.group, DEVELOPMENTAL_MIN)))
            for player in roster
            if position in player.general_positions and "GK" not in player.general_positions
        )
    capacities = {position: formation_counts.get(position, 0) * total_blocks for position in ("D", "M", "F")}
    minimums_feasible = all(group_minimums[position] <= capacities[position] for position in capacities) and sum(group_minimums.values()) <= field_slots
    high_core_names = rotating_core_bonus_names(game, core_players, len(core_players) // 2) if minimums_feasible else set()
    game.core_high_names = sorted(high_core_names)

    # A position needs one spare eligible player to rotate without forcing
    # someone to play every block. This is advisory only; the schedule still
    # runs when the coach chooses to accept the warning.
    for position, required_slots in formation_counts.items():
        if required_slots == 0:
            continue
        eligible_count = sum(
            position in player.general_positions
            or any(
                backup.strip().upper() == position
                or position in {
                    "D" if backup.strip().upper() in {"LB", "LCB", "CB", "RCB", "RB", "LWB", "RWB"}
                    else "M" if backup.strip().upper() in {"LM", "LCM", "CM", "RCM", "RM", "LAM", "CAM", "RAM", "LDM", "CDM", "RDM"}
                    else "F" if backup.strip().upper() in {"LF", "CF", "RF", "LW", "LS", "RS", "RW", "ST"}
                    else backup.strip().upper()
                }
                for backup in player.backup_positions
            )
            for player in roster
            if player.available
        )
        if eligible_count <= required_slots:
            result.warnings.append(
                f"Formation {game.formation} needs at least "
                f"{required_slots + 1} {position}-eligible players to rotate "
                f"without a full-game assignment, but only {eligible_count} "
                f"are available. Players may play without a break."
            )

    for player in roster:
        minimum = maximum = 0

        # The existing "core" group uses the Core A quota.
        if player.group in {"core", "core_a", "core_b"}:
            if player.name in high_core_names:
                target = round(total_blocks * CORE_A_TARGET)
                maximum = target
            else:
                target = round(total_blocks * CORE_MIN)
                maximum = target
            minimum = round(total_blocks * CORE_MIN)

        # Core B
        elif player.group == "core_b":
            target = round(total_blocks * CORE_B_TARGET)
            minimum = maximum = target

        # Rotational GK (special case)
        elif "GK" in player.primary_positions:
            target = round(total_blocks * GK_TARGET)
            minimum = maximum = target

        # Rotational (band)
        elif player.group == "rotational":
            low = round(total_blocks * ROTATIONAL_MIN)
            high = round(total_blocks * ROTATIONAL_MAX)
            target = high if player.name in rotational_high_names else low
            minimum = low
            maximum = high

        # Developmental (band)
        elif player.group in {"developmental", "developing"}:
            low = round(total_blocks * DEVELOPMENTAL_MIN)
            high = round(total_blocks * DEVELOPMENTAL_MAX)
            target = high if player.name in developing_high_names else low
            minimum = low
            maximum = high

        else:
            result.errors.append(f"Unknown group for player {player.name}")
            target = 0

        # Store target using the attribute consumed by the timeline fairness logic.
        if player.name in game.quota_exempt_players:
            target = 0
            minimum = 0
            maximum = total_blocks
        player.target_blocks = target
        player.minimum_blocks = minimum
        bonus = game.replacement_bonuses.get(player.name, 0)
        player.maximum_blocks = maximum + bonus if player.name not in game.quota_exempt_players else total_blocks
        apply_block_limits(player, total_blocks)
        if player.name in game.quota_exempt_players:
            player.hard_minimum_blocks = 0
            player.hard_maximum_blocks = total_blocks
            player.gk_field_minimum_blocks = 0
            player.gk_field_maximum_blocks = total_blocks
        else:
            player.hard_maximum_blocks = min(
                total_blocks, player.hard_maximum_blocks + bonus
            )
        if player.group in {"core", "core_a", "core_b"} and player.name not in game.quota_exempt_players:
            player.hard_maximum_blocks = min(player.hard_maximum_blocks, target)
        player.max_blocks_per_half = max(1, -(-player.hard_maximum_blocks // 2))
        result.block_counts[player.name] = target

        if player.primary_position != "GK" and player.group != "rotational_gk":
            requested_field_slots += target

    if requested_field_slots > field_slots:
        result.warnings.append(
            f"Requested field targets require {requested_field_slots} slots, "
            f"but the formation provides {field_slots}; targets cannot all be met."
        )

    # Metadata for debugging
    result.metadata["total_blocks"] = total_blocks
    result.metadata["method"] = "percentage-based quotas"

    return result
