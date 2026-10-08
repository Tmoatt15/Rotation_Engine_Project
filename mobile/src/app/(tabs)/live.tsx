import { Stack, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, Vibration, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { canCoverSlot } from '@/engine/timeline';
import { POSITION_GROUP_BY_SLOT } from '@/engine/positional';
import { createPlayer } from '@/engine/rotation';
import type { Player, PositionGroup } from '@/engine/models';
import { getRoster } from '@/services/team-service';
import { regenerateLateArrivalSchedule } from '@/services/schedule-service';
import { buildAfterGameReport, clearAcceptedSchedule, getAcceptedSchedule, setAcceptedSchedule, type AvailabilityHistory, type LivePositionOverride, type LiveSchedule } from '@/live-schedule';

const palette = {
  ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1',
  green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c', halftime: '#496a78',
};

type ScheduleBlock = LiveSchedule['blocks'][number];
type PositionRow = NonNullable<LiveSchedule['position_rows']>[number];
type AvailabilityRecord = AvailabilityHistory;
type PendingSwap = {
  blockIndex: number;
  firstPosition: string;
  secondPosition: string;
  firstPlayer: string;
  secondPlayer: string;
  firstLegal: boolean;
  secondLegal: boolean;
};

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
  if (Platform.OS === 'web') return;
  Vibration.vibrate([0, 260, 140, 260, 140, 260]);
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => undefined);
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
  const isFinalBlock = blockIndex === schedule.blocks.length - 1;
  const blockLength = formatBlockTime(schedule.block_lengths_minutes?.[blockIndex] ?? 0);

  if (isFinalBlock) return { title: isSecondHalfStarter ? 'Second Half Starters' : `Block ${blockIndex + 1}`, detail: 'Last substitution of the game.' };
  if (isFirstBlock) return { title: 'Game Starters', detail: `Next substitution occurs at ${blockStartTime(schedule, blockIndex + 1)}` };
  if (isSecondHalfStarter) return { title: 'Second Half Starters', detail: `Next substitution occurs at ${blockStartTime(schedule, blockIndex + 1)}` };
  return { title: `Block ${blockIndex + 1}`, detail: `Next substitution occurs at ${blockStartTime(schedule, blockIndex + 1)}` };
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

function playerCameOffField(blocks: ScheduleBlock[], blockIndex: number, player: string): boolean {
  if (blockIndex === 0 || blockIndex === Math.ceil(blocks.length / 2)) return false;
  const previousPositions = Object.values(blocks[blockIndex - 1].positions ?? {});
  return previousPositions.includes(player) && blocks[blockIndex].bench?.includes(player) === true;
}

function playerHasGoalkeeperRole(player: Player | undefined): boolean {
  return player?.primary_positions.some((position) => position.toUpperCase() === 'GK') ?? false;
}

