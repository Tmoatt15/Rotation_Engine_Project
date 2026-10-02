import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { getActiveTeam } from '@/services/team-service';
import { getRoster } from '@/services/team-service';
const palette = { ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1', green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c' };
type Player = { name: string };

function playerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0]?.charAt(0).toUpperCase() ?? '';
  return `${parts[0].charAt(0)}${parts[parts.length - 1].charAt(0)}`.toUpperCase();
}

export default function RosterListScreen() {
  const [teamName, setTeamName] = useState<string | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getActiveTeam()
      .then((team) => {
        if (active) setTeamName(team.name);
        return getRoster(team.id);
      })
      .then((payload) => {
        if (!Array.isArray(payload.players)) throw new Error('The roster response did not contain a player list.');
        if (active) setPlayers((payload.players as Player[]).sort((first, second) => first.name.localeCompare(second.name)));
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Unable to load roster.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []));

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <View style={styles.headerCopy}><Text style={styles.eyebrow}>ACTIVE ROSTER</Text><Text style={styles.title}>{teamName ? `${teamName} Roster` : 'Roster'}</Text><Text style={styles.subtitle}>Players currently available for this team</Text></View>
              <View style={styles.countBadge}><Text style={styles.countValue}>{players.length}</Text><Text style={styles.countLabel}>players</Text></View>
            </View>
            {loading ? <Text style={styles.helperText}>Loading roster...</Text> : error ? <Text style={styles.errorText}>{error}</Text> : players.length === 0 ? <Text style={styles.helperText}>No players on this roster.</Text> : (
              <View style={styles.rosterCard}>
                {players.map((player, index) => <View key={player.name} style={[styles.playerRow, index === players.length - 1 && styles.lastRow]}><View style={styles.avatar}><Text style={styles.avatarText}>{playerInitials(player.name)}</Text></View><Text style={styles.playerName}>{player.name}</Text></View>)}
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.paper }, safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' }, content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: BottomTabInset + 24 }, header: { alignItems: 'center', flexDirection: 'row', marginBottom: 22 }, headerCopy: { flex: 1 }, eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 }, title: { color: palette.ink, fontSize: 28, fontWeight: '800', marginTop: 4 }, subtitle: { color: palette.muted, fontSize: 12, marginTop: 4 }, countBadge: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 13, minWidth: 54, paddingHorizontal: 9, paddingVertical: 7 }, countValue: { color: palette.green, fontSize: 17, fontWeight: '900' }, countLabel: { color: palette.green, fontSize: 9, fontWeight: '800', marginTop: 1 }, helperText: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 10 }, errorText: { color: palette.coral, fontSize: 13, lineHeight: 19, marginTop: 10 }, rosterCard: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, paddingHorizontal: 15 }, playerRow: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', gap: 12, minHeight: 66 }, lastRow: { borderBottomWidth: 0 }, avatar: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 18, height: 36, justifyContent: 'center', width: 36 }, avatarText: { color: palette.green, fontSize: 13, fontWeight: '900' }, playerName: { color: palette.ink, flex: 1, fontSize: 15, fontWeight: '800' },
});
