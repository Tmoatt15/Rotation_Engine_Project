class Player:
    def __init__(
        self,
        name,
        group,
        primary_position=None,
        forbidden_positions=None,
        backup_positions=None,
        general_position=None,
        general_positions=None,
        primary_positions=None,
        excluded_positions=None,
    ):
        # Basic identity
        self.name = name
        self.group = group.lower()
        self.core_tier = None  # assigned later (A or B)

        # Positional info
        def as_position_list(value):
            if value is None:
                return []
            if isinstance(value, str):
                return [value.strip().upper()]
            return [position.strip().upper() for position in value]

        legacy_general = as_position_list(general_position or primary_position)
        legacy_primary = as_position_list(primary_position)
        self.general_positions = (
            as_position_list(general_positions) or legacy_general
        )
        self.primary_positions = (
            as_position_list(primary_positions) or legacy_primary
        )
        self.backup_positions = as_position_list(backup_positions)
        self.excluded_positions = (
            as_position_list(excluded_positions)
            or as_position_list(forbidden_positions)
        )

        # Retain the old fields while the scheduler is migrated incrementally.
        self.general_position = self.general_positions[0] if self.general_positions else ""
        self.primary_position = self.primary_positions[0] if self.primary_positions else self.general_position
        self.forbidden_positions = self.excluded_positions

        # Derived automatically
        self.positional_group = (
            primary_position if primary_position != "GK" else "GK"
        )

        # Mid-game availability: set False to pull a player out of the
        # rotation (tired, injured, leaving early) and regenerate the rest
        # of the schedule around them.
        self.available = True

        # Assigned later by the engine
        self.target_blocks = 0
        self.minimum_blocks = 0
        self.maximum_blocks = 0
        self.hard_minimum_blocks = 4
        self.hard_maximum_blocks = 8
        # Percentage-derived limits; recomputed per game by compute_block_targets.
        self.max_blocks_per_half = 4
        self.gk_field_minimum_blocks = 2
        self.gk_field_maximum_blocks = 3
        self.blocks_by_half = [0, 0]
        self.block_count = 0
        self.bench_count = 0

        # Positional usage tracking
        self.position_usage = {"GK": 0, "D": 0, "M": 0, "F": 0}

        # GK-specific tracking
        self.gk_blocks = 0
        self.field_blocks = 0
        self.max_gk_blocks = 5
        self.gk_field_targets_by_half = [0, 0]

        # Stores the last two rotation results to apply bench/play streak rules
        self.last_two = []


class Game:
    def __init__(
        self,
        total_blocks,
        formation,
        gk_assignment=None,
        first_half_gk=None,
        second_half_gk=None,
        season_total_games=1,
        season_game_number=1,
        season_seed=2026,
        allow_emergency_positions=False,
        season_player_blocks=None,
    ):
        # Number of blocks in the game (usually 10)
        self.total_blocks = total_blocks

        # Formation for each block (e.g., "2-3-2")
        self.formation = formation

        # Name of the player assigned as GK for this game
        # If None, the engine will choose or error depending on your rules
        self.gk_assignment = gk_assignment
        self.first_half_gk = first_half_gk or gk_assignment
        self.second_half_gk = second_half_gk

        self.season_total_games = season_total_games
        self.season_game_number = season_game_number
        self.season_seed = season_seed
        self.season_player_blocks = season_player_blocks or {}
        self.core_high_names = None
        self.allow_emergency_positions = allow_emergency_positions
        # Mid-game replacement bookkeeping survives later regenerations.
        self.replacement_credits = []
        self.replacement_bonuses = {}
        self.availability_changes = []
        self.quota_exempt_players = set()

        # Assigned later by the engine
        self.timeline = []  # list of block assignments

class RotationResult:
    def __init__(self):
        # Final timeline of assignments (list of dicts)
        self.timeline = []

        # Block counts for each player
        # Example: {"Max": 8, "Sawyer": 7, ...}
        self.block_counts = {}

        # GK-specific breakdown
        # Example: {"Cameron": {"gk": 4, "field": 4, "bench": 2}}
        self.gk_summary = {}

        # Positional usage summary
        # Example: {"Max": {"F": 5, "M": 3}}
        self.position_summary = {}

        # Any warnings or errors the engine wants to report
        self.warnings = []
        self.errors = []

        # Metadata (formation, total blocks, etc.)
        self.metadata = {}
