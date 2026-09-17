import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from simulator import (
    DEFAULT_ROSTER_FILE,
    DEFAULT_SEASON_ROSTER_FILE,
    SEASON_FILE,
    game_from_season,
    load_roster_from_data,
    load_roster_from_json,
    load_season_setup,
    run_rotation_engine,
)
from rotation_engine.season import FORMATIONS_BY_FORMAT, SeasonSetup
from rotation_engine.timeline import formation_slots, parse_formation


ROOT = Path(__file__).resolve().parent
TEAMS_FILE = ROOT / "teams.json"


class ScheduleRequest(BaseModel):
    team_id: str | None = None
    available_player_names: list[str] = Field(min_length=1)
    game_number: int = Field(default=1, ge=1)
    first_half_gk: str | None = None
    second_half_gk: str | None = None


class SavedScheduleRequest(BaseModel):
    name: str = Field(min_length=1)
    schedule: dict[str, Any]


class SavedScheduleRenameRequest(BaseModel):
    name: str = Field(min_length=1)


class GameReportRequest(BaseModel):
    report: dict[str, Any]


class SeasonSettingsRequest(BaseModel):
    team_id: str | None = None
    game_length_minutes: float = Field(gt=0)
    game_format: str
    total_blocks: int = Field(gt=0)
    formation: str
    total_games: int = Field(default=1, ge=1)
    substitution_alert: str = "flash_and_vibrate"
    substitution_warning_seconds: int = Field(default=30, ge=15, le=60)


class RosterPlayerRequest(BaseModel):
    name: str = Field(min_length=1)
    group: str
    general_positions: list[str]
    primary_positions: list[str]
    backup_positions: list[str]
    excluded_positions: list[str]


class RosterUpdateRequest(BaseModel):
    team_id: str | None = None
    players: list[RosterPlayerRequest] = Field(min_length=1)


class TeamCreateRequest(BaseModel):
    name: str = Field(min_length=1)
    players: list[str] = Field(min_length=1)


app = FastAPI(title="Soccer Rotation Engine API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _load_roster():
    return load_roster_from_json(
        file_path=str(ROOT / DEFAULT_ROSTER_FILE),
        season_roster_path=str(ROOT / DEFAULT_SEASON_ROSTER_FILE),
    )


def _load_season_roster() -> list[dict[str, Any]]:
    with open(ROOT / DEFAULT_SEASON_ROSTER_FILE, encoding="utf-8") as roster_file:
        return json.load(roster_file)


def _load_teams() -> list[dict[str, Any]]:
    if not TEAMS_FILE.exists():
        return []
    with open(TEAMS_FILE, encoding="utf-8") as teams_file:
        teams = json.load(teams_file)
    changed = False
    global_settings = _load_global_season_dict()
    for team in teams:
        if not isinstance(team.get("season_settings"), dict):
            team["season_settings"] = dict(global_settings)
            changed = True
    if changed:
        _save_teams(teams)
    return teams


def _load_global_season_dict() -> dict[str, Any]:
    try:
        with open(ROOT / SEASON_FILE, encoding="utf-8") as season_file:
            return json.load(season_file)
    except (OSError, ValueError):
        return {}


def _find_team(team_id: str | None = None) -> dict[str, Any]:
    teams = _load_teams()
    team = next((item for item in teams if item.get("id") == team_id), None) if team_id else next(
        (item for item in teams if item.get("active")), None
    )
    if team is None:
        raise ValueError("Team was not found. Select or activate a team first.")
    return team


def _load_team_roster(team: dict[str, Any]):
    return load_roster_from_data(
        [{"name": name} for name in team.get("players", [])],
        team.get("season_roster", []),
    )


def _season_from_team(team: dict[str, Any]) -> SeasonSetup:
    season = SeasonSetup.from_dict(team.get("season_settings", _load_global_season_dict()))
    formation_error = season.validate_formation()
    if formation_error:
        raise ValueError(formation_error)
    return season


def _season_response(season: SeasonSetup) -> dict[str, Any]:
    return {
        **season.to_dict(),
        "formation_options": FORMATIONS_BY_FORMAT,
        "position_rows": _position_rows(season.formation, has_goalkeeper=False),
    }


def _save_teams(teams: list[dict[str, Any]]) -> None:
    with open(TEAMS_FILE, "w", encoding="utf-8") as teams_file:
        json.dump(teams, teams_file, indent=2)


def _default_season_roster(player_names: list[str]) -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "group": "rotational",
            "general_positions": [],
            "primary_positions": [],
            "backup_positions": [],
            "excluded_positions": [],
        }
        for name in player_names
    ]


