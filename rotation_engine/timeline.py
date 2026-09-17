
from itertools import combinations

from rotation_engine.models import RotationResult
from rotation_engine.positional import is_emergency_allowed, positional_tiers_for

POSITION_GROUP_BY_SLOT = {
    "LF": "F", "CF": "F", "RF": "F", "LW": "F", "LS": "F", "RS": "F", "RW": "F", "ST": "F",
    "LM": "M", "LCM": "M", "CM": "M", "RCM": "M", "RM": "M", "LAM": "M", "CAM": "M", "RAM": "M", "LDM": "M", "CDM": "M", "RDM": "M",
    "LB": "D", "LCB": "D", "CB": "D", "RCB": "D", "RB": "D", "LWB": "D", "RWB": "D",
}


def backup_covers_position(player, position):
    """Return whether Backup covers a group or an exact field slot."""
    requested = position.strip().upper()
    requested_group = POSITION_GROUP_BY_SLOT.get(requested, requested)
    return any(
        backup.strip().upper() == requested
        or (
            backup.strip().upper() in {"D", "M", "F"}
            and backup.strip().upper() == requested_group
        )
        for backup in player.backup_positions
    )


def parse_formation(formation_str):
    """
    Converts a formation string like "2-3-2" or "2-2" into a dict:
    {"D": 2, "M": 3, "F": 2}

    The two-part form is the small-sided D-F shorthand used by 5v5.
    """
    parts = formation_str.split("-")
    if formation_str == "2-1-2-1":
        return {"D": 2, "M": 3, "F": 1, "_shape": formation_str}
    if formation_str == "4-2-3-1":
        return {"D": 4, "M": 5, "F": 1, "_shape": formation_str}
    if len(parts) == 2:
        return {"D": int(parts[0]), "M": 0, "F": int(parts[1])}
    if len(parts) != 3:
        raise ValueError("Formation must be in format 'D-M-F' or 'D-F'")

    return {
        "D": int(parts[0]),
        "M": int(parts[1]),
        "F": int(parts[2]),
    }


def formation_slots(formation):
    """Return the exact field slots for a D-M-F formation."""
    if formation.get("_shape") == "2-1-2-1":
        return {
            "D": ["LB", "RB"],
            "M": ["CDM", "LM", "RM"],
            "F": ["F"],
        }
    if formation.get("_shape") == "4-2-3-1":
        return {
            "D": ["LB", "LCB", "RCB", "RB"],
            "M": ["LAM", "CAM", "RAM", "LDM", "RDM"],
            "F": ["F"],
        }

    slot_names = {
        "D": {
            1: ["CB"],
            2: ["LB", "RB"],
            3: ["LB", "CB", "RB"],
            4: ["LB", "LCB", "RCB", "RB"],
            5: ["LWB", "LCB", "CB", "RCB", "RWB"],
        },
        "M": {
            1: ["CM"],
            2: ["LCM", "RCM"],
            3: ["LM", "CM", "RM"],
            4: ["LM", "LCM", "RCM", "RM"],
            5: ["LM", "LCM", "CM", "RCM", "RM"],
        },
        "F": {
            1: ["ST"],
            2: ["LF", "RF"],
            3: ["LF", "CF", "RF"],
            4: ["LW", "LS", "RS", "RW"],
        },
    }
    return {
        group: slot_names[group].get(
            count, [f"{group}{number}" for number in range(1, count + 1)]
        )
        for group, count in formation.items()
        if group in slot_names
    }


def rotating_starter_names(game, roster):
    starter_names = set()
    player_groups = (
        {"rotational"},
        {"developmental", "developing"},
    )
    for groups in player_groups:
        candidates = sorted(
            player.name
            for player in roster
            if player.group in groups and "GK" not in player.primary_positions
        )
        if candidates:
            starter_names.add(candidates[(game.season_game_number - 1) % len(candidates)])
    return starter_names


def assign_exact_slots(
    players_by_name,
    player_names,
    slots,
    general_position,
    previous_slots=None,
):
    """Assign players to slots, preferring suitability and prior continuity."""
    remaining_players = [players_by_name[name] for name in player_names]
    assignments = {}
    previous_slots = previous_slots or {}

    def position_priority(player, slot):
        primary_positions = set(player.primary_positions)
        general_positions = set(player.general_positions)
        if slot in primary_positions:
            return 0
        if backup_covers_position(player, slot):
            return 1
        if general_position in general_positions:
            return 2
        return 3

    # Allocate exact-position slots before general fallback slots so a
    # specialist is not consumed by a slot that any player can fill.
    ordered_slots = sorted(
        slots,
        key=lambda slot: -sum(
            position_priority(player, slot) < 2
            for player in remaining_players
        ),
    )
    for slot in ordered_slots:
        if not remaining_players:
            assignments[slot] = "UNASSIGNED"
            continue
        player = min(
            remaining_players,
            key=lambda candidate: (
                position_priority(candidate, slot),
                0 if previous_slots.get(candidate.name) == slot else 1,
                candidate.name,
            ),
        )
        assignments[slot] = player.name
        remaining_players.remove(player)

    return {slot: assignments.get(slot, "UNASSIGNED") for slot in slots}


def choose_gk(game, roster, block_num):
    """
    Determines which GK plays this block using half‑game logic.
    Priority:
    1. Explicit assignment (game.gk_assignment)
    2. Primary GK (primary_position == "GK")
    3. Rotational GK (group == "rotational_gk")
    4. Field player emergency GK (only if allowed)
    """

    # Keep one goalkeeper in goal for each full half of the game.
    goalkeepers = [p for p in roster if p.available and "GK" in p.primary_positions]

    if goalkeepers:
        half_length = (game.total_blocks + 1) // 2
        half_index = 0 if block_num <= half_length else 1
        requested_assignment = (
            game.first_half_gk if half_index == 0 else game.second_half_gk
        )
        if requested_assignment:
            requested_name = requested_assignment.strip().casefold()
            requested_goalkeeper = next(
                (
                    player
                    for player in goalkeepers
                    if player.name.strip().casefold() == requested_name
                ),
                None,
            )
            if requested_goalkeeper is not None:
                return requested_goalkeeper

        if len(goalkeepers) == 1:
            return goalkeepers[0]

        if half_index < len(goalkeepers):
            return goalkeepers[half_index]

        return goalkeepers[0]

    # --- Emergency GK fallback --------------------------------------------
    if not game.allow_emergency_positions:
        return None

    emergency_candidates = [
        p for p in roster
        if p.available and p.primary_position != "GK" and p.position_usage["GK"] == 0
    ]

    if emergency_candidates:
        emergency_candidates.sort(key=lambda p: p.block_count)
        return emergency_candidates[0]

    return None



