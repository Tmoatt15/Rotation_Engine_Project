import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { notifyTeamChanged } from '@/team-api';
import { activateTeam, createLocalTeam } from '@/services/team-service';
const palette = {
  ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1',
  green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c',
};

export default function CreateTeamScreen() {
  const router = useRouter();
  const [teamName, setTeamName] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [players, setPlayers] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  async function createTeam() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const payload = await createLocalTeam(teamName.trim(), players);
      await activateTeam(payload.id);
      notifyTeamChanged();
      setTeamName('');
      setPlayerName('');
      setPlayers([]);
      setMessage(`${payload.name} was created and is now active.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to create team.');
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
            <View style={styles.header}>
              <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityLabel="Go back">
                <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} />
              </Pressable>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>TEAM SETUP</Text>
                <Text style={styles.title}>Create new team</Text>
              </View>
            </View>
            <View style={styles.infoCard}>
              <SymbolView name={{ ios: 'person.3.fill', android: 'group', web: 'group' }} size={22} tintColor={palette.green} />
              <Text style={styles.infoText}>Create a team roster. New teams start with the current season defaults.</Text>
            </View>
            <View style={styles.formCard}>
              <Text style={styles.fieldLabel}>Team Name</Text>
              <TextInput value={teamName} onChangeText={setTeamName} placeholder="e.g. U12 United" placeholderTextColor={palette.muted} style={styles.input} />
              <Text style={[styles.fieldLabel, styles.rosterLabel]}>Player Names</Text>
              <Text style={styles.helperText}>Add each player individually. New players start as Rotational.</Text>
              <View style={styles.addPlayerRow}>
                <TextInput value={playerName} onChangeText={setPlayerName} onSubmitEditing={addPlayer} returnKeyType="done" placeholder="Player name" placeholderTextColor={palette.muted} style={[styles.input, styles.playerInput]} />
                <Pressable onPress={addPlayer} style={styles.addButton} accessibilityLabel="Add player to roster">
                  <SymbolView name={{ ios: 'plus', android: 'add', web: 'add' }} size={20} tintColor={palette.panel} />
                </Pressable>
              </View>
              <View style={styles.rosterList}>
                {players.length === 0 ? <Text style={styles.emptyRosterText}>No players added yet.</Text> : players.map((player, index) => (
                  <View key={`${player}-${index}`} style={styles.rosterRow}>
                    <Text style={styles.rosterPlayerName}>{player}</Text>
                    <Pressable onPress={() => setPlayers((current) => current.filter((_, playerIndex) => playerIndex !== index))} accessibilityLabel={`Remove ${player}`}>
                      <SymbolView name={{ ios: 'xmark.circle', android: 'cancel', web: 'cancel' }} size={20} tintColor={palette.coral} />
                    </Pressable>
                  </View>
                ))}
              </View>
            </View>
            <Pressable onPress={createTeam} disabled={saving || players.length === 0 || !teamName.trim()} style={[styles.saveButton, (saving || players.length === 0 || !teamName.trim()) && styles.disabledButton]}>
              <Text style={styles.saveText}>{saving ? 'Creating...' : 'Create team'}</Text>
              <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={20} tintColor={palette.panel} />
            </Pressable>
            {message && <Text style={styles.successText}>{message}</Text>}
            {error && <Text style={styles.errorText}>{error}</Text>}
          </ScrollView>
        </SafeAreaView>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.paper }, safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' }, content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: BottomTabInset + 24 }, header: { alignItems: 'center', flexDirection: 'row', marginBottom: 22 }, backButton: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 }, headerCopy: { marginLeft: 13 }, eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 }, title: { color: palette.ink, fontSize: 28, fontWeight: '800', marginTop: 4 }, infoCard: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 17, flexDirection: 'row', gap: 12, marginBottom: 16, padding: 15 }, infoText: { color: palette.ink, flex: 1, fontSize: 13, lineHeight: 19 }, formCard: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, padding: 16 }, fieldLabel: { color: palette.ink, fontSize: 14, fontWeight: '800' }, rosterLabel: { marginTop: 18 }, helperText: { color: palette.muted, fontSize: 12, lineHeight: 17, marginTop: 5 }, input: { backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 10, borderWidth: 1, color: palette.ink, fontSize: 15, marginTop: 7, minHeight: 46, paddingHorizontal: 11, paddingVertical: 10 }, addPlayerRow: { alignItems: 'center', flexDirection: 'row', gap: 8 }, playerInput: { flex: 1 }, addButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 10, height: 46, justifyContent: 'center', marginTop: 7, width: 46 }, rosterList: { backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 10, borderWidth: 1, marginTop: 12, paddingHorizontal: 11 }, emptyRosterText: { color: palette.muted, fontSize: 12, paddingVertical: 14 }, rosterRow: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', justifyContent: 'space-between', minHeight: 44 }, rosterPlayerName: { color: palette.ink, fontSize: 14, fontWeight: '700' }, saveButton: { alignItems: 'center', backgroundColor: palette.coral, borderRadius: 16, flexDirection: 'row', gap: 9, justifyContent: 'center', marginTop: 18, minHeight: 54 }, disabledButton: { opacity: 0.55 }, saveText: { color: palette.panel, fontSize: 15, fontWeight: '800' }, successText: { color: palette.green, fontSize: 13, fontWeight: '700', marginTop: 14, textAlign: 'center' }, errorText: { color: palette.coral, fontSize: 12, lineHeight: 18, marginTop: 14 },
});
