import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { getLocalTeam, updateTeam } from '@/services/team-service';

const palette = { ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1', green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c' };
type Team = { id: string; name: string; players: string[] };

export default function EditTeamScreen() {
  const router = useRouter();
  const { teamId } = useLocalSearchParams<{ teamId?: string }>();
  const [teamName, setTeamName] = useState('');
  const [players, setPlayers] = useState<string[]>([]);
  const [playerName, setPlayerName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (teamId ? getLocalTeam(teamId) : Promise.reject(new Error('Team was not found.')))
      .then((team) => {
        setTeamName(team.name);
        setPlayers(team.players);
      })
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Unable to load team.'))
      .finally(() => setLoading(false));
  }, [teamId]);

  function addPlayer() {
    const name = playerName.trim();
    if (!name) return;
    if (players.some((player) => player.toLowerCase() === name.toLowerCase())) {
      setError('That player is already on the roster.');
      return;
    }
    setPlayers((current) => [...current, name]);
    setPlayerName('');
    setError(null);
  }

  async function saveTeam() {
    if (!teamId) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const payload = await updateTeam(teamId, teamName.trim(), players);
      setMessage(`${payload.name} was updated.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save team.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.header}><Pressable onPress={() => router.back()} style={styles.backButton} accessibilityLabel="Go back"><SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} /></Pressable><View style={styles.headerCopy}><Text style={styles.eyebrow}>TEAM MANAGEMENT</Text><Text style={styles.title}>Edit {teamName || 'Team'}</Text></View></View>
            {loading ? <Text style={styles.helperText}>Loading team...</Text> : <>
              <View style={styles.formCard}>
                <Text style={styles.fieldLabel}>Team Name</Text>
                <TextInput value={teamName} onChangeText={setTeamName} style={styles.input} />
                <Text style={[styles.fieldLabel, styles.rosterLabel]}>Player Names</Text>
                <View style={styles.addPlayerRow}><TextInput value={playerName} onChangeText={setPlayerName} onSubmitEditing={addPlayer} returnKeyType="done" placeholder="Player name" placeholderTextColor={palette.muted} style={[styles.input, styles.playerInput]} /><Pressable onPress={addPlayer} style={styles.addButton} accessibilityLabel="Add player"><SymbolView name={{ ios: 'plus', android: 'add', web: 'add' }} size={20} tintColor={palette.panel} /></Pressable></View>
                <View style={styles.rosterList}>{players.map((player, index) => <View key={`${player}-${index}`} style={styles.rosterRow}><Text style={styles.rosterPlayerName}>{player}</Text><Pressable onPress={() => setPlayers((current) => current.filter((_, playerIndex) => playerIndex !== index))} accessibilityLabel={`Remove ${player}`}><SymbolView name={{ ios: 'xmark.circle', android: 'cancel', web: 'cancel' }} size={20} tintColor={palette.coral} /></Pressable></View>)}</View>
              </View>
              <Pressable onPress={saveTeam} disabled={saving || players.length === 0 || !teamName.trim()} style={[styles.saveButton, (saving || players.length === 0 || !teamName.trim()) && styles.disabledButton]}><Text style={styles.saveText}>{saving ? 'Saving...' : 'Save team changes'}</Text><SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={20} tintColor={palette.panel} /></Pressable>
              {message && <Text style={styles.successText}>{message}</Text>}
            </>}
            {error && <Text style={styles.errorText}>{error}</Text>}
          </ScrollView>
        </SafeAreaView>
      </View>
    </>
  );
}

const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: palette.paper }, safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' }, content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: BottomTabInset + 24 }, header: { alignItems: 'center', flexDirection: 'row', marginBottom: 22 }, backButton: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 }, headerCopy: { marginLeft: 13 }, eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 }, title: { color: palette.ink, fontSize: 28, fontWeight: '800', marginTop: 4 }, helperText: { color: palette.muted, fontSize: 13, marginTop: 10 }, formCard: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, padding: 16 }, fieldLabel: { color: palette.ink, fontSize: 14, fontWeight: '800' }, rosterLabel: { marginTop: 18 }, input: { backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 10, borderWidth: 1, color: palette.ink, fontSize: 15, marginTop: 7, minHeight: 46, paddingHorizontal: 11 }, addPlayerRow: { alignItems: 'center', flexDirection: 'row', gap: 8 }, playerInput: { flex: 1 }, addButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 10, height: 46, justifyContent: 'center', marginTop: 7, width: 46 }, rosterList: { backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 10, borderWidth: 1, marginTop: 12, paddingHorizontal: 11 }, rosterRow: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', minHeight: 44 }, rosterPlayerName: { color: palette.ink, fontSize: 14, fontWeight: '700' }, saveButton: { alignItems: 'center', backgroundColor: palette.coral, borderRadius: 16, flexDirection: 'row', gap: 9, justifyContent: 'center', marginTop: 18, minHeight: 54 }, disabledButton: { opacity: 0.55 }, saveText: { color: palette.panel, fontSize: 15, fontWeight: '800' }, successText: { color: palette.green, fontSize: 13, fontWeight: '700', marginTop: 14, textAlign: 'center' }, errorText: { color: palette.coral, fontSize: 12, lineHeight: 18, marginTop: 14 } });