def eligible_players(roster, position, allow_emergency=False):
    """
    Returns players in the normal pool for a position group, plus emergency
    candidates when explicitly enabled.
    """

    primary, _, emergency = positional_tiers_for(position)
    eligible = []

    for player in roster:
        if not player.available:
            continue

        forbidden = {
            forbidden_position.strip().upper()
            for forbidden_position in player.forbidden_positions
        }
        if position.upper() in forbidden:
            continue

        if position.upper() in {
            backup.strip().upper()
            for backup in player.backup_positions
        }:
            continue

        general_positions = set(player.general_positions)

        # --- Primary position match ---------------------------------------
        if general_positions.intersection(primary):
            eligible.append(player)
            continue

        # --- Emergency position match -------------------------------------
        if (
            allow_emergency
            and general_positions.intersection(emergency)
            and is_emergency_allowed(player, position)
        ):
            eligible.append(player)
            continue

    return eligible


def backup_eligible_players(roster, position):
    """Return players explicitly marked as backup coverage."""
    eligible = []
    for player in roster:
        if not player.available:
            continue
        forbidden = {
            forbidden_position.strip().upper()
            for forbidden_position in player.forbidden_positions
        }
        if backup_covers_position(player, position) and position.upper() not in forbidden:
            eligible.append(player)
    return eligible


def emergency_eligible_players(roster, position):
    """Return players who can cover a position only as emergency coverage."""
    _, _, emergency = positional_tiers_for(position)
    eligible = []
    for player in roster:
        if not player.available:
            continue
        forbidden = {
            forbidden_position.strip().upper()
            for forbidden_position in player.forbidden_positions
        }
        if position.upper() in forbidden:
            continue
        if backup_covers_position(player, position):
            continue
        if (
            set(player.general_positions).intersection(emergency)
            and is_emergency_allowed(player, position)
        ):
            eligible.append(player)
    return eligible


def positional_priority(player, position, allow_emergency=False):
    """Return priority for normal, backup, and emergency positional fit."""
    forbidden = {
        forbidden_position.strip().upper()
        for forbidden_position in player.forbidden_positions
    }
    if position.upper() in forbidden:
        return 3

    primary, _, emergency = positional_tiers_for(position)
    if set(player.general_positions).intersection(primary):
        return 0
    if backup_covers_position(player, position):
        return 2
    if (
        allow_emergency
        and
        set(player.primary_positions).intersection(emergency)
        and is_emergency_allowed(player, position)
    ):
        return 3
    return 3


def group_priority(player):
    """Return the assignment order for non-goalkeeper player groups."""
    return {
        "core": 0,
        "core_a": 0,
        "core_b": 1,
        "developing": 2,
        "developmental": 2,
        "rotational": 3,
    }.get(player.group, 4)


def hard_minimum_priority(player):
    """Return the hard minimum blocks for a field player.

    Set from playing-time percentages by compute_block_targets, so the
    same rules scale to any game length or number of blocks.
    """
    return player.hard_minimum_blocks


# When capacity is short, developing players give up field blocks twice as
# readily as rotational players, so rotational keeps more consistent time.
GROUP_URGENCY_WEIGHT = {
    "developing": 0.5,
    "developmental": 0.5,
    "rotational": 1.0,
}


def is_dual_role_goalkeeper(player):
    """Return True for a field player who can also cover goalkeeper."""
    return "GK" in player.primary_positions


def field_hard_minimum(player):
    """Return the hard minimum FIELD blocks required for a player."""
    if is_dual_role_goalkeeper(player):
        return player.gk_field_minimum_blocks
    return hard_minimum_priority(player)


def group_urgency_weight(player):
    """Return how urgently a non-core group's remaining need is treated."""
    if is_dual_role_goalkeeper(player):
        return 2.0
    return GROUP_URGENCY_WEIGHT.get(player.group, 1.0)


def continuity_priority(player):
    """Prefer a player continuing a one-block stint for the next block."""
    if player.last_two[-1:] == ["play"] and player.last_two[-2:] != ["play", "play"]:
        return 0
    return 1


def position_minimum_priority(player, position, allow_emergency=False):
    """Return the hard-minimum deficit and current position priority."""
    deficit = max(0, hard_minimum_priority(player) - player.block_count)
    tier = positional_priority(player, position, allow_emergency)
    return (-deficit, tier)


def plan_position_group(
    position,
    slots_per_block,
    total_blocks,
    roster,
    allow_emergency=False,
):
    """Plan one position group across the entire game.

    Returns a list of player-name lists, one list for each block. The planner
    prefers hard-minimum deficits, then primary/backup positional fit, and
    finally continuity and quota fairness.
    """
    if position not in {"D", "M", "F"}:
        raise ValueError("Position group must be D, M, or F.")
    if slots_per_block < 1 or total_blocks < 1:
        raise ValueError("slots_per_block and total_blocks must be positive.")

    candidates = eligible_players(roster, position, allow_emergency)
    counts = {player.name: player.block_count for player in candidates}
    half_counts = {
        player.name: list(player.blocks_by_half)
        for player in candidates
    }
    previous_players = set()
    plan = []
    half_length = (total_blocks + 1) // 2

    for block_number in range(1, total_blocks + 1):
        half_index = 0 if block_number <= half_length else 1
        available = [
            player for player in candidates
            if counts[player.name] < player.hard_maximum_blocks
            and half_counts[player.name][half_index] < player.max_blocks_per_half
        ]

        if len(available) < slots_per_block and allow_emergency:
            available = [
                player for player in candidates
                if counts[player.name] < player.hard_maximum_blocks
                and player not in available
            ]

        def planning_key(player):
            minimum = hard_minimum_priority(player)
            deficit = max(0, minimum - counts[player.name])
            target_deficit = max(0, player.target_blocks - counts[player.name])
            return (
                -deficit,
                positional_priority(player, position, allow_emergency),
                -target_deficit,
                0 if player in previous_players else 1,
                counts[player.name],
                player.name,
            )

        available.sort(key=planning_key)
        chosen = available[:slots_per_block]
        block_plan = [player.name for player in chosen]
        plan.append(block_plan)

        previous_players = set(chosen)
        for player in chosen:
            counts[player.name] += 1
            half_counts[player.name][half_index] += 1

    return plan


