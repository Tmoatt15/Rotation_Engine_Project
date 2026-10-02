import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { getActiveTeam } from '@/services/team-service';
import { getSeasonTotals } from '@/services/report-service';

const palette = { ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1', green: '#19634b', coral: '#d96f4c' };
type PlayerTotal = { player: string; blocksPlayed: number; minutesPlayed: number; positions: Record<string, number>; games: number };
type SortOption = 'name' | 'games' | 'minutes';
function positions(values: Record<string, number>): string { return Object.entries(values).map(([position, count]) => `${position} ${count}`).join(' · ') || 'No field blocks'; }
function sortedPlayers(players: PlayerTotal[], sortBy: SortOption, descending: boolean): PlayerTotal[] {
  return [...players].sort((left, right) => {
    const comparison = sortBy === 'games'
      ? left.games - right.games || left.player.localeCompare(right.player)
      : sortBy === 'minutes'
        ? left.minutesPlayed - right.minutesPlayed || left.player.localeCompare(right.player)
        : left.player.localeCompare(right.player);
    return descending ? -comparison : comparison;
  });
}

export default function SeasonTotalsScreen() {
  const router = useRouter();
  const [teamName, setTeamName] = useState('');
  const [players, setPlayers] = useState<PlayerTotal[]>([]);
  const [sortBy, setSortBy] = useState<SortOption>('name');
  const [sortDescending, setSortDescending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getActiveTeam().then(async (team) => { setTeamName(team.name); setPlayers(await getSeasonTotals(team.id)); }).catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Unable to load player totals.')); }, []);
  const displayPlayers = sortedPlayers(players, sortBy, sortDescending);
  function selectSort(value: SortOption) {
    if (value === sortBy) {
      setSortDescending((descending) => !descending);
      return;
    }
    setSortBy(value);
    setSortDescending(value !== 'name');
  }
  return <><Stack.Screen options={{ headerShown: false }} /><View style={styles.container}><SafeAreaView style={styles.safeArea}><ScrollView contentContainerStyle={styles.content}>
    <View style={styles.header}><Pressable onPress={() => router.back()} style={styles.back} accessibilityLabel="Back"><SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} /></Pressable><View><Text style={styles.eyebrow}>SEASON TOTALS</Text><Text style={styles.title}>{teamName || 'Player totals'}</Text></View></View>
    {error && <Text style={styles.error}>{error}</Text>}{!error && players.length > 0 && <View style={styles.sortSection}><Text style={styles.sortLabel}>SORT BY</Text><View style={styles.sortOptions}>{([['name', sortBy === 'name' && sortDescending ? 'Name Z-A' : 'Name A-Z'], ['games', sortBy === 'games' && sortDescending ? 'Games low-high' : 'Games high-low'], ['minutes', sortBy === 'minutes' && sortDescending ? 'Minutes low-high' : 'Minutes high-low']] as const).map(([value, label]) => <Pressable key={value} accessibilityRole="button" onPress={() => selectSort(value)} style={[styles.sortOption, sortBy === value && styles.sortOptionActive]}><Text style={[styles.sortOptionText, sortBy === value && styles.sortOptionTextActive]}>{label}</Text></Pressable>)}</View></View>}{!error && players.length === 0 && <Text style={styles.muted}>Save an after-game report to begin season totals.</Text>}{displayPlayers.map((player) => <View key={player.player} style={styles.card}><View style={styles.top}><Text style={styles.name}>{player.player}</Text><View><Text style={styles.minutes}>{player.minutesPlayed ?? 0} minutes</Text><Text style={styles.blocks}>{player.blocksPlayed} blocks</Text></View></View><Text style={styles.detail}>{positions(player.positions)}</Text><Text style={styles.games}>{player.games} {player.games === 1 ? 'game' : 'games'} played</Text></View>)}
  </ScrollView></SafeAreaView></View></>;
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: palette.paper }, safeArea: { flex: 1, maxWidth: MaxContentWidth, width: '100%', alignSelf: 'center' }, content: { padding: 16, paddingBottom: BottomTabInset + 24 }, header: { alignItems: 'center', flexDirection: 'row', marginBottom: 20 }, back: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42, marginRight: 13 }, eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 }, title: { color: palette.ink, fontSize: 27, fontWeight: '800', marginTop: 4 }, sortSection: { marginBottom: 15 }, sortLabel: { color: palette.muted, fontSize: 10, fontWeight: '900', letterSpacing: 1.2, marginBottom: 8 }, sortOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, sortOption: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 9 }, sortOptionActive: { backgroundColor: palette.green, borderColor: palette.green }, sortOptionText: { color: palette.muted, fontSize: 12, fontWeight: '800' }, sortOptionTextActive: { color: palette.panel }, card: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 15, borderWidth: 1, padding: 16, marginBottom: 10 }, top: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, name: { color: palette.ink, fontSize: 16, fontWeight: '800' }, minutes: { color: palette.ink, fontSize: 13, fontWeight: '800', textAlign: 'right' }, blocks: { color: palette.muted, fontSize: 11, marginTop: 3, textAlign: 'right' }, detail: { color: palette.muted, fontSize: 12, marginTop: 7 }, games: { color: palette.muted, fontSize: 11, marginTop: 9 }, muted: { color: palette.muted, fontSize: 13 }, error: { color: palette.coral, fontSize: 13 } });
