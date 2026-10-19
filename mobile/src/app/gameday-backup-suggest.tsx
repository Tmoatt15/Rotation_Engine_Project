import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import type { SeasonRosterPlayer } from '@/engine/models';
import { appendBackupPosition, backupSuggestions, formatGeneralPositions } from '@/coverage-utils';
import { generateLocalSchedule } from '@/services/schedule-service';
import { getRoster, updateRoster } from '@/services/team-service';
import { RedesignOfferError } from '@/services/redesign-schedule-service';

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('The available-player list is invalid. Return to Gameday and try again.');
  }
  if (!Array.isArray(parsed) || !parsed.every((name) => typeof name === 'string')) {
    throw new Error('The available-player list is invalid. Return to Gameday and try again.');
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
    warning?: string | string[];
  }>();
  const rawGroup = Array.isArray(params.group) ? params.group[0] : params.group;
  const rawTeamId = Array.isArray(params.teamId) ? params.teamId[0] : params.teamId;
  const rawGameNumber = Array.isArray(params.gameNumber) ? params.gameNumber[0] : params.gameNumber;
  const rawAvailablePlayerNames = Array.isArray(params.availablePlayerNames) ? params.availablePlayerNames[0] : params.availablePlayerNames;
  const rawFirstHalfGk = Array.isArray(params.firstHalfGk) ? params.firstHalfGk[0] : params.firstHalfGk;
  const rawSecondHalfGk = Array.isArray(params.secondHalfGk) ? params.secondHalfGk[0] : params.secondHalfGk;
  const rawWarning = Array.isArray(params.warning) ? params.warning[0] : params.warning;
  const [players, setPlayers] = useState<SeasonRosterPlayer[]>([]);
  const [scheduleRequest, setScheduleRequest] = useState<ScheduleRequest | null>(null);
  const [group, setGroup] = useState<FieldGroup | null>(null);
  const [warning, setWarning] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        const roster = await getRoster(teamId);
        if (!Array.isArray(roster.players)) throw new Error('The roster response did not contain a player list.');
        if (!active) return;
        setPlayers(roster.players);
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
  }, [rawAvailablePlayerNames, rawFirstHalfGk, rawGameNumber, rawGroup, rawSecondHalfGk, rawTeamId, rawWarning]);

  const availableNames = useMemo(
    () => new Set(scheduleRequest?.availablePlayerNames ?? []),
    [scheduleRequest],
  );
  const candidates = useMemo(
    () => group ? backupSuggestions(players.filter((player) => availableNames.has(player.name)), group) : [],
    [availableNames, group, players],
  );

  async function generateAfterBackup(request: ScheduleRequest, allowRelaxedMinimums = false) {
    try {
      const schedule = await generateLocalSchedule({
        ...request,
        allowRelaxedMinimums,
      });
      router.replace({ pathname: '/schedule', params: { data: JSON.stringify(schedule) } });
    } catch (generationError) {
      if (generationError instanceof RedesignOfferError && generationError.offer.kind === 'position-shortage') {
        const nextGroup = generationError.offer.context.positionGroup;
        if (isFieldGroup(nextGroup)) {
          setGroup(nextGroup);
          setWarning(generationError.offer.message);
          setError(null);
          return;
        }
      }
      if (generationError instanceof RedesignOfferError && generationError.offer.kind === 'relaxed-minimums') {
        Alert.alert('Can\'t Generate Schedule', generationError.offer.message, generationError.offer.buttons.map((button) => ({
          text: button.label,
          style: button.action === 'cancel' ? 'cancel' as const : 'default' as const,
          onPress: () => {
            if (button.action === 'allow-relaxed') {
              setSaving(true);
              void generateAfterBackup(request, true).finally(() => setSaving(false));
            }
          },
        })));
        return;
      }
      const message = generationError instanceof Error ? generationError.message : 'Unable to regenerate the schedule.';
      setError(`The backup was saved, but the schedule could not be regenerated: ${message}`);
    }
  }

  async function addBackup(playerName: string) {
    if (!group || !scheduleRequest || saving) return;
    const player = players.find((candidate) => candidate.name === playerName);
    if (!player) {
      setError(`${playerName} is no longer on this roster. Return to Gameday and try again.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updatedRoster = players.map((candidate) =>
        candidate.name === playerName ? appendBackupPosition(candidate, group) : candidate,
      );
      const payload = await updateRoster(scheduleRequest.teamId, updatedRoster);
      setPlayers(payload.players);
      setWarning(`Added ${group} backup for ${playerName}. Regenerating schedule...`);
      await generateAfterBackup(scheduleRequest);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save the backup position.');
    } finally {
      setSaving(false);
    }
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
            {loading ? <Text style={styles.helperText}>Loading available players...</Text> : group && (
              <View style={styles.card}>
                <Text style={styles.groupTitle}>{groupNames[group]}</Text>
                <Text style={styles.warningText}>{warning}</Text>
                <Text style={styles.helperText}>Choose an available player to add a {group} backup. The schedule will regenerate after you add one.</Text>
                {candidates.length === 0 ? (
                  <Text style={styles.emptyText}>No available players can take this backup. Return to Gameday to review the roster.</Text>
                ) : (
                  <View style={styles.playerList}>
                    {candidates.map((player) => (
                      <View key={player.name} style={styles.playerRow}>
                        <Text style={styles.playerName} numberOfLines={2}>{player.name} ({formatGeneralPositions(player.general_positions)})</Text>
                        <Pressable
                          onPress={() => void addBackup(player.name)}
                          disabled={saving}
                          style={[styles.addButton, saving && styles.disabledButton]}
                          accessibilityRole="button">
                          <Text style={styles.addButtonText}>{saving ? 'ADDING...' : 'ADD'}</Text>
                        </Pressable>
                      </View>
                    ))}
                  </View>
                )}
                <Pressable onPress={() => router.back()} disabled={saving} style={styles.cancelButton} accessibilityRole="button">
                  <Text style={styles.cancelButtonText}>CANCEL</Text>
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
});
