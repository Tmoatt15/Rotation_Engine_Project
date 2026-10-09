import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { calculateMovementMetrics } from '@/engine/timeline';
import { createPlayer } from '@/engine/rotation';
import { filterStaleQuotaWarnings } from '@/engine/surplus';
import type { Player } from '@/engine/models';
import { setAcceptedSchedule, type LiveSchedule } from '@/live-schedule';
import { saveLocalSchedule } from '@/services/schedule-service';
import { getRoster } from '@/services/team-service';

const palette = {
  ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1',
  green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c', halftime: '#496a78', halftimeSoft: '#e7eff2', halftimeLine: '#9ab3bd',
};
function displayPlayerName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

type ScheduleBlock = { positions: Record<string, string>; bench: string[]; GK: string; [key: string]: unknown };
type PositionRow = { label: string; positions: string[] };

type ScheduleData = {
  team_id?: string;
  team_name?: string;
  game_number: number;
  available_player_names: string[];
  block_start_minutes?: number[];
  block_lengths_minutes?: number[];
  substitution_alert?: LiveSchedule['substitution_alert'];
  substitution_warning_seconds?: number;
  position_rows?: PositionRow[];
  blocks: ScheduleBlock[];
  warnings: string[];
  errors: string[];
  movement_metrics?: import('@/engine/models').MovementMetrics;
  review_status?: 'generated' | 'generated_with_errors' | 'manually_edited';
};

type SelectedPosition = { blockIndex: number; position: string };

function normalizePosition(position: string): string {
  return { LOB: 'LB', ROB: 'RB' }[position] ?? position;
}

function parseSchedule(value: string | string[] | undefined): ScheduleData | null {
  if (!value || Array.isArray(value)) return null;
  try {
    const parsed = JSON.parse(value) as ScheduleData;
    return {
      ...parsed,
      position_rows: parsed.position_rows?.map((row) => ({
        ...row,
        positions: row.positions.map(normalizePosition),
      })),
      blocks: parsed.blocks.map((block) => ({
        ...block,
        positions: Object.fromEntries(
          Object.entries(block.positions ?? {}).map(([position, player]) => [normalizePosition(position), player]),
        ),
      })),
    };
  } catch { return null; }
}

function formatSubstitutionTime(minutes: number): string {
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
}

function countPlayerBlocks(playerNames: string[], blocks: ScheduleBlock[]): Array<[string, number]> {
  const counts = new Map(playerNames.map((player) => [player, 0]));
  blocks.forEach((block) => {
    const playersInBlock = new Set(Object.values(block.positions ?? {}));
    playersInBlock.forEach((player) => {
      counts.set(player, (counts.get(player) ?? 0) + 1);
    });
  });
  return [...counts.entries()].sort(([firstName, firstCount], [secondName, secondCount]) => {
    if (firstCount !== secondCount) return secondCount - firstCount;
    return firstName.split(/\s+/)[0].localeCompare(secondName.split(/\s+/)[0]);
  });
}

const fallbackPositionRows: PositionRow[] = [
  { label: 'FORWARDS', positions: ['LF', 'RF'] },
  { label: 'MIDFIELDERS', positions: ['LM', 'LCM', 'RCM', 'RM'] },
  { label: 'DEFENDERS', positions: ['LB', 'LCB', 'RCB', 'RB'] },
  { label: 'GOALKEEPER', positions: ['GK'] },
];
const positionRowOrder = [
  'FORWARDS',
  'ATTACKING MIDFIELDERS',
  'MIDFIELDERS',
  'DEFENSIVE MIDFIELDERS',
  'DEFENDERS',
  'GOALKEEPER',
];

function playerHighlight(
  blocks: ScheduleBlock[],
  blockNumber: number,
  position: string,
  player: string,
): 'subbedIn' | 'positionChanged' | null {
  if (blockNumber === 1 || blockNumber === Math.ceil(blocks.length / 2) + 1) return null;
  const currentBlock = blocks[blockNumber - 1];
  const previousBlock = blocks[blockNumber - 2];
  const previousPositions = Object.entries(previousBlock.positions ?? {});
  const wasOnField = previousPositions.some(([, previousPlayer]) => previousPlayer === player);
  const cameFromBench = previousBlock.bench?.includes(player) ?? false;
  if (!wasOnField && cameFromBench) return 'subbedIn';

  const previousPosition = previousPositions.find(([, previousPlayer]) => previousPlayer === player)?.[0];
  if (previousPosition && currentBlock.positions[position] === player && previousPosition !== position) {
    return 'positionChanged';
  }
  return null;
}

