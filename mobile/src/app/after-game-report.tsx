import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useMemo, useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import type { AfterGameReport } from '@/live-schedule';

const palette = { ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1', green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c', yellow: '#f1c76b' };
function parseReport(value: string | string[] | undefined): AfterGameReport | null { if (!value || Array.isArray(value)) return null; try { return JSON.parse(value) as AfterGameReport; } catch { return null; } }
function positions(positionsByBlock: Record<string, number>): string { return Object.entries(positionsByBlock).map(([position, count]) => `${position} ${count}`).join(' · ') || 'No field blocks'; }
type SortMode = 'name' | 'minutes';

export default function AfterGameReportScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ data?: string }>();
  const report = parseReport(params.data);
  const [sortMode, setSortMode] = useState<SortMode>('name');
  const [sortDescending, setSortDescending] = useState(false);
  const sortedPlayers = useMemo(() => [...(report?.players ?? [])].sort((left, right) => {
    const comparison = sortMode === 'minutes'
      ? (left.minutesPlayed ?? 0) - (right.minutesPlayed ?? 0) || left.player.localeCompare(right.player)
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
    <View style={styles.header}><Pressable onPress={() => router.back()} style={styles.back} accessibilityLabel="Back"><SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} /></Pressable><View><Text style={styles.eyebrow}>AFTER GAME REPORT</Text><Text style={styles.title}>{report?.team_name ?? 'Game report'}</Text></View></View>
    <View style={styles.summary}><Text style={styles.summaryNumber}>{report?.total_blocks ?? 0}</Text><Text style={styles.summaryLabel}>blocks recorded · Game {report?.game_number ?? '--'}</Text></View>
    {!!report?.position_override_warnings?.length && <View style={{ backgroundColor: '#f8e5b2', borderRadius: 13, marginBottom: 14, padding: 13 }}><Text style={{ color: '#76591a', fontSize: 10, fontWeight: '900', letterSpacing: 1 }}>LIVE POSITION OVERRIDE</Text>{report.position_override_warnings.map((warning) => <Text key={warning} style={{ color: '#76591a', fontSize: 12, lineHeight: 18, marginTop: 4 }}>{warning}</Text>)}</View>}
    {report && <View style={styles.sortRow}><Text style={styles.sortLabel}>SORT BY</Text><View style={styles.sortOptions}>
      {(['name', 'minutes'] as const).map((mode) => <Pressable key={mode} onPress={() => selectSortMode(mode)} style={[styles.sortOption, sortMode === mode && styles.sortOptionSelected]} accessibilityRole="button" accessibilityState={{ selected: sortMode === mode }}>
        <Text style={[styles.sortOptionText, sortMode === mode && styles.sortOptionTextSelected]}>{mode === 'name' ? sortMode === mode && sortDescending ? 'Name Z-A' : 'Name A-Z' : sortMode === mode && sortDescending ? 'Minutes high-low' : 'Minutes low-high'}</Text>
      </Pressable>)}
    </View></View>}
    {sortedPlayers.map((player) => <View key={player.player} style={styles.player}><View style={styles.playerTop}><Text style={styles.playerName}>{player.player}</Text><View><Text style={styles.minutes}>{player.minutesPlayed ?? 0} minutes</Text><Text style={styles.blocks}>{player.blocksPlayed} blocks</Text></View></View><Text style={styles.positions}>{positions(player.positions)}</Text>{player.unavailableBlocks > 0 && <Text style={styles.unavailable}>{player.unavailableBlocks} blocks unavailable</Text>}</View>)}
    {!report && <Text style={styles.muted}>This report could not be loaded.</Text>}
  </ScrollView></SafeAreaView></View></>;
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: palette.paper }, safeArea: { flex: 1, maxWidth: MaxContentWidth, width: '100%', alignSelf: 'center' }, content: { padding: 16, paddingBottom: BottomTabInset + 24 }, header: { alignItems: 'center', flexDirection: 'row', marginBottom: 20 }, back: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42, marginRight: 13 }, eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 }, title: { color: palette.ink, fontSize: 27, fontWeight: '800', marginTop: 4 }, summary: { backgroundColor: palette.green, borderRadius: 17, padding: 18, marginBottom: 14 }, summaryNumber: { color: palette.panel, fontSize: 28, fontWeight: '800' }, summaryLabel: { color: '#d7e6dc', fontSize: 12, marginTop: 4 }, sortRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }, sortLabel: { color: palette.muted, fontSize: 10, fontWeight: '900', letterSpacing: 1 }, sortOptions: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 10, borderWidth: 1, flexDirection: 'row', padding: 3 }, sortOption: { borderRadius: 7, paddingHorizontal: 12, paddingVertical: 7 }, sortOptionSelected: { backgroundColor: palette.green }, sortOptionText: { color: palette.muted, fontSize: 11, fontWeight: '800' }, sortOptionTextSelected: { color: palette.panel }, player: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 15, borderWidth: 1, padding: 16, marginBottom: 10 }, playerTop: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, playerName: { color: palette.ink, fontSize: 16, fontWeight: '800' }, blocks: { color: palette.muted, fontSize: 11, marginTop: 3, textAlign: 'right' }, minutes: { color: palette.ink, fontSize: 13, fontWeight: '800', textAlign: 'right' }, positions: { color: palette.muted, fontSize: 12, marginTop: 7 }, unavailable: { color: '#8a6820', backgroundColor: '#fff3cf', alignSelf: 'flex-start', fontSize: 11, fontWeight: '800', marginTop: 10, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8 }, muted: { color: palette.muted, fontSize: 13 } });
