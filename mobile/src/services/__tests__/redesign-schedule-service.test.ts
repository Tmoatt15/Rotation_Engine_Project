import { beforeEach, describe, expect, it, vi } from 'vitest';

import { assignQuotas, buildDemandModel, normalizeGame, runStages3And4 } from '@/engine-redesign';
import type { RedesignGameInput, RedesignPlayerInput, WaterfillRotationState } from '@/engine-redesign/model';
import type { SeasonRosterPlayer, SeasonSettings } from '@/engine/models';
import { generateRedesignSchedule, regenerateRedesignLateArrival } from '../redesign-schedule-service';
import type { LateArrivalReplanInput, LateArrivalReplanResult } from '@/engine-redesign/stage5';
import type { PolishedPlacement } from '@/engine-redesign/stage4';

const mocks = vi.hoisted(() => ({
  getLocalTeam: vi.fn(),
  getRoster: vi.fn(),
  getSeasonSettings: vi.fn(),
  getSavedReports: vi.fn(),
  getDatabase: vi.fn(),
  getWaterfillRotationState: vi.fn(),
  saveWaterfillRotationState: vi.fn(),
  replanLateArrival: vi.fn(),
}));

vi.mock('@/engine-redesign', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine-redesign')>();
  return { ...actual, runStages3And4: vi.fn() };
});
vi.mock('@/engine-redesign/stage5', () => ({ replanLateArrival: mocks.replanLateArrival }));
vi.mock('../team-service', () => ({
  getLocalTeam: mocks.getLocalTeam,
  getRoster: mocks.getRoster,
  getSeasonSettings: mocks.getSeasonSettings,
}));
vi.mock('../report-service', () => ({ getSavedReports: mocks.getSavedReports }));
vi.mock('@/storage/database', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('@/storage/waterfill-rotation', () => ({
  getWaterfillRotationState: mocks.getWaterfillRotationState,
  saveWaterfillRotationState: mocks.saveWaterfillRotationState,
}));

function rosterPlayer(
  name: string,
  group: SeasonRosterPlayer['group'],
  generalPositions: string[],
  options: { primaryPositions?: string[]; backupPositions?: string[]; keeperEligible?: boolean } = {},
): SeasonRosterPlayer {
  return {
    name,
    group,
    general_positions: generalPositions,
    primary_positions: options.primaryPositions ?? [],
    backup_positions: options.backupPositions ?? [],
    excluded_positions: [],
    keeper_eligible: options.keeperEligible,
  };
}

const rotationRoster: SeasonRosterPlayer[] = [
  rosterPlayer('Avery', 'rotational', ['M'], { primaryPositions: ['M'], keeperEligible: true }),
  rosterPlayer('Brooklyn', 'core', ['M'], { primaryPositions: ['CM'], backupPositions: ['D'] }),
  rosterPlayer('Dolce', 'rotational', ['D'], { primaryPositions: ['ANY'] }),
  rosterPlayer('Emma', 'rotational', ['F'], { primaryPositions: ['LF'] }),
  rosterPlayer('Kelsey', 'core', ['F'], { primaryPositions: ['ANY'], backupPositions: ['D'] }),
  rosterPlayer('Maddie', 'core', ['F'], { primaryPositions: ['RF'], keeperEligible: true }),
  rosterPlayer('Madelyn', 'rotational', ['M'], { primaryPositions: ['CM'], backupPositions: ['F'] }),
  rosterPlayer('Meg', 'rotational', ['D'], { primaryPositions: ['ANY'], backupPositions: ['M'] }),
  rosterPlayer('Natalie', 'rotational', ['D'], { primaryPositions: ['LB'] }),
  rosterPlayer('Rachel', 'rotational', ['F'], { primaryPositions: ['ANY'], backupPositions: ['M'] }),
  rosterPlayer('Reese', 'rotational', ['M'], { primaryPositions: ['ANY'], backupPositions: ['F'] }),
  rosterPlayer('Selma', 'rotational', ['M'], { primaryPositions: ['ANY'] }),
  rosterPlayer('Sophia', 'core', ['D'], { primaryPositions: ['CB'] }),
];

function settingsFor(totalBlocks: number): SeasonSettings {
  return {
    game_length_minutes: totalBlocks * 10,
    game_format: '9v9',
    total_blocks: totalBlocks,
    block_length_minutes: 10,
    formation: '3-3-2',
    total_games: 1,
    substitution_alert: 'none',
    substitution_warning_seconds: 30,
  };
}

function abundanceRoster(): SeasonRosterPlayer[] {
  return [
    ...Array.from({ length: 5 }, (_, index) => ({
      ...rosterPlayer(`Core D${index + 1}`, 'core', ['D']),
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      ...rosterPlayer(`Core M${index + 1}`, 'core', ['M']),
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      ...rosterPlayer(`Core F${index + 1}`, 'core', ['F']),
    })),
    rosterPlayer('Keeper A', 'rotational', [], { keeperEligible: true }),
    rosterPlayer('Keeper B', 'rotational', [], { keeperEligible: true }),
  ];
}

function redesignPlayers(roster: SeasonRosterPlayer[]): RedesignPlayerInput[] {
  return roster.map((player) => ({
    name: player.name,
    group: player.group,
    general_positions: player.general_positions ?? [],
    primary_positions: player.primary_positions ?? [],
    backup_positions: player.backup_positions ?? [],
    excluded_positions: player.excluded_positions ?? [],
    keeper_eligible: player.keeper_eligible === true,
    keeper: player.keeper_eligible === true && (player.general_positions ?? []).every((position) => position === 'NONE' || position === 'GK'),
  }));
}

function placement(complete: boolean, errors: string[] = []): PolishedPlacement {
  return {
    blocks: [],
    complete,
    audit: {
      restPins: [],
      softRestFallback: false,
      outOfPositionBlocks: {},
      errors,
      failureReason: complete ? undefined : 'no-eligible-player',
    },
    metrics: { maxCoreBenches: 0, maxBoundaryTurnovers: 0, restWindowViolations: 0 },
  };
}

function configureService(roster: SeasonRosterPlayer[], totalBlocks: number, rotation: WaterfillRotationState = {}): void {
  mocks.getLocalTeam.mockResolvedValue({ id: 'team-1', name: 'Test Team' });
  mocks.getRoster.mockResolvedValue({ players: roster });
  mocks.getSeasonSettings.mockResolvedValue(settingsFor(totalBlocks));
  mocks.getSavedReports.mockResolvedValue([]);
  mocks.getDatabase.mockResolvedValue({});
  mocks.getWaterfillRotationState.mockResolvedValue(rotation);
  mocks.saveWaterfillRotationState.mockResolvedValue(undefined);
  mocks.replanLateArrival.mockImplementation((input: LateArrivalReplanInput): LateArrivalReplanResult => ({
    kind: 'success',
    placement: placement(true),
    quotas: input.quotas,
    donorReductions: [],
    keeperFlexed: false,
  }));
  vi.mocked(runStages3And4).mockReturnValue(placement(true));
}

function lateArrivalInput(
  roster: SeasonRosterPlayer[],
  playerName: string,
  startBlock: number,
  targetBlocks: number,
  firstHalfGk = 'Avery',
  secondHalfGk = 'Maddie',
) {
  return {
    teamId: 'team-1',
    gameNumber: 3,
    previousSchedule: { game_number: 3, blocks: [] },
    availablePlayerNames: roster.map((player) => player.name),
    playerName,
    startBlock,
    targetBlocks,
    firstHalfGk,
    secondHalfGk,
  };
}

function gameInput(roster: SeasonRosterPlayer[], totalBlocks: number, rotation: WaterfillRotationState, lateArrival?: RedesignGameInput['lateArrival']): RedesignGameInput {
  return {
    format: '9v9',
    formation: '3-3-2',
    totalBlocks,
    availablePlayerNames: roster.map((player) => player.name),
    firstHalfKeeper: 'Avery',
    secondHalfKeeper: 'Maddie',
    seasonHistory: {},
    seasonRotation: rotation,
    lateArrival,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('redesign schedule service', () => {
  it('surfaces quota audit errors after a successful late-arrival re-plan', async () => {
    const roster: SeasonRosterPlayer[] = [
      rosterPlayer('Defender', 'core', ['D']),
      rosterPlayer('Forward', 'core', ['F']),
      rosterPlayer('Keeper A', 'rotational', [], { keeperEligible: true }),
      rosterPlayer('Keeper B', 'rotational', [], { keeperEligible: true }),
    ];
    configureService(roster, 6);

    await expect(regenerateRedesignLateArrival(lateArrivalInput(roster, 'Forward', 5, 2, 'Keeper A', 'Keeper B')))
      .rejects.toMatchObject({
        name: 'RedesignOfferError',
        offer: {
          kind: 'position-shortage',
          message: expect.stringMatching(/Warning: Defender group \(D\) is short \d+ players\. Add a D backup to a player\./),
          buttons: [
            { label: 'SUGGEST', action: 'suggest-backup' },
            { label: 'Cancel', action: 'cancel' },
          ],
          context: expect.objectContaining({ failureType: 'waterfill-underfill', positionGroup: 'D' }),
        },
      });
    expect(mocks.replanLateArrival).toHaveBeenCalledOnce();
    expect(mocks.saveWaterfillRotationState).not.toHaveBeenCalled();
  });

  it('includes abundance relaxation in the late-arrival warnings', async () => {
    const roster = abundanceRoster();
    configureService(roster, 6);

    const result = await regenerateRedesignLateArrival(lateArrivalInput(roster, 'Core F1', 5, 2, 'Keeper A', 'Keeper B'));
    const warning = result.warnings.find((entry) => entry.startsWith('Minimums relaxed for:'));

    expect(warning).toContain('Core D1 (4 -> 3 blocks)');
    expect(warning?.match(/Core D1/g)).toHaveLength(1);
  });

  it('passes persisted rotation tiebreaks into the service late-arrival re-plan', async () => {
    const roster = rotationRoster;
    const players = redesignPlayers(roster);
    const initialGame = normalizeGame(gameInput(roster, 8, {}), players);
    const originalRotation = assignQuotas(initialGame, buildDemandModel(initialGame)).rotationState ?? {};
    const lateArrival = { player: 'Emma', arrivalBlock: 7, targetBlocks: 2 };
    const expectedGame = normalizeGame(gameInput(roster, 8, originalRotation, lateArrival), players);
    const expectedQuotas = assignQuotas(expectedGame, buildDemandModel(expectedGame));
    const noRotationGame = normalizeGame(gameInput(roster, 8, {}, lateArrival), players);
    const noRotationQuotas = assignQuotas(noRotationGame, buildDemandModel(noRotationGame));
    configureService(roster, 8, originalRotation);

    await regenerateRedesignLateArrival(lateArrivalInput(roster, 'Emma', 7, 2));

    expect(expectedQuotas.rotationState).not.toEqual(noRotationQuotas.rotationState);
    expect(mocks.replanLateArrival).toHaveBeenCalledWith(expect.objectContaining({
      quotas: expect.objectContaining({ rotationState: expectedQuotas.rotationState }),
    }));
    expect(mocks.saveWaterfillRotationState).toHaveBeenCalledWith(
      expect.anything(), 'team-1', 3, expectedQuotas.rotationState,
    );
  });

  it('offers relaxed minimum consent only after a clean quota audit and complete placement', async () => {
    const roster: SeasonRosterPlayer[] = [
      ...Array.from({ length: 7 }, (_, index) => rosterPlayer(`Core D${index + 1}`, 'core', ['D'])),
      ...Array.from({ length: 4 }, (_, index) => rosterPlayer(`Core M${index + 1}`, 'core', ['M'])),
      ...Array.from({ length: 3 }, (_, index) => rosterPlayer(`Core F${index + 1}`, 'core', ['F'])),
      rosterPlayer('Keeper A', 'rotational', ['M'], { keeperEligible: true }),
      rosterPlayer('Keeper B', 'rotational', ['M'], { keeperEligible: true }),
    ];
    configureService(roster, 6);

    await expect(generateRedesignSchedule({
      teamId: 'team-1',
      gameNumber: 3,
      availablePlayerNames: roster.map((player) => player.name),
      firstHalfGk: 'Keeper A',
      secondHalfGk: 'Keeper B',
    })).rejects.toMatchObject({
      name: 'RedesignOfferError',
      offer: {
        kind: 'relaxed-minimums',
        message: expect.stringContaining('below their minimum playing-time floor'),
        buttons: [
          { label: 'Generate', action: 'allow-relaxed' },
          { label: 'Cancel', action: 'cancel' },
        ],
        context: {
          failureType: 'relaxed-minimums',
          players: expect.arrayContaining([
            expect.objectContaining({ player: 'Core D1', belowHardFloor: true }),
          ]),
        },
      },
    });
    expect(runStages3And4).toHaveBeenCalledTimes(2);
  });

  it('does not offer Generate when the relaxed placement trial is incomplete', async () => {
    const roster = abundanceRoster();
    configureService(roster, 6);
    vi.mocked(runStages3And4).mockReturnValue(placement(false, ['Unfilled slot: Block 1, slot D1.']));

    await expect(generateRedesignSchedule({
      teamId: 'team-1',
      gameNumber: 3,
      availablePlayerNames: roster.map((player) => player.name),
      firstHalfGk: 'Keeper A',
      secondHalfGk: 'Keeper B',
    })).rejects.toMatchObject({
      name: 'RedesignOfferError',
      offer: {
        kind: 'impossible',
        buttons: [{ label: 'Cancel', action: 'cancel' }],
        context: { failureType: 'waterfill-placement-failed' },
      },
    });
    expect(runStages3And4).toHaveBeenCalledTimes(2);
  });

  it('reports water-fill placement failures as engine errors, not relaxed-minimum offers', async () => {
    const roster = abundanceRoster();
    configureService(roster, 6);
    vi.mocked(runStages3And4).mockReturnValue(placement(false, ['Unfilled slot: Block 1, slot D1.']));

    await expect(generateRedesignSchedule({
      teamId: 'team-1',
      gameNumber: 3,
      availablePlayerNames: roster.map((player) => player.name),
      firstHalfGk: 'Keeper A',
      secondHalfGk: 'Keeper B',
      allowRelaxedMinimums: true,
    })).rejects.toMatchObject({
      name: 'RedesignOfferError',
      offer: {
        kind: 'impossible',
        message: expect.stringContaining('Water-fill placement failed in Stage 3 for group D'),
        buttons: [{ label: 'Cancel', action: 'cancel' }],
        context: expect.objectContaining({
          failureType: 'waterfill-placement-failed',
          stage: 'Stage 3',
          group: 'D',
        }),
      },
    });
  });
});