function playerCameOffField(blocks: ScheduleBlock[], blockIndex: number, player: string): boolean {
  if (blockIndex === 0 || blockIndex === Math.ceil(blocks.length / 2)) return false;
  const previousPositions = Object.values(blocks[blockIndex - 1].positions ?? {});
  return previousPositions.includes(player) && blocks[blockIndex].bench?.includes(player) === true;
}

export default function ScheduleScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ data?: string }>();
  const schedule = useMemo(() => parseSchedule(params.data), [params.data]);
  const positionRows = useMemo(() => {
    const rows = schedule?.position_rows?.length ? schedule.position_rows : fallbackPositionRows;
    return [...rows].sort((firstRow, secondRow) => positionRowOrder.indexOf(firstRow.label) - positionRowOrder.indexOf(secondRow.label));
  }, [schedule]);
  const positionOrder = new Set(positionRows.flatMap((row) => row.positions));
  const [blocks, setBlocks] = useState<ScheduleBlock[]>(schedule?.blocks ?? []);
  const [selectedPosition, setSelectedPosition] = useState<SelectedPosition | null>(null);
  const [showPlayerBlocks, setShowPlayerBlocks] = useState(false);
  const [showSaveSchedule, setShowSaveSchedule] = useState(false);
  const [scheduleName, setScheduleName] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [hasManualChanges, setHasManualChanges] = useState(false);
  const [showHardErrors, setShowHardErrors] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);
  const [showReviewDiagnostics, setShowReviewDiagnostics] = useState(false);
  const [roster, setRoster] = useState<Player[]>([]);
  const additionalPlayerWarnings = useMemo(
    () => (schedule?.warnings ?? []).filter((warning) => /^Please assign \d+ more /.test(warning)),
    [schedule],
  );
  const otherWarnings = useMemo(
    () => filterStaleQuotaWarnings(
      (schedule?.warnings ?? []).filter((warning) => !/^Please assign \d+ more /.test(warning)),
      blocks as unknown as import('@/engine/models').ScheduleBlock[],
      roster,
    ),
    [blocks, roster, schedule],
  );
  const playerBlockCounts = useMemo(
    () => countPlayerBlocks(schedule?.available_player_names ?? [], blocks),
    [blocks, schedule],
  );

  useEffect(() => {
    if (!schedule) router.replace('/game');
  }, [router, schedule]);

  useEffect(() => {
    let active = true;
    if (!schedule?.team_id) return () => { active = false; };
    getRoster(schedule.team_id).then((response) => {
      if (active) setRoster(response.players.map(createPlayer));
    }).catch(() => {
      if (active) setRoster([]);
    });
    return () => { active = false; };
  }, [schedule?.team_id]);

  useEffect(() => {
    setBlocks(schedule?.blocks ?? []);
    setSelectedPosition(null);
    setHasManualChanges(false);
  }, [schedule]);

  const movementSlots = useMemo(() => {
    const groups = { D: [] as string[], M: [] as string[], F: [] as string[] };
    for (const row of positionRows) {
      const group = row.label.includes('DEFENDER') ? 'D' : row.label.includes('MIDFIELD') ? 'M' : row.label.includes('FORWARD') ? 'F' : null;
      if (group) groups[group].push(...row.positions.filter((position) => position !== 'GK'));
    }
    return groups;
  }, [positionRows]);
  const movementMetrics = useMemo(
    () => calculateMovementMetrics(blocks as unknown as import('@/engine/models').ScheduleBlock[], blocks.length, roster, movementSlots),
    [blocks, movementSlots, roster],
  );

  function handlePositionPress(blockIndex: number, position: string) {
    if (position === 'GK') return;
    if (!selectedPosition) {
      setSelectedPosition({ blockIndex, position });
      return;
    }
    if (selectedPosition.blockIndex !== blockIndex) {
      setSelectedPosition(null);
      return;
    }
    if (selectedPosition.position === position) {
      setSelectedPosition(null);
      return;
    }

    setBlocks((currentBlocks) => {
      const nextBlocks = currentBlocks.map((block) => ({
        ...block,
        positions: { ...block.positions },
      }));
      const sourcePosition = selectedPosition.position;
      const movedPlayer = nextBlocks[blockIndex].positions[sourcePosition];
      const targetPlayer = nextBlocks[blockIndex].positions[position];

      nextBlocks[blockIndex].positions[sourcePosition] = targetPlayer;
      nextBlocks[blockIndex].positions[position] = movedPlayer;

      for (let nextIndex = blockIndex + 1; nextIndex < nextBlocks.length; nextIndex += 1) {
        const nextBlock = nextBlocks[nextIndex];
        if (nextBlock.positions[sourcePosition] !== movedPlayer || !nextBlock.positions[position]) break;
        nextBlock.positions[sourcePosition] = nextBlock.positions[position];
        nextBlock.positions[position] = movedPlayer;
      }

      return nextBlocks;
    });
    setHasManualChanges(true);
    setSelectedPosition(null);
  }

  async function saveSchedule() {
    const name = scheduleName.trim();
    if (!name || !schedule) {
      setSaveError('Enter a name for this schedule.');
      return;
    }
    setSavingSchedule(true);
    setSaveError(null);
    try {
      await saveLocalSchedule(name, { ...schedule, blocks: blocks as unknown as LiveSchedule['blocks'], movement_metrics: movementMetrics, review_status: hasManualChanges ? 'manually_edited' : schedule.errors.length ? 'generated_with_errors' : 'generated' } as unknown as import('@/engine/models').LiveSchedule);
      setScheduleName('');
      setShowSaveSchedule(false);
      router.replace('/');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Unable to save schedule.');
    } finally {
      setSavingSchedule(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <Pressable onPress={() => router.navigate('/game')} style={styles.backButton} accessibilityLabel="Back to availability">
                <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} />
              </Pressable>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>GAME {schedule?.game_number ?? 1} · {schedule?.errors.length ? 'GENERATED WITH ERRORS' : 'GENERATED'}</Text>
                <Text style={styles.title}>{schedule?.team_name ? `${schedule.team_name} Schedule Review` : 'Schedule review'}</Text>
              </View>
              <View style={styles.countBadge}>
                <Text style={styles.countValue}>{blocks.length}</Text>
                <Text style={styles.countLabel}>blocks</Text>
              </View>
            </View>

            {!schedule ? (
              <View style={styles.emptyCard}><Text style={styles.emptyText}>No schedule data was provided.</Text></View>
            ) : (
              <>
                <View style={styles.summaryCard}>
                  <View style={styles.summaryIcon}><SymbolView name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }} size={22} tintColor={palette.green} /></View>
                  <View style={styles.summaryCopy}>
                    <Text style={styles.summaryTitle}>{schedule.available_player_names.length} players scheduled</Text>
                    <Text style={styles.summaryDetail}>{selectedPosition ? 'Tap another field player in this block to swap positions.' : 'Tap two field players in the same block to swap positions.'}</Text>
                  </View>
                </View>
                <Pressable
                  onPress={() => setShowReviewDiagnostics((expanded) => !expanded)}
                  style={styles.reviewCard}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showReviewDiagnostics }}>
                  <View style={styles.reviewHeader}>
                    <Text style={styles.reviewTitle}>Review diagnostics</Text>
                    <Text style={[styles.reviewStatus, (hasManualChanges || schedule.errors.length > 0) && styles.reviewStatusManual]}>{hasManualChanges ? 'MANUAL EDITS' : schedule.errors.length ? 'GENERATED WITH ERRORS' : 'VALID'}</Text>
                  </View>
                  {showReviewDiagnostics && <>
                    <View style={styles.metricGrid}>
                      <View style={styles.metricCell}><Text style={styles.metricValue}>{movementMetrics.exact_slot_switches}</Text><Text style={styles.metricLabel}>exact switches</Text></View>
                      <View style={styles.metricCell}><Text style={styles.metricValue}>{movementMetrics.turnovers}</Text><Text style={styles.metricLabel}>slot turnovers</Text></View>
                      <View style={styles.metricCell}><Text style={styles.metricValue}>{movementMetrics.group_switches}</Text><Text style={styles.metricLabel}>group switches</Text></View>
                    </View>
                    <Text style={styles.reviewDetail}>Half 1: {movementMetrics.by_half[0].exact_slot_switches} exact, {movementMetrics.by_half[0].turnovers} turnovers</Text>
                    <Text style={styles.reviewDetail}>Half 2: {movementMetrics.by_half[1].exact_slot_switches} exact, {movementMetrics.by_half[1].turnovers} turnovers</Text>
                    {(movementMetrics.general_assignments > 0 || movementMetrics.backup_assignments > 0 || movementMetrics.emergency_assignments > 0) && <Text style={styles.reviewDetail}>Position quality: {movementMetrics.general_assignments} general, {movementMetrics.backup_assignments} backup, {movementMetrics.emergency_assignments} emergency assignments</Text>}
                  </>}
                </Pressable>
                {additionalPlayerWarnings.length > 0 && <View style={styles.additionalPlayersCard}>
                  <View style={styles.additionalPlayersCopy}>
                    <Text style={styles.issueTitle}>Roster changes needed</Text>
                    {additionalPlayerWarnings.map((warning) => <Text key={warning} style={styles.additionalPlayersText}>{warning}</Text>)}
                  </View>
                  <Pressable
                    onPress={() => router.push('/position-assignment')}
                    style={styles.makeChangesButton}
                    accessibilityRole="button">
                    <Text style={styles.makeChangesButtonText}>Make Changes</Text>
                    <SymbolView name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }} size={17} tintColor={palette.panel} />
                  </Pressable>
                </View>}
                {schedule.errors.length > 0 && <Pressable
                  onPress={() => setShowHardErrors((expanded) => !expanded)}
                  style={styles.issueCard}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showHardErrors }}>
                  <View style={styles.issueHeader}>
                    <Text style={styles.issueTitle}>Hard errors</Text>
                    <SymbolView name={{ ios: showHardErrors ? 'chevron.up' : 'chevron.down', android: showHardErrors ? 'expand_less' : 'expand_more', web: showHardErrors ? 'expand_less' : 'expand_more' }} size={18} tintColor={palette.coral} />
                  </View>
                  {showHardErrors && <Text style={styles.errorText}>{schedule.errors.join(' ')}</Text>}
                </Pressable>}
                {otherWarnings.length > 0 && <Pressable
                  onPress={() => setShowWarnings((expanded) => !expanded)}
                  style={styles.warningCard}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showWarnings }}>
                  <View style={styles.issueHeader}>
                    <Text style={styles.issueTitle}>Warnings</Text>
                    <SymbolView name={{ ios: showWarnings ? 'chevron.up' : 'chevron.down', android: showWarnings ? 'expand_less' : 'expand_more', web: showWarnings ? 'expand_less' : 'expand_more' }} size={18} tintColor="#956d1b" />
                  </View>
                  {showWarnings && <Text style={styles.warningText}>{otherWarnings.join(' ')}</Text>}
                </Pressable>}
                <View style={styles.legend}>
                  <View style={styles.legendItem}><View style={[styles.legendSwatch, styles.subbedInCell]} /><Text style={styles.legendText}>Subbed in</Text></View>
                  <View style={styles.legendItem}><View style={[styles.legendSwatch, styles.positionChangedCell]} /><Text style={styles.legendText}>Position changed</Text></View>
                </View>
                <Pressable
                  onPress={() => setShowPlayerBlocks(true)}
                  style={styles.playerBlocksButton}
                  accessibilityRole="button">
                  <Text style={styles.playerBlocksButtonText}>VIEW PLAYER BLOCKS</Text>
                  <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={18} tintColor={palette.green} />
                </Pressable>
                {blocks.map((block, index) => {
                  const blockNumber = index + 1;
                  const secondHalfIndex = Math.ceil(blocks.length / 2);
                  const secondHalfBlock = secondHalfIndex + 1;
                  const blockTitle = blockNumber === 1
                    ? 'Game Starters'
                    : blockNumber === secondHalfBlock
                      ? 'Second Half Starters'
                      : `Block ${blockNumber}`;
                  const substitutionTime = schedule.block_start_minutes?.[index];
                  const halftimeStart = schedule.block_start_minutes?.[secondHalfIndex] ?? 0;
                  const displayedSubstitutionTime = blockNumber > secondHalfBlock && substitutionTime !== undefined
                    ? substitutionTime - halftimeStart
                    : substitutionTime;
                  return (
                    <View key={`block-${blockNumber}`}>
                      {blockNumber === secondHalfBlock && (
                        <View style={styles.halftimeDivider}>
                          <View style={styles.halftimeLine} />
                          <Text style={styles.halftimeText}>HALFTIME</Text>
                          <View style={styles.halftimeLine} />
                        </View>
                      )}
                      <View style={styles.blockCard}>
                      <View style={styles.blockHeader}>
                          <Text style={styles.blockTitle}>{blockTitle}</Text>
                          {displayedSubstitutionTime !== undefined && blockNumber !== 1 && blockNumber !== secondHalfBlock && <View style={styles.blockTiming}>
                            <SymbolView name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }} size={15} tintColor={palette.green} />
                            <Text style={styles.blockTimingText}>{formatSubstitutionTime(displayedSubstitutionTime)}</Text>
                          </View>}
                      </View>
                      <View style={styles.assignmentList}>
                        {positionRows.map((row) => {
                          const assignments = row.positions
                            .filter((position) => block.positions?.[position])
                            .map((position) => [position, block.positions[position]] as const);
                          if (assignments.length === 0) return null;
                          return (
                            <View key={`${index}-${row.label}`} style={styles.positionRow}>
                              {assignments.map(([position, player]) => (
                                <Pressable
                                  key={`${index}-${position}`}
                                  onPress={() => handlePositionPress(index, position)}
                                  disabled={position === 'GK'}
                                  style={[styles.assignmentCell, playerHighlight(blocks, index + 1, position, player) === 'subbedIn' && styles.subbedInCell, playerHighlight(blocks, index + 1, position, player) === 'positionChanged' && styles.positionChangedCell, selectedPosition?.blockIndex === index && selectedPosition.position === position && styles.assignmentCellSelected]}
                                  accessibilityRole="button"
                                  accessibilityState={{ disabled: position === 'GK', selected: selectedPosition?.blockIndex === index && selectedPosition.position === position }}>
                                  <Text style={styles.positionLabel}>{position}</Text>
                                  <Text style={styles.assignmentName} numberOfLines={1}>{displayPlayerName(player)}</Text>
                                </Pressable>
                              ))}
                            </View>
                          );
                        })}
                        {Object.entries(block.positions ?? {})
                          .filter(([position]) => !positionOrder.has(position))
                          .map(([position, player]) => (
                            <View key={`${index}-${position}`} style={styles.positionRow}>
                              <Pressable
                                onPress={() => handlePositionPress(index, position)}
                                style={[styles.assignmentCell, playerHighlight(blocks, index + 1, position, player) === 'subbedIn' && styles.subbedInCell, playerHighlight(blocks, index + 1, position, player) === 'positionChanged' && styles.positionChangedCell, selectedPosition?.blockIndex === index && selectedPosition.position === position && styles.assignmentCellSelected]}
                                accessibilityRole="button"
                                accessibilityState={{ selected: selectedPosition?.blockIndex === index && selectedPosition.position === position }}>
                                <Text style={styles.positionLabel}>{position}</Text>
                                <Text style={styles.assignmentName} numberOfLines={1}>{displayPlayerName(player)}</Text>
                              </Pressable>
                            </View>
                          ))}
                      </View>
                      <View style={styles.benchList}>
                        <Text style={styles.benchLabel}>BENCH - {block.bench?.length ?? 0} {(block.bench?.length ?? 0) === 1 ? 'player' : 'players'}</Text>
                        <Text style={styles.benchNames}>
                          {block.bench?.length
                            ? block.bench.slice().sort((firstName, secondName) => firstName.localeCompare(secondName)).map((player, playerIndex, sortedBench) => (
                              <Text key={player} style={playerCameOffField(blocks, index, player) ? styles.benchSubbedOutName : undefined}>
                                {displayPlayerName(player)}{playerIndex < sortedBench.length - 1 ? ', ' : ''}
                              </Text>
                            ))
                            : 'None'}
                        </Text>
                      </View>
                      </View>
                    </View>
                  );
                })}
                <Pressable onPress={() => { setSaveError(null); setShowSaveSchedule(true); }} style={styles.saveScheduleButton} accessibilityRole="button">
                  <Text style={styles.saveScheduleText}>SAVE SCHEDULE</Text>
                </Pressable>
                <Pressable
                  onPress={async () => {
                    const acceptedSchedule = { ...schedule, blocks, movement_metrics: movementMetrics, review_status: hasManualChanges ? 'manually_edited' : schedule.errors.length ? 'generated_with_errors' : 'generated' };
                    await setAcceptedSchedule(acceptedSchedule);
                    router.navigate('/live');
                  }}
                  style={styles.acceptButton}
                  accessibilityRole="button">
                  <View>
                    <Text style={styles.acceptEyebrow}>NEXT STEP</Text>
                    <Text style={styles.acceptTitle}>Accept Schedule</Text>
                    <Text style={styles.acceptDetail}>Open live game mode</Text>
                  </View>
                  <SymbolView name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }} size={22} tintColor={palette.panel} />
                </Pressable>
                <Modal
                  visible={showPlayerBlocks}
                  transparent
                  animationType="fade"
                  onRequestClose={() => setShowPlayerBlocks(false)}>
                  <View style={styles.modalOverlay}>
                    <View style={styles.playerBlocksModal}>
                      <Text style={styles.modalEyebrow}>GAME {schedule.game_number}</Text>
                      <Text style={styles.modalTitle}>Player Blocks</Text>
                      <Text style={styles.modalDetail}>Scheduled blocks for this game</Text>
                      <ScrollView style={styles.playerBlockList} showsVerticalScrollIndicator={false}>
                        {playerBlockCounts.map(([player, count]) => (
                          <View key={player} style={styles.playerBlockRow}>
                            <Text style={styles.playerBlockName}>{player}</Text>
                            <Text style={styles.playerBlockCount}>{count} {count === 1 ? 'block' : 'blocks'}</Text>
                          </View>
                        ))}
                      </ScrollView>
                      <Pressable
                        onPress={() => setShowPlayerBlocks(false)}
                        style={styles.exitButton}
                        accessibilityRole="button">
                        <Text style={styles.exitButtonText}>EXIT</Text>
                      </Pressable>
                    </View>
                  </View>
                </Modal>
                <Modal visible={showSaveSchedule} transparent animationType="fade" onRequestClose={() => setShowSaveSchedule(false)}>
                  <View style={styles.modalOverlay}>
                    <View style={styles.saveScheduleModal}>
                      <Text style={styles.modalEyebrow}>SAVE SCHEDULE</Text>
                      <Text style={styles.modalTitle}>Name this schedule</Text>
                      <TextInput
                        value={scheduleName}
                        onChangeText={(value) => { setScheduleName(value); setSaveError(null); }}
                        autoFocus
                        placeholder="Saturday match"
                        placeholderTextColor={palette.muted}
                        style={styles.scheduleNameInput}
                      />
                      {saveError && <Text style={styles.saveError}>{saveError}</Text>}
                      <View style={styles.modalActions}>
                        <Pressable onPress={() => setShowSaveSchedule(false)} style={styles.cancelButton} accessibilityRole="button">
                          <Text style={styles.cancelButtonText}>CANCEL</Text>
                        </Pressable>
                        <Pressable onPress={() => void saveSchedule()} disabled={savingSchedule} style={styles.saveModalButton} accessibilityRole="button">
                          <Text style={styles.saveModalButtonText}>{savingSchedule ? 'SAVING...' : 'SAVE'}</Text>
                        </Pressable>
                      </View>
                    </View>
                  </View>
                </Modal>
              </>
            )}
          </ScrollView>
        </SafeAreaView>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  saveScheduleButton: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.green, borderRadius: 14, borderWidth: 1, marginTop: 16, paddingVertical: 14 },
  saveScheduleText: { color: palette.green, fontSize: 12, fontWeight: '900', letterSpacing: 1 },
  saveScheduleModal: { backgroundColor: palette.panel, borderRadius: 20, padding: 20, width: '100%' },
  scheduleNameInput: { backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 11, borderWidth: 1, color: palette.ink, fontSize: 16, marginTop: 16, paddingHorizontal: 12, paddingVertical: 12 },
  saveError: { color: palette.coral, fontSize: 12, marginTop: 8 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  cancelButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 12, borderWidth: 1, flex: 1, paddingVertical: 13 },
  cancelButtonText: { color: palette.muted, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  saveModalButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 12, flex: 1, paddingVertical: 13 },
  saveModalButtonText: { color: palette.panel, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  playerBlocksButton: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16, paddingHorizontal: 15, paddingVertical: 14 },
  playerBlocksButtonText: { color: palette.green, fontSize: 11, fontWeight: '800', letterSpacing: 1.1 },
  modalOverlay: { alignItems: 'center', backgroundColor: 'rgba(23, 34, 31, 0.55)', flex: 1, justifyContent: 'center', padding: 20 },
  playerBlocksModal: { backgroundColor: palette.panel, borderRadius: 20, maxHeight: '80%', padding: 20, width: '100%' },
  modalEyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  modalTitle: { color: palette.ink, fontSize: 25, fontWeight: '800', marginTop: 5 },
  modalDetail: { color: palette.muted, fontSize: 12, marginTop: 4 },
  playerBlockList: { marginTop: 16 },
  playerBlockRow: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 13 },
  playerBlockName: { color: palette.ink, flex: 1, fontSize: 14, fontWeight: '700' },
  playerBlockCount: { color: palette.green, fontSize: 13, fontWeight: '800' },
  exitButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 12, marginTop: 16, paddingVertical: 14 },
  exitButtonText: { color: palette.panel, fontSize: 12, fontWeight: '800', letterSpacing: 1.2 },
  blockTiming: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  acceptButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 18, flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, minHeight: 88, paddingHorizontal: 18, paddingVertical: 15 },
  acceptEyebrow: { color: '#c7e5d5', fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  acceptTitle: { color: '#fffaf3', fontSize: 19, fontWeight: '800', marginTop: 6 },
  acceptDetail: { color: '#d8eee1', fontSize: 12, marginTop: 4 },
  blockTimingText: { color: palette.green, fontSize: 12, fontWeight: '800' },
  container: { flex: 1, backgroundColor: palette.paper }, safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: BottomTabInset + 24 }, header: { alignItems: 'center', flexDirection: 'row', marginBottom: 22 },
  backButton: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 }, headerCopy: { flex: 1, marginLeft: 13 },
  eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 }, title: { color: palette.ink, fontSize: 28, fontWeight: '800', marginTop: 4 }, countBadge: { alignItems: 'flex-end' }, countValue: { color: palette.green, fontSize: 23, fontWeight: '800' }, countLabel: { color: palette.muted, fontSize: 11, marginTop: 1 },
  summaryCard: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 17, flexDirection: 'row', marginBottom: 20, padding: 15 }, summaryIcon: { alignItems: 'center', backgroundColor: palette.panel, borderRadius: 13, height: 44, justifyContent: 'center', width: 44 }, summaryCopy: { flex: 1, marginLeft: 12 }, summaryTitle: { color: palette.ink, fontSize: 15, fontWeight: '800' }, summaryDetail: { color: palette.muted, fontSize: 12, marginTop: 3 },
  reviewCard: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, marginBottom: 16, padding: 15 }, reviewHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, reviewTitle: { color: palette.ink, fontSize: 15, fontWeight: '800' }, reviewStatus: { color: palette.green, fontSize: 10, fontWeight: '900', letterSpacing: 1 }, reviewStatusManual: { color: palette.coral }, metricGrid: { flexDirection: 'row', gap: 8, marginTop: 14 }, metricCell: { backgroundColor: '#f7f4ed', borderRadius: 10, flex: 1, padding: 10 }, metricValue: { color: palette.green, fontSize: 20, fontWeight: '900' }, metricLabel: { color: palette.muted, fontSize: 10, marginTop: 2 }, reviewDetail: { color: palette.muted, fontSize: 11, marginTop: 8 }, issueCard: { backgroundColor: '#fbe9e4', borderColor: '#e8b4a6', borderRadius: 14, borderWidth: 1, marginBottom: 12, padding: 14 }, warningCard: { backgroundColor: '#fff4d8', borderColor: '#e8cc82', borderRadius: 14, borderWidth: 1, marginBottom: 12, padding: 14 }, additionalPlayersCard: { backgroundColor: palette.greenSoft, borderColor: '#9dc5ae', borderRadius: 14, borderWidth: 1, marginBottom: 12, padding: 14 }, additionalPlayersCopy: { flex: 1 }, additionalPlayersText: { color: palette.green, fontSize: 12, fontWeight: '700', lineHeight: 18, marginTop: 4 }, makeChangesButton: { alignItems: 'center', alignSelf: 'flex-start', backgroundColor: palette.coral, borderRadius: 10, flexDirection: 'row', gap: 7, marginTop: 12, paddingHorizontal: 12, paddingVertical: 10 }, makeChangesButtonText: { color: palette.panel, fontSize: 10, fontWeight: '900', letterSpacing: 0.8 }, issueHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, issueTitle: { color: palette.ink, fontSize: 12, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase' },
  legend: { alignItems: 'center', flexDirection: 'row', gap: 16, marginBottom: 14, paddingHorizontal: 3 }, legendItem: { alignItems: 'center', flexDirection: 'row', gap: 6 }, legendSwatch: { borderRadius: 4, height: 12, width: 12 }, legendText: { color: palette.muted, fontSize: 11, fontWeight: '700' }, benchSubbedOutName: { color: palette.coral },
  halftimeDivider: { alignItems: 'center', backgroundColor: palette.halftimeSoft, borderRadius: 17, flexDirection: 'row', gap: 12, marginBottom: 12, marginTop: 4, paddingHorizontal: 15, paddingVertical: 13 }, halftimeLine: { backgroundColor: palette.halftimeLine, flex: 1, height: 2 }, halftimeText: { color: palette.halftime, fontSize: 14, fontWeight: '800', letterSpacing: 2 }, blockCard: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, marginBottom: 12, overflow: 'hidden' }, blockHeader: { alignItems: 'baseline', backgroundColor: palette.greenSoft, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 15, paddingVertical: 12 }, blockTitle: { color: palette.green, fontSize: 16, fontWeight: '800' }, benchText: { color: palette.muted, fontSize: 11 }, assignmentList: { paddingHorizontal: 15, paddingVertical: 6 }, positionRow: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'center', paddingVertical: 6 }, assignmentCell: { alignItems: 'center', backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 9, borderWidth: 1, minWidth: 0, paddingHorizontal: 4, paddingVertical: 8, width: '22%' }, subbedInCell: { backgroundColor: '#dcebe2', borderColor: palette.green }, positionChangedCell: { backgroundColor: '#f8e5b2', borderColor: '#b4872e' }, assignmentCellSelected: { backgroundColor: '#f6e8c7', borderColor: palette.coral, borderWidth: 2 }, positionLabel: { color: palette.muted, fontSize: 10, fontWeight: '800' }, assignmentName: { color: palette.ink, fontSize: 12, fontWeight: '700', marginTop: 4 }, benchList: { backgroundColor: '#f7f4ed', borderTopColor: palette.line, borderTopWidth: 1, paddingHorizontal: 15, paddingVertical: 11 }, benchLabel: { color: palette.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1 }, benchNames: { color: palette.ink, fontSize: 12, fontWeight: '600', lineHeight: 18, marginTop: 4 }, emptyCard: { backgroundColor: palette.panel, borderRadius: 17, padding: 18 }, emptyText: { color: palette.muted, fontSize: 13 }, warningText: { color: '#956d1b', fontSize: 12, lineHeight: 18, marginTop: 4 }, errorText: { color: palette.coral, fontSize: 12, lineHeight: 18, marginTop: 4 },
});