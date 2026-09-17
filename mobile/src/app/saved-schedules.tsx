import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { getActiveTeam, teamQuery } from '@/team-api';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000';
const palette = {
  ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1',
  green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c',
};

type SavedSchedule = {
  id: string;
  name: string;
  game_number: number;
  created_at?: string;
  schedule: Record<string, unknown>;
};

export default function SavedSchedulesScreen() {
  const router = useRouter();
  const [teamName, setTeamName] = useState('');
  const [schedules, setSchedules] = useState<SavedSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renameSchedule, setRenameSchedule] = useState<SavedSchedule | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renaming, setRenaming] = useState(false);

  const loadSchedules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const team = await getActiveTeam();
      const response = await fetch(`${API_URL}/schedules?${teamQuery(team.id)}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? 'Unable to load saved schedules.');
      setTeamName(payload.team_name ?? team.name);
      setSchedules(payload.schedules ?? []);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load saved schedules.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSchedules();
  }, [loadSchedules]);

  async function deleteSchedule(savedSchedule: SavedSchedule) {
    Alert.alert('Delete saved schedule?', savedSchedule.name, [
      { text: 'CANCEL', style: 'cancel' },
      { text: 'DELETE', style: 'destructive', onPress: async () => {
        try {
          const team = await getActiveTeam();
          const response = await fetch(`${API_URL}/schedules/${savedSchedule.id}?${teamQuery(team.id)}`, { method: 'DELETE' });
          if (!response.ok) throw new Error('Unable to delete saved schedule.');
          setSchedules((current) => current.filter((item) => item.id !== savedSchedule.id));
        } catch (requestError) {
          setError(requestError instanceof Error ? requestError.message : 'Unable to delete saved schedule.');
        }
      } },
    ]);
  }

  function openRename(savedSchedule: SavedSchedule) {
    setError(null);
    setRenameSchedule(savedSchedule);
    setRenameValue(savedSchedule.name);
  }

  async function renameSavedSchedule() {
    const name = renameValue.trim();
    if (!name) {
      setError('Schedule name is required.');
      return;
    }
    setRenaming(true);
    setError(null);
    try {
      const team = await getActiveTeam();
      const response = await fetch(`${API_URL}/schedules/${renameSchedule?.id}?${teamQuery(team.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? 'Unable to rename saved schedule.');
      setSchedules((current) => current.map((item) => item.id === renameSchedule?.id ? { ...item, name: payload.name ?? name } : item));
      setRenameSchedule(null);
      setRenameValue('');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to rename saved schedule.');
    } finally {
      setRenaming(false);
    }
  }

  function openSchedule(savedSchedule: SavedSchedule) {
    router.push({ pathname: '/schedule', params: { data: JSON.stringify(savedSchedule.schedule) } });
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Modal visible={renameSchedule !== null} transparent animationType="fade" onRequestClose={() => setRenameSchedule(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.renameModal}>
            <Text style={styles.modalEyebrow}>RENAME SCHEDULE</Text>
            <Text style={styles.modalTitle}>Name this schedule</Text>
            <TextInput
              autoFocus
              onChangeText={setRenameValue}
              placeholder="Schedule name"
              placeholderTextColor={palette.muted}
              style={styles.renameInput}
              value={renameValue}
            />
            <View style={styles.modalActions}>
              <Pressable onPress={() => setRenameSchedule(null)} disabled={renaming} style={styles.cancelButton} accessibilityRole="button">
                <Text style={styles.cancelButtonText}>CANCEL</Text>
              </Pressable>
              <Pressable onPress={() => void renameSavedSchedule()} disabled={renaming} style={styles.renameButton} accessibilityRole="button">
                <Text style={styles.renameButtonText}>{renaming ? 'SAVING...' : 'SAVE'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.header}>
              <Pressable onPress={() => router.navigate('/' as never)} style={styles.backButton} accessibilityLabel="Go home">
                <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} />
              </Pressable>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>SCHEDULE LIBRARY</Text>
                <Text style={styles.title}>{teamName ? `${teamName} Saved Schedules` : 'Saved Schedules'}</Text>
              </View>
            </View>
            {loading && <Text style={styles.helperText}>Loading saved schedules...</Text>}
            {!loading && error && <Text style={styles.errorText}>{error}</Text>}
            {!loading && !error && schedules.length === 0 && (
              <View style={styles.emptyCard}><Text style={styles.emptyTitle}>No saved schedules</Text><Text style={styles.helperText}>Save a generated schedule from Schedule Review to find it here.</Text></View>
            )}
            {!loading && schedules.map((savedSchedule) => (
              <View key={savedSchedule.id} style={styles.scheduleCard}>
                <Pressable onPress={() => openSchedule(savedSchedule)} style={styles.scheduleInfo} accessibilityRole="button">
                  <Text style={styles.scheduleName}>{savedSchedule.name}</Text>
                  <Text style={styles.scheduleDetail}>Game {savedSchedule.game_number}</Text>
                </Pressable>
                <Pressable onPress={() => openRename(savedSchedule)} style={styles.renameListButton} accessibilityRole="button" accessibilityLabel={`Rename ${savedSchedule.name}`}>
                  <Text style={styles.renameListButtonText}>RENAME</Text>
                </Pressable>
                <Pressable onPress={() => void deleteSchedule(savedSchedule)} style={styles.deleteButton} accessibilityRole="button" accessibilityLabel={`Delete ${savedSchedule.name}`}>
                  <SymbolView name={{ ios: 'trash', android: 'delete', web: 'delete' }} size={19} tintColor={palette.coral} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </SafeAreaView>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.paper },
  safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: BottomTabInset + 24 },
  header: { alignItems: 'center', flexDirection: 'row', marginBottom: 26 },
  backButton: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 },
  headerCopy: { flex: 1, marginLeft: 13 },
  eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 },
  title: { color: palette.ink, fontSize: 27, fontWeight: '800', marginTop: 4 },
  helperText: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 6 },
  errorText: { color: palette.coral, fontSize: 12, lineHeight: 18 },
  emptyCard: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, padding: 18 },
  emptyTitle: { color: palette.ink, fontSize: 17, fontWeight: '800' },
  scheduleCard: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, flexDirection: 'row', marginBottom: 12, paddingLeft: 16 },
  scheduleInfo: { flex: 1, paddingVertical: 16 },
  scheduleName: { color: palette.ink, fontSize: 16, fontWeight: '800' },
  scheduleDetail: { color: palette.muted, fontSize: 12, marginTop: 4 },
  renameListButton: { alignItems: 'center', borderLeftColor: palette.line, borderLeftWidth: 1, height: 57, justifyContent: 'center', paddingHorizontal: 12 },
  renameListButtonText: { color: palette.green, fontSize: 10, fontWeight: '900', letterSpacing: 0.7 },
  deleteButton: { alignItems: 'center', borderLeftColor: palette.line, borderLeftWidth: 1, height: 57, justifyContent: 'center', width: 58 },
  modalOverlay: { alignItems: 'center', backgroundColor: 'rgba(23, 34, 31, 0.55)', flex: 1, justifyContent: 'center', padding: 20 },
  renameModal: { backgroundColor: palette.panel, borderRadius: 20, padding: 20, width: '100%' },
  modalEyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  modalTitle: { color: palette.ink, fontSize: 25, fontWeight: '800', marginTop: 5 },
  renameInput: { borderColor: palette.line, borderRadius: 10, borderWidth: 1, color: palette.ink, fontSize: 15, marginTop: 16, paddingHorizontal: 12, paddingVertical: 11 },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  cancelButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 12, borderWidth: 1, flex: 1, paddingVertical: 13 },
  cancelButtonText: { color: palette.muted, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  renameButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 12, flex: 1, paddingVertical: 13 },
  renameButtonText: { color: palette.panel, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
});