def _serialize_result(result) -> dict[str, Any]:
    return {
        "blocks": result.timeline,
        "block_counts": result.block_counts,
        "gk_summary": result.gk_summary,
        "position_summary": result.position_summary,
        "metadata": result.metadata,
        "warnings": result.warnings,
        "errors": result.errors,
    }


def _position_rows(formation: str, has_goalkeeper: bool = True) -> list[dict[str, Any]]:
    if formation == "4-2-3-1":
        rows = [
            {"label": "FORWARDS", "positions": ["F"]},
            {"label": "ATTACKING MIDFIELDERS", "positions": ["LAM", "CAM", "RAM"]},
            {"label": "DEFENSIVE MIDFIELDERS", "positions": ["LDM", "RDM"]},
            {"label": "DEFENDERS", "positions": ["LB", "LCB", "RCB", "RB"]},
        ]
        if has_goalkeeper:
            rows.append({"label": "GOALKEEPER", "positions": ["GK"]})
        return rows

    slots = formation_slots(parse_formation(formation))
    labels = {"F": "FORWARDS", "M": "MIDFIELDERS", "D": "DEFENDERS"}
    rows = [
        {"label": labels[group], "positions": slots[group]}
        for group in ("F", "M", "D")
        if slots[group]
    ]
    if has_goalkeeper:
        rows.append({"label": "GOALKEEPER", "positions": ["GK"]})
    return rows


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/teams")
def get_teams() -> dict[str, Any]:
    try:
        return {"teams": _load_teams()}
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=500, detail=f"Unable to load teams: {error}") from error


@app.get("/schedules")
def get_saved_schedules(team_id: str | None = None) -> dict[str, Any]:
    try:
        team = _find_team(team_id)
        return {"team_id": team["id"], "team_name": team["name"], "schedules": team.get("saved_schedules", [])}
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=500, detail=f"Unable to load saved schedules: {error}") from error


@app.post("/schedules")
def save_schedule(request: SavedScheduleRequest) -> dict[str, Any]:
    try:
        teams = _load_teams()
        team = next((item for item in teams if item.get("id") == request.schedule.get("team_id")), None)
        if team is None:
            raise ValueError("Team was not found.")
        name = request.name.strip()
        if not name:
            raise ValueError("Schedule name is required.")
        saved_schedules = team.setdefault("saved_schedules", [])
        used_ids = {item.get("id") for item in saved_schedules}
        next_number = 1
        while f"schedule-{next_number}" in used_ids:
            next_number += 1
        saved_schedule = {
            "id": f"schedule-{next_number}",
            "name": name,
            "game_number": request.schedule.get("game_number", 1),
            "created_at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
            "schedule": request.schedule,
        }
        saved_schedules.append(saved_schedule)
        _save_teams(teams)
        return saved_schedule
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.patch("/schedules/{schedule_id}")
def rename_saved_schedule(schedule_id: str, request: SavedScheduleRenameRequest, team_id: str | None = None) -> dict[str, Any]:
    try:
        teams = _load_teams()
        team = next((item for item in teams if item.get("id") == team_id), None) if team_id else next((item for item in teams if item.get("active")), None)
        if team is None:
            raise ValueError("Team was not found.")
        name = request.name.strip()
        if not name:
            raise ValueError("Schedule name is required.")
        saved_schedule = next((item for item in team.get("saved_schedules", []) if item.get("id") == schedule_id), None)
        if saved_schedule is None:
            raise ValueError("Saved schedule was not found.")
        saved_schedule["name"] = name
        _save_teams(teams)
        return saved_schedule
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.delete("/schedules/{schedule_id}")
def delete_saved_schedule(schedule_id: str, team_id: str | None = None) -> dict[str, str]:
    try:
        teams = _load_teams()
        team = next((item for item in teams if item.get("id") == team_id), None) if team_id else next((item for item in teams if item.get("active")), None)
        if team is None:
            raise ValueError("Team was not found.")
        saved_schedules = team.get("saved_schedules", [])
        remaining = [item for item in saved_schedules if item.get("id") != schedule_id]
        if len(remaining) == len(saved_schedules):
            raise ValueError("Saved schedule was not found.")
        team["saved_schedules"] = remaining
        _save_teams(teams)
        return {"message": "Saved schedule deleted."}
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.get("/game-reports")
def get_game_reports(team_id: str | None = None) -> dict[str, Any]:
    try:
        team = _find_team(team_id)
        reports = sorted(team.get("game_reports", []), key=lambda item: item.get("created_at", ""), reverse=True)
        return {"team_id": team["id"], "team_name": team["name"], "reports": reports}
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=500, detail=f"Unable to load after-game reports: {error}") from error


