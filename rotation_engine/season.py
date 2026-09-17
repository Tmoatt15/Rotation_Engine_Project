"""Season-level setup: game length, game format, and substitution blocks."""

# Block lengths are rounded down to a whole number of these units so blocks
# land on clean clock values; the leftover time is added back to the last
# block of each half.
BLOCK_ROUNDING_SECONDS = 30

# players_on_field counts the goalkeeper when the format uses one, so the
# field players a formation must cover is players_on_field minus the keeper.
GAME_FORMATS = {
    "4v4": {"players_on_field": 4, "has_goalkeeper": False, "default_formation": "1-2-1"},
    "5v5": {"players_on_field": 5, "has_goalkeeper": True, "default_formation": "1-2-1"},
    "7v7": {"players_on_field": 7, "has_goalkeeper": True, "default_formation": "2-3-1"},
    "9v9": {"players_on_field": 9, "has_goalkeeper": True, "default_formation": "3-3-2"},
    "11v11": {"players_on_field": 11, "has_goalkeeper": True, "default_formation": "4-4-2"},
}

FORMATIONS_BY_FORMAT = {
    "4v4": ["1-2-1", "2-0-2"],
    "5v5": ["1-2-1", "2-0-2", "2-1-1"],
    "7v7": ["2-3-1", "3-2-1", "2-1-2-1"],
    "9v9": ["3-3-2", "3-4-1", "4-3-1"],
    "11v11": ["4-3-3", "4-4-2", "4-2-3-1", "3-4-3"],
}


def format_block_length(seconds):
    """Format a block length in seconds as M:SS."""
    minutes, remaining_seconds = divmod(int(seconds), 60)
    return f"{minutes}:{remaining_seconds:02d}"