function playerNumber(roster: Player[], name: string): number | undefined {
  return roster.find((player) => player.name === name)?.number;
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
  const [roster, setRoster] = useState<Player[]>([]);
  const [positionOverrides, setPositionOverrides] = useState<LivePositionOverride[]>([]);
  const [selectedPosition, setSelectedPosition] = useState<{ blockIndex: number; position: string } | null>(null);
  const [pendingSwap, setPendingSwap] = useState<PendingSwap | null>(null);
  const [showLateArrival, setShowLateArrival] = useState(false);
  const [latePlayerName, setLatePlayerName] = useState<string | null>(null);
  const [lateStartBlock, setLateStartBlock] = useState(1);
  const [lateTargetBlocks, setLateTargetBlocks] = useState(1);
  const [lateTakeoverGk, setLateTakeoverGk] = useState(false);
  const [lateApprovalScope, setLateApprovalScope] = useState<'one_block' | 'entire_half' | null>(null);
  const [approvalCandidates, setApprovalCandidates] = useState<string[]>([]);
  const [approvedPlayerName, setApprovedPlayerName] = useState<string | null>(null);
  const [lateError, setLateError] = useState<string | null>(null);
  const [lateSaving, setLateSaving] = useState(false);
  const [lateArrivedNames, setLateArrivedNames] = useState<string[]>([]);
  const [availablePlayerNames, setAvailablePlayerNames] = useState<string[]>([]);
  const [liveWarnings, setLiveWarnings] = useState<string[]>([]);
  const warnedBlocks = useRef(new Set<string>());
  const flashInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentAvailablePlayerNames = availablePlayerNames.length ? availablePlayerNames : (schedule?.available_player_names ?? []);

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
      setPositionOverrides(schedule.live_position_overrides ?? []);
      setAvailablePlayerNames(schedule.available_player_names ?? []);
      setLiveWarnings(schedule.warnings ?? []);
    }
  }, [schedule]);

  useEffect(() => {
    if (!schedule?.team_id) return undefined;
    let active = true;
    getRoster(schedule.team_id).then((payload) => {
      if (active) setRoster(payload.players.map((player) => createPlayer(player)));
    }).catch(() => {
      if (active) setRoster([]);
    });
    return () => { active = false; };
  }, [schedule?.team_id]);

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
      triggerVibrationPulse();
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

  function openLateArrival() {
    const nextBlock = Math.min(activeBlock + 1, Math.max(1, (schedule?.blocks.length ?? 1) - 1));
    setLatePlayerName(null);
    setLateStartBlock(nextBlock + 1);
    setLateTargetBlocks(Math.max(1, Math.ceil(((schedule?.blocks.length ?? 1) - nextBlock) / 2)));
    setLateTakeoverGk(false);
    setLateApprovalScope(null);
    setApprovalCandidates([]);
    setApprovedPlayerName(null);
    setLateError(null);
    setShowLateArrival(true);
  }

  async function confirmLateArrival() {
    if (!schedule?.team_id || !latePlayerName) return;
    const arrivingPlayer = latePlayerName;
    const remainingBlocks = schedule.blocks.length - lateStartBlock + 1;
    setLateSaving(true);
    setLateError(null);
    try {
      const availableNames = [...new Set([...currentAvailablePlayerNames, arrivingPlayer])];
      const nextSchedule = await regenerateLateArrivalSchedule({ teamId: schedule.team_id, gameNumber: schedule.game_number, previousSchedule: { ...schedule, blocks: liveBlocks as unknown as import('@/engine/models').ScheduleBlock[] }, availablePlayerNames: availableNames, playerName: arrivingPlayer, startBlock: lateStartBlock, targetBlocks: lateTargetBlocks, minimumBlocks: lateTargetBlocks, maximumBlocks: Math.min(lateTargetBlocks, remainingBlocks), firstHalfGk: schedule.first_half_gk ?? undefined, secondHalfGk: lateTakeoverGk ? arrivingPlayer : (schedule.second_half_gk ?? undefined), ...(lateApprovalScope ? { approval: { player: arrivingPlayer, scope: lateApprovalScope, block: lateStartBlock, half: lateStartBlock > Math.ceil(schedule.blocks.length / 2) ? 1 : 0, reason: 'Late arrival exception requested in live mode' } } : {}), ...(approvedPlayerName ? { approvedPlayerName } : {}) });
      if (nextSchedule.needs_coach_approval && approvedPlayerName) {
        setApprovalCandidates([]);
        setApprovedPlayerName(null);
        setLateError('Unable to generate a complete rotation with that approval.');
        return;
      }
      if (nextSchedule.needs_coach_approval) {
        setApprovalCandidates(nextSchedule.approval_candidates ?? []);
        setApprovedPlayerName(nextSchedule.recommended_approval_player ?? nextSchedule.approval_candidates?.[0] ?? null);
        setLateApprovalScope(nextSchedule.approval_scope ?? 'entire_half');
        setLateError(nextSchedule.late_arrival_approval?.prompt ?? 'A coach approval is needed before applying this late arrival.');
        return;
      }
      const nextBlocks = nextSchedule.blocks.map((block) => ({ ...block, positions: { ...block.positions }, bench: [...block.bench] }));
      setLiveBlocks(nextBlocks as unknown as ScheduleBlock[]);
      setAvailablePlayerNames(nextSchedule.available_player_names ?? availableNames);
      const nextWarnings = [...new Set([...(schedule.warnings ?? []), ...(nextSchedule.warnings ?? [])])];
      setLiveWarnings(nextWarnings);
      await setAcceptedSchedule({ ...schedule, ...nextSchedule, warnings: nextWarnings, blocks: nextBlocks as unknown as ScheduleBlock[], completed_blocks: completedBlocks, live_availability: availabilityRecords, live_availability_history: availabilityHistory, live_position_overrides: positionOverrides, live_returned_players: returnedPlayers });
      setLateArrivedNames((names) => [...names, arrivingPlayer]);
      setApprovalCandidates([]);
      setApprovedPlayerName(null);
      setShowLateArrival(false);
    } catch (error) {
      setLateError(error instanceof Error ? error.message : 'The future rotation could not be updated.');
    } finally {
      setLateSaving(false);
    }
  }

  if (!schedule) {
    return (
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No live game right now.</Text>
            <Pressable onPress={() => router.navigate('/game')} style={styles.emptyAction} accessibilityRole="button">
              <Text style={styles.emptyActionText}>Create a schedule</Text>
            </Pressable>
          </View>
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
    const report = buildAfterGameReport(schedule, liveBlocks, availabilityHistory, positionOverrides);
    await clearAcceptedSchedule();
    if (onGameEnded) {
      onGameEnded(report);
    } else {
      router.push({ pathname: '/after-game', params: { data: JSON.stringify(report) } });
    }
  }

  function getPositionGroup(position: string): PositionGroup | null {
    return POSITION_GROUP_BY_SLOT[position] ?? null;
  }

  function isLegalPosition(playerName: string, position: string): boolean {
    const player = roster.find((candidate) => candidate.name === playerName);
    const group = getPositionGroup(position);
    return Boolean(player && group && canCoverSlot(player, position, group));
  }

  function swapPositions(block: ScheduleBlock, firstPosition: string, secondPosition: string): ScheduleBlock {
    const firstPlayer = block.positions[firstPosition];
    const secondPlayer = block.positions[secondPosition];
    const nextBlock = { ...block, positions: { ...block.positions }, bench: [...block.bench] } as ScheduleBlock;
    nextBlock.positions[firstPosition] = secondPlayer;
    nextBlock.positions[secondPosition] = firstPlayer;
    for (const group of ['D', 'M', 'F']) {
      const players = nextBlock[group];
      if (Array.isArray(players)) nextBlock[group] = players.filter((player) => player !== firstPlayer && player !== secondPlayer);
    }
    const firstGroup = getPositionGroup(firstPosition);
    const secondGroup = getPositionGroup(secondPosition);
    if (firstGroup && Array.isArray(nextBlock[firstGroup])) nextBlock[firstGroup].push(secondPlayer);
    if (secondGroup && Array.isArray(nextBlock[secondGroup])) nextBlock[secondGroup].push(firstPlayer);
    return nextBlock;
  }

  function selectPosition(blockIndex: number, position: string) {
    if (position === 'GK' || completedBlocks.includes(blockIndex) || availabilityMode || selectingUnavailablePlayer) return;
    const player = liveBlocks[blockIndex]?.positions[position];
    if (!player || player === 'UNASSIGNED') return;
    if (!selectedPosition) {
      setSelectedPosition({ blockIndex, position });
      return;
    }
    if (selectedPosition.blockIndex !== blockIndex) {
      setSelectedPosition({ blockIndex, position });
      return;
    }
    if (selectedPosition.position === position) {
      setSelectedPosition(null);
      return;
    }
    const firstPlayer = liveBlocks[blockIndex]?.positions[selectedPosition.position];
    if (!firstPlayer) return;
    setPendingSwap({
      blockIndex,
      firstPosition: selectedPosition.position,
      secondPosition: position,
      firstPlayer,
      secondPlayer: player,
      firstLegal: isLegalPosition(firstPlayer, position),
      secondLegal: isLegalPosition(player, selectedPosition.position),
    });
    setSelectedPosition(null);
  }

  async function confirmPositionSwap(scope: LivePositionOverride['scope']) {
    if (!schedule || !pendingSwap) return;
    const { blockIndex, firstPosition, secondPosition, firstPlayer, secondPlayer } = pendingSwap;
    const nextBlocks = liveBlocks.map((block, index) => {
      if (index === blockIndex) return swapPositions(block, firstPosition, secondPosition);
      if (scope === 'rest_of_game' && index > blockIndex
        && block.positions[firstPosition] === firstPlayer
        && block.positions[secondPosition] === secondPlayer) {
        return swapPositions(block, firstPosition, secondPosition);
      }
      return block;
    });
    const nextOverrides = [...positionOverrides,
      { blockIndex, player: firstPlayer, fromPosition: firstPosition, toPosition: secondPosition, scope, reason: 'coach_swap' as const, legalBefore: pendingSwap.firstLegal },
      { blockIndex, player: secondPlayer, fromPosition: secondPosition, toPosition: firstPosition, scope, reason: 'coach_swap' as const, legalBefore: pendingSwap.secondLegal },
    ];
    setLiveBlocks(nextBlocks);
    setPositionOverrides(nextOverrides);
    setPendingSwap(null);
    await setAcceptedSchedule({ ...schedule, blocks: nextBlocks, warnings: liveWarnings, live_position_overrides: nextOverrides, live_availability: availabilityRecords, live_availability_history: availabilityHistory, completed_blocks: completedBlocks, live_returned_players: returnedPlayers });
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
      warnings: liveWarnings,
      live_availability: availabilityRecords,
      live_availability_history: availabilityHistory,
      live_position_overrides: positionOverrides,
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
      warnings: liveWarnings,
      live_availability: availabilityRecords,
      live_availability_history: availabilityHistory,
      live_position_overrides: positionOverrides,
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
      warnings: liveWarnings,
      live_availability: nextAvailabilityRecords,
      live_availability_history: nextAvailabilityHistory,
      live_position_overrides: positionOverrides,
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
          <ScrollView style={styles.liveScroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <Pressable onPress={exitLiveMode} style={styles.backButton} accessibilityLabel="Exit live game">
                <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} />
              </Pressable>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>GAME {schedule.game_number} · LIVE</Text>
                <Text style={styles.title}>{schedule.team_name ?? 'Live game mode'}</Text>
              </View>
              <Text style={styles.halfLabel}>{secondHalf ? '2ND HALF' : '1ST HALF'}</Text>
            </View>

            <View style={styles.timerCard}>
              <Text style={styles.timer}>{formatTimer(seconds)}</Text>
              <Pressable
                onPress={() => setRunning((current) => !current)}
                style={styles.timerButton}
                accessibilityRole="button"
                accessibilityLabel={running ? 'Pause timer' : seconds === 0 ? 'Start timer' : 'Resume timer'}>
                <SymbolView name={{ ios: running ? 'pause.fill' : 'play.fill', android: running ? 'pause' : 'play_arrow', web: running ? 'pause' : 'play_arrow' }} size={17} tintColor={palette.panel} />
              </Pressable>
              <Pressable onPress={openTimeEditor} style={styles.setTimeButton} accessibilityRole="button">
                <SymbolView name={{ ios: 'pencil', android: 'edit', web: 'edit' }} size={15} tintColor={palette.green} />
                <Text style={styles.setTimeButtonText}>SET TIME</Text>
              </Pressable>
            </View>
            {!isEndOfGame && <Pressable onPress={openLateArrival} style={styles.lateArrivalButton} accessibilityRole="button"><SymbolView name={{ ios: 'person.badge.plus', android: 'person_add', web: 'person_add' }} size={16} tintColor={palette.green} /><Text style={styles.lateArrivalText}>ADD PLAYER</Text></Pressable>}
            {liveWarnings.length > 0 && <View style={styles.liveWarningBanner}><Text style={styles.liveWarningTitle}>ROTATION NOTES</Text>{liveWarnings.slice(-3).map((warning) => <Text key={warning} style={styles.liveWarningText}>{warning}</Text>)}</View>}

            <View style={styles.blockHeading}>
              <View>
                <Text style={styles.sectionEyebrow}>CURRENT BLOCK</Text>
                {!!positionOverrides.some((override) => !override.legalBefore) && <Text style={styles.overrideWarningText}>Manual position override recorded</Text>}
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
                          <Text style={[styles.blockCardTitle, header.title === 'Halftime' && styles.halftimeTitle]}>{header.title}</Text>
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
                                  style={[styles.assignmentCell, selectedPosition?.blockIndex === blockIndex && selectedPosition.position === position && styles.selectedAssignmentCell, !completedBlocks.includes(blockIndex) && (playerHighlight(liveBlocks, secondHalf ? index + halftimeIndex + 1 : index + 1, position, block.positions[position]) === 'subbedIn' || returnedPlayers.some((item) => item.player === block.positions[position] && item.blockIndex === blockIndex)) && styles.subbedInCell, !completedBlocks.includes(blockIndex) && playerHighlight(liveBlocks, secondHalf ? index + halftimeIndex + 1 : index + 1, position, block.positions[position]) === 'positionChanged' && styles.positionChangedCell]}
                                  onPress={() => selectingUnavailablePlayer ? selectUnavailablePlayer(block.positions[position], blockIndex) : selectPosition(blockIndex, position)}
                                  disabled={completedBlocks.includes(blockIndex) && !selectingUnavailablePlayer}
                                  accessibilityRole="button"
                                  accessibilityLabel={selectingUnavailablePlayer ? `Mark ${displayPlayerName(block.positions[position])} unavailable` : `Select ${displayPlayerName(block.positions[position])} at ${position}`}>
                                  <Text style={styles.positionLabel}>{position}</Text>
                                  <Text style={styles.assignmentName} numberOfLines={1}>
                                    {displayPlayerName(block.positions[position])}
                                    {playerNumber(roster, block.positions[position]) !== undefined ? ` #${playerNumber(roster, block.positions[position])}` : ''}
                                  </Text>
                                </Pressable>
                              ))}
                            </View>
                          </View>
                        );
                      })}
                    </View>
                    <View style={styles.benchList}>
                      <Text style={styles.benchLabel}>BENCH · {block.bench?.length ?? 0}</Text>
                      <Text style={styles.benchNames}>
                        {block.bench?.length
                          ? block.bench.map((player, playerIndex, bench) => (
                            <Text key={player} style={playerCameOffField(liveBlocks, blockIndex, player) ? styles.benchSubbedOutName : undefined}>
                              {displayPlayerName(player)}{playerNumber(roster, player) !== undefined ? ` #${playerNumber(roster, player)}` : ''}{playerIndex < bench.length - 1 ? ', ' : ''}
                            </Text>
                          ))
                          : 'None'}
                      </Text>
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

          </ScrollView>
          <View style={styles.liveActionFooter}>
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
          </View>
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
      <Modal visible={showLateArrival} transparent animationType="fade" onRequestClose={() => setShowLateArrival(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.timeModal}>
            <Text style={styles.modalEyebrow}>LATE ARRIVAL</Text>
            <Text style={styles.modalTitle}>{latePlayerName ? 'Set playing time' : 'Who arrived?'}</Text>
            <Text style={styles.modalDetail}>{latePlayerName ? 'Choose when they start and how many blocks they play.' : 'Players who were unavailable before the game.'}</Text>
            {!latePlayerName ? (
              <ScrollView style={styles.latePlayerList}>
                {roster.filter((player) => !currentAvailablePlayerNames.includes(player.name) && !lateArrivedNames.includes(player.name)).map((player) => (
                  <Pressable key={player.name} onPress={() => setLatePlayerName(player.name)} style={styles.latePlayerRow} accessibilityRole="button">
                    <Text style={styles.latePlayerName}>{displayPlayerName(player.name)}</Text>
                  </Pressable>
                ))}
                {roster.filter((player) => !currentAvailablePlayerNames.includes(player.name) && !lateArrivedNames.includes(player.name)).length === 0 && <Text style={styles.modalDetail}>Everyone is already in this rotation.</Text>}
              </ScrollView>
            ) : (
              <>
                <View style={styles.stepperRow}><Text style={styles.stepperLabel}>START BLOCK</Text><View style={styles.stepper}><Pressable onPress={() => setLateStartBlock((value) => Math.max(activeBlock + 2, value - 1))} style={styles.stepperButton}><Text style={styles.stepperButtonText}>-</Text></Pressable><Text style={styles.stepperValue}>{lateStartBlock}</Text><Pressable onPress={() => setLateStartBlock((value) => Math.min(schedule.blocks.length, value + 1))} style={styles.stepperButton}><Text style={styles.stepperButtonText}>+</Text></Pressable></View></View>
                <View style={styles.stepperRow}><Text style={styles.stepperLabel}>BLOCKS TO PLAY</Text><View style={styles.stepper}><Pressable onPress={() => setLateTargetBlocks((value) => Math.max(0, value - 1))} style={styles.stepperButton}><Text style={styles.stepperButtonText}>-</Text></Pressable><Text style={styles.stepperValue}>{lateTargetBlocks}</Text><Pressable onPress={() => setLateTargetBlocks((value) => Math.min(schedule.blocks.length - lateStartBlock + 1, value + 1))} style={styles.stepperButton}><Text style={styles.stepperButtonText}>+</Text></Pressable></View></View>
                {!lateApprovalScope ? <Pressable onPress={() => setLateApprovalScope('one_block')} style={styles.approvalOptIn}><Text style={styles.approvalOptInText}>REQUEST EXCEPTION APPROVAL</Text></Pressable> : <>
                  <Text style={styles.stepperLabel}>APPROVAL SCOPE</Text>
                  <View style={styles.scopeChoices}>
                    <Pressable onPress={() => setLateApprovalScope('one_block')} style={[styles.scopeButton, lateApprovalScope === 'one_block' && styles.scopeButtonSelected]}><Text style={styles.scopeButtonTitle}>One block</Text><Text style={styles.scopeButtonDetail}>Review this substitution</Text></Pressable>
                    <Pressable onPress={() => setLateApprovalScope('entire_half')} style={[styles.scopeButton, lateApprovalScope === 'entire_half' && styles.scopeButtonSelected]}><Text style={styles.scopeButtonTitle}>Entire half</Text><Text style={styles.scopeButtonDetail}>Review the remaining half</Text></Pressable>
                  </View>
                </>}
                {approvalCandidates.length > 0 && <View style={styles.approvalPanel}>
                  <Text style={styles.approvalPanelTitle}>COACH APPROVAL NEEDED</Text>
                  <Text style={styles.modalDetail}>The normal rotation could not be completed. Recommended: {displayPlayerName(approvedPlayerName ?? approvalCandidates[0])}.</Text>
                  <Text style={styles.approvalPanelLabel}>CHOOSE DIFFERENT</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    {approvalCandidates.map((candidate) => <Pressable key={candidate} onPress={() => setApprovedPlayerName(candidate)} style={[styles.candidateButton, approvedPlayerName === candidate && styles.scopeButtonSelected]}><Text style={styles.candidateButtonText}>{displayPlayerName(candidate)}</Text></Pressable>)}
                  </ScrollView>
                </View>}
                {lateStartBlock === halftimeIndex + 1 && latePlayerName && playerHasGoalkeeperRole(roster.find((item) => item.name === latePlayerName)) && <Pressable onPress={() => setLateTakeoverGk((value) => !value)} style={styles.gkChoice}><Text style={styles.gkChoiceText}>{lateTakeoverGk ? '✓ ' : ''}Take goalkeeper in the second half</Text></Pressable>}
                {lateError && <Text style={styles.timeError}>{lateError}</Text>}
                <View style={styles.modalActions}><Pressable onPress={() => approvalCandidates.length > 0 ? (setApprovalCandidates([]), setApprovedPlayerName(null), setLateApprovalScope(null), setLateError('Unable to generate a complete rotation without coach approval.')) : setLatePlayerName(null)} style={styles.cancelButton}><Text style={styles.cancelButtonText}>{approvalCandidates.length > 0 ? 'CANCEL' : 'BACK'}</Text></Pressable><Pressable onPress={() => void confirmLateArrival()} disabled={lateSaving} style={styles.applyButton}><Text style={styles.applyButtonText}>{lateSaving ? 'UPDATING' : approvalCandidates.length > 0 ? 'CONFIRM' : 'DONE'}</Text></Pressable></View>
              </>
            )}
            {!latePlayerName && <Pressable onPress={() => setShowLateArrival(false)} style={[styles.cancelButton, styles.lateCancel]}><Text style={[styles.cancelButtonText, styles.lateCancelText]}>CANCEL</Text></Pressable>}
          </View>
        </View>
      </Modal>
      <Modal visible={pendingSwap !== null} transparent animationType="fade" onRequestClose={() => setPendingSwap(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.timeModal}>
            <Text style={styles.modalEyebrow}>LIVE POSITION SWITCH</Text>
            <Text style={styles.modalTitle}>Choose how long this lasts</Text>
            <Text style={styles.modalDetail}>{pendingSwap && `${displayPlayerName(pendingSwap.firstPlayer)} and ${displayPlayerName(pendingSwap.secondPlayer)} will exchange positions.`}</Text>
            {pendingSwap && (!pendingSwap.firstLegal || !pendingSwap.secondLegal) && <Text style={styles.overrideNotice}>This creates an eligibility override. It will be visible in the game report.</Text>}
            <View style={styles.scopeChoices}>
              <Pressable onPress={() => void confirmPositionSwap('current_block')} style={styles.scopeButton} accessibilityRole="button">
                <Text style={styles.scopeButtonTitle}>This block only</Text>
                <Text style={styles.scopeButtonDetail}>Recommended</Text>
              </Pressable>
              <Pressable onPress={() => void confirmPositionSwap('rest_of_game')} style={styles.scopeButton} accessibilityRole="button">
                <Text style={styles.scopeButtonTitle}>Rest of game</Text>
                <Text style={styles.scopeButtonDetail}>Only while both players remain on field</Text>
              </Pressable>
            </View>
            <Pressable onPress={() => setPendingSwap(null)} style={styles.cancelButton} accessibilityRole="button">
              <Text style={styles.cancelButtonText}>CANCEL</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.paper },
  safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  liveScroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: BottomTabInset + 16 },
  liveActionFooter: { backgroundColor: palette.paper, paddingHorizontal: 16, paddingBottom: 8, paddingTop: 6 },
  header: { alignItems: 'center', flexDirection: 'row', marginBottom: 12 },
  backButton: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 },
  headerCopy: { flex: 1, marginLeft: 13 },
  eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 },
  title: { color: palette.ink, fontSize: 24, fontWeight: '800', marginTop: 3 },
  halfLabel: { color: palette.green, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  timerCard: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 18, flexDirection: 'row', gap: 12, justifyContent: 'space-evenly', marginBottom: 8, paddingHorizontal: 14, paddingVertical: 8 },
  timerLabel: { color: palette.green, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  timer: { color: palette.ink, fontSize: 38, fontWeight: '800', letterSpacing: 1 },
  timerButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 11, height: 40, justifyContent: 'center', width: 40 },
  lateArrivalButton: { alignItems: 'center', alignSelf: 'flex-end', flexDirection: 'row', gap: 5, marginBottom: 10, paddingHorizontal: 4, paddingVertical: 4 },
  lateArrivalText: { color: palette.green, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  setTimeButton: { alignItems: 'center', flexDirection: 'column', gap: 2, justifyContent: 'center', paddingHorizontal: 4, paddingVertical: 2 },
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
  latePlayerList: { marginTop: 16, maxHeight: 260 },
  latePlayerRow: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 14 },
  latePlayerName: { color: palette.ink, fontSize: 15, fontWeight: '800' },
  lateCancel: { alignSelf: 'stretch', borderColor: palette.coral, flex: 0, marginTop: 10 },
  lateCancelText: { color: palette.coral },
  liveWarningBanner: { backgroundColor: '#fff1dc', borderColor: '#e8bd82', borderRadius: 10, borderWidth: 1, marginBottom: 12, padding: 10 },
  liveWarningTitle: { color: '#8a5a18', fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  liveWarningText: { color: '#684719', fontSize: 12, marginTop: 4 },
  stepperRow: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 14 },
  stepperLabel: { color: palette.muted, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  stepper: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  stepperButton: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 10, height: 34, justifyContent: 'center', width: 34 },
  stepperButtonText: { color: palette.green, fontSize: 22, fontWeight: '700' },
  stepperValue: { color: palette.ink, fontSize: 20, fontWeight: '800', minWidth: 25, textAlign: 'center' },
  gkChoice: { backgroundColor: palette.greenSoft, borderRadius: 10, marginTop: 14, padding: 12 },
  gkChoiceText: { color: palette.green, fontSize: 12, fontWeight: '800' },
  blockHeading: { alignItems: 'flex-end', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 6 },
  legendItem: { alignItems: 'center', flexDirection: 'row', gap: 5 },
  legendSwatch: { borderRadius: 4, height: 12, width: 12 },
  legendText: { color: palette.muted, fontSize: 10, fontWeight: '700' },
  sectionEyebrow: { color: palette.coral, fontSize: 16, fontWeight: '800', letterSpacing: 0 },
  blockTitle: { color: palette.ink, fontSize: 21, fontWeight: '800', marginTop: 3 },
  swipeHint: { color: palette.muted, fontSize: 11 },
  page: { width: 360 },
  blockCard: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, overflow: 'hidden' },
  blockCardHeader: { alignItems: 'center', backgroundColor: palette.greenSoft, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 15, paddingVertical: 10 },
  blockCardTitle: { color: palette.ink, flex: 1, fontSize: 16, fontWeight: '800' }, halftimeTitle: { color: palette.halftime },
  blockCardDetail: { color: palette.green, fontSize: 10, fontWeight: '800', marginLeft: 12, textAlign: 'right' },
  assignmentList: { padding: 15 },
  positionGroup: { marginBottom: 13 },
  positionGroupLabel: { color: palette.muted, fontSize: 10, fontWeight: '900', letterSpacing: 1, marginBottom: 6, textAlign: 'center' },
  assignmentRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  assignmentCell: { alignItems: 'center', backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 9, borderWidth: 1, flex: 1, minWidth: 62, paddingHorizontal: 4, paddingVertical: 8 },
  selectedAssignmentCell: { backgroundColor: '#f8e5b2', borderColor: '#b4872e', borderWidth: 2 },
  subbedInCell: { backgroundColor: '#dcebe2', borderColor: palette.green },
  positionChangedCell: { backgroundColor: '#f8e5b2', borderColor: '#b4872e' },
  positionLabel: { color: palette.muted, fontSize: 10, fontWeight: '800' },
  assignmentName: { color: palette.ink, fontSize: 12, fontWeight: '700', marginTop: 4 },
  benchList: { backgroundColor: '#f7f4ed', borderTopColor: palette.line, borderTopWidth: 1, padding: 15 },
  benchLabel: { color: palette.muted, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  benchNames: { color: palette.ink, fontSize: 12, lineHeight: 18, marginTop: 4 }, benchSubbedOutName: { color: palette.coral },
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
  overrideNotice: { backgroundColor: '#f8e5b2', borderRadius: 11, color: '#76591a', fontSize: 12, fontWeight: '700', lineHeight: 18, marginTop: 14, padding: 12 },
  scopeChoices: { gap: 9, marginTop: 18 },
  scopeButton: { backgroundColor: palette.greenSoft, borderColor: palette.green, borderRadius: 11, borderWidth: 1, padding: 13 },
  scopeButtonSelected: { backgroundColor: '#b9d9c4', borderWidth: 2 },
  approvalOptIn: { alignSelf: 'flex-start', borderColor: palette.green, borderRadius: 9, borderWidth: 1, marginBottom: 10, paddingHorizontal: 10, paddingVertical: 8 },
  approvalOptInText: { color: palette.green, fontSize: 11, fontWeight: '900', letterSpacing: 0.5 },
  approvalPanel: { backgroundColor: '#fff1dc', borderColor: '#e8bd82', borderRadius: 10, borderWidth: 1, marginBottom: 10, padding: 10 },
  approvalPanelTitle: { color: '#8a5a18', fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  approvalPanelLabel: { color: palette.muted, fontSize: 10, fontWeight: '900', marginTop: 8 },
  candidateButton: { backgroundColor: palette.panel, borderColor: palette.green, borderRadius: 9, borderWidth: 1, marginRight: 6, marginTop: 6, paddingHorizontal: 10, paddingVertical: 7 },
  candidateButtonText: { color: palette.green, fontSize: 12, fontWeight: '800' },
  scopeButtonTitle: { color: palette.green, fontSize: 13, fontWeight: '900' },
  scopeButtonDetail: { color: palette.muted, fontSize: 11, marginTop: 3 },
  overrideWarningText: { color: palette.coral, fontSize: 10, fontWeight: '800', marginTop: 3 },
  halftimeButton: { alignItems: 'center', backgroundColor: palette.coral, borderRadius: 16, flexDirection: 'row', justifyContent: 'space-between', marginTop: 18, paddingHorizontal: 17, paddingVertical: 16 },
  halftimeButtonText: { color: palette.panel, fontSize: 14, fontWeight: '800' },
  endGameButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 16, flexDirection: 'row', justifyContent: 'space-between', marginTop: 18, paddingHorizontal: 17, paddingVertical: 16 },
  endGameButtonText: { color: palette.panel, fontSize: 14, fontWeight: '800' },
  footerHint: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 18, textAlign: 'center' },
  emptyState: { backgroundColor: palette.panel, borderRadius: 17, margin: 16, padding: 18 },
  emptyText: { color: palette.ink, fontSize: 18, fontWeight: '800' },
  emptyAction: { alignItems: 'center', backgroundColor: palette.coral, borderRadius: 12, marginTop: 18, minHeight: 46, justifyContent: 'center', paddingHorizontal: 16 },
  emptyActionText: { color: palette.panel, fontSize: 13, fontWeight: '800' },
  warningFlash: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(255, 255, 255, 0.82)' },
});
