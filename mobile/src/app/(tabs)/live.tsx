import { Stack, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, Vibration, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { buildAfterGameReport, clearAcceptedSchedule, getAcceptedSchedule, setAcceptedSchedule, type AvailabilityHistory, type LiveSchedule } from '@/live-schedule';

const palette = {
  ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1',
  green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c',
};

type ScheduleBlock = LiveSchedule['blocks'][number];
type PositionRow = NonNullable<LiveSchedule['position_rows']>[number];
type AvailabilityRecord = AvailabilityHistory;

const fallbackPositionRows: PositionRow[] = [
  { label: 'FORWARDS', positions: ['LF', 'RF'] },
  { label: 'MIDFIELDERS', positions: ['LM', 'LCM', 'RCM', 'RM'] },
  { label: 'DEFENDERS', positions: ['LB', 'LCB', 'RCB', 'RB'] },
  { label: 'GOALKEEPER', positions: ['GK'] },
];

function displayPlayerName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

function formatTimer(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function parseTimer(value: string): number | null {
  const parts = value.trim().split(':');
  if (parts.length > 2 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const parsed = parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1]) : Number(parts[0]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function triggerVibrationPulse() {
  if (Platform.OS === 'android') {
    Vibration.vibrate(220);
    return;
  }
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
}

function formatBlockTime(minutes: number): string {
  const totalSeconds = Math.round(minutes * 60);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function blockStartTime(schedule: LiveSchedule, blockIndex: number): string {
  const startMinutes = schedule.block_start_minutes?.[blockIndex] ?? 0;
  const halftimeIndex = Math.ceil(schedule.blocks.length / 2);
  const halftimeStartMinutes = schedule.block_start_minutes?.[halftimeIndex] ?? 0;
  const displayedMinutes = blockIndex >= halftimeIndex
    ? startMinutes - halftimeStartMinutes
    : startMinutes;
  return formatBlockTime(Math.max(0, displayedMinutes));
}

function blockStartSeconds(schedule: LiveSchedule, blockIndex: number, secondHalf: boolean): number {
  const startMinutes = schedule.block_start_minutes?.[blockIndex] ?? 0;
  const halftimeIndex = Math.ceil(schedule.blocks.length / 2);
  const halftimeStartMinutes = schedule.block_start_minutes?.[halftimeIndex] ?? 0;
  return Math.max(0, (startMinutes - (secondHalf ? halftimeStartMinutes : 0)) * 60);
}

function blockHeader(schedule: LiveSchedule, blockIndex: number): { title: string; detail: string } {
  const halftimeIndex = Math.ceil(schedule.blocks.length / 2);
  const isFirstBlock = blockIndex === 0;
  const isSecondHalfStarter = blockIndex === halftimeIndex;
  const isBeforeHalftime = blockIndex === halftimeIndex - 1;
  const isFinalBlock = blockIndex === schedule.blocks.length - 1;
  const blockLength = formatBlockTime(schedule.block_lengths_minutes?.[blockIndex] ?? 0);

  if (isBeforeHalftime) return { title: 'Halftime', detail: 'Last substitution of the half.' };
  if (isFinalBlock) return { title: isSecondHalfStarter ? 'Second Half Starters' : 'Substitution block', detail: 'Last substitution of the game.' };
  if (isFirstBlock) return { title: 'Game Starters', detail: `Next substitution occurs at ${blockStartTime(schedule, blockIndex + 1)}` };
  if (isSecondHalfStarter) return { title: 'Second Half Starters', detail: `Next substitution occurs at ${blockStartTime(schedule, blockIndex + 1)}` };
  return { title: 'Substitution block', detail: `Next substitution occurs at ${blockStartTime(schedule, blockIndex + 1)}` };
}

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

type LiveScreenProps = {
  schedule?: LiveSchedule | null;
  onExit?: () => void;
  onGameEnded?: (report: ReturnType<typeof buildAfterGameReport>) => void;
};

export default function LiveScreen({ schedule: providedSchedule, onExit, onGameEnded }: LiveScreenProps = {}) {
  const router = useRouter();
  const [storedSchedule, setStoredSchedule] = useState<LiveSchedule | null>(null);
  const schedule = providedSchedule ?? storedSchedule;
  const positionRows = schedule?.position_rows?.length ? schedule.position_rows : fallbackPositionRows;
  const scrollRef = useRef<ScrollView>(null);
  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(false);
  const [activeBlock, setActiveBlock] = useState(0);
  const [secondHalf, setSecondHalf] = useState(false);
  const [showWarningFlash, setShowWarningFlash] = useState(false);
  const [showTimeEditor, setShowTimeEditor] = useState(false);
  const [timeInput, setTimeInput] = useState('00:00');
  const [timeError, setTimeError] = useState<string | null>(null);
  const [liveBlocks, setLiveBlocks] = useState<ScheduleBlock[]>([]);
  const [availabilityRecords, setAvailabilityRecords] = useState<AvailabilityRecord[]>([]);
  const [availabilityHistory, setAvailabilityHistory] = useState<AvailabilityHistory[]>([]);
  const [completedBlocks, setCompletedBlocks] = useState<number[]>([]);
  const [returnedPlayers, setReturnedPlayers] = useState<Array<{ player: string; blockIndex: number }>>([]);
  const [availabilityMode, setAvailabilityMode] = useState<'unavailable' | 'available' | null>(null);
  const [selectingUnavailablePlayer, setSelectingUnavailablePlayer] = useState(false);
  const [availabilityBlockIndex, setAvailabilityBlockIndex] = useState(0);
  const [selectedUnavailablePlayer, setSelectedUnavailablePlayer] = useState<string | null>(null);
  const [selectedReplacement, setSelectedReplacement] = useState<string | null>(null);
  const warnedBlocks = useRef(new Set<string>());
  const flashInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (providedSchedule) return undefined;
    let active = true;
    getAcceptedSchedule().then((savedSchedule) => {
      if (active) setStoredSchedule(savedSchedule);
    });
    return () => {
      active = false;
    };
  }, [providedSchedule]);

  useEffect(() => {
    if (schedule) {
      setLiveBlocks(schedule.blocks.map((block) => ({ ...block, positions: { ...block.positions }, bench: [...block.bench] })));
      setAvailabilityRecords(schedule.live_availability ?? []);
      setAvailabilityHistory(schedule.live_availability_history ?? schedule.live_availability ?? []);
      setCompletedBlocks(schedule.completed_blocks ?? []);
      setReturnedPlayers(schedule.live_returned_players ?? []);
    }
  }, [schedule]);

  useEffect(() => {
    if (!running) return undefined;
    const interval = setInterval(() => setSeconds((current) => current + 1), 1000);
    return () => clearInterval(interval);
  }, [running]);

  useEffect(() => () => {
    if (flashInterval.current) clearInterval(flashInterval.current);
  }, []);

  useEffect(() => {
    if (!schedule || !running) return;
    const nextBlockIndex = activeBlock + 1;
    if (nextBlockIndex >= schedule.blocks.length) return;
    const warningSeconds = schedule.substitution_warning_seconds ?? 30;
    const nextBlockTime = blockStartSeconds(schedule, nextBlockIndex, secondHalf);
    const warningKey = `${secondHalf ? 'second' : 'first'}-${nextBlockIndex}`;
    if (seconds < nextBlockTime - warningSeconds || seconds >= nextBlockTime || warnedBlocks.current.has(warningKey)) return;

    warnedBlocks.current.add(warningKey);
    const alert = schedule.substitution_alert ?? 'flash_and_vibrate';
    if (alert === 'flash' || alert === 'flash_and_vibrate') {
      if (flashInterval.current) clearInterval(flashInterval.current);
      let pulseCount = 0;
      setShowWarningFlash(false);
      flashInterval.current = setInterval(() => {
        pulseCount += 1;
        setShowWarningFlash(pulseCount % 2 === 1);
        if (pulseCount >= 10) {
          if (flashInterval.current) clearInterval(flashInterval.current);
          flashInterval.current = null;
          setShowWarningFlash(false);
        }
      }, 140);
    }
    if (alert === 'vibrate' || alert === 'flash_and_vibrate') {
      for (let pulse = 0; pulse < 5; pulse += 1) {
        setTimeout(() => {
          triggerVibrationPulse();
        }, pulse * 300);
      }
    }
  }, [activeBlock, running, schedule, secondHalf, seconds]);

  function resetForSecondHalf() {
    setRunning(false);
    setSeconds(0);
    setSecondHalf(true);
    warnedBlocks.current.clear();
    setActiveBlock(Math.ceil((schedule?.blocks.length ?? 0) / 2));
    scrollRef.current?.scrollTo({ x: 0, animated: false });
  }

  function openTimeEditor() {
    setTimeInput(formatTimer(seconds));
    setTimeError(null);
    setShowTimeEditor(true);
    setRunning(false);
  }

  function applyManualTime() {
    const parsedSeconds = parseTimer(timeInput);
    if (parsedSeconds === null) {
      setTimeError('Enter a valid time such as 07:30.');
      return;
    }
    setSeconds(parsedSeconds);
    warnedBlocks.current.clear();
    setTimeError(null);
    setShowTimeEditor(false);
  }

  if (!schedule) {
    return (
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.emptyState}><Text style={styles.emptyText}>No accepted schedule was provided.</Text></View>
        </SafeAreaView>
      </View>
    );
  }

  const halftimeIndex = Math.ceil(schedule.blocks.length / 2);
  const blocks = secondHalf ? liveBlocks.slice(halftimeIndex) : liveBlocks.slice(0, halftimeIndex);
  const currentBlock = liveBlocks[activeBlock];
  const isEndOfFirstHalf = !secondHalf && activeBlock === halftimeIndex - 1;
  const isEndOfGame = secondHalf && activeBlock === schedule.blocks.length - 1;

  function exitLiveMode() {
    if (onExit) {
      onExit();
    } else {
      router.navigate('/' as never);
    }
  }

  async function endGame() {
    if (!schedule) return;
    const report = buildAfterGameReport(schedule, liveBlocks, availabilityHistory);
    await clearAcceptedSchedule();
    if (onGameEnded) {
      onGameEnded(report);
    } else {
      exitLiveMode();
    }
  }

  function openUnavailable(blockIndex: number) {
    setAvailabilityBlockIndex(blockIndex);
    setSelectedUnavailablePlayer(null);
    setSelectedReplacement(null);
    setSelectingUnavailablePlayer(true);
  }

  function cancelUnavailableSelection() {
    setSelectingUnavailablePlayer(false);
    setSelectedUnavailablePlayer(null);
  }

  async function completeBlock(blockIndex: number) {
    if (!schedule || completedBlocks.includes(blockIndex)) return;
    const nextCompletedBlocks = [...completedBlocks, blockIndex].sort((left, right) => left - right);
    setCompletedBlocks(nextCompletedBlocks);
    await setAcceptedSchedule({
      ...schedule,
      blocks: liveBlocks,
      live_availability: availabilityRecords,
      live_availability_history: availabilityHistory,
      completed_blocks: nextCompletedBlocks,
      live_returned_players: returnedPlayers,
    });
  }

  async function reopenBlock(blockIndex: number) {
    if (!schedule) return;
    const nextCompletedBlocks = completedBlocks.filter((index) => index !== blockIndex);
    setCompletedBlocks(nextCompletedBlocks);
    await setAcceptedSchedule({
      ...schedule,
      blocks: liveBlocks,
      live_availability: availabilityRecords,
      live_availability_history: availabilityHistory,
      completed_blocks: nextCompletedBlocks,
    });
  }

  function openAvailable(blockIndex: number, player: string) {
    setAvailabilityBlockIndex(blockIndex);
    setSelectedUnavailablePlayer(player);
    setSelectedReplacement(null);
    setAvailabilityMode('available');
  }

  function selectUnavailablePlayer(player: string, blockIndex: number) {
    setAvailabilityBlockIndex(blockIndex);
    setSelectedUnavailablePlayer(player);
    setSelectedReplacement(null);
    setSelectingUnavailablePlayer(false);
    setAvailabilityMode('unavailable');
  }

  function closeAvailability() {
    setSelectingUnavailablePlayer(false);
    setAvailabilityMode(null);
    setSelectedUnavailablePlayer(null);
    setSelectedReplacement(null);
  }

  async function confirmAvailabilityChange() {
    if (!schedule) return;
    const block = liveBlocks[availabilityBlockIndex];
    if (!block || !selectedUnavailablePlayer) return;

    let nextAvailabilityRecords = availabilityRecords;
    let nextAvailabilityHistory = availabilityHistory;
    let nextReturnedPlayers = returnedPlayers;
    let nextBlocks = liveBlocks;
    if (availabilityMode === 'unavailable') {
      if (!selectedReplacement) return;
      const positionEntry = Object.entries(block.positions).find(([, player]) => player === selectedUnavailablePlayer);
      const isGoalkeeper = block.GK === selectedUnavailablePlayer;
      const position = isGoalkeeper ? 'GK' : positionEntry?.[0];
      if (!position) return;
      const nextBlock = { ...block, positions: { ...block.positions }, bench: [...block.bench] };
      if (isGoalkeeper) {
        nextBlock.GK = selectedReplacement;
        nextBlock.positions.GK = selectedReplacement;
      } else nextBlock.positions[position] = selectedReplacement;
      nextBlock.bench = nextBlock.bench.filter((player) => player !== selectedReplacement);
      nextBlocks = liveBlocks.map((item, index) => {
        if (index === availabilityBlockIndex) return nextBlock;
        if (index < availabilityBlockIndex) return item;

        const futureBlock = { ...item, positions: { ...item.positions }, bench: [...item.bench] };
        const futurePosition = Object.entries(futureBlock.positions).find(([, player]) => player === selectedUnavailablePlayer)?.[0];
        const futureIsGoalkeeper = futureBlock.GK === selectedUnavailablePlayer;
        if (!futurePosition && !futureIsGoalkeeper) return futureBlock;

        const fieldPlayers = new Set([
          futureBlock.GK,
          ...Object.values(futureBlock.positions),
        ]);
        const replacement = futureBlock.bench.find(
          (player) => player !== selectedUnavailablePlayer && !fieldPlayers.has(player),
        );
        if (!replacement) return futureBlock;

        if (futureIsGoalkeeper) {
          futureBlock.GK = replacement;
          futureBlock.positions.GK = replacement;
        }
        else if (futurePosition) futureBlock.positions[futurePosition] = replacement;
        futureBlock.bench = futureBlock.bench.filter((player) => player !== replacement);
        if (!futureBlock.bench.includes(selectedUnavailablePlayer)) futureBlock.bench.push(selectedUnavailablePlayer);
        return futureBlock;
      });
      const historyRecord = { player: selectedUnavailablePlayer, replacement: selectedReplacement, blockIndex: availabilityBlockIndex, position };
      nextAvailabilityRecords = [...availabilityRecords, historyRecord];
      nextAvailabilityHistory = [...availabilityHistory, historyRecord];
    } else {
      const record = availabilityRecords.find((item) => item.blockIndex <= availabilityBlockIndex && item.player === selectedUnavailablePlayer);
      if (!record) return;
      const returnBlockIndex = availabilityBlockIndex + 1;
      const returnBlock = liveBlocks[returnBlockIndex];
      if (!returnBlock) return;
      nextBlocks = liveBlocks.map((item, index) => {
        if (index <= availabilityBlockIndex) return item;
        const futureBlock = { ...item, positions: { ...item.positions }, bench: [...item.bench] };
        const displaced = record.position === 'GK' ? futureBlock.GK : futureBlock.positions[record.position];
        if (record.position === 'GK') {
          futureBlock.GK = record.player;
          futureBlock.positions.GK = record.player;
        }
        else futureBlock.positions[record.position] = record.player;
        futureBlock.bench = futureBlock.bench.filter((player) => player !== record.player);
        if (displaced && displaced !== record.player && !futureBlock.bench.includes(displaced)) futureBlock.bench.push(displaced);
        return futureBlock;
      });
      nextAvailabilityRecords = availabilityRecords.filter((item) => !(item.blockIndex === record.blockIndex && item.player === record.player));
      nextAvailabilityHistory = availabilityHistory.map((item) => item.player === record.player && item.blockIndex === record.blockIndex ? { ...item, endBlockIndex: returnBlockIndex } : item);
      nextReturnedPlayers = [...returnedPlayers.filter((item) => !(item.player === record.player && item.blockIndex === returnBlockIndex)), { player: record.player, blockIndex: returnBlockIndex }];
    }
    setLiveBlocks(nextBlocks);
    setAvailabilityRecords(nextAvailabilityRecords);
    setAvailabilityHistory(nextAvailabilityHistory);
    setReturnedPlayers(nextReturnedPlayers);
    await setAcceptedSchedule({
      ...schedule,
      blocks: nextBlocks,
      live_availability: nextAvailabilityRecords,
      live_availability_history: nextAvailabilityHistory,
      completed_blocks: completedBlocks,
      live_returned_players: nextReturnedPlayers,
    });
    closeAvailability();
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <Pressable onPress={exitLiveMode} style={styles.backButton} accessibilityLabel="Exit live game">
                <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} />
              </Pressable>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>GAME {schedule.game_number} · LIVE</Text>
                <Text style={styles.title}>{schedule.team_name ? `${schedule.team_name} Live Game` : 'Live game mode'}</Text>
              </View>
              <Text style={styles.halfLabel}>{secondHalf ? '2ND HALF' : '1ST HALF'}</Text>
            </View>

            <View style={styles.timerCard}>
              <Text style={styles.timer}>{formatTimer(seconds)}</Text>
              <Pressable onPress={() => setRunning((current) => !current)} style={styles.timerButton} accessibilityRole="button">
                <SymbolView name={{ ios: running ? 'pause.fill' : 'play.fill', android: running ? 'pause' : 'play_arrow', web: running ? 'pause' : 'play_arrow' }} size={17} tintColor={palette.panel} />
                <Text style={styles.timerButtonText}>{running ? 'Pause timer' : seconds === 0 ? 'Start timer' : 'Resume timer'}</Text>
              </Pressable>
              <Pressable onPress={openTimeEditor} style={styles.setTimeButton} accessibilityRole="button">
                <SymbolView name={{ ios: 'pencil', android: 'edit', web: 'edit' }} size={15} tintColor={palette.green} />
                <Text style={styles.setTimeButtonText}>SET TIME</Text>
              </Pressable>
            </View>

            <View style={styles.blockHeading}>
              <View>
                <Text style={styles.sectionEyebrow}>CURRENT BLOCK</Text>
                <Text style={styles.blockTitle}>Block {activeBlock + 1}</Text>
              </View>
              {!isEndOfFirstHalf && !isEndOfGame && <Text style={styles.swipeHint}>Swipe Left for next block.</Text>}
            </View>
            <View style={styles.legend}>
              <View style={styles.legendItem}><View style={[styles.legendSwatch, styles.subbedInCell]} /><Text style={styles.legendText}>Subbed in</Text></View>
              <View style={styles.legendItem}><View style={[styles.legendSwatch, styles.positionChangedCell]} /><Text style={styles.legendText}>Position changed</Text></View>
            </View>

            <ScrollView
              ref={scrollRef}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              onMomentumScrollEnd={(event) => {
                const width = event.nativeEvent.layoutMeasurement.width;
                const nextIndex = Math.round(event.nativeEvent.contentOffset.x / width);
                setActiveBlock((secondHalf ? halftimeIndex : 0) + nextIndex);
              }}>
              {blocks.map((block, index) => {
                const blockIndex = secondHalf ? index + halftimeIndex : index;
                return (
                <View key={`live-${blockIndex}`} style={styles.page}>
                  <View style={styles.blockCard}>
                    {(() => {
                      const header = blockHeader(schedule, blockIndex);
                      return (
                        <View style={styles.blockCardHeader}>
                          <Text style={styles.blockCardTitle}>{header.title}</Text>
                          <Text style={styles.blockCardDetail}>{header.detail}</Text>
                        </View>
                      );
                    })()}
                    <View style={styles.assignmentList}>
                      {positionRows.map((row) => {
                        const assignments = row.positions.filter((position) => block.positions?.[position]);
                        if (assignments.length === 0) return null;
                        return (
                          <View key={`${index}-${row.label}`} style={styles.positionGroup}>
                            <Text style={styles.positionGroupLabel}>{row.label}</Text>
                            <View style={styles.assignmentRow}>
                              {assignments.map((position) => (
                                <Pressable
                                  key={`${index}-${position}`}
                                  style={[styles.assignmentCell, !completedBlocks.includes(blockIndex) && (playerHighlight(liveBlocks, secondHalf ? index + halftimeIndex + 1 : index + 1, position, block.positions[position]) === 'subbedIn' || returnedPlayers.some((item) => item.player === block.positions[position] && item.blockIndex === blockIndex)) && styles.subbedInCell, !completedBlocks.includes(blockIndex) && playerHighlight(liveBlocks, secondHalf ? index + halftimeIndex + 1 : index + 1, position, block.positions[position]) === 'positionChanged' && styles.positionChangedCell]}
                                  onPress={() => selectingUnavailablePlayer && selectUnavailablePlayer(block.positions[position], blockIndex)}
                                  disabled={!selectingUnavailablePlayer}
                                  accessibilityRole={selectingUnavailablePlayer ? 'button' : undefined}
                                  accessibilityLabel={selectingUnavailablePlayer ? `Mark ${displayPlayerName(block.positions[position])} unavailable` : undefined}>
                                  <Text style={styles.positionLabel}>{position}</Text>
                                  <Text style={styles.assignmentName} numberOfLines={1}>{displayPlayerName(block.positions[position])}</Text>
                                </Pressable>
                              ))}
                            </View>
                          </View>
                        );
                      })}
                    </View>
                    <View style={styles.benchList}>
                      <Text style={styles.benchLabel}>BENCH · {block.bench?.length ?? 0}</Text>
                      <Text style={styles.benchNames}>{block.bench?.map(displayPlayerName).join(', ') || 'None'}</Text>
                      {selectingUnavailablePlayer && blockIndex === activeBlock ? (
                        <View style={styles.selectionPrompt}>
                          <Text style={styles.selectionPromptText}>TAP A FIELD PLAYER TO MARK UNAVAILABLE</Text>
                          <Pressable onPress={cancelUnavailableSelection} style={styles.undoSelectionButton} accessibilityRole="button">
                            <Text style={styles.undoSelectionText}>UNDO</Text>
                          </Pressable>
                        </View>
                      ) : (
                        <Pressable onPress={() => openUnavailable(blockIndex)} style={styles.availabilityButton} accessibilityRole="button">
                          <Text style={styles.availabilityButtonText}>MARK AS UNAVAILABLE</Text>
                        </Pressable>
                      )}
                      {availabilityRecords.filter((record) => record.blockIndex <= blockIndex).map((record) => (
                        <View key={`${record.blockIndex}-${record.player}`} style={styles.unavailableRow}>
                          <View>
                            <Text style={styles.unavailableLabel}>UNAVAILABLE</Text>
                            <Text style={styles.unavailableName}>{displayPlayerName(record.player)}</Text>
                          </View>
                          <Pressable onPress={() => openAvailable(blockIndex, record.player)} style={styles.makeAvailableButton} accessibilityRole="button">
                            <Text style={styles.makeAvailableText}>MAKE AVAILABLE</Text>
                          </Pressable>
                        </View>
                      ))}
                    </View>
                  </View>
                </View>
                );
              })}
            </ScrollView>

            {completedBlocks.includes(activeBlock) ? (
              <Pressable onPress={() => void reopenBlock(activeBlock)} style={styles.completedBlockBadge} accessibilityRole="button" hitSlop={8}>
                <Text style={styles.completedBlockText}>BLOCK COMPLETED · TAP TO REOPEN</Text>
              </Pressable>
            ) : (
              <Pressable onPress={() => void completeBlock(activeBlock)} style={styles.completeBlockButton} accessibilityRole="button" hitSlop={8}>
                <Text style={styles.completeBlockText}>COMPLETE BLOCK</Text>
              </Pressable>
            )}

            {isEndOfFirstHalf && (
              <Pressable onPress={resetForSecondHalf} style={styles.halftimeButton} accessibilityRole="button">
                <Text style={styles.halftimeButtonText}>End First Half & Reset Timer</Text>
                <SymbolView name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }} size={19} tintColor={palette.panel} />
              </Pressable>
            )}
            {isEndOfGame && (
              <Pressable onPress={() => void endGame()} style={styles.endGameButton} accessibilityRole="button">
                <Text style={styles.endGameButtonText}>End Game</Text>
                <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={19} tintColor={palette.panel} />
              </Pressable>
            )}
            {!isEndOfFirstHalf && !isEndOfGame && currentBlock && <Text style={styles.footerHint}>{secondHalf ? 'Second-half timer is ready. Start when play resumes.' : 'Swipe through the approved blocks as substitutions happen.'}</Text>}
          </ScrollView>
        </SafeAreaView>
      </View>
      {showWarningFlash && <View pointerEvents="none" style={styles.warningFlash} />}
      <Modal visible={showTimeEditor} transparent animationType="fade" onRequestClose={() => setShowTimeEditor(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.timeModal}>
            <Text style={styles.modalEyebrow}>GAME TIMER</Text>
            <Text style={styles.modalTitle}>Set current time</Text>
            <Text style={styles.modalDetail}>Enter elapsed time for the current half.</Text>
            <TextInput
              value={timeInput}
              onChangeText={(value) => {
                setTimeInput(value);
                setTimeError(null);
              }}
              autoFocus
              keyboardType="numbers-and-punctuation"
              placeholder="00:00"
              placeholderTextColor={palette.muted}
              style={styles.timeInput}
              accessibilityLabel="Current game time"
            />
            {timeError && <Text style={styles.timeError}>{timeError}</Text>}
            <View style={styles.modalActions}>
              <Pressable onPress={() => setShowTimeEditor(false)} style={styles.cancelButton} accessibilityRole="button">
                <Text style={styles.cancelButtonText}>CANCEL</Text>
              </Pressable>
              <Pressable onPress={applyManualTime} style={styles.applyButton} accessibilityRole="button">
                <Text style={styles.applyButtonText}>SET TIME</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <Modal visible={availabilityMode !== null} transparent animationType="fade" onRequestClose={closeAvailability}>
        <View style={styles.modalOverlay}>
          <View style={styles.timeModal}>
            <Text style={styles.modalEyebrow}>{availabilityMode === 'available' ? 'RETURN TO ROTATION' : 'LIVE AVAILABILITY'}</Text>
            <Text style={styles.modalTitle}>{availabilityMode === 'available' ? 'Make player available' : 'Mark player unavailable'}</Text>
            <Text style={styles.modalDetail}>
              {availabilityMode === 'available'
                ? 'Confirm to restore this player in the next block.'
                : selectedUnavailablePlayer
                  ? 'Select the bench player who will take this position.'
                  : 'Select the player leaving the field.'}
            </Text>

            {availabilityMode === 'unavailable' && !selectedUnavailablePlayer && (
              <View style={styles.choiceList}>
                {[
                  ...(liveBlocks[availabilityBlockIndex]?.GK ? [['GK', liveBlocks[availabilityBlockIndex].GK] as [string, string]] : []),
                  ...Object.entries(liveBlocks[availabilityBlockIndex]?.positions ?? {}),
                ].filter(([, player], index, entries) => entries.findIndex(([, name]) => name === player) === index).map(([position, player]) => (
                  <Pressable key={`${position}-${player}`} onPress={() => setSelectedUnavailablePlayer(player)} style={styles.choiceButton} accessibilityRole="button">
                    <Text style={styles.choicePosition}>{position}</Text>
                    <Text style={styles.choiceName}>{displayPlayerName(player)}</Text>
                  </Pressable>
                ))}
              </View>
            )}

            {availabilityMode === 'unavailable' && selectedUnavailablePlayer && !selectedReplacement && (
              <ScrollView style={styles.choiceScroll} contentContainerStyle={styles.choiceList} showsVerticalScrollIndicator>
                <Text style={styles.selectedChoice}>Leaving field: {displayPlayerName(selectedUnavailablePlayer)}</Text>
                {(liveBlocks[availabilityBlockIndex]?.bench ?? []).filter((player) => player !== selectedUnavailablePlayer && !availabilityRecords.some((record) => record.player === player)).map((player) => (
                  <Pressable key={player} onPress={() => setSelectedReplacement(player)} style={styles.choiceButton} accessibilityRole="button">
                    <Text style={styles.choiceName}>{displayPlayerName(player)}</Text>
                    <Text style={styles.choiceHint}>Bench replacement</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}

            {availabilityMode === 'unavailable' && selectedUnavailablePlayer && selectedReplacement && (
              <Text style={styles.confirmDetail}>{displayPlayerName(selectedReplacement)} will replace {displayPlayerName(selectedUnavailablePlayer)}.</Text>
            )}
            {availabilityMode === 'available' && selectedUnavailablePlayer && (
              <Text style={styles.confirmDetail}>{displayPlayerName(selectedUnavailablePlayer)} returns in Block {availabilityBlockIndex + 2}. Block {availabilityBlockIndex + 1} stays unchanged.</Text>
            )}
            <View style={styles.modalActions}>
              <Pressable onPress={closeAvailability} style={styles.cancelButton} accessibilityRole="button">
                <Text style={styles.cancelButtonText}>{availabilityMode === 'unavailable' ? 'UNDO' : 'CANCEL'}</Text>
              </Pressable>
              {availabilityMode === 'unavailable' && selectedUnavailablePlayer && !selectedReplacement ? null : (
                <Pressable onPress={() => void confirmAvailabilityChange()} disabled={availabilityMode === 'unavailable' && !selectedReplacement} style={styles.applyButton} accessibilityRole="button">
                  <Text style={styles.applyButtonText}>CONFIRM</Text>
                </Pressable>
              )}
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.paper },
  safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: BottomTabInset + 24 },
  header: { alignItems: 'center', flexDirection: 'row', marginBottom: 22 },
  backButton: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 },
  headerCopy: { flex: 1, marginLeft: 13 },
  eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 },
  title: { color: palette.ink, fontSize: 28, fontWeight: '800', marginTop: 4 },
  halfLabel: { color: palette.green, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  timerCard: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 18, marginBottom: 22, padding: 18 },
  timerLabel: { color: palette.green, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  timer: { color: palette.ink, fontSize: 48, fontWeight: '800', letterSpacing: 1, marginVertical: 5 },
  timerButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 11, flexDirection: 'row', gap: 7, paddingHorizontal: 14, paddingVertical: 9 },
  timerButtonText: { color: palette.panel, fontSize: 12, fontWeight: '800' },
  setTimeButton: { alignItems: 'center', flexDirection: 'row', gap: 6, marginTop: 12, padding: 5 },
  setTimeButtonText: { color: palette.green, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  modalOverlay: { alignItems: 'center', backgroundColor: 'rgba(23, 34, 31, 0.55)', flex: 1, justifyContent: 'center', padding: 20 },
  timeModal: { backgroundColor: palette.panel, borderRadius: 20, padding: 20, width: '100%' },
  modalEyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  modalTitle: { color: palette.ink, fontSize: 24, fontWeight: '800', marginTop: 5 },
  modalDetail: { color: palette.muted, fontSize: 12, marginTop: 4 },
  timeInput: { backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 12, borderWidth: 1, color: palette.ink, fontSize: 28, fontWeight: '800', marginTop: 18, paddingHorizontal: 14, paddingVertical: 10, textAlign: 'center' },
  timeError: { color: palette.coral, fontSize: 12, marginTop: 8, textAlign: 'center' },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  cancelButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 12, borderWidth: 1, flex: 1, paddingVertical: 13 },
  cancelButtonText: { color: palette.muted, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  applyButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 12, flex: 1, paddingVertical: 13 },
  applyButtonText: { color: palette.panel, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  blockHeading: { alignItems: 'flex-end', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 10 },
  legendItem: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  legendSwatch: { borderRadius: 4, height: 12, width: 12 },
  legendText: { color: palette.muted, fontSize: 10, fontWeight: '700' },
  sectionEyebrow: { color: palette.coral, fontSize: 10, fontWeight: '900', letterSpacing: 1.3 },
  blockTitle: { color: palette.ink, fontSize: 21, fontWeight: '800', marginTop: 3 },
  swipeHint: { color: palette.muted, fontSize: 11 },
  page: { width: 360 },
  blockCard: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, overflow: 'hidden' },
  blockCardHeader: { alignItems: 'center', backgroundColor: palette.greenSoft, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 15, paddingVertical: 13 },
  blockCardTitle: { color: palette.green, flex: 1, fontSize: 16, fontWeight: '800' },
  blockCardDetail: { color: palette.green, fontSize: 10, fontWeight: '800', marginLeft: 12, textAlign: 'right' },
  assignmentList: { padding: 15 },
  positionGroup: { marginBottom: 13 },
  positionGroupLabel: { color: palette.muted, fontSize: 10, fontWeight: '900', letterSpacing: 1, marginBottom: 6, textAlign: 'center' },
  assignmentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  assignmentCell: { alignItems: 'center', backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 9, borderWidth: 1, flex: 1, minWidth: 62, paddingHorizontal: 4, paddingVertical: 8 },
  subbedInCell: { backgroundColor: '#dcebe2', borderColor: palette.green },
  positionChangedCell: { backgroundColor: '#f8e5b2', borderColor: '#b4872e' },
  positionLabel: { color: palette.muted, fontSize: 10, fontWeight: '800' },
  assignmentName: { color: palette.ink, fontSize: 12, fontWeight: '700', marginTop: 4 },
  benchList: { backgroundColor: '#f7f4ed', borderTopColor: palette.line, borderTopWidth: 1, padding: 15 },
  benchLabel: { color: palette.muted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  benchNames: { color: palette.ink, fontSize: 12, lineHeight: 18, marginTop: 4 },
  availabilityButton: { alignItems: 'center', borderColor: palette.coral, borderRadius: 10, borderWidth: 1, marginTop: 13, paddingVertical: 10 },
  availabilityButtonText: { color: palette.coral, fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  selectionPrompt: { alignItems: 'center', borderTopColor: '#efc8bc', borderTopWidth: 1, marginTop: 13, paddingTop: 12 },
  selectionPromptText: { color: palette.coral, fontSize: 10, fontWeight: '900', letterSpacing: 0.7, textAlign: 'center' },
  undoSelectionButton: { borderColor: palette.line, borderRadius: 9, borderWidth: 1, marginTop: 9, paddingHorizontal: 16, paddingVertical: 8 },
  undoSelectionText: { color: palette.muted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  completeBlockButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 10, marginTop: 13, paddingVertical: 11 },
  completeBlockText: { color: palette.panel, fontSize: 10, fontWeight: '900', letterSpacing: 0.9 },
  completedBlockBadge: { alignItems: 'center', backgroundColor: palette.greenSoft, borderColor: palette.green, borderRadius: 10, borderWidth: 1, marginTop: 13, paddingVertical: 10 },
  completedBlockText: { color: palette.green, fontSize: 10, fontWeight: '900', letterSpacing: 0.9 },
  unavailableRow: { alignItems: 'center', borderTopColor: '#efc8bc', borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-between', marginTop: 13, paddingTop: 12 },
  unavailableLabel: { color: palette.coral, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  unavailableName: { color: palette.coral, fontSize: 13, fontWeight: '800', marginTop: 3 },
  makeAvailableButton: { borderColor: palette.green, borderRadius: 9, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 8 },
  makeAvailableText: { color: palette.green, fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  choiceList: { gap: 8, marginTop: 18, maxHeight: 260 },
  choiceScroll: { marginTop: 18, maxHeight: 300 },
  choiceButton: { alignItems: 'center', backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 11, borderWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 11 },
  choicePosition: { color: palette.green, fontSize: 10, fontWeight: '900', width: 42 },
  choiceName: { color: palette.ink, flex: 1, fontSize: 13, fontWeight: '800' },
  choiceHint: { color: palette.muted, fontSize: 10 },
  selectedChoice: { color: palette.coral, fontSize: 12, fontWeight: '800', marginBottom: 4 },
  confirmDetail: { backgroundColor: palette.greenSoft, borderRadius: 11, color: palette.green, fontSize: 13, fontWeight: '700', lineHeight: 19, marginTop: 18, padding: 12 },
  halftimeButton: { alignItems: 'center', backgroundColor: palette.coral, borderRadius: 16, flexDirection: 'row', justifyContent: 'space-between', marginTop: 18, paddingHorizontal: 17, paddingVertical: 16 },
  halftimeButtonText: { color: palette.panel, fontSize: 14, fontWeight: '800' },
  endGameButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 16, flexDirection: 'row', justifyContent: 'space-between', marginTop: 18, paddingHorizontal: 17, paddingVertical: 16 },
  endGameButtonText: { color: palette.panel, fontSize: 14, fontWeight: '800' },
  footerHint: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 18, textAlign: 'center' },
  emptyState: { backgroundColor: palette.panel, borderRadius: 17, margin: 16, padding: 18 },
  emptyText: { color: palette.muted, fontSize: 13 },
  warningFlash: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(255, 255, 255, 0.82)' },
});