def plan_position_groups(
    game,
    formation,
    roster,
    goalkeeper_names,
    start_block_index=0,
    emergency_assignments=None,
):
    """Plan all field groups together while reserving each block's players.

    Blocks before start_block_index are left untouched (already played), so
    this can also regenerate only the remaining part of a game in progress.
    """
    positions = ["D", "M", "F"]
    reserved = [set([name]) for name in goalkeeper_names]
    rotating_starters = rotating_starter_names(game, roster)

    # Raw counts include every block played (GK or field) and enforce each
    # player's hard maximum blocks for the whole game.
    raw_counts = {player.name: player.block_count for player in roster}
    for goalkeeper_name in goalkeeper_names:
        if goalkeeper_name in raw_counts:
            raw_counts[goalkeeper_name] += 1

    field_counts = {player.name: player.block_count for player in roster}

    half_counts = {
        player.name: list(player.blocks_by_half)
        for player in roster
    }
    plans = {position: [[] for _ in range(game.total_blocks)] for position in positions}
    players_by_name = {player.name: player for player in roster}
    backup_blocks = {position: {} for position in positions}

    half_length = (game.total_blocks + 1) // 2
    half_lengths = [half_length, game.total_blocks - half_length]
    gk_field_percentages = {
        "core": 0.80,
        "core_a": 0.80,
        "core_b": 0.80,
        "rotational": 0.60,
        "developing": 0.40,
        "developmental": 0.40,
    }
    for player in roster:
        player.gk_field_targets_by_half = [0, 0]
    for half_index in (0, 1):
        half_start = 0 if half_index == 0 else half_length
        half_end = half_start + half_lengths[half_index]
        half_goalkeepers = set(goalkeeper_names[half_start:half_end])
        other_half = 1 - half_index
        for player in roster:
            if player.name in half_goalkeepers and player.group in gk_field_percentages:
                player.gk_field_targets_by_half[other_half] = round(
                    half_lengths[other_half] * gk_field_percentages[player.group]
                )
    for player in roster:
        target_field_blocks = max(player.gk_field_targets_by_half)
        if target_field_blocks:
            goalkeeper_blocks = sum(
                goalkeeper_name == player.name for goalkeeper_name in goalkeeper_names
            )
            player.gk_field_maximum_blocks = max(
                player.gk_field_maximum_blocks,
                target_field_blocks,
            )
            player.hard_maximum_blocks = max(
                player.hard_maximum_blocks,
                goalkeeper_blocks + target_field_blocks,
            )

    def position_key(position):
        normal_candidates = [
            player for player in eligible_players(
                roster, position, game.allow_emergency_positions
            )
            if positional_priority(
                player, position, game.allow_emergency_positions
            ) < 2
        ]
        return len(normal_candidates), positions.index(position)

    def tier_and_urgency(player, half_index):
        is_core = player.group in {"core", "core_a", "core_b"}
        is_gk = is_dual_role_goalkeeper(player)
        reserved_core = (
            core_reserved_by_player[player.name]
            if is_core and formation == {"D": 4, "M": 4, "F": 2}
            else 0
        )
        planned_count = field_counts[player.name] + reserved_core
        deficit = field_hard_minimum(player) - planned_count

        # Nobody's hard minimum is ever skipped. Core is filled first, then
        # a dual-role goalkeeper's small floor (it only has one half's worth
        # of blocks to land in), then everyone else's hard minimum equally.
        if deficit > 0:
            if is_core:
                return 0, -deficit
            if is_gk:
                return 1, -deficit
            return 2, -deficit

        gk_field_deficit = max(
            0,
            player.gk_field_targets_by_half[half_index]
            - half_counts[player.name][half_index],
        )
        if gk_field_deficit > 0:
            return 3, -gk_field_deficit

        # Once every hard minimum is met, developing gives up its remaining
        # soft target twice as readily as rotational (see GROUP_URGENCY_WEIGHT).
        target = player.gk_field_maximum_blocks if is_gk else player.target_blocks
        target_deficit = max(0, target - planned_count)
        if target_deficit > 0:
            return 4, -target_deficit * group_urgency_weight(player)
        return 5, 0

    def is_usable(player, position, reserved_names, half_index):
        return (
            player.name not in reserved_names
            and raw_counts[player.name] < player.hard_maximum_blocks
            and half_counts[player.name][half_index] < player.max_blocks_per_half
            and not (
                is_dual_role_goalkeeper(player)
                and field_counts[player.name] >= player.gk_field_maximum_blocks
            )
        )

    def player_general_groups(player):
        return {
            group
            for position_name in player.general_positions
            for group in (
                position_name
                if position_name in {"D", "M", "F"}
                else None,
            )
            if group is not None
        }

    # Build a core-player skeleton before filling the rest of the roster.
    # Core appearances are spread across both halves, then the normal planner
    # fills remaining slots with developing and rotational players.
    core_blocks = {position: {} for position in positions}
    core_reserved_by_player = {player.name: 0 for player in roster}
    odd_core_players = sorted(
        (
            player for player in roster
            if (
                player.group in {"core", "core_a", "core_b"}
                and player.target_blocks % 2
            )
        ),
        key=lambda player: (not player.backup_positions, player.name),
    )
    odd_core_order = {
        player.name: index
        for index, player in enumerate(odd_core_players)
    }
    half_length = (game.total_blocks + 1) // 2
    for position in sorted(positions, key=position_key):
        needed = formation[position]
        if not needed:
            continue
        core_candidates = [
            player for player in eligible_players(
                roster, position, game.allow_emergency_positions
            )
            if player.group in {"core", "core_a", "core_b"}
        ]
        for player in sorted(
            core_candidates,
            key=lambda item: (
                sum(
                    item in eligible_players(
                        roster, other_position,
                        game.allow_emergency_positions,
                    )
                    for other_position in positions
                ),
                positional_priority(
                    item, position, game.allow_emergency_positions
                ),
                item.name,
            ),
        ):
            remaining_target = max(
                0,
                min(player.target_blocks, player.hard_maximum_blocks)
                - field_counts[player.name],
            )
            remaining_target -= core_reserved_by_player[player.name]
            if not remaining_target:
                continue
            half_indices = (
                [
                    index for index in range(game.total_blocks)
                    if start_block_index <= index < half_length
                ],
                [
                    index for index in range(game.total_blocks)
                    if start_block_index <= index >= half_length
                ],
            )
            total_target = max(
                0,
                min(player.target_blocks, player.hard_maximum_blocks),
            )
            first_half_target = total_target // 2
            if (
                formation == {"D": 4, "M": 4, "F": 2}
                and total_target % 2
                and odd_core_order[player.name] % 2 == 1
            ):
                first_half_target += 1
            elif formation != {"D": 4, "M": 4, "F": 2} and total_target % 2:
                first_half_target += 1
            half_targets = (first_half_target, total_target - first_half_target)
            for half_index, block_indices in enumerate(half_indices):
                if not block_indices or not remaining_target:
                    continue
                half_capacity = max(
                    0,
                    player.max_blocks_per_half
                    - half_counts[player.name][half_index],
                )
                appearances = min(
                    half_capacity,
                    remaining_target,
                    max(0, half_targets[half_index] - half_counts[player.name][half_index]),
                )
                for block_index in sorted(
                    block_indices,
                    key=lambda index: (
                        len(core_blocks[position].get(index, [])),
                        index,
                    ),
                ):
                    if appearances <= 0:
                        break
                    occupied = {
                        name
                        for planned in core_blocks.values()
                        for name in planned.get(block_index, [])
                    }
                    if player.name in occupied:
                        continue
                    if len(core_blocks[position].get(block_index, [])) >= needed:
                        continue
                    core_blocks[position].setdefault(block_index, []).append(
                        player.name
                    )
                    core_reserved_by_player[player.name] += 1
                    remaining_target -= 1
                    appearances -= 1

    for position in positions:
        for block_index in range(start_block_index, game.total_blocks):
            core_blocks[position].setdefault(block_index, [])

    # Pre-plan backup appearances for groups whose normal players cannot cover
    # every slot in a half within their rotation limits. This also lets the
    # constrained group reserve its backup before another group selects them.
    for position in positions:
        needed = formation[position]
        if not needed:
            continue
        normal_candidates = eligible_players(
            roster, position, game.allow_emergency_positions
        )
        backup_candidates = backup_eligible_players(roster, position)
        if not backup_candidates:
            continue
        half_length = (game.total_blocks + 1) // 2
        for half_index, block_indices in enumerate((
            [
                index for index in range(game.total_blocks)
                if index < half_length and index >= start_block_index
            ],
            [
                index for index in range(game.total_blocks)
                if index >= half_length and index >= start_block_index
            ],
        )):
            if not block_indices:
                continue
            normal_capacity = sum(
                min(
                    player.max_blocks_per_half,
                    player.hard_maximum_blocks - raw_counts[player.name],
                )
                for player in normal_candidates
            )
            required_backup_slots = max(
                0, needed * len(block_indices) - normal_capacity
            )
            if not required_backup_slots:
                continue
            capacity = {
                player.name: min(
                    player.max_blocks_per_half,
                    player.hard_maximum_blocks - raw_counts[player.name],
                )
                for player in backup_candidates
            }
            slot_number = 0
            for player in sorted(backup_candidates, key=lambda item: item.name):
                for _ in range(min(capacity[player.name], required_backup_slots)):
                    block_index = block_indices[
                        -1 - (slot_number % len(block_indices))
                    ]
                    backup_blocks[position].setdefault(block_index, []).append(
                        player.name
                    )
                    slot_number += 1
                    required_backup_slots -= 1
                    if not required_backup_slots:
                        break
                if not required_backup_slots:
                    break

    for position in sorted(positions, key=position_key):
        # Keep emergency coverage out of the normal pool. Declared backups
        # are intentional coverage and must be exhausted before emergencies.
        normal_candidates = eligible_players(roster, position, False)
        backup_candidates = backup_eligible_players(roster, position)
        emergency_candidates = (
            emergency_eligible_players(roster, position)
            if game.allow_emergency_positions
            else []
        )
        candidates = normal_candidates + [
            player for player in backup_candidates
            if player not in normal_candidates
        ] + [
            player for player in emergency_candidates
            if player not in normal_candidates and player not in backup_candidates
        ]
        previous_players = set()

        # If a position's primary-fit players cannot cover every block in a
        # half on their own, spread the required backup appearances over
        # different blocks (each resting a different primary) instead of
        # letting every primary run out of half capacity on the same block.
        primary_candidates = [
            player for player in candidates
            if positional_priority(
                player, position, game.allow_emergency_positions
            ) == 0
        ]
        backup_candidates_for_rotation = [
            player for player in candidates
            if positional_priority(
                player, position, game.allow_emergency_positions
            ) == 2
        ]
        forced_rest = {}
        if primary_candidates and backup_candidates_for_rotation:
            half_length = (game.total_blocks + 1) // 2
            half_block_indices = [
                [
                    i for i in range(game.total_blocks)
                    if i < half_length and i >= start_block_index
                ],
                [
                    i for i in range(game.total_blocks)
                    if i >= half_length and i >= start_block_index
                ],
            ]
            needed = formation[position]
            for block_indices in half_block_indices:
                if not block_indices:
                    continue
                primary_capacity = sum(
                    min(
                        player.max_blocks_per_half,
                        player.hard_maximum_blocks - raw_counts[player.name],
                    )
                    for player in primary_candidates
                )
                shortfall = max(
                    0, needed * len(block_indices) - primary_capacity
                )
                for rest_number in range(shortfall):
                    resting_player = primary_candidates[
                        rest_number % len(primary_candidates)
                    ]
                    rest_block = block_indices[-1 - (rest_number % len(block_indices))]
                    forced_rest.setdefault(rest_block, set()).add(
                        resting_player.name
                    )

        for block_index in range(start_block_index, game.total_blocks):
            half_index = 0 if block_index < (game.total_blocks + 1) // 2 else 1
            is_initial_block = block_index == 0 and start_block_index == 0
            planned_backup_names = set(
                backup_blocks[position].get(block_index, [])
            )
            normal_available = [
                player for player in normal_candidates
                if is_usable(player, position, reserved[block_index], half_index)
            ]
            backup_available = [
                player for player in backup_candidates
                if player.name in planned_backup_names
                and is_usable(player, position, reserved[block_index], half_index)
            ]
            available = normal_available + backup_available
            needed = formation[position]
            planned_core_names = set(core_blocks[position].get(block_index, []))

            resting_names = forced_rest.get(block_index, set())
            if resting_names:
                rested = [
                    player for player in available
                    if player.name not in resting_names
                ]
                if len(rested) >= needed:
                    available = rested

            # When the coach allows emergency coverage, relax hard limits as
            # a last resort so a position is not left short.
            if game.allow_emergency_positions and len(available) < needed:
                available = [
                    player for player in candidates
                    if player.name not in reserved[block_index]
                    and raw_counts[player.name] < player.hard_maximum_blocks
                ]
            if game.allow_emergency_positions and len(available) < needed:
                available = [
                    player for player in candidates
                    if player.name not in reserved[block_index]
                ]
            if len(available) < needed:
                available = [
                    player for player in candidates
                    if is_usable(player, position, reserved[block_index], half_index)
                ]
                if planned_backup_names:
                    available = [
                        player for player in available
                        if player.name in normal_candidates
                        or player.name in planned_backup_names
                    ]
            if len(available) < needed and len(candidates) <= needed:
                # A group with exactly the required number of eligible players
                # must keep its formation intact, even when rotation caps are
                # already exhausted. There is no positional substitute left.
                available = [
                    player for player in normal_candidates + backup_candidates
                    if player.name in planned_backup_names
                    or player in normal_candidates
                    if player.name not in reserved[block_index]
                ]
            def assignment_key(player):
                is_core = player.group in {"core", "core_a", "core_b"}
                return (
                    0 if is_initial_block and is_core else 1,
                    0 if is_initial_block and player.name in rotating_starters else 1,
                    tier_and_urgency(player, half_index)[0],
                    positional_priority(
                        player, position, game.allow_emergency_positions
                    ),
                    tier_and_urgency(player, half_index)[1],
                    0 if player in previous_players else 1,
                    field_counts[player.name],
                    player.name,
                )
            available.sort(key=assignment_key)

            def leaves_future_coverage(chosen_players):
                """Keep this choice from making a later block impossible."""
                simulated_raw = raw_counts.copy()
                simulated_field = field_counts.copy()
                simulated_half = {
                    name: counts[:] for name, counts in half_counts.items()
                }
                for player in chosen_players:
                    simulated_raw[player.name] += 1
                    simulated_field[player.name] += 1
                    simulated_half[player.name][half_index] += 1

                for future_index in range(block_index + 1, game.total_blocks):
                    future_half = (
                        0
                        if future_index < (game.total_blocks + 1) // 2
                        else 1
                    )
                    future_available = 0
                    for player in candidates:
                        if player.name in reserved[future_index]:
                            continue
                        if simulated_raw[player.name] >= player.hard_maximum_blocks:
                            continue
                        if simulated_half[player.name][future_half] >= player.max_blocks_per_half:
                            continue
                        if (
                            is_dual_role_goalkeeper(player)
                            and simulated_field[player.name]
                            >= player.gk_field_maximum_blocks
                        ):
                            continue
                        future_available += 1
                    if future_available < needed:
                        return False

                for future_half in (0, 1):
                    future_indices = [
                        index
                        for index in range(block_index + 1, game.total_blocks)
                        if (
                            0
                            if index < (game.total_blocks + 1) // 2
                            else 1
                        ) == future_half
                    ]
                    required_slots = needed * len(future_indices)
                    available_capacity = 0
                    for player in candidates:
                        eligible_future_blocks = sum(
                            player.name not in reserved[index]
                            for index in future_indices
                        )
                        half_capacity = (
                            player.max_blocks_per_half
                            - simulated_half[player.name][future_half]
                        )
                        total_capacity = (
                            player.hard_maximum_blocks
                            - simulated_raw[player.name]
                        )
                        if is_dual_role_goalkeeper(player):
                            total_capacity = min(
                                total_capacity,
                                player.gk_field_maximum_blocks
                                - simulated_field[player.name],
                            )
                        available_capacity += max(
                            0,
                            min(
                                eligible_future_blocks,
                                half_capacity,
                                total_capacity,
                            ),
                        )
                    if available_capacity < required_slots:
                        return False
                return True

            if len(available) >= needed:
                required_backup = [
                    player for player in backup_available
                    if player.name in planned_backup_names
                ]
                optional_players = [
                    player for player in available
                    if player not in required_backup
                    and player.name not in planned_core_names
                ]
                required_core = [
                    player for player in available
                    if player.name in planned_core_names
                ]
                slots_to_fill = max(
                    0,
                    needed - len(required_backup) - len(required_core),
                )
                possible_choices = (
                    [
                        tuple(required_backup + required_core) + choice
                        for choice in combinations(optional_players, slots_to_fill)
                    ]
                    if required_backup or required_core
                    else combinations(available, needed)
                )
                feasible_choices = [
                    choice for choice in possible_choices
                    if leaves_future_coverage(choice)
                ]
                if feasible_choices:
                    chosen = list(min(
                        feasible_choices,
                        key=lambda choice: (
                            tuple(
                                sorted(assignment_key(player) for player in choice)
                            ),
                        ),
                    ))
                else:
                    chosen = available[:needed]
            else:
                chosen = available
            plans[position][block_index] = [player.name for player in chosen]
            for player in chosen:
                reserved[block_index].add(player.name)
                raw_counts[player.name] += 1
                field_counts[player.name] += 1
                half_counts[player.name][half_index] += 1
            previous_players = set(chosen)

    # Softly spread core rests across general groups when a legal same-position
    # swap exists. This never overrides workload limits or positional rules.
    core_groups = {"core", "core_a", "core_b"}

    def duplicate_core_rest_score(block_index):
        assigned = {
            name
            for position in positions
            for name in plans[position][block_index]
        }
        rested_counts = {group: 0 for group in ("D", "M", "F")}
        for player in roster:
            if (
                player.group in core_groups
                and player.available
                and player.name not in assigned
            ):
                for group in player_general_groups(player):
                    rested_counts[group] += 1
        return sum(max(0, count - 1) for count in rested_counts.values())

    for block_index in range(start_block_index, game.total_blocks):
        half_index = 0 if block_index < (game.total_blocks + 1) // 2 else 1
        while True:
            current_score = duplicate_core_rest_score(block_index)
            best_swap = None
            best_score = current_score
            assigned_names = {
                name
                for position in positions
                for name in plans[position][block_index]
            }
            for position in positions:
                for slot_name in list(plans[position][block_index]):
                    field_player = players_by_name[slot_name]
                    if field_player.group in core_groups:
                        continue
                    for rested_player in roster:
                        if (
                            not rested_player.available
                            or rested_player.group not in core_groups
                            or raw_counts[slot_name] - 1
                            < players_by_name[slot_name].hard_minimum_blocks
                            or rested_player.name in assigned_names
                            or rested_player.name == goalkeeper_names[block_index]
                            or rested_player not in eligible_players(
                                roster, position, game.allow_emergency_positions
                            )
                        ):
                            continue
                        reserved_names = set(reserved[block_index]) - {slot_name}
                        if not is_usable(
                            rested_player, position, reserved_names, half_index
                        ):
                            continue
                        plans[position][block_index].remove(slot_name)
                        plans[position][block_index].append(rested_player.name)
                        if duplicate_core_rest_score(block_index) < best_score:
                            best_score = duplicate_core_rest_score(block_index)
                            best_swap = (
                                position,
                                slot_name,
                                rested_player.name,
                            )
                        plans[position][block_index].remove(rested_player.name)
                        plans[position][block_index].append(slot_name)
            if best_swap is None:
                break
            position, old_name, new_name = best_swap
            plans[position][block_index].remove(old_name)
            plans[position][block_index].append(new_name)
            reserved[block_index].remove(old_name)
            reserved[block_index].add(new_name)
            raw_counts[old_name] -= 1
            field_counts[old_name] -= 1
            half_counts[old_name][half_index] -= 1
            raw_counts[new_name] += 1
            field_counts[new_name] += 1
            half_counts[new_name][half_index] += 1

    # Move unavoidable core rests away from concentrated blocks when a legal
    # same-position exchange preserves both players' half totals.
    def core_rest_count(block_index):
        assigned = {
            name
            for position in positions
            for name in plans[position][block_index]
        }
        return sum(
            player.group in core_groups
            and player.available
            and player.name not in assigned
            for player in roster
        )

    def core_rest_limit(block_index):
        if block_index in {0, game.total_blocks - 1}:
            return 0
        if block_index in {4, 5}:
            return 3
        return 2

    for half_blocks in (
        range(start_block_index, (game.total_blocks + 1) // 2),
        range(max(start_block_index, (game.total_blocks + 1) // 2), game.total_blocks),
    ):
        half_blocks = list(half_blocks)
        for target_index in sorted(
            half_blocks,
            key=lambda index: (-core_rest_count(index), index),
        ):
            while core_rest_count(target_index) > core_rest_limit(target_index):
                exchanged = False
                for position in positions:
                    target_players = plans[position][target_index]
                    target_core = [
                        player for player in roster
                        if player.group in core_groups
                        and player.available
                        and player.name not in {
                            name
                            for planned_position in positions
                            for name in plans[planned_position][target_index]
                        }
                        and player.name not in goalkeeper_names
                        and player in eligible_players(
                            roster, position, game.allow_emergency_positions
                        )
                    ]
                    for source_index in sorted(
                        half_blocks,
                        key=lambda index: (core_rest_count(index), index),
                    ):
                        if source_index == target_index:
                            continue
                        source_players = plans[position][source_index]
                        for core_player in target_core:
                            if core_player.name not in source_players:
                                continue
                            for replacement_name in target_players:
                                replacement = players_by_name[replacement_name]
                                if replacement.group in core_groups:
                                    continue
                                if replacement.name in {
                                    name
                                    for planned_position in positions
                                    for name in plans[planned_position][source_index]
                                }:
                                    continue
                                if replacement not in eligible_players(
                                    roster, position, game.allow_emergency_positions
                                ):
                                    continue
                                target_slot = target_players.index(replacement_name)
                                source_slot = source_players.index(core_player.name)
                                target_players[target_slot] = core_player.name
                                source_players[source_slot] = replacement.name
                                exchanged = True
                                break
                            if exchanged:
                                break
                        if exchanged:
                            break
                    if exchanged:
                        break
                if not exchanged:
                    break

    # Finish with the strongest feasible core lineup. Swaps stay within a
    # position group, so player totals and positional eligibility are unchanged.
    final_block_index = game.total_blocks - 1
    second_half_start = (game.total_blocks + 1) // 2
    if start_block_index <= final_block_index:
        final_assigned_names = {
            goalkeeper_names[final_block_index],
            *(
                player_name
                for position in positions
                for player_name in plans[position][final_block_index]
            ),
        }
        for position in positions:
            final_players = plans[position][final_block_index]
            for final_slot, final_name in enumerate(final_players):
                if players_by_name[final_name].group in {"core", "core_a", "core_b"}:
                    continue
                for block_index in range(second_half_start, final_block_index):
                    source_assigned_names = {
                        goalkeeper_names[block_index],
                        *(
                            assigned_name
                            for planned_position in positions
                            for assigned_name in plans[planned_position][block_index]
                        ),
                    }
                    for player_slot, player_name in enumerate(plans[position][block_index]):
                        if (
                            players_by_name[player_name].group
                            in {"core", "core_a", "core_b"}
                            and player_name not in final_assigned_names
                            and final_name not in source_assigned_names
                        ):
                            plans[position][block_index][player_slot] = final_name
                            final_players[final_slot] = player_name
                            final_assigned_names.remove(final_name)
                            final_assigned_names.add(player_name)
                            break
                    else:
                        continue
                    break

    # Rescue pass: if a position still came up short in some block, see if a
    # player used elsewhere that block is also eligible for it, and a free
    # replacement can cover the spot they would leave behind.
    for block_index in range(start_block_index, game.total_blocks):
        half_index = 0 if block_index < (game.total_blocks + 1) // 2 else 1
        for position in positions:
            needed = formation[position]
            while len(plans[position][block_index]) < needed:
                rescued = False
                for other_position in positions:
                    if other_position == position:
                        continue
                    for candidate_name in list(plans[other_position][block_index]):
                        candidate = players_by_name[candidate_name]
                        if positional_priority(
                            candidate, position, game.allow_emergency_positions
                        ) >= 3:
                            continue
                        reserved_names = set(reserved[block_index]) - {candidate_name}
                        replacements = [
                            player for player in eligible_players(
                                roster, other_position, game.allow_emergency_positions
                            )
                            if player.name != candidate_name
                            and player.name not in plans[other_position][block_index]
                            and is_usable(
                                player, other_position, reserved_names, half_index
                            )
                        ]
                        if not replacements:
                            continue
                        replacements.sort(
                            key=lambda player: (
                                tier_and_urgency(player, half_index)[0],
                                positional_priority(
                                    player, other_position,
                                    game.allow_emergency_positions,
                                ),
                                tier_and_urgency(player, half_index)[1],
                                field_counts[player.name],
                                player.name,
                            )
                        )
                        replacement = replacements[0]
                        plans[other_position][block_index].remove(candidate_name)
                        plans[other_position][block_index].append(replacement.name)
                        plans[position][block_index].append(candidate_name)
                        reserved[block_index].add(replacement.name)
                        raw_counts[replacement.name] += 1
                        field_counts[replacement.name] += 1
                        half_counts[replacement.name][half_index] += 1
                        rescued = True
                        break
                    if rescued:
                        break
                if not rescued:
                    break

    # Automatic emergency coverage is the final protection against empty
    # field slots. It uses any available non-excluded field player, while
    # preserving hard workload limits whenever possible.
    if emergency_assignments is None:
        emergency_assignments = []
    for block_index in range(start_block_index, game.total_blocks):
        half_index = 0 if block_index < (game.total_blocks + 1) // 2 else 1
        for position in positions:
            needed = formation[position]
            while len(plans[position][block_index]) < needed:
                assigned_names = set(reserved[block_index]) | {
                    name
                    for planned_position in positions
                    for name in plans[planned_position][block_index]
                }
                emergency_candidates = []
                for player in roster:
                    if not player.available or player.name in assigned_names:
                        continue
                    if player.name == goalkeeper_names[block_index]:
                        continue
                    if position in {
                        excluded.strip().upper()
                        for excluded in player.excluded_positions
                    }:
                        continue
                    if not is_usable(
                        player, position, assigned_names, half_index
                    ):
                        continue
                    deficit = max(
                        0, field_hard_minimum(player) - field_counts[player.name]
                    )
                    emergency_candidates.append((
                        -deficit,
                        raw_counts[player.name],
                        half_counts[player.name][half_index],
                        player.name,
                        player,
                    ))
                if not emergency_candidates:
                    emergency_candidates = [
                        (
                            0,
                            raw_counts[player.name],
                            half_counts[player.name][half_index],
                            player.name,
                            player,
                        )
                        for player in roster
                        if (
                            player.available
                            and player.name not in assigned_names
                            and player.name != goalkeeper_names[block_index]
                            and position not in {
                                excluded.strip().upper()
                                for excluded in player.excluded_positions
                            }
                        )
                    ]
                if not emergency_candidates:
                    break
                emergency_candidates.sort(key=lambda item: item[:4])
                player = emergency_candidates[0][4]
                plans[position][block_index].append(player.name)
                reserved[block_index].add(player.name)
                assigned_names.add(player.name)
                raw_counts[player.name] += 1
                field_counts[player.name] += 1
                half_counts[player.name][half_index] += 1
                emergency_assignments.append((block_index, position, player.name))

    return plans




def position_assignment_order(
    formation,
    roster,
    used_players=None,
    block_num=None,
    total_blocks=None,
    allow_emergency=False,
):
    """Return field positions from most constrained to most flexible."""
    used_players = used_players or set()
    positions = [
        position for position in ("D", "M", "F")
        if formation.get(position, 0) > 0
    ]

    def constraint_key(position):
        available = [
            player for player in eligible_players(roster, position, allow_emergency)
            if player.name not in used_players and (
                block_num is None
                or total_blocks is None
                or (
                    player.block_count < player.hard_maximum_blocks
                    and player.blocks_by_half[
                        0 if block_num <= (total_blocks + 1) // 2 else 1
                    ] < player.max_blocks_per_half
                )
            )
        ]
        non_emergency = [
            player for player in available
            if positional_priority(player, position, allow_emergency) < 2
        ]
        return len(non_emergency), positions.index(position)


    return sorted(positions, key=constraint_key)




def assign_positions(
    block_num, total_blocks, formation, roster, gk_player,
    allow_emergency=False,
):
    """
    Assigns players to positions for a single block.
    Returns a dict:
    {
        "GK": player_name,
        "D": [...],
        "M": [...],
        "F": [...],
        "bench": [...]
    }
    """

    assignment = {
        "GK": None,
        "D": [],
        "M": [],
        "F": [],
        "bench": []
    }

    # --- GK assignment ----------------------------------------------------
    if gk_player:
        assignment["GK"] = gk_player.name
        gk_player.block_count += 1
        gk_player.gk_blocks += 1
        gk_player.position_usage["GK"] += 1
        gk_player.last_two.append("play")
        if len(gk_player.last_two) > 2:
            gk_player.last_two.pop(0)
    else:
        assignment["GK"] = "NO GK AVAILABLE"

    used_players = {assignment["GK"]}
    half_index = 0 if block_num <= (total_blocks + 1) // 2 else 1

    # --- Field positions: assign constrained positions first ----------------
    for pos in position_assignment_order(
        formation,
        roster,
        used_players,
        block_num,
        total_blocks,
        allow_emergency=allow_emergency,
    ):
        needed = formation[pos]
        eligible = eligible_players(roster, pos, allow_emergency)
        eligible = [
            p for p in eligible
            if (
                p.name not in used_players
                and p.block_count < p.hard_maximum_blocks
                and p.blocks_by_half[half_index] < p.max_blocks_per_half
            )
        ]

        # A complete formation takes precedence when hard limits leave too
        # few candidates. Use additional eligible players as a last resort.
        if allow_emergency and len(eligible) < needed:
            fallback_names = {player.name for player in eligible}
            eligible.extend(
                player
                for player in eligible_players(roster, pos, allow_emergency)
                if player.name not in used_players
                and player.name not in fallback_names
            )

        def fairness_key(p, pos=pos):
            """
            Fairness + block-target priority + surplus/deficit + bench fairness.
            Lower tuple values = higher priority.
            """

            # --- Block-target priority --------------------------------------------
            target_diff = p.block_count - p.target_blocks

            # --- Surplus / Deficit logic (Option E) -------------------------------
            # deficit = player is behind target → boost
            # surplus = player is ahead → slight penalty
            deficit = p.target_blocks - p.block_count
            surplus = p.block_count - p.target_blocks

            # deficit should boost strongly
            deficit_boost = -deficit if deficit > 0 else 0

            # surplus should penalize gently
            surplus_penalty = max(0, surplus)

            # --- Bench fairness (Option D) ----------------------------------------
            bench_streak_penalty = 0
            if p.last_two == ["bench", "bench"]:
                bench_streak_penalty = -2
            elif p.last_two[-1:] == ["bench"]:
                bench_streak_penalty = -1

            # --- Play streak fairness ----------------------------------------------
            play_streak_penalty = 0
            if p.last_two == ["play", "play"]:
                play_streak_penalty = 1

            # --- Final fairness tuple ----------------------------------------------
            return (
                position_minimum_priority(p, pos, allow_emergency),
                0 if p.block_count < p.maximum_blocks else 1,
                continuity_priority(p) if block_num != (total_blocks + 1) // 2 + 1 else 1,
                p.blocks_by_half[half_index],
                group_priority(p),
                target_diff,
                deficit_boost,
                surplus_penalty,
                bench_streak_penalty,
                play_streak_penalty,
                p.block_count,
                p.bench_count,
                p.position_usage[pos],
            )


        eligible.sort(key=fairness_key)
        chosen = eligible[:needed]

        for p in chosen:
            assignment[pos].append(p.name)
            p.block_count += 1
            p.blocks_by_half[half_index] += 1
            p.field_blocks += 1
            p.position_usage[pos] += 1

            p.last_two.append("play")
            if len(p.last_two) > 2:
                p.last_two.pop(0)

            used_players.add(p.name)

    # --- Bench assignment ----------------------------------------------------
    for p in roster:
        if p.name not in used_players:
            assignment["bench"].append(p.name)
            p.bench_count += 1

            if p.available:
                p.last_two.append("bench")

    return assignment


def player_was_unavailable(game, player_name, block_number):
    """Return whether a player was unavailable during a numbered block."""
    unavailable = False
    for change in game.availability_changes:
        if change["player"] != player_name:
            continue
        if block_number >= change["block"] + 1:
            unavailable = change["action"] == "unavailable"
    return unavailable


def apply_block_to_stats(
    players_by_name, block_assignment, half_index, game=None, block_number=None
):
    """Record one already-decided block assignment onto player stats.

    Used both when a block is first generated and when replaying earlier
    blocks to rebuild each player's stats before regenerating the rest of
    a game in progress.
    """
    assigned_names = {block_assignment["GK"]}
    for position in ("D", "M", "F"):
        assigned_names.update(block_assignment[position])
        for name in block_assignment[position]:
            player = players_by_name[name]
            player.block_count += 1
            player.field_blocks += 1
            player.position_usage[position] += 1
            player.blocks_by_half[half_index] += 1
            player.last_two.append("play")
            player.last_two = player.last_two[-2:]

    gk_player = players_by_name.get(block_assignment["GK"])
    if gk_player is not None:
        gk_player.block_count += 1
        gk_player.gk_blocks += 1
        gk_player.position_usage["GK"] += 1
        gk_player.last_two.append("play")
        gk_player.last_two = gk_player.last_two[-2:]

    for player in players_by_name.values():
        was_unavailable = (
            game is not None
            and block_number is not None
            and player_was_unavailable(game, player.name, block_number)
        )
        has_replacement_credit = (
            game is not None
            and block_number is not None
            and any(
                credit["player"] == player.name
                and credit["block"] == block_number
                for credit in game.replacement_credits
            )
        )
        if player.name not in assigned_names and not was_unavailable and not has_replacement_credit:
            player.bench_count += 1
            player.last_two.append("bench")
            player.last_two = player.last_two[-2:]


def apply_replacement_credits(roster, game):
    """Count replaced players as having played their completed block."""
    players_by_name = {player.name: player for player in roster}
    for credit in game.replacement_credits:
        player = players_by_name.get(credit["player"])
        if player is None:
            continue
        position = credit["position"]
        half_index = credit["half_index"]
        player.block_count += 1
        player.blocks_by_half[half_index] += 1
        player.position_usage[position] += 1
        if position == "GK":
            player.gk_blocks += 1
        else:
            player.field_blocks += 1


def reset_player_stats(player):
    """Reset one player's game stats back to the start of a fresh game."""
    player.block_count = 0
    player.bench_count = 0
    player.position_usage = {"GK": 0, "D": 0, "M": 0, "F": 0}
    player.gk_blocks = 0
    player.field_blocks = 0
    player.blocks_by_half = [0, 0]
    player.last_two = []


def replay_timeline(roster, timeline_prefix, game):
    """Reset all player stats, then replay already-decided blocks in order.

    Used to rebuild the correct baseline before regenerating the remaining
    part of a game after a mid-game availability change.
    """
    players_by_name = {player.name: player for player in roster}
    for player in roster:
        reset_player_stats(player)

    half_length = (game.total_blocks + 1) // 2
    for block_number, block_assignment in enumerate(timeline_prefix, start=1):
        half_index = 0 if block_number <= half_length else 1
        apply_block_to_stats(
            players_by_name,
            block_assignment,
            half_index,
            game=game,
            block_number=block_number,
        )
    apply_replacement_credits(roster, game)


def build_timeline(game, roster, start_block=1, frozen_timeline=None):
    """Build the timeline for blocks start_block..total_blocks.

    Blocks before start_block are assumed to already be reflected in each
    player's stats (block_count, field_blocks, etc.) and are supplied via
    frozen_timeline, so this can also regenerate just the remaining part of
    a game already in progress.
    """
    result = RotationResult()
    formation = parse_formation(game.formation)
    exact_slots = formation_slots(formation)
    frozen_timeline = list(frozen_timeline or [])

    goalkeeper_names = [block["GK"] for block in frozen_timeline]
    goalkeepers = [None] * len(frozen_timeline)
    for block in range(start_block, game.total_blocks + 1):
        gk_player = choose_gk(game, roster, block)
        goalkeepers.append(gk_player)
        goalkeeper_names.append(
            gk_player.name if gk_player else "NO GK AVAILABLE"
        )

    emergency_assignments = []
    plans = plan_position_groups(
        game, formation, roster, goalkeeper_names,
        start_block_index=start_block - 1,
        emergency_assignments=emergency_assignments,
    )
    players_by_name = {player.name: player for player in roster}
    half_length = (game.total_blocks + 1) // 2

    result.timeline.extend(frozen_timeline)

    for block in range(start_block, game.total_blocks + 1):
        gk_player = goalkeepers[block - 1]
        block_assignment = {
            "GK": gk_player.name if gk_player else "NO GK AVAILABLE",
            "D": plans["D"][block - 1],
            "M": plans["M"][block - 1],
            "F": plans["F"][block - 1],
            "bench": [],
        }
        block_assignment["positions"] = {"GK": block_assignment["GK"]}
        previous_slots = {}
        if result.timeline:
            previous_slots = {
                player_name: slot
                for slot, player_name in result.timeline[-1].get(
                    "positions", {}
                ).items()
                if slot != "GK" and player_name != "UNASSIGNED"
            }
        for position in ("D", "M", "F"):
            position_previous_slots = {
                player_name: slot
                for player_name, slot in previous_slots.items()
                if slot in exact_slots[position]
            }
            block_assignment["positions"].update(
                assign_exact_slots(
                    players_by_name,
                    block_assignment[position],
                    exact_slots[position],
                    position,
                    previous_slots=position_previous_slots,
                )
            )

        for emergency_block, position, player_name in emergency_assignments:
            if emergency_block != block - 1:
                continue
            slot = next(
                (
                    slot_name
                    for slot_name, assigned_name
                    in block_assignment["positions"].items()
                    if slot_name != "GK" and assigned_name == player_name
                ),
                position,
            )
            result.warnings.append(
                f"Emergency coverage: {player_name} assigned to "
                f"{position} slot {slot} in block {block}."
            )

        assigned_names = {block_assignment["GK"]}
        for position in ("D", "M", "F"):
            assigned_names.update(block_assignment[position])
        for player in roster:
            if player.name not in assigned_names:
                block_assignment["bench"].append(player.name)

        half_index = 0 if block <= half_length else 1
        apply_block_to_stats(players_by_name, block_assignment, half_index)

        for position in ("D", "M", "F"):
            if len(block_assignment[position]) != formation[position]:
                result.errors.append(
                    f"Block {block}: {position} requires {formation[position]} "
                    f"players but only {len(block_assignment[position])} were assigned."
                )
        if gk_player is None:
            result.errors.append(f"Block {block}: no goalkeeper was assigned.")
        result.timeline.append(block_assignment)

    # Metadata
    result.metadata = {
        "total_blocks": game.total_blocks,
        "formation": game.formation,
        "gk_assignment": game.gk_assignment
    }

    return result

