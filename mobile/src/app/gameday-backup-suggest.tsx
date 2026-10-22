import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import type { SeasonRosterPlayer } from '@/engine/models';
import { appendBackupPosition, backupSuggestions, formatGeneralPositions } from '@/coverage-utils';
import { generateLocalSchedule } from '@/services/schedule-service';
import { getRoster, updateRoster } from '@/services/team-service';
import { RedesignOfferError, ScheduleGenerationCancelledError, suggestBackupPlayerNames } from '@/services/redesign-schedule-service';

const palette = {
  ink: '#17221f',
  muted: '#6b7873',
  paper: '#f5f1e8',
  panel: '#fffdf8',
  line: '#e4ded1',
  green: '#19634b',
  greenSoft: '#dcebe2',
  coral: '#d96f4c',
  red: '#b42318',
  redSoft: '#fde7e5',
};

type FieldGroup = 'D' | 'M' | 'F';
type ScheduleRequest = {
  teamId: string;
  gameNumber: number;
  availablePlayerNames: string[];
  firstHalfGk: string | null;
  secondHalfGk: string | null;
};

const groupNames: Record<FieldGroup, string> = {
  D: 'Defenders',
  M: 'Midfielders',
  F: 'Forwards',
};

function parameter(value: string | string[] | undefined, label: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && value.length === 1 && value[0]) return value[0];
  throw new Error(`Missing gameday backup ${label}. Return to Gameday and try again.`);
}

function isFieldGroup(value: unknown): value is FieldGroup {
  return value === 'D' || value === 'M' || value === 'F';
}

function parseAvailablePlayers(value: string): string[] {
  return parsePlayerNames(value, 'available-player list');
}

function parsePlayerNames(value: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`The ${label} is invalid. Return to Gameday and try again.`);
  }
  if (!Array.isArray(parsed) || !parsed.every((name) => typeof name === 'string')) {
    throw new Error(`The ${label} is invalid. Return to Gameday and try again.`);
  }
  return parsed;
}

