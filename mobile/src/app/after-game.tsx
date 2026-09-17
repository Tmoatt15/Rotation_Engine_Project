import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { getActiveTeam } from '@/team-api';
import { saveLocalReport } from '@/services/report-service';
import type { AfterGameReport } from '@/live-schedule';

const palette = { ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1', green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c' };

function parseReport(value: string | string[] | undefined): AfterGameReport | null {
  if (!value || Array.isArray(value)) return null;
  try { return JSON.parse(value) as AfterGameReport; } catch { return null; }
}

export default function AfterGameScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ data?: string }>();
  const report = parseReport(params.data);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function saveAndReturn() {
    if (!report) return;
    setSaving(true);
    setSaveError(null);
    try {
      const activeTeam = await getActiveTeam();
      await saveLocalReport(activeTeam.id, { ...report, team_id: report.team_id ?? activeTeam.id, team_name: report.team_name ?? activeTeam.name });
      router.replace('/');
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Unable to save after-game report.');
    } finally {
      setSaving(false);
    }
  }

  return <><Stack.Screen options={{ headerShown: false }} /><View style={styles.container}><SafeAreaView style={styles.safeArea}><ScrollView contentContainerStyle={styles.content}>
    <View style={styles.header}><View style={styles.icon}><SymbolView name={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }} size={25} tintColor={palette.green} /></View><Text style={styles.eyebrow}>GAME COMPLETE</Text><Text style={styles.title}>What would you like to do?</Text><Text style={styles.subtitle}>Game {report?.game_number ?? '--'} is ready for review.</Text></View>
    <Pressable style={styles.primary} onPress={() => router.push({ pathname: '/after-game-report', params: { data: JSON.stringify(report) } })}><Text style={styles.primaryText}>VIEW AFTER GAME REPORT</Text><SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={19} tintColor={palette.panel} /></Pressable>
    <Pressable style={styles.option} onPress={() => void saveAndReturn()} disabled={saving}><Text style={styles.optionTitle}>{saving ? 'SAVING AFTER GAME REPORT...' : 'SAVE AFTER GAME REPORT AND RETURN TO HOME SCREEN'}</Text><Text style={styles.optionDetail}>Keep this game in the season record.</Text></Pressable>
    {saveError && <Text style={styles.error}>{saveError}</Text>}
    <Pressable style={styles.option} onPress={() => router.replace('/')}><Text style={styles.optionTitle}>RETURN TO HOME SCREEN</Text><Text style={styles.optionDetail}>Discard this report.</Text></Pressable>
  </ScrollView></SafeAreaView></View></>;
}

const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: palette.paper }, safeArea: { flex: 1, maxWidth: MaxContentWidth, width: '100%', alignSelf: 'center' }, content: { padding: 20, paddingBottom: BottomTabInset + 24 }, header: { backgroundColor: palette.green, borderRadius: 20, padding: 24, marginBottom: 18 }, icon: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 24, height: 48, justifyContent: 'center', width: 48, marginBottom: 24 }, eyebrow: { color: '#b8d4c5', fontSize: 10, fontWeight: '800', letterSpacing: 1.6 }, title: { color: palette.panel, fontSize: 28, fontWeight: '800', marginTop: 7 }, subtitle: { color: '#d7e6dc', fontSize: 13, marginTop: 8 }, primary: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 15, flexDirection: 'row', justifyContent: 'space-between', padding: 18, marginBottom: 12 }, primaryText: { color: palette.panel, flex: 1, fontSize: 13, fontWeight: '800', letterSpacing: .5 }, option: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 15, borderWidth: 1, padding: 18, marginBottom: 12 }, optionTitle: { color: palette.ink, fontSize: 13, fontWeight: '800' }, optionDetail: { color: palette.muted, fontSize: 12, marginTop: 6 }, error: { color: palette.coral, fontSize: 12, lineHeight: 18, marginBottom: 12 } });
