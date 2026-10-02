import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { getActiveTeam } from '@/services/team-service';
import { getSeasonFairness, type SeasonFairnessReport } from '@/services/report-service';

const palette = { ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1', green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c', coralSoft: '#f8e4dc' };

function positionStarts(values: Record<string, number>): string {
  return Object.entries(values).map(([position, count]) => `${position} ${count}`).join(' · ') || 'No position starts';
}
type SortMode = 'name' | 'minutes';

export default function SeasonFairnessScreen() {
  const router = useRouter();
  const [teamName, setTeamName] = useState('');
  const [report, setReport] = useState<SeasonFairnessReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('name');
  const [sortDescending, setSortDescending] = useState(false);
  useEffect(() => {
    getActiveTeam().then(async (team) => { setTeamName(team.name); setReport(await getSeasonFairness(team.id)); }).catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Unable to load season fairness.'));
  }, []);
  const sortedPlayers = useMemo(() => [...(report?.players ?? [])].sort((left, right) => {
    const comparison = sortMode === 'minutes'
      ? left.minutes - right.minutes || left.player.localeCompare(right.player)
      : left.player.localeCompare(right.player);
    return sortDescending ? -comparison : comparison;
  }), [report?.players, sortDescending, sortMode]);
  function selectSortMode(mode: SortMode) {
    if (mode === sortMode) {
      setSortDescending((descending) => !descending);
      return;
    }
    setSortMode(mode);
    setSortDescending(mode === 'minutes');
  }
  return <><Stack.Screen options={{ headerShown: false }} /><View style={styles.container}><SafeAreaView style={styles.safeArea}><ScrollView contentContainerStyle={styles.content}>
    <View style={styles.header}><Pressable onPress={() => router.back()} style={styles.back} accessibilityLabel="Back"><SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} /></Pressable><View><Text style={styles.eyebrow}>SEASON FAIRNESS</Text><Text style={styles.title}>{teamName || 'Fairness report'}</Text></View></View>
    {error && <Text style={styles.error}>{error}</Text>}
    {report && <>
      <View style={[styles.status, report.accepted ? styles.accepted : styles.needsReview]}><Text style={styles.statusTitle}>{report.accepted ? 'ACCEPTANCE THRESHOLDS MET' : 'SEASON NEEDS REVIEW'}</Text><Text style={styles.statusDetail}>Zero-start threshold: {report.thresholds.minimumAppearancesForZeroStart}+ appearances · Total-start gap threshold: {report.thresholds.maximumSameRoleStartGap} starts</Text></View>
      <Text style={styles.sectionLabel}>PLAYER FAIRNESS</Text>
      <View style={styles.sortSection}><Text style={styles.sortLabel}>SORT BY</Text><View style={styles.sortOptions}>{(['name', 'minutes'] as const).map((mode) => <Pressable key={mode} onPress={() => selectSortMode(mode)} style={[styles.sortOption, sortMode === mode && styles.sortOptionActive]} accessibilityRole="button" accessibilityState={{ selected: sortMode === mode }}><Text style={[styles.sortOptionText, sortMode === mode && styles.sortOptionTextActive]}>{mode === 'name' ? sortMode === mode && sortDescending ? 'Name Z-A' : 'Name A-Z' : sortMode === mode && sortDescending ? 'Minutes high-low' : 'Minutes low-high'}</Text></Pressable>)}</View></View>
      {sortedPlayers.map((player) => <View key={player.player} style={styles.card}><View style={styles.cardTop}><Text style={styles.name}>{player.player}</Text>{player.flags.length > 0 && <Text style={styles.flag}>{player.flags.join(' · ')}</Text>}</View><Text style={styles.metrics}>{player.minutes.toFixed(1)} min · {player.attendanceAdjustedMinutes.toFixed(1)} adjusted</Text><Text style={styles.metrics}>{player.starts} starts · {player.attendanceAdjustedStarts.toFixed(1)} adjusted starts · {player.appearances} appearances</Text><Text style={styles.positions}>{positionStarts(player.positionStarts)}</Text></View>)}
      {report.sameRoleDisparities.length > 0 && <><Text style={styles.sectionLabel}>TOTAL-START DISPARITIES</Text>{report.sameRoleDisparities.map((disparity) => <View key={`${disparity.position}-${disparity.highPlayer}-${disparity.lowPlayer}`} style={styles.issue}><Text style={styles.issueTitle}>{disparity.highPlayer} vs {disparity.lowPlayer}</Text><Text style={styles.issueDetail}>{disparity.gap} total-start gap</Text></View>)}</>}
      {report.first_endpoint_misses.length > 0 && <><Text style={styles.sectionLabel}>FIRST-BLOCK ENDPOINT MISSES</Text>{report.first_endpoint_misses.map((miss) => <View key={`first-${miss.game}-${miss.player}`} style={styles.issue}><Text style={styles.issueTitle}>{miss.player}</Text><Text style={styles.issueDetail}>Game {miss.game}</Text></View>)}</>}
      {report.last_endpoint_misses.length > 0 && <><Text style={styles.sectionLabel}>LAST-BLOCK ENDPOINT MISSES</Text>{report.last_endpoint_misses.map((miss) => <View key={`last-${miss.game}-${miss.player}`} style={styles.issue}><Text style={styles.issueTitle}>{miss.player}</Text><Text style={styles.issueDetail}>Game {miss.game}</Text></View>)}</>}
      {report.structuralErrors.length > 0 && <><Text style={styles.sectionLabel}>STRUCTURAL GAME ISSUES</Text>{report.structuralErrors.map((issue) => <View key={issue.game} style={styles.issue}><Text style={styles.issueTitle}>Game {issue.game}</Text><Text style={styles.issueDetail}>{issue.errors.join(' ')}</Text></View>)}</>}
      {report.players.length === 0 && <Text style={styles.muted}>Save an after-game report to begin season fairness.</Text>}
    </>}
  </ScrollView></SafeAreaView></View></>;
}

