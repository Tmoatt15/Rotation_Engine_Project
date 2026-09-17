import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { notifyTeamChanged } from '@/team-api';
import { getTeams, removeTeam } from '@/services/team-service';

const palette = { ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1', green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c' };
type Team = { id: string; name: string; players: string[]; active?: boolean };

export default function SavedTeamsScreen() {
  const router = useRouter();
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTeams = useCallback(() => {
    setLoading(true);
    setError(null);
    getTeams()
      .then((payload) => {
        setTeams(payload.teams as Team[]);
      })
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Unable to load saved teams.'))
      .finally(() => setLoading(false));
  }, []);

  useFocusEffect(useCallback(() => {
    loadTeams();
  }, [loadTeams]));

  function confirmDelete(team: Team) {
    Alert.alert('CONFIRM DELETION', `Delete ${team.name}? This will remove the team and its saved roster.`, [
      { text: 'CANCEL', style: 'cancel' },
      { text: 'DELETE TEAM', style: 'destructive', onPress: () => void deleteTeam(team) },
    ]);
  }

  async function deleteTeam(team: Team) {
    try {
      const payload = await removeTeam(team.id);
      setTeams(payload.teams);
      if (team.active) notifyTeamChanged();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to delete team.');
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.header}>
              <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityLabel="Go back"><SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} /></Pressable>
              <View style={styles.headerCopy}><Text style={styles.eyebrow}>TEAM MANAGEMENT</Text><Text style={styles.title}>Saved Teams</Text></View>
            </View>
            {loading ? <Text style={styles.helperText}>Loading saved teams...</Text> : teams.map((team) => (
              <View key={team.id} style={styles.teamCard}>
                <View style={styles.teamIdentity}><View style={styles.teamIcon}><Text style={styles.teamInitial}>{team.name.charAt(0).toUpperCase()}</Text></View><View><Text style={styles.teamName}>{team.name}</Text><Text style={styles.teamDetail}>{team.players.length} players{team.active ? ' · Active' : ''}</Text></View></View>
                <View style={styles.actions}>
                  <View style={styles.teamActions}>
                    <Pressable onPress={() => router.push({ pathname: '/team-edit', params: { teamId: team.id } })} style={styles.editButton}><Text style={styles.editText}>EDIT</Text></Pressable>
                  </View>
                  <Pressable onPress={() => confirmDelete(team)} style={styles.deleteButton}><Text style={styles.deleteText}>DELETE TEAM</Text></Pressable>
                </View>
              </View>
            ))}
            {!loading && teams.length === 0 && <Text style={styles.helperText}>No saved teams yet.</Text>}
            {error && <Text style={styles.errorText}>{error}</Text>}
          </ScrollView>
        </SafeAreaView>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.paper }, safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' }, content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: BottomTabInset + 24 }, header: { alignItems: 'center', flexDirection: 'row', marginBottom: 22 }, backButton: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 }, headerCopy: { marginLeft: 13 }, eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 }, title: { color: palette.ink, fontSize: 28, fontWeight: '800', marginTop: 4 }, helperText: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 10 }, teamCard: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, marginBottom: 12, padding: 15 }, teamIdentity: { alignItems: 'center', flexDirection: 'row', gap: 12 }, teamIcon: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 18, height: 36, justifyContent: 'center', width: 36 }, teamInitial: { color: palette.green, fontSize: 16, fontWeight: '900' }, teamName: { color: palette.ink, fontSize: 17, fontWeight: '800' }, teamDetail: { color: palette.muted, fontSize: 12, marginTop: 3 }, actions: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', marginTop: 15 }, teamActions: { alignItems: 'center', flexDirection: 'row', gap: 8 }, editButton: { backgroundColor: palette.green, borderRadius: 9, paddingHorizontal: 13, paddingVertical: 9 }, editText: { color: palette.panel, fontSize: 11, fontWeight: '900' }, deleteButton: { backgroundColor: palette.coral, borderRadius: 9, paddingHorizontal: 13, paddingVertical: 9 }, deleteText: { color: palette.panel, fontSize: 11, fontWeight: '900' }, disabledButton: { opacity: 0.35 }, errorText: { color: palette.coral, fontSize: 12, lineHeight: 18, marginTop: 14 },
});