@app.post("/game-reports")
def save_game_report(request: GameReportRequest) -> dict[str, Any]:
    try:
        teams = _load_teams()
        requested_team_id = request.report.get("team_id")
        team = next((item for item in teams if item.get("id") == requested_team_id), None) if requested_team_id else next((item for item in teams if item.get("active")), None)
        if team is None:
            raise ValueError("Team was not found.")
        reports = team.setdefault("game_reports", [])
        used_ids = {item.get("id") for item in reports}
        next_number = 1
        while f"report-{next_number}" in used_ids:
            next_number += 1
        saved_report = {"id": f"report-{next_number}", **request.report, "team_id": team["id"], "team_name": team["name"]}
        reports.append(saved_report)
        _save_teams(teams)
        return saved_report
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.patch("/game-reports/{report_id}")
def rename_game_report(report_id: str, request: SavedScheduleRenameRequest, team_id: str | None = None) -> dict[str, Any]:
    try:
        teams = _load_teams()
        team = next((item for item in teams if item.get("id") == team_id), None) if team_id else next((item for item in teams if item.get("active")), None)
        if team is None:
            raise ValueError("Team was not found.")
        name = request.name.strip()
        if not name:
            raise ValueError("Report name is required.")
        report = next((item for item in team.get("game_reports", []) if item.get("id") == report_id), None)
        if report is None:
            raise ValueError("After-game report was not found.")
        report["name"] = name
        _save_teams(teams)
        return report
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.delete("/game-reports/{report_id}")
def delete_game_report(report_id: str, team_id: str | None = None) -> dict[str, str]:
    try:
        teams = _load_teams()
        team = next((item for item in teams if item.get("id") == team_id), None) if team_id else next((item for item in teams if item.get("active")), None)
        if team is None:
            raise ValueError("Team was not found.")
        reports = team.get("game_reports", [])
        remaining = [item for item in reports if item.get("id") != report_id]
        if len(remaining) == len(reports):
            raise ValueError("After-game report was not found.")
        team["game_reports"] = remaining
        _save_teams(teams)
        return {"message": "After-game report deleted."}
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.get("/season-totals")
def get_season_totals(team_id: str | None = None) -> dict[str, Any]:
    try:
        team = _find_team(team_id)
        totals: dict[str, dict[str, Any]] = {}
        for report in team.get("game_reports", []):
            for player_report in report.get("players", []):
                player = player_report.get("player")
                if not player:
                    continue
                blocks_played = player_report.get("blocksPlayed", 0)
                minutes_played = player_report.get("minutesPlayed")
                block_lengths = report.get("block_lengths_minutes", [])
                if (not isinstance(minutes_played, (int, float)) or minutes_played == 0) and blocks_played and block_lengths and len(set(block_lengths)) == 1:
                    minutes_played = blocks_played * block_lengths[0]
                total = totals.setdefault(player, {"player": player, "blocksPlayed": 0, "minutesPlayed": 0, "positions": {}, "games": 0})
                total["blocksPlayed"] += blocks_played
                total["minutesPlayed"] += minutes_played if isinstance(minutes_played, (int, float)) else 0
                total["games"] += 1 if blocks_played else 0
                for position, count in player_report.get("positions", {}).items():
                    total["positions"][position] = total["positions"].get(position, 0) + count
        return {"team_id": team["id"], "team_name": team["name"], "players": sorted(totals.values(), key=lambda item: item["player"])}
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=500, detail=f"Unable to load season totals: {error}") from error