const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: palette.paper }, safeArea: { flex: 1, maxWidth: MaxContentWidth, width: '100%', alignSelf: 'center' }, content: { padding: 16, paddingBottom: BottomTabInset + 24 }, header: { alignItems: 'center', flexDirection: 'row', marginBottom: 20 }, back: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42, marginRight: 13 }, eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 }, title: { color: palette.ink, fontSize: 27, fontWeight: '800', marginTop: 4 }, status: { borderRadius: 15, padding: 16, marginBottom: 18 }, accepted: { backgroundColor: palette.greenSoft }, needsReview: { backgroundColor: palette.coralSoft }, statusTitle: { color: palette.ink, fontSize: 13, fontWeight: '900' }, statusDetail: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 6 }, sectionLabel: { color: palette.muted, fontSize: 10, fontWeight: '900', letterSpacing: 1.2, marginBottom: 8, marginTop: 4 }, sortSection: { marginBottom: 12 }, sortLabel: { color: palette.muted, fontSize: 10, fontWeight: '900', letterSpacing: 1.2, marginBottom: 8 }, sortOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, sortOption: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 9 }, sortOptionActive: { backgroundColor: palette.green, borderColor: palette.green }, sortOptionText: { color: palette.muted, fontSize: 12, fontWeight: '800' }, sortOptionTextActive: { color: palette.panel }, card: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 15, borderWidth: 1, padding: 15, marginBottom: 9 }, cardTop: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, name: { color: palette.ink, fontSize: 16, fontWeight: '800' }, flag: { color: palette.coral, flexShrink: 1, fontSize: 10, fontWeight: '900', marginLeft: 12, textAlign: 'right' }, metrics: { color: palette.ink, fontSize: 12, marginTop: 7 }, positions: { color: palette.muted, fontSize: 12, marginTop: 7 }, issue: { backgroundColor: palette.coralSoft, borderRadius: 12, padding: 13, marginBottom: 8 }, issueTitle: { color: palette.ink, fontSize: 13, fontWeight: '800' }, issueDetail: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 4 }, muted: { color: palette.muted, fontSize: 13 }, error: { color: palette.coral, fontSize: 13 } });