export default function GamedayBackupSuggestScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    group?: string | string[];
    teamId?: string | string[];
    gameNumber?: string | string[];
    availablePlayerNames?: string | string[];
    firstHalfGk?: string | string[];
    secondHalfGk?: string | string[];
    suggestedPlayerNames?: string | string[];
    warning?: string | string[];
  }>();
  const rawGroup = Array.isArray(params.group) ? params.group[0] : params.group;
  const rawTeamId = Array.isArray(params.teamId) ? params.teamId[0] : params.teamId;
  const rawGameNumber = Array.isArray(params.gameNumber) ? params.gameNumber[0] : params.gameNumber;
  const rawAvailablePlayerNames = Array.isArray(params.availablePlayerNames) ? params.availablePlayerNames[0] : params.availablePlayerNames;
  const rawFirstHalfGk = Array.isArray(params.firstHalfGk) ? params.firstHalfGk[0] : params.firstHalfGk;
  const rawSecondHalfGk = Array.isArray(params.secondHalfGk) ? params.secondHalfGk[0] : params.secondHalfGk;
  const rawSuggestedPlayerNames = Array.isArray(params.suggestedPlayerNames) ? params.suggestedPlayerNames[0] : params.suggestedPlayerNames;
  const rawWarning = Array.isArray(params.warning) ? params.warning[0] : params.warning;
  const [players, setPlayers] = useState<SeasonRosterPlayer[]>([]);
  const [scheduleRequest, setScheduleRequest] = useState<ScheduleRequest | null>(null);
  const [suggestedPlayerNames, setSuggestedPlayerNames] = useState<string[] | null>(null);
  const [group, setGroup] = useState<FieldGroup | null>(null);
  const [warning, setWarning] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [backupAdded, setBackupAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submissionStarted = useRef(false);
  const generationController = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    async function loadSuggestionContext() {
      try {
        const groupValue = parameter(rawGroup, 'position group');
        if (!isFieldGroup(groupValue)) throw new Error('The requested backup group is invalid. Return to Gameday and try again.');
        const teamId = parameter(rawTeamId, 'team');
        const gameNumber = Number(parameter(rawGameNumber, 'game number'));
        if (!Number.isInteger(gameNumber) || gameNumber < 1) throw new Error('The game number is invalid. Return to Gameday and try again.');
        const availablePlayerNames = parseAvailablePlayers(parameter(rawAvailablePlayerNames, 'available-player list'));
        const suggestedNames = rawSuggestedPlayerNames
          ? parsePlayerNames(rawSuggestedPlayerNames, 'suggested-player list')
          : await suggestBackupPlayerNames({
            teamId,
            gameNumber,
            availablePlayerNames,
            firstHalfGk: rawFirstHalfGk || null,
            secondHalfGk: rawSecondHalfGk || null,
            group: groupValue,
          });
        const roster = await getRoster(teamId);
        if (!Array.isArray(roster.players)) throw new Error('The roster response did not contain a player list.');
        if (!active) return;
        setPlayers(roster.players);
        setSuggestedPlayerNames(suggestedNames);
        setGroup(groupValue);
        setScheduleRequest({
          teamId,
          gameNumber,
          availablePlayerNames,
          firstHalfGk: rawFirstHalfGk || null,
          secondHalfGk: rawSecondHalfGk || null,
        });
        setWarning(rawWarning ?? `Choose a player for a ${groupValue} backup.`);
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Unable to load gameday backup suggestions.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadSuggestionContext();
    return () => {
      active = false;
    };
  }, [rawAvailablePlayerNames, rawFirstHalfGk, rawGameNumber, rawGroup, rawSecondHalfGk, rawSuggestedPlayerNames, rawTeamId, rawWarning]);

  useEffect(() => () => generationController.current?.abort(), []);

  const availableNames = useMemo(
    () => new Set(scheduleRequest?.availablePlayerNames ?? []),
    [scheduleRequest],
  );
  const suggestedNames = useMemo(
    () => suggestedPlayerNames ? new Set(suggestedPlayerNames) : null,
    [suggestedPlayerNames],
  );
  const candidates = useMemo(
    () => group
      ? backupSuggestions(players.filter((player) => availableNames.has(player.name)), group)
        .filter((player) => !suggestedNames || suggestedNames.has(player.name))
      : [],
    [availableNames, group, players, suggestedNames],
  );

  async function openBackupSuggestions(
    request: ScheduleRequest,
    backupGroup: FieldGroup,
    backupWarning: string,
    offeredNames: string[] | null,
  ) {
    const qualifyingNames = offeredNames ?? await suggestBackupPlayerNames({
      ...request,
      group: backupGroup,
    });
    if (!qualifyingNames.length) {
      Alert.alert('Backup suggestions unavailable', 'No backup currently qualifies for this position group.');
      return;
    }
    router.push({
      pathname: '/gameday-backup-suggest',
      params: {
        group: backupGroup,
        teamId: request.teamId,
        gameNumber: String(request.gameNumber),
        availablePlayerNames: JSON.stringify(request.availablePlayerNames),
        firstHalfGk: request.firstHalfGk ?? '',
        secondHalfGk: request.secondHalfGk ?? '',
        warning: backupWarning,
        suggestedPlayerNames: JSON.stringify(qualifyingNames),
      },
    });
  }

  function confirmRelaxedSchedule(
    request: ScheduleRequest,
    backupPlayerName: string,
    backupGroup: FieldGroup,
    missedBackup: boolean,
  ) {
    Alert.alert(
      missedBackup ? 'Backup not needed' : 'Confirm relaxed schedule',
      missedBackup
        ? `${backupPlayerName} wasn't needed at ${backupGroup}. The schedule also needs relaxed playing-time limits. Generate it?`
        : 'The schedule needs relaxed minimum and maximum playing-time limits. Generate it?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Generate Relaxed',
          onPress: () => void generateAfterBackup(request, backupPlayerName, backupGroup, true, true),
        },
      ],
    );
  }

  async function generateAfterBackup(
    request: ScheduleRequest,
    backupPlayerName: string,
    backupGroup: FieldGroup,
    allowRelaxedMinimums = false,
    allowRelaxedMaximums = false,
    requireRelaxedConsent = false,
  ) {
    const controller = new AbortController();
    generationController.current = controller;
    setRegenerating(true);
    setError(null);
    try {
      const schedule = await generateLocalSchedule({
        ...request,
        allowRelaxedMinimums,
        allowRelaxedMaximums,
        previewOnly: requireRelaxedConsent,
        signal: controller.signal,
      });
      const missedBackup = schedule.placement_audit?.plannedVsPlaced?.find((entry) =>
        entry.player === backupPlayerName && entry.group === backupGroup && entry.placed === 0);
      const needsRelaxedConsent = requireRelaxedConsent && schedule.warnings.some((entry) =>
        entry.startsWith('Minimums relaxed for:') || entry.startsWith('Playing time relaxed to fit'));
      if (missedBackup) {
        if (needsRelaxedConsent) {
          confirmRelaxedSchedule(request, backupPlayerName, backupGroup, true);
          return;
        }
        Alert.alert(
          'Backup not needed',
          `${backupPlayerName} wasn't needed at ${backupGroup} this game`,
          [{ text: 'OK', onPress: () => router.replace({ pathname: '/schedule', params: { data: JSON.stringify(schedule) } }) }],
        );
        return;
      }
      if (needsRelaxedConsent) {
        confirmRelaxedSchedule(request, backupPlayerName, backupGroup, false);
        return;
      }
      router.replace({ pathname: '/schedule', params: { data: JSON.stringify(schedule) } });
    } catch (generationError) {
      if (generationError instanceof ScheduleGenerationCancelledError) return;
      if (generationError instanceof RedesignOfferError && generationError.offer.kind === 'position-shortage') {
        const offer = generationError.offer;
        const nextGroup = offer.context.positionGroup;
        const nextGroupWarning = typeof offer.context.positionGroupWarning === 'string'
          ? offer.context.positionGroupWarning
          : offer.message;
        const suggestedNames = Array.isArray(offer.context.suggestedPlayerNames)
          ? offer.context.suggestedPlayerNames.filter((value): value is string => typeof value === 'string')
          : null;
        Alert.alert('Can\'t Generate Schedule', offer.message, offer.buttons.map((button) => ({
          text: button.label,
          style: button.action === 'cancel' ? 'cancel' as const : 'default' as const,
          onPress: () => {
            if (button.action === 'suggest-backup' || button.action === 'go-to-builder' || button.action === 'choose-player') {
              if (!isFieldGroup(nextGroup)) {
                Alert.alert('Backup suggestions unavailable', 'The schedule warning did not include a valid position group.');
                return;
              }
              void openBackupSuggestions(request, nextGroup, nextGroupWarning, suggestedNames);
            }
          },
        })));
        return;
      }
      if (generationError instanceof RedesignOfferError && generationError.offer.kind === 'relaxed-minimums') {
        Alert.alert('Can\'t Generate Schedule', generationError.offer.message, generationError.offer.buttons.map((button) => ({
          text: button.label,
          style: button.action === 'cancel' ? 'cancel' as const : 'default' as const,
          onPress: () => {
            if (button.action === 'allow-relaxed') void generateAfterBackup(request, backupPlayerName, backupGroup, true);
          },
        })));
        return;
      }
      if (generationError instanceof RedesignOfferError && generationError.offer.kind === 'relaxed-maximums') {
        const offer = generationError.offer;
        const nextGroup = offer.context.positionGroup;
        const nextGroupWarning = typeof offer.context.positionGroupWarning === 'string'
          ? offer.context.positionGroupWarning
          : offer.message;
        const suggestedNames = Array.isArray(offer.context.suggestedPlayerNames)
          ? offer.context.suggestedPlayerNames.filter((value): value is string => typeof value === 'string')
          : null;
        Alert.alert('Can\'t Generate Schedule', offer.message, offer.buttons.map((button) => ({
          text: button.label,
          style: button.action === 'cancel' ? 'cancel' as const : 'default' as const,
          onPress: () => {
            if (button.action === 'allow-relaxed-maximums') void generateAfterBackup(request, backupPlayerName, backupGroup, true, true);
            else if (button.action === 'suggest-backup') {
              if (!isFieldGroup(nextGroup)) {
                Alert.alert('Backup suggestions unavailable', 'The schedule warning did not include a valid position group.');
                return;
              }
              void openBackupSuggestions(request, nextGroup, nextGroupWarning, suggestedNames);
            }
          },
        })));
        return;
      }
      const message = generationError instanceof Error ? generationError.message : 'Unable to regenerate the schedule.';
      setError(`The backup was saved, but the schedule could not be regenerated: ${message}`);
    } finally {
      setRegenerating(false);
      setSaving(false);
      if (generationController.current === controller) generationController.current = null;
    }
  }

  async function addBackup(playerName: string) {
    if (!group || !scheduleRequest || submissionStarted.current) return;
    const player = players.find((candidate) => candidate.name === playerName);
    if (!player) {
      setError(`${playerName} is no longer on this roster. Return to Gameday and try again.`);
      return;
    }
    submissionStarted.current = true;
    setSaving(true);
    setError(null);
    try {
      const updatedRoster = players.map((candidate) =>
        candidate.name === playerName ? appendBackupPosition(candidate, group) : candidate,
      );
      await updateRoster(scheduleRequest.teamId, updatedRoster);
      setBackupAdded(true);
      await generateAfterBackup(scheduleRequest, playerName, group, true, true, true);
    } catch (saveError) {
      submissionStarted.current = false;
      setSaving(false);
      setError(saveError instanceof Error ? saveError.message : 'Unable to save the backup position.');
    }
  }

  function cancelRetry() {
    generationController.current?.abort();
    router.back();
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityLabel="Return to Gameday">
                <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} />
              </Pressable>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>GAMEDAY BACKUP</Text>
                <Text style={styles.title}>Suggest a backup</Text>
              </View>
            </View>

            {error && <View style={styles.errorBanner}><Text style={styles.errorText}>{error}</Text></View>}
            {regenerating && (
              <View style={styles.regeneratingBanner} accessibilityLiveRegion="polite">
                <ActivityIndicator color={palette.green} />
                <Text style={styles.regeneratingText}>Backup saved. Regenerating schedule...</Text>
              </View>
            )}
            {loading ? <Text style={styles.helperText}>Loading available players...</Text> : group && (
              <View style={styles.card}>
                <Text style={styles.groupTitle}>{groupNames[group]}</Text>
                <Text style={styles.warningText}>{warning}</Text>
                <Text style={styles.helperText}>{backupAdded ? 'The backup is saved. Review the retry result or return to Gameday.' : `Choose an available player to add a ${group} backup. The schedule will regenerate after you add one.`}</Text>
                {candidates.length === 0 ? (
                  <Text style={styles.emptyText}>No backup helps this game</Text>
                ) : (
                  <View style={styles.playerList}>
                    {candidates.map((player) => (
                      <View key={player.name} style={styles.playerRow}>
                        <Text style={styles.playerName} numberOfLines={2}>{player.name} ({formatGeneralPositions(player.general_positions)})</Text>
                        <Pressable
                          onPress={() => void addBackup(player.name)}
                          disabled={backupAdded || saving || regenerating}
                          style={[styles.addButton, saving && styles.disabledButton]}
                          accessibilityRole="button">
                          <Text style={styles.addButtonText}>{saving ? 'ADDING...' : backupAdded ? 'ADDED' : 'ADD'}</Text>
                        </Pressable>
                      </View>
                    ))}
                  </View>
                )}
                <Pressable onPress={regenerating ? cancelRetry : () => router.back()} disabled={saving && !regenerating} style={styles.cancelButton} accessibilityRole="button">
                  <Text style={styles.cancelButtonText}>{regenerating ? 'CANCEL RETRY' : 'CANCEL'}</Text>
                </Pressable>
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.paper },
  safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: BottomTabInset + 24, gap: 14 },
  header: { alignItems: 'center', flexDirection: 'row', marginBottom: 3 },
  backButton: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 },
  headerCopy: { flex: 1, marginLeft: 13 },
  eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 },
  title: { color: palette.ink, fontSize: 27, fontWeight: '800', marginTop: 3 },
  card: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 18, borderWidth: 1, padding: 17 },
  groupTitle: { color: palette.ink, fontSize: 19, fontWeight: '800' },
  warningText: { color: palette.red, fontSize: 14, fontWeight: '700', lineHeight: 20, marginTop: 8 },
  helperText: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 9 },
  playerList: { borderTopColor: palette.line, borderTopWidth: 1, marginTop: 15 },
  playerRow: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', gap: 10, minHeight: 59, paddingVertical: 9 },
  playerName: { color: palette.ink, flex: 1, fontSize: 14, fontWeight: '700' },
  addButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 9, minWidth: 70, paddingHorizontal: 13, paddingVertical: 10 },
  addButtonText: { color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  disabledButton: { opacity: 0.55 },
  emptyText: { backgroundColor: palette.redSoft, borderRadius: 10, color: palette.red, fontSize: 12, lineHeight: 18, marginTop: 14, padding: 11 },
  cancelButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 9, borderWidth: 1, marginTop: 14, paddingVertical: 11 },
  cancelButtonText: { color: palette.muted, fontSize: 11, fontWeight: '900', letterSpacing: 0.8 },
  errorBanner: { backgroundColor: palette.redSoft, borderRadius: 11, padding: 11 },
  errorText: { color: palette.red, fontSize: 12, lineHeight: 17 },
  regeneratingBanner: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 11, flexDirection: 'row', gap: 10, padding: 12 },
  regeneratingText: { color: palette.green, flex: 1, fontSize: 12, fontWeight: '700' },
});