@app.post("/teams")
def create_team(request: TeamCreateRequest) -> dict[str, Any]:
    team_name = request.name.strip()
    player_names = [player.strip() for player in request.players if player.strip()]
    normalized_names = [player.casefold() for player in player_names]
    if not team_name:
        raise HTTPException(status_code=422, detail="Team name is required.")
    if len(set(normalized_names)) != len(normalized_names):
        raise HTTPException(status_code=422, detail="Player names must be unique.")
    if not player_names:
        raise HTTPException(status_code=422, detail="Enter at least one player name.")
    try:
        teams = _load_teams()
        if any(team["name"].casefold() == team_name.casefold() for team in teams):
            raise ValueError("A team with that name already exists.")
        used_ids = {team.get("id") for team in teams}
        next_team_number = 1
        while f"team-{next_team_number}" in used_ids:
            next_team_number += 1
        team_id = f"team-{next_team_number}"
        team = {
            "id": team_id,
            "name": team_name,
            "players": player_names,
            "season_roster": _default_season_roster(player_names),
            "season_settings": _load_global_season_dict(),
            "active": False,
        }
        teams.append(team)
        _save_teams(teams)
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return team


@app.put("/teams/{team_id}")
def update_team(team_id: str, request: TeamCreateRequest) -> dict[str, Any]:
    team_name = request.name.strip()
    player_names = [player.strip() for player in request.players if player.strip()]
    normalized_names = [player.casefold() for player in player_names]
    if not team_name:
        raise HTTPException(status_code=422, detail="Team name is required.")
    if len(set(normalized_names)) != len(normalized_names):
        raise HTTPException(status_code=422, detail="Player names must be unique.")
    if not player_names:
        raise HTTPException(status_code=422, detail="Enter at least one player name.")
    try:
        teams = _load_teams()
        selected_team = next((team for team in teams if team["id"] == team_id), None)
        if selected_team is None:
            raise ValueError("Team was not found.")
        if any(team["id"] != team_id and team["name"].casefold() == team_name.casefold() for team in teams):
            raise ValueError("A team with that name already exists.")

        existing_rules = {
            player["name"].casefold(): player
            for player in selected_team.get("season_roster", [])
        }
        if selected_team.get("active") and not existing_rules:
            existing_rules = {
                player["name"].casefold(): player
                for player in _load_season_roster()
            }
        season_roster = []
        for name in player_names:
            existing_player = existing_rules.get(name.casefold())
            season_roster.append({
                **(existing_player or _default_season_roster([name])[0]),
                "name": name,
            })

        selected_team["name"] = team_name
        selected_team["players"] = player_names
        selected_team["season_roster"] = season_roster
        if selected_team.get("active"):
            with open(ROOT / DEFAULT_ROSTER_FILE, "w", encoding="utf-8") as roster_file:
                json.dump([{"name": name} for name in player_names], roster_file, indent=2)
            with open(ROOT / DEFAULT_SEASON_ROSTER_FILE, "w", encoding="utf-8") as season_roster_file:
                json.dump(season_roster, season_roster_file, indent=2)
        _save_teams(teams)
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return selected_team


