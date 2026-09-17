import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import type { AfterGameReport } from '@/live-schedule';

const palette = { ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1', green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c', yellow: '#f1c76b' };
function parseReport(value: string | string[] | undefined): AfterGameReport | null { if (!value || Array.isArray(value)) return null; try { return JSON.parse(value) as AfterGameReport; } catch { return null; } }
function positions(positionsByBlock: Record<string, number>): string { return Object.entries(positionsByBlock).map(([position, count]) => `${position} ${count}`).join(' · ') || 'No field blocks'; }

export default function AfterGameReportScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ data?: string }>();
  const report = parseReport(params.data);
  return <><Stack.Screen options={{ headerShown: false }} /><View style={styles.container}><SafeAreaView style={styles.safeArea}><ScrollView contentContainerStyle={styles.content}>
    <View style={styles.header}><Pressable onPress={() => router.back()} style={styles.back} accessibilityLabel="Back"><SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} /></Pressable><View><Text style={styles.eyebrow}>AFTER GAME REPORT</Text><Text style={styles.title}>{report?.team_name ?? 'Game report'}</Text></View></View>
    <View style={styles.summary}><Text style={styles.summaryNumber}>{report?.total_blocks ?? 0}</Text><Text style={styles.summaryLabel}>blocks recorded · Game {report?.game_number ?? '--'}</Text></View>
    {report?.players.map((player) => <View key={player.player} style={styles.player}><View style={styles.playerTop}><Text style={styles.playerName}>{player.player}</Text><View><Text style={styles.minutes}>{player.minutesPlayed ?? 0} minutes</Text><Text style={styles.blocks}>{player.blocksPlayed} blocks</Text></View></View><Text style={styles.positions}>{positions(player.positions)}</Text>{player.unavailableBlocks > 0 && <Text style={styles.unavailable}>{player.unavailableBlocks} blocks unavailable</Text>}</View>)}
    {!report && <Text style={styles.muted}>This report could not be loaded.</Text>}
  </ScrollView></SafeAreaView></View></>;
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: palette.paper }, safeArea: { flex: 1, maxWidth: MaxContentWidth, width: '100%', alignSelf: 'center' }, content: { padding: 16, paddingBottom: BottomTabInset + 24 }, header: { alignItems: 'center', flexDirection: 'row', marginBottom: 20 }, back: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42, marginRight: 13 }, eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 }, title: { color: palette.ink, fontSize: 27, fontWeight: '800', marginTop: 4 }, summary: { backgroundColor: palette.green, borderRadius: 17, padding: 18, marginBottom: 14 }, summaryNumber: { color: palette.panel, fontSize: 28, fontWeight: '800' }, summaryLabel: { color: '#d7e6dc', fontSize: 12, marginTop: 4 }, player: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 15, borderWidth: 1, padding: 16, marginBottom: 10 }, playerTop: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }, playerName: { color: palette.ink, fontSize: 16, fontWeight: '800' }, blocks: { color: palette.muted, fontSize: 11, marginTop: 3, textAlign: 'right' }, minutes: { color: palette.ink, fontSize: 13, fontWeight: '800', textAlign: 'right' }, positions: { color: palette.muted, fontSize: 12, marginTop: 7 }, unavailable: { color: '#8a6820', backgroundColor: '#fff3cf', alignSelf: 'flex-start', fontSize: 11, fontWeight: '800', marginTop: 10, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8 }, muted: { color: palette.muted, fontSize: 13 } });
