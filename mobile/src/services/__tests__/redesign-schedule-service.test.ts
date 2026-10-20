import { beforeEach, describe, expect, it, vi } from 'vitest';

import { assignQuotas, buildDemandModel, normalizeGame, runStages3And4 } from '@/engine-redesign';
import type { RedesignGameInput, RedesignPlayerInput, WaterfillRotationState } from '@/engine-redesign/model';
import type { SeasonRosterPlayer, SeasonSettings } from '@/engine/models';
import { generateRedesignSchedule, RedesignOfferError, regenerateRedesignLateArrival, suggestBackupPlayerNames } from '../redesign-schedule-service';
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

function placementWithFieldLoad(totalBlocks: number, player: string, group: 'D' | 'M' | 'F', fieldBlocks: number): PolishedPlacement {
  const slotByGroup = { D: 'CB', M: 'CM', F: 'LF' } as const;
  return {
    ...placement(true),
    blocks: Array.from({ length: totalBlocks }, (_, index) => ({
      block: index + 1,
      assignments: new Map(index < fieldBlocks ? [[slotByGroup[group], player]] : []),
    })),
  };
}

function mockRestRiskOffer(
  totalBlocks: number,
  atRiskPlayer: string,
  group: 'D' | 'M' | 'F',
  atRiskFieldBlocks: number,
  qualifyingNames: string[],
): void {
  vi.mocked(runStages3And4)
    .mockReturnValueOnce(placement(false))
    .mockReturnValueOnce(placement(false))
    .mockReturnValueOnce(placementWithFieldLoad(totalBlocks, atRiskPlayer, group, atRiskFieldBlocks))
    .mockImplementation((game) => {
      const candidate = game.players.find((player) =>
        qualifyingNames.includes(player.name) && player.backupPositions.includes(group));
      return candidate
        ? placementWithFieldLoad(totalBlocks, candidate.name, group, 1)
        : placement(true);
    });
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
  it('suggests only backups whose relaxed quota and dry-run placement use the target group', async () => {
    configureService(rotationRoster, 8);
    vi.mocked(runStages3And4).mockImplementation((game) => ({
      ...placement(true),
      blocks: game.players.some((player) => player.name === 'Dolce' && player.backupPositions.includes('M'))
        ? [{ block: 1, assignments: new Map([['CM', 'Dolce']]) }]
        : [],
    }));
    const availablePlayerNames = rotationRoster
      .filter((player) => player.name !== 'Emma' && player.name !== 'Madelyn')
      .map((player) => player.name);

    const suggestions = await suggestBackupPlayerNames({
      teamId: 'team-1',
      gameNumber: 1,
      availablePlayerNames,
      firstHalfGk: 'Avery',
      secondHalfGk: 'Maddie',
      group: 'M',
    });

    expect(suggestions).toContain('Dolce');
    expect(suggestions).not.toContain('Natalie');
  });

  it('does not suggest backups when no player reaches the field-rest threshold', async () => {
    configureService(rotationRoster, 8);
    const availablePlayerNames = rotationRoster
      .filter((player) => player.name !== 'Emma' && player.name !== 'Madelyn')
      .map((player) => player.name);

    await expect(generateRedesignSchedule({
      teamId: 'team-1',
      gameNumber: 1,
      availablePlayerNames,
      firstHalfGk: 'Avery',
      secondHalfGk: 'Maddie',
    })).rejects.toMatchObject({
      name: 'RedesignOfferError',
      offer: {
        kind: 'relaxed-maximums',
        message: expect.stringContaining('Can\'t fit normal playing time.'),
        buttons: [
          { label: 'Generate Relaxed', action: 'allow-relaxed-maximums' },
          { label: 'Cancel', action: 'cancel' },
        ],
        context: expect.objectContaining({
          failureType: 'relaxed-maximums',
          maximumCapacityShortfall: 4,
        }),
      },
    });
  });

  it('does not offer a backup when a rest alert has no qualifying candidates', async () => {
    configureService(rotationRoster, 8);
    mockRestRiskOffer(8, 'Brooklyn', 'D', 7, []);
    const availablePlayerNames = rotationRoster
      .filter((player) => player.name !== 'Emma' && player.name !== 'Madelyn')
      .map((player) => player.name);

    await expect(generateRedesignSchedule({
      teamId: 'team-1',
      gameNumber: 1,
      availablePlayerNames,
      firstHalfGk: 'Avery',
      secondHalfGk: 'Maddie',
    })).rejects.toMatchObject({
      offer: {
        kind: 'relaxed-maximums',
        buttons: [
          { label: 'Generate Relaxed', action: 'allow-relaxed-maximums' },
          { label: 'Cancel', action: 'cancel' },
        ],
        context: expect.objectContaining({
          positionGroup: 'D',
          suggestedPlayerNames: [],
        }),
      },
    });
  });

  it('recomputes qualified backups after a saved backup changes the roster', async () => {
    const availablePlayerNames = rotationRoster
      .filter((player) => player.name !== 'Emma' && player.name !== 'Madelyn')
      .map((player) => player.name);
    const updatedRoster = rotationRoster.map((player) => player.name === 'Selma'
      ? { ...player, backup_positions: [...player.backup_positions, 'D'] }
      : player);
    configureService(rotationRoster, 8);
    mockRestRiskOffer(8, 'Brooklyn', 'D', 7, ['Selma']);

    await expect(generateRedesignSchedule({
      teamId: 'team-1',
      gameNumber: 1,
      availablePlayerNames,
      firstHalfGk: 'Avery',
      secondHalfGk: 'Maddie',
    })).rejects.toMatchObject({
      offer: {
        buttons: expect.arrayContaining([{ label: 'Suggest Backup', action: 'suggest-backup' }]),
        context: expect.objectContaining({ suggestedPlayerNames: ['Selma'] }),
      },
    });

    vi.mocked(runStages3And4).mockReset();
    configureService(updatedRoster, 8);
    mockRestRiskOffer(8, 'Brooklyn', 'D', 7, ['Selma']);

    await expect(generateRedesignSchedule({
      teamId: 'team-1',
      gameNumber: 1,
      availablePlayerNames,
      firstHalfGk: 'Avery',
      secondHalfGk: 'Maddie',
    })).rejects.toMatchObject({
      offer: {
        buttons: [
          { label: 'Generate Relaxed', action: 'allow-relaxed-maximums' },
          { label: 'Cancel', action: 'cancel' },
        ],
        context: expect.objectContaining({ suggestedPlayerNames: [] }),
      },
    });
    expect(mocks.getRoster).toHaveBeenCalledTimes(2);
  });

  it('offers a different qualifying backup after the saved player is excluded', async () => {
    const roster = rotationRoster.map((player) => player.name === 'Reese'
      ? { ...player, backup_positions: [...player.backup_positions, 'D'] }
      : player);
    const availablePlayerNames = roster
      .filter((player) => player.name !== 'Emma' && player.name !== 'Madelyn')
      .map((player) => player.name);
    configureService(roster, 8);
    mockRestRiskOffer(8, 'Brooklyn', 'D', 7, ['Reese', 'Selma']);

    await expect(generateRedesignSchedule({
      teamId: 'team-1',
      gameNumber: 1,
      availablePlayerNames,
      firstHalfGk: 'Avery',
      secondHalfGk: 'Maddie',
    })).rejects.toMatchObject({
      offer: {
        buttons: expect.arrayContaining([{ label: 'Suggest Backup', action: 'suggest-backup' }]),
        context: expect.objectContaining({ suggestedPlayerNames: ['Selma'] }),
      },
    });
  });

  it.each([6, 8, 10, 12])('suggests a backup for a non-keeper with at least totalBlocks - 1 field blocks (%d blocks)', async (totalBlocks) => {
    configureService(rotationRoster, totalBlocks);
    mockRestRiskOffer(totalBlocks, 'Brooklyn', 'M', totalBlocks - 1, ['Dolce']);
    const availablePlayerNames = rotationRoster
      .filter((player) => player.name !== 'Emma' && player.name !== 'Madelyn')
      .map((player) => player.name);
    const hasQualifyingBackup = totalBlocks <= 8;

    await expect(generateRedesignSchedule({
      teamId: 'team-1',
      gameNumber: 1,
      availablePlayerNames,
      firstHalfGk: 'Avery',
      secondHalfGk: 'Maddie',
    })).rejects.toMatchObject({
      name: 'RedesignOfferError',
      offer: {
        kind: 'relaxed-maximums',
        buttons: [
          ...(hasQualifyingBackup ? [{ label: 'Suggest Backup', action: 'suggest-backup' }] : []),
          { label: 'Generate Relaxed', action: 'allow-relaxed-maximums' },
          { label: 'Cancel', action: 'cancel' },
        ],
        context: expect.objectContaining({
          positionGroup: 'M',
          positionGroupWarning: expect.stringContaining(`Brooklyn (${totalBlocks - 1}/${totalBlocks} field blocks)`),
          suggestedPlayerNames: hasQualifyingBackup ? ['Dolce'] : [],
        }),
      },
    });
  });

  it.each([6, 8, 10, 12])('uses totalBlocks / 2 for the keeper field-rest threshold (%d blocks)', async (totalBlocks) => {
    configureService(rotationRoster, totalBlocks);
    mockRestRiskOffer(totalBlocks, 'Avery', 'M', totalBlocks / 2, ['Dolce']);
    const availablePlayerNames = rotationRoster
      .filter((player) => player.name !== 'Emma' && player.name !== 'Madelyn')
      .map((player) => player.name);
    const hasQualifyingBackup = totalBlocks <= 8;

    await expect(generateRedesignSchedule({
      teamId: 'team-1',
      gameNumber: 1,
      availablePlayerNames,
      firstHalfGk: 'Avery',
      secondHalfGk: 'Maddie',
    })).rejects.toMatchObject({
      name: 'RedesignOfferError',
      offer: {
        kind: 'relaxed-maximums',
        buttons: [
          ...(hasQualifyingBackup ? [{ label: 'Suggest Backup', action: 'suggest-backup' }] : []),
          { label: 'Generate Relaxed', action: 'allow-relaxed-maximums' },
          { label: 'Cancel', action: 'cancel' },
        ],
        context: expect.objectContaining({
          positionGroup: 'M',
          positionGroupWarning: expect.stringContaining(`Avery (${totalBlocks / 2}/${totalBlocks / 2} field blocks)`),
          suggestedPlayerNames: hasQualifyingBackup ? ['Dolce'] : [],
        }),
      },
    });
  });

  it('does not suggest a half-keeper backup when one field block is available for rest', async () => {
    configureService(rotationRoster, 8);
    vi.mocked(runStages3And4)
      .mockReturnValueOnce(placement(false))
      .mockReturnValueOnce(placement(false))
      .mockReturnValueOnce(placementWithFieldLoad(8, 'Avery', 'M', 3));
    const availablePlayerNames = rotationRoster
      .filter((player) => player.name !== 'Emma' && player.name !== 'Madelyn')
      .map((player) => player.name);

    await expect(generateRedesignSchedule({
      teamId: 'team-1',
      gameNumber: 1,
      availablePlayerNames,
      firstHalfGk: 'Avery',
      secondHalfGk: 'Maddie',
    })).rejects.toMatchObject({
      name: 'RedesignOfferError',
      offer: {
        kind: 'relaxed-maximums',
        buttons: [
          { label: 'Generate Relaxed', action: 'allow-relaxed-maximums' },
          { label: 'Cancel', action: 'cancel' },
        ],
      },
    });
  });

  it('generates with relaxed maximums and explains the playing-time change', async () => {
    configureService(rotationRoster, 8);
    const availablePlayerNames = rotationRoster
      .filter((player) => player.name !== 'Emma' && player.name !== 'Madelyn')
      .map((player) => player.name);

    const result = await generateRedesignSchedule({
      teamId: 'team-1',
      gameNumber: 1,
      availablePlayerNames,
      firstHalfGk: 'Avery',
      secondHalfGk: 'Maddie',
      allowRelaxedMaximums: true,
    });

    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/^Playing time relaxed to fit \d+ available players \(maximums increased for \d+\)\.$/),
    ]));
    expect(result.engine_source).toBe('redesign');
  });

  it('delivers the repaired Dolce/Reese schedule through the service', async () => {
    configureService(rotationRoster, 8);
    const engine = await vi.importActual<typeof import('@/engine-redesign')>('@/engine-redesign');
    vi.mocked(runStages3And4).mockImplementation(engine.runStages3And4);
    const availablePlayerNames = rotationRoster
      .filter((player) => player.name !== 'Dolce' && player.name !== 'Reese')
      .map((player) => player.name);

    const result = await generateRedesignSchedule({
      teamId: 'team-1',
      gameNumber: 1,
      availablePlayerNames,
      firstHalfGk: 'Avery',
      secondHalfGk: 'Maddie',
      allowRelaxedMaximums: true,
    });

    expect(result.engine_source).toBe('redesign');
    expect(result.placement_audit?.repair).toMatchObject({ attempted: true, success: true });
    expect(result.placement_audit?.errors.some((error) => error.startsWith('Cannot place minimum'))).toBe(false);
  });

  it('generates for Dolce/Meg absence or reports a truthful D shortfall', async () => {
    configureService(rotationRoster, 8);
    const engine = await vi.importActual<typeof import('@/engine-redesign')>('@/engine-redesign');
    vi.mocked(runStages3And4).mockImplementation(engine.runStages3And4);
    const availablePlayerNames = rotationRoster
      .filter((player) => player.name !== 'Dolce' && player.name !== 'Meg')
      .map((player) => player.name);

    try {
      const result = await generateRedesignSchedule({
        teamId: 'team-1',
        gameNumber: 1,
        availablePlayerNames,
        firstHalfGk: 'Avery',
        secondHalfGk: 'Maddie',
        allowRelaxedMaximums: true,
      });
      expect(result.engine_source).toBe('redesign');
      expect(result.placement_audit?.errors.some((error) => error.startsWith('Cannot place minimum'))).toBe(false);
    } catch (error) {
      if (!(error instanceof RedesignOfferError)) throw error;
      const offer = error.offer;
      expect(offer.context.positionGroup).toBe('D');
      expect(offer.message).toContain('Relaxed generation failed:');
      expect(offer.message).not.toContain('Cannot place minimum');
    }
  });

  it('names the forward group for an unfilled RF slot', async () => {
    const roster = abundanceRoster();
    configureService(roster, 6);
    const game = normalizeGame({
      format: '9v9',
      formation: '3-3-2',
      totalBlocks: 6,
      firstHalfKeeper: 'Keeper A',
      secondHalfKeeper: 'Keeper B',
    }, redesignPlayers(roster));
    const demand = buildDemandModel(game);
    vi.mocked(runStages3And4).mockReturnValue({
      ...placement(false, ['Unfilled slot: Block 1, slot RF.']),
      blocks: Array.from({ length: game.totalBlocks }, (_, index) => ({
        block: index + 1,
        assignments: new Map(demand.fieldSlots
          .filter((slot) => slot.slot !== 'RF')
          .map((slot) => [slot.slot, 'assigned'])),
      })),
    });

    await expect(generateRedesignSchedule({
      teamId: 'team-1',
      gameNumber: 1,
      availablePlayerNames: roster.map((player) => player.name),
      firstHalfGk: 'Keeper A',
      secondHalfGk: 'Keeper B',
      allowRelaxedMaximums: true,
    })).rejects.toMatchObject({
      name: 'RedesignOfferError',
      offer: {
        kind: 'relaxed-maximums',
        context: expect.objectContaining({
          failureType: 'relaxed-maximums-failed',
          positionGroup: 'F',
        }),
        message: expect.stringContaining('Unfilled slot: Block 1, slot RF.'),
      },
    });
  });

  it('reports insufficient total player capacity after a successful late-arrival re-plan', async () => {
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
          message: expect.stringContaining('Can\'t fit normal playing time for this late-arrival change.'),
          buttons: [{ label: 'Cancel', action: 'cancel' }],
          context: expect.objectContaining({
            failureType: 'late-arrival-maximum-capacity',
            maximumCapacityShortfall: 41,
          }),
        },
      });
    expect(mocks.replanLateArrival).toHaveBeenCalledOnce();
    expect(mocks.saveWaterfillRotationState).not.toHaveBeenCalled();
  });

  it('keeps group-specific diagnostics when no backup passes the dry run', async () => {
    const roster = [
      ...Array.from({ length: 12 }, (_, index) =>
        rosterPlayer(`Defender ${index + 1}`, 'rotational', ['D'], { primaryPositions: ['ANY'] })),
      rosterPlayer('Keeper A', 'rotational', [], { keeperEligible: true }),
      rosterPlayer('Keeper B', 'rotational', [], { keeperEligible: true }),
    ];
    configureService(roster, 6);

    await expect(generateRedesignSchedule({
      teamId: 'team-1',
      gameNumber: 1,
      availablePlayerNames: roster.map((player) => player.name),
      firstHalfGk: 'Keeper A',
      secondHalfGk: 'Keeper B',
    })).rejects.toMatchObject({
      name: 'RedesignOfferError',
      offer: {
        kind: 'relaxed-maximums',
        message: expect.stringContaining('Relaxed generation failed: Midfield group (M)'),
        buttons: [
          { label: 'Cancel', action: 'cancel' },
        ],
        context: expect.objectContaining({
          failureType: 'relaxed-maximums-failed',
          positionGroup: 'M',
          positionGroupWarning: expect.stringContaining('Add an M backup and try again.'),
          suggestedPlayerNames: [],
        }),
      },
    });
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

  it('requires a backup when relaxed generation cannot fill a position', async () => {
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
        kind: 'relaxed-maximums',
        buttons: [
          { label: 'Cancel', action: 'cancel' },
        ],
        context: {
          failureType: 'relaxed-maximums-failed',
          positionGroup: 'D',
        },
      },
    });
    expect(runStages3And4).toHaveBeenCalledTimes(3);
  });

  it('offers a backup when an explicitly requested relaxed generation fails', async () => {
    const roster = abundanceRoster();
    configureService(roster, 6);
    vi.mocked(runStages3And4).mockReturnValue(placement(false, ['Unfilled slot: Block 1, slot D1.']));

    await expect(generateRedesignSchedule({
      teamId: 'team-1',
      gameNumber: 3,
      availablePlayerNames: roster.map((player) => player.name),
      firstHalfGk: 'Keeper A',
      secondHalfGk: 'Keeper B',
      allowRelaxedMaximums: true,
    })).rejects.toMatchObject({
      name: 'RedesignOfferError',
      offer: {
        kind: 'relaxed-maximums',
        buttons: [
          { label: 'Cancel', action: 'cancel' },
        ],
        context: { failureType: 'relaxed-maximums-failed', positionGroup: 'D' },
      },
    });
  });
});