@app.put("/teams/{team_id}/activate")
def activate_team(team_id: str) -> dict[str, Any]:
    try:
        teams = _load_teams()
        selected_team = next((team for team in teams if team["id"] == team_id), None)
        if selected_team is None:
            raise ValueError("Team was not found.")
        if not selected_team.get("season_roster"):
            existing_roster = _load_season_roster()
            existing_names = {player["name"].casefold() for player in existing_roster}
            selected_names = {name.casefold() for name in selected_team["players"]}
            selected_team["season_roster"] = existing_roster if existing_names == selected_names else _default_season_roster(selected_team["players"])
        for team in teams:
            team["active"] = team["id"] == team_id
        with open(ROOT / DEFAULT_ROSTER_FILE, "w", encoding="utf-8") as roster_file:
            json.dump([{"name": name} for name in selected_team["players"]], roster_file, indent=2)
        with open(ROOT / DEFAULT_SEASON_ROSTER_FILE, "w", encoding="utf-8") as season_roster_file:
            json.dump(selected_team["season_roster"], season_roster_file, indent=2)
        _save_teams(teams)
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return selected_team


@app.delete("/teams/{team_id}")
def delete_team(team_id: str) -> dict[str, str]:
    try:
        teams = _load_teams()
        selected_team = next((team for team in teams if team.get("id") == team_id), None)
        if selected_team is None:
            raise HTTPException(status_code=404, detail="Team was not found.")
        teams = [team for team in teams if team.get("id") != team_id]
        active_team = teams[0] if teams else None
        for team in teams:
            team["active"] = team is active_team
        if active_team is not None:
            with open(ROOT / DEFAULT_ROSTER_FILE, "w", encoding="utf-8") as roster_file:
                json.dump([{"name": name} for name in active_team["players"]], roster_file, indent=2)
            with open(ROOT / DEFAULT_SEASON_ROSTER_FILE, "w", encoding="utf-8") as season_roster_file:
                json.dump(active_team.get("season_roster", []), season_roster_file, indent=2)
        else:
            with open(ROOT / DEFAULT_ROSTER_FILE, "w", encoding="utf-8") as roster_file:
                json.dump([], roster_file, indent=2)
            with open(ROOT / DEFAULT_SEASON_ROSTER_FILE, "w", encoding="utf-8") as season_roster_file:
                json.dump([], season_roster_file, indent=2)
        _save_teams(teams)
    except HTTPException:
        raise
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {
        "message": f"{selected_team['name']} was deleted.",
        "active_team_id": active_team["id"] if active_team else "",
    }


@app.get("/season")
def get_season(team_id: str | None = None) -> dict[str, Any]:
    try:
        return _season_response(_season_from_team(_find_team(team_id)))
    except (OSError, KeyError, ValueError) as error:
        raise HTTPException(status_code=500, detail=f"Unable to load season settings: {error}") from error


@app.put("/season")
def update_season(request: SeasonSettingsRequest) -> dict[str, Any]:
    try:
        season = SeasonSetup(
            game_length_minutes=request.game_length_minutes,
            game_format=request.game_format,
            total_blocks=request.total_blocks,
            formation=request.formation,
            total_games=request.total_games,
            substitution_alert=request.substitution_alert,
            substitution_warning_seconds=request.substitution_warning_seconds,
        )
        formation_error = season.validate_formation()
        if formation_error:
            raise ValueError(formation_error)
        teams = _load_teams()
        selected_team = next(
            (team for team in teams if team.get("id") == request.team_id), None
        ) if request.team_id else next((team for team in teams if team.get("active")), None)
        if selected_team is None:
            raise ValueError("Team was not found. Select or activate a team first.")
        selected_team["season_settings"] = season.to_dict()
        _save_teams(teams)
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return _season_response(season)


@app.get("/roster")
def get_roster(team_id: str | None = None) -> dict[str, Any]:
    try:
        return {"players": _find_team(team_id).get("season_roster", [])}
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=500, detail=f"Unable to load season roster: {error}") from error


