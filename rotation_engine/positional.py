"""
Positional rules and utilities for the rotation engine.

This module defines:
- Primary positional tiers
- Emergency fallback rules
- Developmental player restrictions
- GK field eligibility rules
"""

# --- Position tiers -------------------------------------------------------

PRIMARY_POSITIONS = {
    "GK": ["GK"],
    "D": ["D"],
    "M": ["M"],
    "F": ["F"],
}

# Emergency positions are used only when no eligible players exist.
EMERGENCY_POSITIONS = {
    "GK": [],            # GK emergency rules handled separately
    "D": ["F"],          # Forwards can emergency-fill defense
    "M": [],             # Midfield has enough flexibility already
    "F": ["D"],          # Defenders can emergency-fill forward
}

# --- Developmental restrictions -------------------------------------------

# Developmental players should not exceed these limits unless necessary.
DEVELOPMENTAL_MAX_BLOCKS = 4

# Developmental players should avoid emergency positions.
DEVELOPMENTAL_FORBIDDEN_EMERGENCY = True

# --- GK rules --------------------------------------------------------------

GK_MAX_BLOCKS = 5               # GK plays half the game
ROTATIONAL_GK_FIELD_BLOCKS = 3  # Rotational GK allowed limited field time
GK_CAN_PLAY_FIELD = False       # Default: GK does not play field positions

# --- Eligibility helper ----------------------------------------------------

def positional_tiers_for(position):
    """
    Returns the normal and emergency positional tiers for a position group.

    The middle tuple value remains empty for compatibility with older callers.
    """
    primary = PRIMARY_POSITIONS.get(position, [])
    emergency = EMERGENCY_POSITIONS.get(position, [])
    return primary, [], emergency


def is_emergency_allowed(player, position):
    """
    Returns True if a player is allowed to play an emergency position.
    Developmental players may be restricted.
    """
    forbidden = (
        player.group in {"developmental", "developing"}
        and DEVELOPMENTAL_FORBIDDEN_EMERGENCY
    )
    return not forbidden

