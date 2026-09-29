# Offline Migration Map

This document records the step-2 boundary between the current Python/FastAPI
application and the offline TypeScript/SQLite application. The TypeScript
implementation under `mobile/src/engine` is the production and behavioral
source of truth. The Python implementation is retained only for legacy tooling
and migration reference; it must not drive production behavior or gate
TypeScript changes.

## Locked Scheduling Policy

The TypeScript engine applies this scheduling priority, while preserving legal
positional and goalkeeper coverage at every step:

1. Legal positional and goalkeeper coverage
2. Hard-minimum deficits
3. Lowest current field totals
4. Group urgency
5. Continuity and rest fairness
6. Intended targets and soft maximums
7. Deterministic name tie-breaker

The policy contracts are:

- `hard_maximum_blocks` is an absolute limit unless an explicit override
  relaxes it.
- `maximum_blocks` is an intended soft ceiling.
- Exceeding an intended maximum is allowed only when required for coverage or
  explicitly overridden.
- Emergency assignments may exceed intended maximums when necessary and must
  remain visible in result warnings.
- Core, Core A, and Core B share one 70% target; there is no A/B target
  rotation policy.
- An availability change applies starting with its specified block. Completed
  blocks remain frozen, and a returning player receives no automatic make-up
  quota credit.

## Python Responsibilities

| Current module | Responsibility | Future TypeScript owner |
| --- | --- | --- |
| `rotation_engine/models.py` | `Player`, `Game`, and `RotationResult` state | `mobile/src/engine/models.ts` |
| `rotation_engine/season.py` | Formats, formations, season validation, block timing | `mobile/src/engine/season.ts` |
| `rotation_engine/positional.py` | Position tiers, eligibility, emergency-position rules | `mobile/src/engine/positional.ts` |
| `rotation_engine/quotas.py` | Playing-time targets and hard block limits | `mobile/src/engine/quotas.ts` |
| `rotation_engine/timeline.py` | Formation parsing, slot assignment, goalkeeper selection, timeline regeneration | `mobile/src/engine/timeline.ts` |
| `rotation_engine/surplus.py` | Block counts, goalkeeper summaries, position summaries, warnings, errors | `mobile/src/engine/surplus.ts` |
| `rotation_engine/gk.py` | Reserved goalkeeper module; current logic lives in timeline/quotas | `mobile/src/engine/goalkeeper.ts` when extracted |
| `simulator.py` | Roster normalization, season-to-game conversion, engine orchestration, mid-game changes | `mobile/src/engine/rotation.ts` plus local services |
| `api.py` | HTTP transport, JSON persistence, request validation, team/report transformations | `mobile/src/storage/*` and `mobile/src/services/*`; FastAPI routes are not ported |

## Orchestration Boundary

The core scheduling call is:

```text
Game + Player[]
  -> compute_block_targets
  -> build_timeline
  -> compute_surplus
  -> RotationResult
```

The TypeScript equivalent should accept ordinary objects and return ordinary
objects. It must preserve the current output shape, including timeline blocks,
`block_counts`, `gk_summary`, `position_summary`, `metadata`, `warnings`, and
`errors`.

## API-to-Local Service Map

| Current API behavior | Current mobile callers | Future local owner |
| --- | --- | --- |
| `GET/PUT /roster` | `game.tsx`, `roster.tsx`, `coverage.tsx`, `position-assignment.tsx` | `team-service.ts` |
| `GET/PUT /season` | `settings.tsx`, `coverage.tsx`, `position-assignment.tsx` | `team-service.ts` |
| `GET/POST/PUT/DELETE /teams` and activation | `index.tsx`, `team-create.tsx`, `saved-teams.tsx`, `team-edit.tsx` | `team-service.ts` |
| `POST /schedule` | `game.tsx` | `schedule-service.ts` calling the local engine |
| `GET/POST/PATCH/DELETE /schedules` | `saved-schedules.tsx`, `schedule.tsx` | `schedule-service.ts` |
| `GET/POST/PATCH/DELETE /game-reports` | `after-game.tsx`, `saved-after-game-reports.tsx` | `report-service.ts` |
| `GET /season-totals` | `season-totals.tsx` | `report-service.ts` or `analytics-service.ts` |

`mobile/src/team-api.ts` is currently the shared HTTP client and active-team
notification point. During the migration, its active-team behavior should be
preserved while its HTTP implementation is replaced by local service calls.
The final app must not require `EXPO_PUBLIC_API_URL`.

## Port Order

1. Models and stable types
2. Season formats and validation
3. Positional rules and constants
4. Quotas
5. Timeline, slot assignment, and goalkeeper behavior
6. Surplus and summary aggregation
7. Rotation orchestration and mid-game regeneration
8. SQLite storage and team/roster service
9. Schedule service
10. Report and season-total service
11. Screen call-site replacement

## Behavior Contracts

- Preserve deterministic output for the same inputs and season seed.
- Preserve formation slot names and block ordering.
- Preserve goalkeeper half-game assignment and the `NO GK AVAILABLE` sentinel.
- Preserve player-group quota targets and hard minimum/maximum bounds.
- Preserve primary, general, backup, excluded, and emergency position rules.
- Preserve frozen blocks when regenerating after availability changes.
- Preserve the rule that a returning player does not receive make-up quota time.
- Preserve active-team switching and complete roster enrichment.
- Preserve schedule/report rename and delete behavior.
- Preserve warnings and errors instead of silently dropping them.

## Known Risks

- `simulator.py` combines input normalization, season conversion, and engine orchestration; these need separate TypeScript boundaries.
- `rotation_engine/gk.py` is currently empty, while goalkeeper behavior is distributed across timeline and quota logic.
- Team activation currently synchronizes multiple JSON files; SQLite transactions must replace that multi-file update safely.
- Saved schedules and reports are nested in team persistence and must become independently queryable by `team_id`.
- The retired Python oracle fingerprints must be replaced by TypeScript
  fingerprints whose expected outputs are derived from the locked scheduling
  policy and verified against the TypeScript engine.