@app.put("/roster")
def update_roster(request: RosterUpdateRequest) -> dict[str, Any]:
    try:
        teams = _load_teams()
        selected_team = next(
            (team for team in teams if team.get("id") == request.team_id), None
        ) if request.team_id else next((team for team in teams if team.get("active")), None)
        if selected_team is None:
            raise ValueError("Team was not found. Select or activate a team first.")
        base_roster = _load_team_roster(selected_team)
        expected_names = {player.name.casefold() for player in base_roster}
        normalized_players = []
        seen_names = set()
        valid_groups = {"core", "developing", "rotational"}
        for player in request.players:
            name = player.name.strip()
            group = player.group.strip().lower()
            if name.casefold() in seen_names:
                raise ValueError(f"Duplicate player: {name}")
            if name.casefold() not in expected_names:
                raise ValueError(f"Unknown player: {name}")
            if group not in valid_groups:
                raise ValueError(f"Unsupported group: {player.group}")
            seen_names.add(name.casefold())
            normalized_players.append({
                "name": name,
                "group": group,
                "general_positions": [position.strip().upper() for position in player.general_positions if position.strip()],
                "primary_positions": [position.strip().upper() for position in player.primary_positions if position.strip()],
                "backup_positions": [position.strip().upper() for position in player.backup_positions if position.strip()],
                "excluded_positions": [position.strip().upper() for position in player.excluded_positions if position.strip()],
            })
        if seen_names != expected_names:
            raise ValueError("Season roster must include every player in the team roster.")
        selected_team["season_roster"] = normalized_players
        _save_teams(teams)
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return {"players": normalized_players}


@app.post("/schedule")
def create_schedule(request: ScheduleRequest) -> dict[str, Any]:
    try:
        team = _find_team(request.team_id)
        roster = _load_team_roster(team)
        season = _season_from_team(team)
    except (OSError, KeyError, ValueError) as error:
        raise HTTPException(status_code=500, detail=f"Unable to load season data: {error}") from error

    if season is None:
        raise HTTPException(status_code=500, detail="No valid season setup is configured.")

    players_by_name = {player.name.casefold(): player for player in roster}
    requested_names = [name.strip() for name in request.available_player_names]
    normalized_names = {name.casefold() for name in requested_names if name}
    unknown_names = sorted(
        name for name in requested_names if name and name.casefold() not in players_by_name
    )
    if unknown_names:
        raise HTTPException(status_code=422, detail=f"Unknown player(s): {', '.join(unknown_names)}")
    if len(normalized_names) < season.players_on_field:
        raise HTTPException(
            status_code=422,
            detail=f"At least {season.players_on_field} available players are required.",
        )

    available_roster = [player for player in roster if player.name.casefold() in normalized_names]
    available_names = {player.name.casefold() for player in available_roster}
    eligible_gk_names = {
        player.name.casefold()
        for player in available_roster
        if "GK" in player.primary_positions
    }
    for label, goalkeeper_name in (("first-half", request.first_half_gk), ("second-half", request.second_half_gk)):
        if goalkeeper_name is None:
            continue
        normalized_goalkeeper = goalkeeper_name.strip().casefold()
        if normalized_goalkeeper not in available_names:
            raise HTTPException(status_code=422, detail=f"Selected {label} goalkeeper must be available.")
        if normalized_goalkeeper not in eligible_gk_names:
            raise HTTPException(status_code=422, detail=f"Selected {label} goalkeeper is not marked GK eligible.")
    game = game_from_season(
        season,
        game_number=request.game_number,
        first_half_gk=request.first_half_gk,
        second_half_gk=request.second_half_gk,
        allow_emergency_positions=False,
    )
    result = run_rotation_engine(game, available_roster)
    block_start_minutes = []
    elapsed_minutes = 0.0
    for block_length in season.block_lengths_minutes:
        block_start_minutes.append(elapsed_minutes)
        elapsed_minutes += block_length
    return {
        "team_id": team.get("id"),
        "team_name": team.get("name"),
        "game_number": request.game_number,
        "available_player_names": [player.name for player in available_roster],
        "block_start_minutes": block_start_minutes,
        "block_lengths_minutes": season.block_lengths_minutes,
        "substitution_alert": season.substitution_alert,
        "substitution_warning_seconds": season.substitution_warning_seconds,
        "position_rows": _position_rows(season.formation, season.has_goalkeeper),
        **_serialize_result(result),
    }