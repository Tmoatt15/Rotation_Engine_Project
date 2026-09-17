import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { API_URL, getActiveTeam, teamQuery } from '@/team-api';
import type { AfterGameReport } from '@/live-schedule';

const palette = { ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1', green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c' };
type SavedReport = AfterGameReport & { id: string; name?: string };
function dateLabel(value: string): string { return new Date(value).toLocaleDateString(); }
function reportLabel(report: SavedReport): string { return report.name ?? `Game ${report.game_number}`; }

export default function SavedAfterGameReportsScreen() {
  const router = useRouter();
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [teamName, setTeamName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renameReport, setRenameReport] = useState<SavedReport | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);
  const load = useCallback(async () => { try { const team = await getActiveTeam(); const response = await fetch(`${API_URL}/game-reports?${teamQuery(team.id)}`); const payload = await response.json(); if (!response.ok) throw new Error(payload.detail); setTeamName(payload.team_name ?? team.name); setReports(payload.reports ?? []); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : 'Unable to load reports.'); } }, []);
  useEffect(() => { void load(); }, [load]);
  function deleteReport(report: SavedReport) { Alert.alert('Delete after-game report?', reportLabel(report), [{ text: 'CANCEL', style: 'cancel' }, { text: 'DELETE', style: 'destructive', onPress: async () => { const team = await getActiveTeam(); const response = await fetch(`${API_URL}/game-reports/${report.id}?${teamQuery(team.id)}`, { method: 'DELETE' }); if (response.ok) setReports((current) => current.filter((item) => item.id !== report.id)); } }]); }
  function openRename(report: SavedReport) { setError(null); setRenameReport(report); setRenameValue(reportLabel(report)); }
  async function renameSavedReport() {
    const name = renameValue.trim();
    if (!name) { setError('Report name is required.'); return; }
    setRenaming(true);
    setError(null);
    try {
      const team = await getActiveTeam();
      const response = await fetch(`${API_URL}/game-reports/${renameReport?.id}?${teamQuery(team.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? 'Unable to rename after-game report.');
      setReports((current) => current.map((item) => item.id === renameReport?.id ? { ...item, name: payload.name ?? name } : item));
      setRenameReport(null);
      setRenameValue('');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to rename after-game report.');
    } finally { setRenaming(false); }
  }
  return <><Stack.Screen options={{ headerShown: false }} /><Modal visible={renameReport !== null} transparent animationType="fade" onRequestClose={() => setRenameReport(null)}><View style={styles.modalOverlay}><View style={styles.renameModal}><Text style={styles.modalEyebrow}>RENAME REPORT</Text><Text style={styles.modalTitle}>Name this report</Text><TextInput autoFocus onChangeText={setRenameValue} placeholder="Report name" placeholderTextColor={palette.muted} style={styles.renameInput} value={renameValue} /><View style={styles.modalActions}><Pressable onPress={() => setRenameReport(null)} disabled={renaming} style={styles.cancelButton} accessibilityRole="button"><Text style={styles.cancelButtonText}>CANCEL</Text></Pressable><Pressable onPress={() => void renameSavedReport()} disabled={renaming} style={styles.renameButton} accessibilityRole="button"><Text style={styles.renameButtonText}>{renaming ? 'SAVING...' : 'SAVE'}</Text></Pressable></View></View></View></Modal><View style={styles.container}><SafeAreaView style={styles.safeArea}><ScrollView contentContainerStyle={styles.content}>
    <View style={styles.header}><Pressable onPress={() => router.navigate('/' as never)} style={styles.back} accessibilityLabel="Go home"><SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} /></Pressable><View><Text style={styles.eyebrow}>SEASON RECORD</Text><Text style={styles.title}>{teamName ? `${teamName} Reports` : 'After Game Reports'}</Text></View></View>
    <Pressable style={styles.totalsButton} onPress={() => router.push('/season-totals')}><Text style={styles.totalsText}>SEE PLAYER TOTALS</Text><SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={18} tintColor={palette.green} /></Pressable>
    {error && <Text style={styles.error}>{error}</Text>}{!error && reports.length === 0 && <Text style={styles.muted}>No saved after-game reports yet.</Text>}
    {reports.map((report) => <View key={report.id} style={styles.card}><Pressable style={styles.info} onPress={() => router.push({ pathname: '/after-game-report', params: { data: JSON.stringify(report) } })}><Text style={styles.name}>{reportLabel(report)}</Text><Text style={styles.detail}>{dateLabel(report.created_at)} · {report.total_blocks} blocks</Text></Pressable><Pressable style={styles.renameListButton} onPress={() => openRename(report)} accessibilityRole="button" accessibilityLabel={`Rename ${reportLabel(report)}`}><Text style={styles.renameListButtonText}>RENAME</Text></Pressable><Pressable style={styles.delete} onPress={() => deleteReport(report)} accessibilityLabel={`Delete ${reportLabel(report)}`}><SymbolView name={{ ios: 'trash', android: 'delete', web: 'delete' }} size={19} tintColor={palette.coral} /></Pressable></View>)}
  </ScrollView></SafeAreaView></View></>;
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: palette.paper }, safeArea: { flex: 1, maxWidth: MaxContentWidth, width: '100%', alignSelf: 'center' }, content: { padding: 16, paddingBottom: BottomTabInset + 24 }, header: { alignItems: 'center', flexDirection: 'row', marginBottom: 20 }, back: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42, marginRight: 13 }, eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 }, title: { color: palette.ink, fontSize: 27, fontWeight: '800', marginTop: 4 }, totalsButton: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 14, flexDirection: 'row', justifyContent: 'space-between', padding: 17, marginBottom: 15 }, totalsText: { color: palette.green, fontSize: 13, fontWeight: '800' }, card: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 15, borderWidth: 1, flexDirection: 'row', marginBottom: 10, paddingLeft: 16 }, info: { flex: 1, paddingVertical: 16 }, name: { color: palette.ink, fontSize: 16, fontWeight: '800' }, detail: { color: palette.muted, fontSize: 12, marginTop: 5 }, renameListButton: { alignItems: 'center', borderLeftColor: palette.line, borderLeftWidth: 1, height: 58, justifyContent: 'center', paddingHorizontal: 12 }, renameListButtonText: { color: palette.green, fontSize: 10, fontWeight: '900', letterSpacing: 0.7 }, delete: { alignItems: 'center', borderLeftColor: palette.line, borderLeftWidth: 1, height: 58, justifyContent: 'center', width: 58 }, muted: { color: palette.muted, fontSize: 13 }, error: { color: palette.coral, fontSize: 13 }, modalOverlay: { alignItems: 'center', backgroundColor: 'rgba(23, 34, 31, 0.55)', flex: 1, justifyContent: 'center', padding: 20 }, renameModal: { backgroundColor: palette.panel, borderRadius: 20, padding: 20, width: '100%' }, modalEyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 }, modalTitle: { color: palette.ink, fontSize: 25, fontWeight: '800', marginTop: 5 }, renameInput: { borderColor: palette.line, borderRadius: 10, borderWidth: 1, color: palette.ink, fontSize: 15, marginTop: 16, paddingHorizontal: 12, paddingVertical: 11 }, modalActions: { flexDirection: 'row', gap: 10, marginTop: 18 }, cancelButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 12, borderWidth: 1, flex: 1, paddingVertical: 13 }, cancelButtonText: { color: palette.muted, fontSize: 11, fontWeight: '900', letterSpacing: 1 }, renameButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 12, flex: 1, paddingVertical: 13 }, renameButtonText: { color: palette.panel, fontSize: 11, fontWeight: '900', letterSpacing: 1 } });
