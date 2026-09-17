import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import LiveScreen from './(tabs)/live';
import { setAcceptedSchedule, type LiveSchedule } from '@/live-schedule';
import { API_URL } from '@/team-api';

const palette = {
  ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1',
  green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c',
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
  const [liveSchedule, setLiveSchedule] = useState<LiveSchedule | null>(null);
  const [showPlayerBlocks, setShowPlayerBlocks] = useState(false);
  const [showSaveSchedule, setShowSaveSchedule] = useState(false);
  const [scheduleName, setScheduleName] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const playerBlockCounts = useMemo(
    () => countPlayerBlocks(schedule?.available_player_names ?? [], blocks),
    [blocks, schedule],
  );

  useEffect(() => {
    if (!schedule) router.replace('/game');
  }, [router, schedule]);

  useEffect(() => {
    setBlocks(schedule?.blocks ?? []);
    setSelectedPosition(null);
    setLiveSchedule(null);
  }, [schedule]);

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
      const response = await fetch(`${API_URL}/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, schedule: { ...schedule, blocks, team_id: schedule.team_id } }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? 'Unable to save schedule.');
      setScheduleName('');
      setShowSaveSchedule(false);
      router.replace('/');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Unable to save schedule.');
    } finally {
      setSavingSchedule(false);
    }
  }

  if (liveSchedule) return <LiveScreen schedule={liveSchedule} onGameEnded={(report) => router.push({ pathname: '/after-game', params: { data: JSON.stringify(report) } })} />;

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
                <Text style={styles.eyebrow}>GAME {schedule?.game_number ?? 1} · GENERATED</Text>
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
                  onPress={() => setShowPlayerBlocks(true)}
                  style={styles.playerBlocksButton}
                  accessibilityRole="button">
                  <Text style={styles.playerBlocksButtonText}>VIEW PLAYER BLOCKS</Text>
                  <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={18} tintColor={palette.green} />
                </Pressable>
                {blocks.map((block, index) => {
                  const blockNumber = index + 1;
                  const blockTitle = blockNumber === 1
                    ? 'Game Starters'
                    : blockNumber === 6
                      ? 'Second Half Starters'
                      : `Block ${blockNumber}`;
                  const substitutionTime = schedule.block_start_minutes?.[index];
                  const halftimeStart = schedule.block_start_minutes?.[5] ?? 0;
                  const displayedSubstitutionTime = blockNumber > 6 && substitutionTime !== undefined
                    ? substitutionTime - halftimeStart
                    : substitutionTime;
                  return (
                    <View key={`block-${blockNumber}`}>
                      {blockNumber === 6 && (
                        <View style={styles.halftimeDivider}>
                          <View style={styles.halftimeLine} />
                          <Text style={styles.halftimeText}>HALFTIME</Text>
                          <View style={styles.halftimeLine} />
                        </View>
                      )}
                      <View style={styles.blockCard}>
                      <View style={styles.blockHeader}>
                          <Text style={styles.blockTitle}>{blockTitle}</Text>
                          {displayedSubstitutionTime !== undefined && blockNumber !== 1 && blockNumber !== 6 && <View style={styles.blockTiming}>
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
                                  style={[styles.assignmentCell, selectedPosition?.blockIndex === index && selectedPosition.position === position && styles.assignmentCellSelected]}
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
                                style={[styles.assignmentCell, selectedPosition?.blockIndex === index && selectedPosition.position === position && styles.assignmentCellSelected]}
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
                        <Text style={styles.benchNames}>{block.bench?.slice().sort((firstName, secondName) => firstName.localeCompare(secondName)).map(displayPlayerName).join(', ') || 'None'}</Text>
                      </View>
                      </View>
                    </View>
                  );
                })}
                {schedule.warnings.length > 0 && <Text style={styles.warningText}>{schedule.warnings.join(' ')}</Text>}
                {schedule.errors.length > 0 && <Text style={styles.errorText}>{schedule.errors.join(' ')}</Text>}
                <Pressable onPress={() => { setSaveError(null); setShowSaveSchedule(true); }} style={styles.saveScheduleButton} accessibilityRole="button">
                  <Text style={styles.saveScheduleText}>SAVE SCHEDULE</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    const acceptedSchedule = { ...schedule, blocks };
                    void setAcceptedSchedule(acceptedSchedule);
                    setLiveSchedule(acceptedSchedule);
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
  halftimeDivider: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 17, flexDirection: 'row', gap: 12, marginBottom: 12, marginTop: 4, paddingHorizontal: 15, paddingVertical: 13 }, halftimeLine: { backgroundColor: '#9dc5ae', flex: 1, height: 2 }, halftimeText: { color: palette.green, fontSize: 14, fontWeight: '800', letterSpacing: 2 }, blockCard: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, marginBottom: 12, overflow: 'hidden' }, blockHeader: { alignItems: 'baseline', backgroundColor: palette.greenSoft, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 15, paddingVertical: 12 }, blockTitle: { color: palette.green, fontSize: 16, fontWeight: '800' }, benchText: { color: palette.muted, fontSize: 11 }, assignmentList: { paddingHorizontal: 15, paddingVertical: 6 }, positionRow: { alignItems: 'center', flexDirection: 'row', gap: 8, justifyContent: 'center', paddingVertical: 6 }, assignmentCell: { alignItems: 'center', backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 9, borderWidth: 1, minWidth: 0, paddingHorizontal: 4, paddingVertical: 8, width: '22%' }, assignmentCellSelected: { backgroundColor: '#f6e8c7', borderColor: palette.coral, borderWidth: 2 }, positionLabel: { color: palette.muted, fontSize: 10, fontWeight: '800' }, assignmentName: { color: palette.ink, fontSize: 12, fontWeight: '700', marginTop: 4 }, benchList: { backgroundColor: '#f7f4ed', borderTopColor: palette.line, borderTopWidth: 1, paddingHorizontal: 15, paddingVertical: 11 }, benchLabel: { color: palette.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1 }, benchNames: { color: palette.ink, fontSize: 12, fontWeight: '600', lineHeight: 18, marginTop: 4 }, emptyCard: { backgroundColor: palette.panel, borderRadius: 17, padding: 18 }, emptyText: { color: palette.muted, fontSize: 13 }, warningText: { color: '#956d1b', fontSize: 12, lineHeight: 18, marginTop: 4 }, errorText: { color: palette.coral, fontSize: 12, lineHeight: 18, marginTop: 4 },
});