class SeasonSetup:
    """Season-wide settings the coach enters once before the season starts.

    The coach supplies either total_blocks or block_length_minutes; the
    other is derived from the game length.
    """

    def __init__(
        self,
        game_length_minutes,
        game_format,
        total_blocks=None,
        block_length_minutes=None,
        formation=None,
        total_games=1,
        substitution_alert='flash_and_vibrate',
        substitution_warning_seconds=30,
    ):
        if game_length_minutes <= 0:
            raise ValueError("Game length must be greater than zero minutes.")

        game_format = str(game_format).strip().lower().replace(" ", "")
        if game_format not in GAME_FORMATS:
            supported = ", ".join(GAME_FORMATS)
            raise ValueError(f"Game format must be one of: {supported}.")

        if (total_blocks is None) == (block_length_minutes is None):
            raise ValueError(
                "Provide either total_blocks or block_length_minutes, not both."
            )

        total_seconds = round(game_length_minutes * 60)

        if total_blocks is not None:
            if total_blocks <= 0:
                raise ValueError("Number of blocks must be greater than zero.")
            total_blocks = int(total_blocks)
            base_seconds = (
                total_seconds // total_blocks // BLOCK_ROUNDING_SECONDS
            ) * BLOCK_ROUNDING_SECONDS
        else:
            if block_length_minutes <= 0:
                raise ValueError("Block length must be greater than zero minutes.")
            if block_length_minutes > game_length_minutes:
                raise ValueError("Block length cannot exceed the game length.")
            base_seconds = round(block_length_minutes * 60)
            total_blocks = total_seconds // base_seconds

        if base_seconds < BLOCK_ROUNDING_SECONDS:
            raise ValueError(
                f"{total_blocks} blocks would be shorter than "
                f"{BLOCK_ROUNDING_SECONDS} seconds each."
            )

        # Leftover time is split between the halves and handed to the final
        # block of each half, so every block still starts on a clean value.
        surplus_seconds = total_seconds - base_seconds * total_blocks
        half_length = (total_blocks + 1) // 2
        block_seconds = [base_seconds] * total_blocks
        if surplus_seconds > 0:
            first_half_extra = surplus_seconds // 2
            block_seconds[half_length - 1] += first_half_extra
            block_seconds[-1] += surplus_seconds - first_half_extra

        self.game_length_minutes = game_length_minutes
        self.game_format = game_format
        self.total_blocks = int(total_blocks)
        self.base_block_seconds = base_seconds
        self.block_seconds = block_seconds
        self.block_length_minutes = round(base_seconds / 60, 2)
        self.total_games = total_games
        valid_alerts = {'none', 'flash', 'vibrate', 'flash_and_vibrate'}
        if substitution_alert not in valid_alerts:
            raise ValueError('Substitution alert must be none, flash, vibrate, or flash_and_vibrate.')
        if substitution_warning_seconds not in {15, 30, 60}:
            raise ValueError('Substitution warning must be 15, 30, or 60 seconds.')
        self.substitution_alert = substitution_alert
        self.substitution_warning_seconds = substitution_warning_seconds

        details = GAME_FORMATS[game_format]
        self.players_on_field = details["players_on_field"]
        self.has_goalkeeper = details["has_goalkeeper"]
        self.formation = formation or details["default_formation"]

    @property
    def formation_options(self):
        return FORMATIONS_BY_FORMAT[self.game_format]

    @property
    def field_players(self):
        """Players a formation must cover, excluding the goalkeeper."""
        return self.players_on_field - (1 if self.has_goalkeeper else 0)

    @property
    def blocks_divide_evenly(self):
        return all(
            seconds == self.base_block_seconds for seconds in self.block_seconds
        )

    @property
    def block_lengths_minutes(self):
        """Length of every block in minutes, in block order."""
        return [seconds / 60 for seconds in self.block_seconds]

    @property
    def extended_block_numbers(self):
        """1-based blocks that absorb the leftover time."""
        return [
            number
            for number, seconds in enumerate(self.block_seconds, start=1)
            if seconds != self.base_block_seconds
        ]

    def validate_formation(self):
        """Return an error message if the formation does not fit the format."""
        if self.formation not in self.formation_options:
            options = ", ".join(self.formation_options)
            return f"Formation {self.formation} is not available for {self.game_format}. Choose: {options}."

        parts = self.formation.split("-")
        valid_part_counts = (
            {2, 3}
            if self.game_format == "5v5"
            else ({3, 4} if self.game_format in {"7v7", "11v11"} else {3})
        )
        if len(parts) not in valid_part_counts or not all(
            part.strip().isdigit() for part in parts
        ):
            example = "2-2 or 1-2-1" if self.game_format == "5v5" else "4-4-2"
            return f"Formation must be in the correct format, for example {example}."

        total = sum(int(part) for part in parts)
        if total != self.field_players:
            return (
                f"Formation {self.formation} uses {total} field players but "
                f"{self.game_format} needs {self.field_players}."
            )
        return None

    def to_dict(self):
        return {
            "game_length_minutes": self.game_length_minutes,
            "game_format": self.game_format,
            "total_blocks": self.total_blocks,
            "block_length_minutes": self.block_length_minutes,
            "formation": self.formation,
            "total_games": self.total_games,
            "substitution_alert": self.substitution_alert,
            "substitution_warning_seconds": self.substitution_warning_seconds,
        }

    @classmethod
    def from_dict(cls, data):
        return cls(
            game_length_minutes=data["game_length_minutes"],
            game_format=data["game_format"],
            total_blocks=data.get("total_blocks"),
            formation=data.get("formation"),
            total_games=data.get("total_games", 1),
            substitution_alert=data.get("substitution_alert", "flash_and_vibrate"),
            substitution_warning_seconds=data.get("substitution_warning_seconds", 30),
        )

    def summary(self):
        lines = [
            f"Game length: {self.game_length_minutes} minutes",
            f"Game format: {self.game_format} "
            f"({self.players_on_field} on the field, "
            f"{self.field_players} field players"
            + (" + goalkeeper" if self.has_goalkeeper else ", no goalkeeper")
            + ")",
            f"Blocks: {self.total_blocks}",
            f"Block length: {format_block_length(self.base_block_seconds)}",
            f"Formation: {self.formation}",
            f"Games in season: {self.total_games}",
        ]
        if self.extended_block_numbers:
            extended = ", ".join(
                f"block {number} ({format_block_length(self.block_seconds[number - 1])})"
                for number in self.extended_block_numbers
            )
            lines.append(f"Leftover time added to: {extended}")
        return "\n".join(lines)
