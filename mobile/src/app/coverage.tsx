import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { getActiveTeam, getActiveTeamId } from '@/team-api';
import { getRoster, getSeasonSettings } from '@/services/team-service';

const palette = {
  ink: '#17221f',
  muted: '#6b7873',
  paper: '#f5f1e8',
  panel: '#fffdf8',
  line: '#e4ded1',
  green: '#19634b',
  greenSoft: '#dcebe2',
  coral: '#d96f4c',
  yellow: '#f1c76b',
};

type Group = 'core' | 'developing' | 'rotational';
type Player = {
  name: string;
  group: Group;
  general_positions: string[];
  primary_positions: string[];
  backup_positions: string[];
  excluded_positions: string[];
};
type RoleGroup = { key: string; label: string };
type PositionTier = 'primary' | 'general' | 'backup';
type PositionEntry = { position: string; tier: PositionTier };
type GroupedPlayer = { player: Player; positions: string[]; isBackup: boolean };

const positionLabels = ['F', 'M', 'D', 'GK'];
const positionNames: Record<string, string> = { F: 'Forwards', M: 'Midfielders', D: 'Defenders', GK: 'Goalkeepers' };
const roleGroups: RoleGroup[] = [
  { key: 'F', label: 'Forwards' },
  { key: 'M', label: 'Midfielders' },
  { key: 'D', label: 'Defenders' },
  { key: 'GK', label: 'Goalkeepers' },
];

function formationGroupCounts(formation: string): Record<string, number> {
  if (formation === '2-1-2-1') return { D: 2, M: 3, F: 1 };
  if (formation === '4-2-3-1') return { D: 4, M: 5, F: 1 };
  const parts = formation.split('-').map(Number);
  if (parts.length === 2) return { D: parts[0], M: 0, F: parts[1] };
  return { D: parts[0], M: parts[1], F: parts[2] };
}

function recommendedGroupDepth(formation: string, position: string): number {
  const count = formationGroupCounts(formation)[position] ?? 0;
  return count + (count <= 2 ? 1 : 2);
}

function displayPlayerName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

function playerPositionEntries(player: Player): PositionEntry[] {
  const excluded = new Set(player.excluded_positions.map((position) => position.toUpperCase()));
  const entries: PositionEntry[] = [];
  const seen = new Set<string>();
  const addPositions = (positions: string[], tier: PositionTier) => {
    positions.forEach((position) => {
      const normalized = position.toUpperCase();
      const excludedByGroup = [...excluded].some((excludedPosition) =>
        ['F', 'M', 'D', 'GK'].includes(excludedPosition) && belongsToRoleGroup(normalized, excludedPosition),
      );
      if (normalized && !excluded.has(normalized) && !excludedByGroup && !seen.has(normalized)) {
        seen.add(normalized);
        entries.push({ position: normalized, tier });
      }
    });
  };
  addPositions(player.primary_positions, 'primary');
  addPositions(player.general_positions, 'general');
  addPositions(player.backup_positions, 'backup');
  return entries;
}

function isInPosition(player: Player, position: string): boolean {
  return playerPositionEntries(player).some(({ position: playerPosition }) => belongsToRoleGroup(playerPosition, position));
}

function belongsToRoleGroup(position: string, group: string): boolean {
  if (group === 'GK') return position === 'GK';
  if (group === 'F') return position === 'F' || position.startsWith('F') || ['CF', 'LW', 'RW'].includes(position);
  if (group === 'M') return position === 'M' || position.startsWith('M') || ['CM', 'CDM', 'CAM', 'LAM', 'RAM', 'LDM', 'RDM'].includes(position);
  return position === 'D' || ['CB', 'LB', 'RB', 'LCB', 'RCB', 'LWB', 'RWB'].includes(position);
}

