import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import type { SeasonRosterPlayer } from '@/engine/models';
import { appendBackupPosition, backupProgressText, backupSuggestions, calculateBackupNeeds, calculateRosterCheck, countAssignedBackups, countGroupBackups, formatGeneralPositions, isMissingGeneralGroup, type RosterCheckGroup } from '@/coverage-utils';
import { getActiveTeam, getRoster, getSeasonSettings, updateRoster } from '@/services/team-service';

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
  yellow: '#9a6900',
  yellowSoft: '#fff1cb',
};

type FieldGroup = 'D' | 'M' | 'F';
type UndoAction = { playerName: string; group: FieldGroup };

const groupCopy: Record<FieldGroup, { label: string; source: string }> = {
  D: { label: 'Defenders', source: 'midfield' },
  M: { label: 'Midfielders', source: 'defense or forward' },
  F: { label: 'Forwards', source: 'midfield' },
};

const statusCopy: Record<RosterCheckGroup['status'], string> = {
  'in-range': 'In range',
  over: 'Over',
  under: 'Under',
};

const statusStyles = {
  'in-range': { text: palette.green, background: palette.greenSoft },
  over: { text: palette.yellow, background: palette.yellowSoft },
  under: { text: palette.red, background: palette.redSoft },
};

export default function CoverageScreen() {
  const router = useRouter();
  const [players, setPlayers] = useState<SeasonRosterPlayer[]>([]);
  const playersRef = useRef<SeasonRosterPlayer[]>([]);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [formation, setFormation] = useState<string | null>(null);
  const [gameFormat, setGameFormat] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedGroup, setExpandedGroup] = useState<FieldGroup | null>(null);
  const [selectedPlayers, setSelectedPlayers] = useState<Partial<Record<FieldGroup, string>>>({});
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getActiveTeam()
      .then((team) => Promise.all([getRoster(team.id), getSeasonSettings(team.id)]).then(([roster, settings]) => ({ team, roster, settings })))
      .then(({ team, roster, settings }) => {
        if (!Array.isArray(roster.players)) throw new Error('The roster response did not contain a player list.');
        if (!active) return;
        playersRef.current = roster.players;
        setPlayers(roster.players);
        setTeamId(team.id);
        setTeamName(team.name);
        setFormation(settings.formation);
        setGameFormat(settings.game_format);
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Unable to load roster helper.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []));

  const targets = useMemo(
    () => formation
      ? calculateRosterCheck(formation, players, gameFormat !== '4v4')
      : [],
    [formation, gameFormat, players],
  );
  const missingGroupPlayers = useMemo(() => players.filter(isMissingGeneralGroup), [players]);
  const backupPlan = useMemo(
    () => formation ? calculateBackupNeeds(formation, players.length) : { total: 0, groups: [] },
    [formation, players.length],
  );
  const totalSuggestedBackups = backupPlan.total;
  const remainingSuggestedBackups = Math.max(0, totalSuggestedBackups - countAssignedBackups(players));
  const uncoveredGroups = targets.filter((item) => item.group !== 'GK' && item.backupCoverage !== 'covered');
  const noCoverGroups = uncoveredGroups.filter((item) => item.backupCoverage === 'no-cover');
  const thinCoverGroups = uncoveredGroups.filter((item) => item.backupCoverage === 'thin');
  const describeCoverageGap = (groups: typeof uncoveredGroups, phrase: string) => {
    if (!groups.length) return null;
    const plural = groups.length !== 1;
    return `${groups.length} ${plural ? 'groups have' : 'group has'} ${phrase} (${groups.map((item) => item.label).join(', ')})`;
  };
  const coverageWarning = [
    describeCoverageGap(noCoverGroups, 'no backup cover'),
    describeCoverageGap(thinCoverGroups, 'thin backup cover'),
  ].filter((message): message is string => message !== null).join('; ');
  const rosterCheckAllGood = missingGroupPlayers.length === 0
    && targets.every((item) => item.status === 'in-range')
    && targets.filter((item) => item.group !== 'GK').every((item) => item.backupCoverage === 'covered');

  async function addBackup(playerName: string, group: FieldGroup) {
    if (saving) return;
    const currentPlayers = playersRef.current;
    const player = currentPlayers.find((candidate) => candidate.name === playerName);
    if (!player) {
      setError(`${playerName} is no longer on this roster. Reload the screen and try again.`);
      return;
    }
    const nextPlayers = currentPlayers.map((candidate) =>
      candidate.name === playerName ? appendBackupPosition(candidate, group) : candidate,
    );
    setSaving(true);
    setError(null);
    try {
      if (!teamId) throw new Error('The active team is not loaded yet.');
      const payload = await updateRoster(teamId, nextPlayers);
      playersRef.current = payload.players;
      setPlayers(payload.players);
      setExpandedGroup(null);
      setSelectedPlayers({});
      setUndoAction({ playerName, group });
      setToast(`${playerName} added as a ${groupCopy[group].label.toLowerCase()} backup.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save the backup assignment.');
    } finally {
      setSaving(false);
    }
  }

  async function undoBackup() {
    if (!undoAction || saving) return;
    const { playerName, group } = undoAction;
    const currentPlayers = playersRef.current;
    const nextPlayers = currentPlayers.map((player) => player.name === playerName
      ? { ...player, backup_positions: (player.backup_positions ?? []).filter((position) => position.toUpperCase() !== group) }
      : player,
    );
    setSaving(true);
    setError(null);
    try {
      if (!teamId) throw new Error('The active team is not loaded yet.');
      const payload = await updateRoster(teamId, nextPlayers);
      playersRef.current = payload.players;
      setPlayers(payload.players);
      setUndoAction(null);
      setToast('Backup assignment undone.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to undo the backup assignment.');
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
              <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityLabel="Go back">
                <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} />
              </Pressable>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>WEEKLY PLANNING</Text>
                <Text style={styles.title}>Roster Helper</Text>
                {teamName && <Text style={styles.subtitle}>{teamName}</Text>}
              </View>
            </View>

            {error && <View style={styles.errorBanner}><Text style={styles.errorText}>{error}</Text></View>}
            {loading ? <Text style={styles.loadingText}>Loading roster...</Text> : formation && (
              <>
                {remainingSuggestedBackups > 0 && (
                  <View style={styles.backupPlannerBanner}>
                    <Text style={styles.backupPlannerBannerTitle}>Backup coverage is thin</Text>
                    <Text style={styles.backupPlannerBannerDetail}>Backup Planner suggests {remainingSuggestedBackups} backups</Text>
                  </View>
                )}
                <View style={styles.card}>
                  <View style={styles.cardHeading}>
                    <View style={styles.cardIcon}><SymbolView name="checkmark.seal" size={21} tintColor={palette.green} /></View>
                    <View style={styles.cardHeadingCopy}>
                      <Text style={styles.cardTitle}>Roster Check</Text>
                      <Text style={styles.cardSubtitle}>Based on {players.length} players in a {formation} formation</Text>
                    </View>
                    <View style={[styles.rosterCheckStatus, rosterCheckAllGood ? styles.rosterCheckStatusGood : styles.rosterCheckStatusAttention]}>
                      <Text style={[styles.rosterCheckStatusText, rosterCheckAllGood ? styles.rosterCheckStatusTextGood : styles.rosterCheckStatusTextAttention]}>
                        {rosterCheckAllGood ? 'All good' : 'Needs attention'}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.checkRows}>
                    {targets.map((item) => {
                      const color = statusStyles[item.status];
                      const backupCoverageText = item.backupCoverage === 'covered' ? 'Covered' : item.backupCoverage === 'thin' ? 'Thin' : 'No cover';
                      const rangeStatusText = item.group === 'GK' && item.status === 'in-range' ? 'Covered' : statusCopy[item.status];
                      return (
                        <View key={item.group} style={styles.checkRow}>
                          <View style={styles.checkCopy}>
                            <Text style={styles.checkLabel}>{item.label} · {item.count} players</Text>
                            <Text style={styles.checkTarget}>(target {item.minimum}-{item.maximum})</Text>
                            {item.group !== 'GK' && (
                              <Text style={[styles.backupDetail, item.backupCoverage === 'covered' ? styles.backupDetailCovered : styles.backupDetailGap]}>
                                {item.backups} {item.backups === 1 ? 'backup' : 'backups'} · {backupCoverageText}
                              </Text>
                            )}
                          </View>
                          <View style={[styles.statusPill, { backgroundColor: color.background }]}>
                            <Text style={[styles.statusText, { color: color.text }]}>{rangeStatusText}</Text>
                          </View>
                        </View>
                      );
                    })}
                  </View>

                  {missingGroupPlayers.length > 0 ? (
                    <View style={styles.alertRow}>
                      <View style={styles.alertCopy}>
                        <Text style={styles.alertTitle}>{missingGroupPlayers.length} {missingGroupPlayers.length === 1 ? 'player needs' : 'players need'} a general group</Text>
                        <Text style={styles.alertDetail}>{missingGroupPlayers.map((player) => player.name).join(', ')}</Text>
                      </View>
                      <Pressable onPress={() => router.push('/position-assignment')} style={styles.rosterButton} accessibilityRole="button">
                        <Text style={styles.rosterButtonText}>Go to Roster</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <View style={styles.assignedBanner}>
                      <Text style={styles.assignedText}>✓ All {players.length} players have a primary position</Text>
                    </View>
                  )}
                  <View style={[styles.coverageBanner, coverageWarning ? styles.coverageBannerAttention : styles.coverageBannerCovered]}>
                    <Text style={[styles.coverageBannerText, coverageWarning ? styles.coverageBannerTextAttention : styles.coverageBannerTextCovered]}>
                      {coverageWarning || '✓ All field groups have backup cover'}
                    </Text>
                  </View>
                </View>

                <View style={styles.card}>
                  <View style={styles.cardHeading}>
                    <View style={styles.cardIcon}><SymbolView name="person.2" size={21} tintColor={palette.green} /></View>
                    <View style={styles.cardHeadingCopy}>
                      <Text style={styles.cardTitle}>Backup Planner</Text>
                      <Text style={styles.cardSubtitle}>Plan ahead for absences — no rotation simulation</Text>
                    </View>
                  </View>
                  <View style={styles.totalBackups}>
                    <Text style={styles.totalBackupsNumber}>{remainingSuggestedBackups}</Text>
                    <Text style={styles.totalBackupsCopy}>suggested backups across your {players.length}-player roster</Text>
                  </View>
                  <View style={styles.suggestionList}>
                    {backupPlan.groups.map(({ group, minimum, maximum }) => {
                      const candidates = backupSuggestions(players, group);
                      const added = countGroupBackups(players, group);
                      const progress = backupProgressText({ minimum, maximum }, added);
                      const expanded = expandedGroup === group;
                      const selected = selectedPlayers[group];
                      return (
                        <View key={group} style={styles.suggestionGroup}>
                          <View style={styles.suggestionHeader}>
                            <View style={styles.suggestionCopy}>
                              <Text style={styles.suggestionTitle}>{groupCopy[group].label}</Text>
                              <Text style={styles.suggestionDetail}>
                                {progress}{progress.startsWith('Suggest') ? ` (best from ${groupCopy[group].source})` : ''}
                              </Text>
                            </View>
                            <Pressable
                              onPress={() => {
                                setExpandedGroup(expanded ? null : group);
                                setSelectedPlayers({});
                              }}
                              style={[styles.suggestButton, expanded && styles.suggestButtonSelected]}
                              accessibilityRole="button"
                              accessibilityState={{ expanded }}>
                              <Text style={[styles.suggestButtonText, expanded && styles.suggestButtonTextSelected]}>{expanded ? 'CLOSE' : 'SUGGEST'}</Text>
                            </Pressable>
                          </View>
                          {expanded && (
                            <View style={styles.candidateList}>
                              {candidates.length === 0 ? (
                                <Text style={styles.emptyCandidates}>No eligible players to suggest.</Text>
                              ) : candidates.map((candidate) => {
                                const isSelected = selected === candidate.name;
                                return (
                                  <View key={candidate.name} style={styles.candidateRow}>
                                    <Pressable
                                      onPress={() => setSelectedPlayers((current) => ({ ...current, [group]: candidate.name }))}
                                      style={styles.candidateNameButton}
                                      accessibilityRole="button"
                                      accessibilityState={{ selected: isSelected }}>
                                      <Text style={[styles.candidateName, isSelected && styles.candidateNameSelected]}>{candidate.name} ({formatGeneralPositions(candidate.general_positions)})</Text>
                                      {candidate.group && <Text style={styles.candidateTier}>{candidate.group.replace('_', ' ')}</Text>}
                                    </Pressable>
                                    {isSelected && (
                                      <Pressable
                                        onPress={() => void addBackup(candidate.name, group)}
                                        disabled={saving}
                                        style={[styles.addButton, saving && styles.disabledButton]}
                                        accessibilityRole="button">
                                        <Text style={styles.addButtonText}>{saving ? 'SAVING...' : 'ADD'}</Text>
                                      </Pressable>
                                    )}
                                  </View>
                                );
                              })}
                              <Text style={styles.candidateHint}>Choose a player, then tap Add to append this backup assignment.</Text>
                            </View>
                          )}
                        </View>
                      );
                    })}
                  </View>
                </View>
              </>
            )}
            {(toast || undoAction) && (
              <View style={styles.toast}>
                <Text style={styles.toastText}>{toast}</Text>
                {undoAction && <Pressable onPress={() => void undoBackup()} disabled={saving} style={styles.undoButton} accessibilityRole="button"><Text style={styles.undoText}>UNDO</Text></Pressable>}
                <Pressable onPress={() => { setToast(null); setUndoAction(null); }} style={styles.dismissButton} accessibilityLabel="Dismiss message"><Text style={styles.dismissText}>×</Text></Pressable>
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
  subtitle: { color: palette.muted, fontSize: 12, marginTop: 2 },
  card: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 18, borderWidth: 1, padding: 16 },
  cardHeading: { alignItems: 'center', flexDirection: 'row', gap: 11, marginBottom: 16 },
  cardIcon: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 12, height: 42, justifyContent: 'center', width: 42 },
  cardHeadingCopy: { flex: 1 },
  cardTitle: { color: palette.ink, fontSize: 19, fontWeight: '800' },
  cardSubtitle: { color: palette.muted, fontSize: 12, lineHeight: 17, marginTop: 3 },
  checkRows: { borderTopColor: palette.line, borderTopWidth: 1 },
  checkRow: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', minHeight: 58, paddingVertical: 9 },
  checkCopy: { flex: 1 },
  checkLabel: { color: palette.ink, fontSize: 14, fontWeight: '700' },
  checkTarget: { color: palette.ink, fontSize: 14, fontWeight: '800', marginTop: 3 },
  targetDetail: { color: palette.muted, fontSize: 12, fontWeight: '500' },
  statusPill: { borderRadius: 10, marginLeft: 8, paddingHorizontal: 10, paddingVertical: 6 },
  statusText: { fontSize: 11, fontWeight: '800' },
  alertRow: { alignItems: 'center', backgroundColor: palette.redSoft, borderRadius: 12, flexDirection: 'row', gap: 8, marginTop: 12, padding: 11 },
  alertCopy: { flex: 1 },
  alertTitle: { color: palette.red, fontSize: 13, fontWeight: '800' },
  alertDetail: { color: palette.red, fontSize: 11, marginTop: 3 },
  rosterButton: { backgroundColor: palette.red, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 9 },
  rosterButtonText: { color: '#fff', fontSize: 10, fontWeight: '900' },
  assignedBanner: { backgroundColor: palette.greenSoft, borderRadius: 11, marginTop: 12, padding: 11 },
  assignedText: { color: palette.green, fontSize: 13, fontWeight: '800' },
  backupPlannerBanner: { backgroundColor: palette.yellowSoft, borderColor: '#e6c36d', borderRadius: 12, borderWidth: 1, padding: 12 },
  backupPlannerBannerTitle: { color: palette.yellow, fontSize: 13, fontWeight: '900' },
  backupPlannerBannerDetail: { color: palette.yellow, fontSize: 12, lineHeight: 17, marginTop: 3 },
  rosterCheckStatus: { borderRadius: 10, marginLeft: 8, paddingHorizontal: 9, paddingVertical: 6 },
  rosterCheckStatusGood: { backgroundColor: palette.greenSoft },
  rosterCheckStatusAttention: { backgroundColor: palette.yellowSoft },
  rosterCheckStatusText: { fontSize: 10, fontWeight: '900' },
  rosterCheckStatusTextGood: { color: palette.green },
  rosterCheckStatusTextAttention: { color: palette.yellow },
  backupDetail: { fontSize: 11, fontWeight: '800', marginTop: 3 },
  backupDetailCovered: { color: palette.green },
  backupDetailGap: { color: palette.yellow },
  coverageBanner: { borderRadius: 11, marginTop: 10, padding: 11 },
  coverageBannerAttention: { backgroundColor: palette.yellowSoft },
  coverageBannerCovered: { backgroundColor: palette.greenSoft },
  coverageBannerText: { fontSize: 12, fontWeight: '800', lineHeight: 17 },
  coverageBannerTextAttention: { color: palette.yellow },
  coverageBannerTextCovered: { color: palette.green },
  totalBackups: { alignItems: 'center', backgroundColor: '#f3f0e7', borderRadius: 13, flexDirection: 'row', gap: 11, marginBottom: 13, paddingHorizontal: 13, paddingVertical: 11 },
  totalBackupsNumber: { color: palette.green, fontSize: 25, fontWeight: '900' },
  totalBackupsCopy: { color: palette.muted, flex: 1, fontSize: 12, lineHeight: 17 },
  suggestionList: { borderTopColor: palette.line, borderTopWidth: 1 },
  suggestionGroup: { borderBottomColor: palette.line, borderBottomWidth: 1, paddingVertical: 12 },
  suggestionHeader: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  suggestionCopy: { flex: 1 },
  suggestionTitle: { color: palette.ink, fontSize: 14, fontWeight: '800' },
  suggestionDetail: { color: palette.muted, fontSize: 12, lineHeight: 17, marginTop: 3 },
  suggestButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 9, minWidth: 82, paddingHorizontal: 10, paddingVertical: 9 },
  suggestButtonSelected: { backgroundColor: palette.greenSoft },
  suggestButtonText: { color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: 0.7 },
  suggestButtonTextSelected: { color: palette.green },
  candidateList: { backgroundColor: '#f8f6ef', borderRadius: 11, marginTop: 10, paddingHorizontal: 10 },
  candidateRow: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', minHeight: 48 },
  candidateNameButton: { alignItems: 'center', flex: 1, flexDirection: 'row', justifyContent: 'space-between', minHeight: 46, paddingRight: 8 },
  candidateName: { color: palette.ink, flex: 1, fontSize: 13, fontWeight: '700' },
  candidateNameSelected: { color: palette.green },
  candidateTier: { color: palette.muted, fontSize: 10, marginLeft: 6, textTransform: 'capitalize' },
  addButton: { backgroundColor: palette.green, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  addButtonText: { color: '#fff', fontSize: 10, fontWeight: '900', letterSpacing: 0.7 },
  disabledButton: { opacity: 0.55 },
  candidateHint: { color: palette.muted, fontSize: 11, lineHeight: 16, paddingBottom: 9, paddingTop: 8 },
  emptyCandidates: { color: palette.muted, fontSize: 12, paddingVertical: 13 },
  loadingText: { color: palette.muted, fontSize: 13, paddingVertical: 20 },
  errorBanner: { backgroundColor: palette.redSoft, borderRadius: 11, padding: 11 },
  errorText: { color: palette.red, fontSize: 12, lineHeight: 17 },
  toast: { alignItems: 'center', backgroundColor: palette.ink, borderRadius: 12, flexDirection: 'row', gap: 12, paddingHorizontal: 13, paddingVertical: 11 },
  toastText: { color: '#fff', flex: 1, fontSize: 12, fontWeight: '700' },
  undoButton: { paddingHorizontal: 4, paddingVertical: 5 },
  undoText: { color: '#b9e1c8', fontSize: 11, fontWeight: '900', letterSpacing: 0.8 },
  dismissButton: { paddingHorizontal: 3, paddingVertical: 1 },
  dismissText: { color: '#fff', fontSize: 21, lineHeight: 22 },
});
