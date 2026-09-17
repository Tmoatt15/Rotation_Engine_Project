import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { getActiveTeam, getActiveTeamId } from '@/team-api';
import { generateLocalSchedule } from '@/services/schedule-service';
import { getRoster } from '@/services/team-service';

const palette = {
  ink: '#17221f',
  muted: '#6b7873',
  paper: '#f5f1e8',
  panel: '#fffdf8',
  line: '#e4ded1',
  green: '#19634b',
  greenSoft: '#dcebe2',
  coral: '#d96f4c',
};

type RosterPlayer = { name: string; primary_positions?: string[]; group?: string };

function displayPlayerName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

export default function GameScreen() {
  const router = useRouter();
  const [playerNames, setPlayerNames] = useState<string[]>([]);
  const [goalkeeperNames, setGoalkeeperNames] = useState<string[]>([]);
  const [firstHalfGK, setFirstHalfGK] = useState<string | null>(null);
  const [secondHalfGK, setSecondHalfGK] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingRoster, setLoadingRoster] = useState(true);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const availableCount = playerNames.length - unavailable.size;

  function loadRoster() {
    setLoadingRoster(true);
    getActiveTeam()
      .then((activeTeam) => {
        setTeamId(activeTeam.id);
        setTeamName(activeTeam.name);
        return getRoster(activeTeam.id);
      })
      .then((payload) => {
        const rosterPlayers = payload.players as RosterPlayer[];
        const eligibleGoalkeepers = rosterPlayers
          .filter((player) => player.primary_positions?.some((position) => position.toUpperCase() === 'GK') || player.group === 'rotational_gk')
          .map((player) => player.name);
        setPlayerNames(rosterPlayers.map((player) => player.name));
        setGoalkeeperNames(eligibleGoalkeepers);
        setFirstHalfGK(eligibleGoalkeepers[0] ?? null);
        setSecondHalfGK(eligibleGoalkeepers[1] ?? eligibleGoalkeepers[0] ?? null);
      })
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Unable to load roster.'))
      .finally(() => setLoadingRoster(false));
  }

  useFocusEffect(useCallback(() => {
    setUnavailable(new Set());
    loadRoster();
  }, []));
  function toggleAvailability(name: string) {
    setUnavailable((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
    if (name === firstHalfGK) setFirstHalfGK(null);
    if (name === secondHalfGK) setSecondHalfGK(null);
    setError(null);
  }

  async function generateSchedule() {
    setLoading(true);
    setError(null);
    try {
      const activeTeamId = teamId ?? await getActiveTeamId();
      const payload = await generateLocalSchedule({ teamId: activeTeamId, availablePlayerNames: playerNames.filter((name) => !unavailable.has(name)), gameNumber: 1, firstHalfGk: firstHalfGK, secondHalfGk: secondHalfGK });
      router.navigate({ pathname: '/schedule', params: { data: JSON.stringify(payload) } });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to reach the schedule service.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <Pressable onPress={() => router.navigate('/' as never)} style={styles.backButton} accessibilityLabel="Go home">
                <SymbolView
                  name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
                  size={20}
                  tintColor={palette.ink}
                />
              </Pressable>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>GAME 01 · FALL 2026</Text>
                <Text style={styles.title}>{teamName ? `Set availability for ${teamName}` : 'Set availability'}</Text>
              </View>
              <View style={styles.countBadge}>
                <Text style={styles.countValue}>{availableCount}</Text>
                <Text style={styles.countLabel}>available</Text>
              </View>
            </View>

            <View style={styles.infoCard}>
              <View style={styles.infoIcon}>
                <SymbolView
                  name={{ ios: 'checkmark.circle', android: 'check_circle', web: 'check_circle' }}
                  size={22}
                  tintColor={palette.green}
                />
              </View>
              <View style={styles.infoCopy}>
                <Text style={styles.infoTitle}>Who is here today?</Text>
                <Text style={styles.infoDetail}>Tap a player to mark them unavailable for this game.</Text>
              </View>
            </View>

            <View style={styles.listHeader}>
              <Text style={styles.sectionTitle}>Players</Text>
              <Text style={styles.resultCount}>{unavailable.size} unavailable</Text>
            </View>

            <View style={styles.goalkeeperCard}>
              <Text style={styles.goalkeeperTitle}>Goalkeepers</Text>
              <Text style={styles.goalkeeperDetail}>Choose who plays each half. Select GK Yes players only.</Text>
              {goalkeeperNames.length === 0 ? <Text style={styles.helperText}>No GK-eligible players are configured.</Text> : (
                <View style={styles.goalkeeperSelectors}>
                  <View style={styles.goalkeeperSelector}>
                    <Text style={styles.selectorLabel}>First half</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.selectorOptions}>
                      {goalkeeperNames.map((name) => (
                        <Pressable key={`first-${name}`} onPress={() => setFirstHalfGK(name)} disabled={unavailable.has(name)} style={[styles.goalkeeperOption, firstHalfGK === name && styles.goalkeeperOptionSelected, unavailable.has(name) && styles.goalkeeperOptionDisabled]}>
                          <Text style={[styles.goalkeeperOptionText, firstHalfGK === name && styles.goalkeeperOptionTextSelected]}>{displayPlayerName(name)}</Text>
                        </Pressable>
                      ))}
                    </ScrollView>
                  </View>
                  <View style={styles.goalkeeperSelector}>
                    <Text style={styles.selectorLabel}>Second half</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.selectorOptions}>
                      {goalkeeperNames.map((name) => (
                        <Pressable key={`second-${name}`} onPress={() => setSecondHalfGK(name)} disabled={unavailable.has(name)} style={[styles.goalkeeperOption, secondHalfGK === name && styles.goalkeeperOptionSelected, unavailable.has(name) && styles.goalkeeperOptionDisabled]}>
                          <Text style={[styles.goalkeeperOptionText, secondHalfGK === name && styles.goalkeeperOptionTextSelected]}>{displayPlayerName(name)}</Text>
                        </Pressable>
                      ))}
                    </ScrollView>
                  </View>
                </View>
              )}
            </View>

            {loadingRoster ? <Text style={styles.helperText}>Loading season roster...</Text> : <View style={styles.playerList}>
              {playerNames.map((name, index) => {
                const isUnavailable = unavailable.has(name);
                return (
                  <Pressable
                    key={name}
                    onPress={() => toggleAvailability(name)}
                    style={[styles.playerRow, index === playerNames.length - 1 && styles.lastRow]}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: !isUnavailable }}>
                    <View style={[styles.avatar, isUnavailable && styles.avatarUnavailable]}>
                      <Text style={[styles.avatarText, isUnavailable && styles.avatarTextUnavailable]}>
                        {name.charAt(0)}
                      </Text>
                    </View>
                    <Text style={[styles.playerName, isUnavailable && styles.playerNameUnavailable]}>{displayPlayerName(name)}</Text>
                    <View style={[styles.status, isUnavailable ? styles.statusUnavailable : styles.statusAvailable]}>
                      <SymbolView
                        name={
                          isUnavailable
                            ? { ios: 'xmark', android: 'close', web: 'close' }
                            : { ios: 'checkmark', android: 'check', web: 'check' }
                        }
                        size={15}
                        tintColor={isUnavailable ? palette.coral : palette.green}
                      />
                      <Text style={[styles.statusText, isUnavailable && styles.statusTextUnavailable]}>
                        {isUnavailable ? 'Unavailable' : 'Available'}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>}

            <Pressable
              onPress={generateSchedule}
              style={[styles.primaryAction, availableCount < 11 && styles.primaryActionDisabled]}
              disabled={loadingRoster || availableCount < 11 || loading}
              accessibilityRole="button">
              <View>
                <Text style={styles.primaryEyebrow}>NEXT STEP</Text>
                <Text style={styles.primaryTitle}>{loading ? 'Generating...' : 'Generate schedule'}</Text>
                <Text style={styles.primaryDetail}>
                  {availableCount < 11 ? 'At least 11 players are needed' : 'Review this game’s availability'}
                </Text>
              </View>
              <SymbolView
                name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }}
                size={22}
                tintColor={palette.panel}
              />
            </Pressable>

            {error && <Text style={styles.errorText}>{error}</Text>}
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
  header: { alignItems: 'center', flexDirection: 'row', marginBottom: 22 },
  backButton: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 },
  headerCopy: { flex: 1, marginLeft: 13 },
  eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 },
  title: { color: palette.ink, fontSize: 28, fontWeight: '800', marginTop: 4 },
  countBadge: { alignItems: 'flex-end' },
  countValue: { color: palette.green, fontSize: 23, fontWeight: '800' },
  countLabel: { color: palette.muted, fontSize: 11, marginTop: 1 },
  infoCard: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 17, flexDirection: 'row', marginBottom: 22, padding: 15 },
  infoIcon: { alignItems: 'center', backgroundColor: palette.panel, borderRadius: 13, height: 44, justifyContent: 'center', width: 44 },
  infoCopy: { flex: 1, marginLeft: 12 },
  infoTitle: { color: palette.ink, fontSize: 15, fontWeight: '800' },
  infoDetail: { color: palette.muted, fontSize: 12, lineHeight: 17, marginTop: 3 },
  listHeader: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  sectionTitle: { color: palette.ink, fontSize: 19, fontWeight: '800' },
  resultCount: { color: palette.muted, fontSize: 11 },
  goalkeeperCard: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, marginBottom: 18, padding: 15 },
  goalkeeperTitle: { color: palette.ink, fontSize: 17, fontWeight: '800' },
  goalkeeperDetail: { color: palette.muted, fontSize: 12, lineHeight: 17, marginTop: 3 },
  goalkeeperSelectors: { gap: 13, marginTop: 14 },
  goalkeeperSelector: { gap: 7 },
  selectorLabel: { color: palette.ink, fontSize: 12, fontWeight: '800' },
  selectorOptions: { gap: 7 },
  goalkeeperOption: { backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 10, borderWidth: 1, paddingHorizontal: 11, paddingVertical: 9 },
  goalkeeperOptionSelected: { backgroundColor: palette.coral, borderColor: palette.coral },
  goalkeeperOptionDisabled: { opacity: 0.4 },
  goalkeeperOptionText: { color: palette.ink, fontSize: 12, fontWeight: '700' },
  goalkeeperOptionTextSelected: { color: palette.panel },
  playerList: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, marginBottom: 18, overflow: 'hidden' },
  playerRow: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', minHeight: 64, paddingHorizontal: 13 },
  lastRow: { borderBottomWidth: 0 },
  avatar: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 20, height: 38, justifyContent: 'center', width: 38 },
  avatarUnavailable: { backgroundColor: '#f6ddd4' },
  avatarText: { color: palette.green, fontSize: 15, fontWeight: '800' },
  avatarTextUnavailable: { color: palette.coral },
  playerName: { color: palette.ink, flex: 1, fontSize: 15, fontWeight: '800', marginLeft: 12 },
  playerNameUnavailable: { color: palette.muted, textDecorationLine: 'line-through' },
  status: { alignItems: 'center', borderRadius: 9, flexDirection: 'row', gap: 5, paddingHorizontal: 8, paddingVertical: 6 },
  statusAvailable: { backgroundColor: palette.greenSoft },
  statusUnavailable: { backgroundColor: '#f6ddd4' },
  statusText: { color: palette.green, fontSize: 10, fontWeight: '800' },
  statusTextUnavailable: { color: palette.coral },
  primaryAction: { alignItems: 'center', backgroundColor: palette.coral, borderRadius: 18, flexDirection: 'row', justifyContent: 'space-between', minHeight: 88, paddingHorizontal: 18, paddingVertical: 15 },
  primaryActionDisabled: { opacity: 0.5 },
  primaryEyebrow: { color: '#f9d7c9', fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  primaryTitle: { color: '#fffaf3', fontSize: 19, fontWeight: '800', marginTop: 6 },
  primaryDetail: { color: '#f9ddd2', fontSize: 12, marginTop: 4 },
  errorText: { color: palette.coral, fontSize: 12, lineHeight: 18, marginTop: 14, paddingHorizontal: 4 },
  helperText: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 5 },
});