export default function CoverageScreen() {
  const router = useRouter();
  const [players, setPlayers] = useState<Player[]>([]);
  const [formation, setFormation] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getActiveTeam()
      .then((activeTeam) => {
        if (active) setTeamName(activeTeam.name);
        return getRoster(activeTeam.id);
      })
      .then((payload) => {
        if (!Array.isArray(payload.players)) throw new Error('The roster response did not contain a player list.');
        if (active) setPlayers(payload.players as Player[]);
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Unable to load coverage.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    getActiveTeamId()
      .then((activeTeamId) => getSeasonSettings(activeTeamId))
      .then((payload) => {
        if (active && typeof payload.formation === 'string') setFormation(payload.formation);
      })
      .catch((requestError) => {
        if (active && !error) setError(requestError instanceof Error ? requestError.message : 'Unable to load season settings.');
      });
    return () => {
      active = false;
    };
  }, []));

  const depth = useMemo(() => positionLabels.map((position) => ({
    position,
    count: players.filter((player) => isInPosition(player, position)).length,
    names: players.filter((player) => isInPosition(player, position)).map((player) => player.name),
    recommended: formation
      ? position === 'GK' ? 3 : recommendedGroupDepth(formation, position)
      : null,
  })), [formation, players]);

  const groupedPlayers = useMemo(() => roleGroups.map((group) => ({
    ...group,
    players: players.flatMap((player) => {
      const entries = playerPositionEntries(player).filter(({ position }) => belongsToRoleGroup(position, group.key));
      if (!entries.length) return [];
      const hasNormalCoverage = entries.some(({ tier }) => tier !== 'backup');
      return [{
        player,
        positions: entries.map(({ position }) => position),
        isBackup: !hasNormalCoverage,
      }];
    }).sort((first, second) => {
      if (first.isBackup !== second.isBackup) return first.isBackup ? 1 : -1;
      return first.player.name.localeCompare(second.player.name);
    }),
  })), [players]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityLabel="Go back">
                <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} />
              </Pressable>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>ROSTER ANALYSIS</Text>
                <Text style={styles.title}>{teamName ? `Position Analytics for ${teamName}` : 'Position Analytics'}</Text>
              </View>
            </View>

            <View style={styles.summaryCard}>
              <View>
                <Text style={styles.summaryEyebrow}>ACTIVE ROSTER</Text>
                <Text style={styles.summaryTitle}>{players.length} players mapped</Text>
                <Text style={styles.summaryDetail}>Position depth from primary, general, and backup assignments.</Text>
              </View>
              <View style={styles.summaryIcon}>
                <SymbolView name="chart.bar" size={25} tintColor={palette.green} />
              </View>
            </View>

            <Text style={styles.sectionTitle}>Position depth</Text>
            <View style={styles.depthList}>
              {depth.map((item) => (
                <View key={item.position} style={styles.depthRow}>
                  <View style={styles.depthLabel}>
                    <Text style={styles.positionName}>{positionNames[item.position].toUpperCase()}</Text>
                    {item.recommended !== null && <Text style={[styles.recommendation, item.count >= item.recommended && styles.recommendationMet]}>{item.recommended} {positionNames[item.position]} recommended</Text>}
                  </View>
                  <View style={styles.depthGraphRow}>
                    <View style={styles.depthBarTrack}>
                      <View style={[styles.depthBar, item.recommended !== null && item.count >= item.recommended && styles.depthBarMet, { width: `${Math.min(item.count / Math.max(item.recommended ?? item.count, 1), 1) * 100}%` }]} />
                    </View>
                    <Text style={[styles.depthCount, item.recommended !== null && item.count >= item.recommended && styles.depthCountMet]}>{item.count}</Text>
                  </View>
                </View>
              ))}
            </View>

            <Text style={styles.sectionTitle}>Player roles</Text>
            {loading ? <Text style={styles.helperText}>Loading roster coverage...</Text> : error ? <Text style={styles.errorText}>{error}</Text> : (
              <View>
                {groupedPlayers.map((group) => (
                  <View key={group.key} style={styles.roleGroupCard}>
                    <Text style={styles.roleGroupHeader}>{group.label}</Text>
                    {group.players.length === 0 ? <Text style={styles.noPlayersText}>No players assigned</Text> : (
                      <View style={styles.rolePlayersGrid}>
                        {group.players.map(({ player, positions, isBackup }) => (
                          <View key={`${group.key}-${player.name}`} style={styles.playerTile}>
                            <View style={styles.tileAvatar}><Text style={styles.tileAvatarText}>{player.name.charAt(0)}</Text></View>
                            <View style={styles.tileNameRow}>
                              <Text style={styles.tilePlayerName} numberOfLines={2}>{displayPlayerName(player.name)}</Text>
                              {isBackup && <Text style={styles.backupBadge}>BACKUP</Text>}
                            </View>
                            <Text style={styles.tilePlayerDetail} numberOfLines={1}>{positions.join(' · ')}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                ))}
              </View>
            )}
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
  summaryCard: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 18, flexDirection: 'row', justifyContent: 'space-between', marginBottom: 25, padding: 17 },
  summaryEyebrow: { color: palette.green, fontSize: 10, fontWeight: '800', letterSpacing: 1.4 },
  summaryTitle: { color: palette.ink, fontSize: 20, fontWeight: '800', marginTop: 4 },
  summaryDetail: { color: palette.muted, fontSize: 12, lineHeight: 17, marginTop: 4, maxWidth: 245 },
  summaryIcon: { alignItems: 'center', backgroundColor: palette.panel, borderRadius: 14, height: 50, justifyContent: 'center', width: 50 },
  sectionTitle: { color: palette.ink, fontSize: 19, fontWeight: '800', marginBottom: 10 },
  depthList: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, marginBottom: 24, padding: 15 },
  depthRow: { marginBottom: 18 },
  depthLabel: { alignItems: 'center' },
  positionName: { color: palette.green, fontSize: 12, fontWeight: '900', letterSpacing: 0.8 },
  recommendation: { color: palette.coral, fontSize: 9, fontWeight: '700', lineHeight: 12, marginTop: 3 },
  recommendationMet: { color: palette.green },
  depthGraphRow: { alignItems: 'center', flexDirection: 'row', marginTop: 8 },
  depthBarTrack: { backgroundColor: '#edf0e9', borderRadius: 5, flex: 1, height: 9, overflow: 'hidden' },
  depthBar: { backgroundColor: palette.coral, borderRadius: 5, height: 9, minWidth: 4 },
  depthBarMet: { backgroundColor: palette.green },
  depthCount: { color: palette.ink, fontSize: 16, fontWeight: '800', marginLeft: 12, textAlign: 'right', width: 22 },
  depthCountMet: { color: palette.green },
  roleGroupCard: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, marginBottom: 12, overflow: 'hidden' },
  roleGroupHeader: { backgroundColor: palette.greenSoft, color: palette.green, fontSize: 14, fontWeight: '900', letterSpacing: 1, paddingHorizontal: 13, paddingVertical: 12, textTransform: 'uppercase' },
  rolePlayersGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 10 },
  playerTile: { alignItems: 'center', backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 10, borderWidth: 1, minHeight: 76, paddingHorizontal: 6, paddingVertical: 8, width: '31%' },
  tileAvatar: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 14, height: 28, justifyContent: 'center', width: 28 },
  tileAvatarText: { color: palette.green, fontSize: 12, fontWeight: '800' },
  tilePlayerName: { color: palette.ink, fontSize: 11, fontWeight: '800', marginTop: 5, textAlign: 'center' },
  tileNameRow: { alignItems: 'center', marginTop: 5, width: '100%' },
  backupBadge: { color: palette.coral, fontSize: 8, fontWeight: '900', letterSpacing: 0.5, marginTop: 2 },
  tilePlayerDetail: { color: palette.muted, fontSize: 9, marginTop: 3, textAlign: 'center' },
  noPlayersText: { color: palette.muted, fontSize: 12, paddingHorizontal: 13, paddingVertical: 15 },
  helperText: { color: palette.muted, fontSize: 12, lineHeight: 18, marginBottom: 16 },
  errorText: { color: palette.coral, fontSize: 12, lineHeight: 18, marginBottom: 16 },
});
