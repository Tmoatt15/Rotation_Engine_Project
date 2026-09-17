from rotation_engine.models import RotationResult


def compute_surplus(game, roster):
    """
    Computes surplus/deficit for each player based on:
    - block_target (from quotas.py)
    - block_count (from timeline.py)
    - positional usage
    - GK usage (if applicable)

    Returns a dictionary with clean summaries the engine can use.
    """

    result = RotationResult()

    # --- 1. Basic surplus/deficit -----------------------------------------
    surplus = {}
    for player in roster:
        diff = player.block_count - player.target_blocks
        surplus[player.name] = {
            "target": player.target_blocks,
            "actual": player.block_count,
            "surplus": diff,          # positive = overused, negative = underused
            "bench": player.bench_count
        }

    result.block_counts = {p.name: p.block_count for p in roster}

    # --- 2. GK-specific surplus -------------------------------------------
    gk_summary = {}
    for player in roster:
        if "GK" in player.primary_positions:
            gk_summary[player.name] = {
                "gk_blocks": player.gk_blocks,
                "field_blocks": player.field_blocks,
                "bench": player.bench_count,
                "total": player.block_count
            }

    result.gk_summary = gk_summary

    # --- 3. Positional usage summary --------------------------------------
    position_summary = {}
    for player in roster:
        position_summary[player.name] = dict(player.position_usage)

    result.position_summary = position_summary

    # --- 4. Metadata -------------------------------------------------------
    result.metadata = {
        "total_blocks": game.total_blocks,
        "formation": game.formation,
        "gk_assignment": game.gk_assignment,
    }

    # --- 5. Warnings & errors ---------------------------------------------
    for player in roster:
        # Underused core players
        if player.group.startswith("core") and player.block_count < player.minimum_blocks:
            result.warnings.append(
                f"{player.name} (core) is under target by "
                f"{player.minimum_blocks - player.block_count} blocks."
            )

        # Overused developmental players
        if player.group in {"developmental", "developing"} and player.block_count > player.maximum_blocks:
            result.warnings.append(
                f"{player.name} (developmental) exceeded target by "
                f"{player.block_count - player.maximum_blocks} blocks."
            )

        # GK fairness check
        if player.group == "rotational_gk" and player.gk_blocks == 0:
            result.warnings.append(
                f"{player.name} is rotational_gk but received no GK blocks."
            )

    # --- 6. Return clean structure for engine ------------------------------
    return {
        "surplus": surplus,
        "gk_summary": gk_summary,
        "position_summary": position_summary,
        "warnings": result.warnings,
        "errors": result.errors,
        "metadata": result.metadata,
        "result": result  # full RotationResult object
    }
