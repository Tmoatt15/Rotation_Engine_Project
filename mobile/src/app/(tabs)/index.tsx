import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import LiveScreen from './live';
import { clearAcceptedSchedule, getAcceptedSchedule, type LiveSchedule } from '@/live-schedule';
import { notifyTeamChanged } from '@/services/team-service';
import { activateTeam, getTeams } from '@/services/team-service';

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
type Team = {
  id: string;
  name: string;
  active?: boolean;
  players?: string[];
  season_roster?: unknown[];
  season_settings?: Record<string, unknown>;
};

type TeamStatus = 'READY' | 'SET UP TEAM' | 'NEEDS SETUP' | 'DATA ERROR';

function isTeamReady(team: Team | undefined): boolean {
  if (!team?.players?.length || team.season_roster?.length !== team.players.length) return false;
  const settings = team.season_settings;
  return Boolean(settings?.formation && settings.game_format && settings.total_blocks && settings.game_length_minutes);
}

export default function HomeScreen() {
  const router = useRouter();
  const [teams, setTeams] = useState<Team[]>([]);
  const [activeTeamName, setActiveTeamName] = useState<string | null>(null);
  const [teamsError, setTeamsError] = useState(false);
  const [hasAcceptedSchedule, setHasAcceptedSchedule] = useState(false);
  const [acceptedSchedule, setAcceptedSchedule] = useState<LiveSchedule | null>(null);
  const [showLiveGame, setShowLiveGame] = useState(false);
  const activeTeam = teams.find((team) => team.active);
  const teamStatus: TeamStatus = teamsError
    ? 'DATA ERROR'
    : teams.length === 0
      ? 'SET UP TEAM'
      : isTeamReady(activeTeam)
        ? 'READY'
        : 'NEEDS SETUP';
  const statusStyle = teamStatus === 'READY'
    ? styles.readyStatusSurface
    : teamStatus === 'DATA ERROR'
      ? styles.errorStatusSurface
      : styles.setupStatusSurface;
  const statusColor = teamStatus === 'READY'
    ? palette.green
    : teamStatus === 'DATA ERROR'
      ? '#ffad9d'
      : '#f1c76b';

  useFocusEffect(useCallback(() => {
    let active = true;
    getAcceptedSchedule().then((schedule) => {
      if (active) {
        setAcceptedSchedule(schedule);
        setHasAcceptedSchedule(Boolean(schedule));
      }
    });
    getTeams().then((teamsPayload) => {
      if (!Array.isArray(teamsPayload.teams)) throw new Error('Invalid teams response.');
      const loadedTeams = teamsPayload.teams as Team[];
      const loadedActiveTeam = loadedTeams.find((team) => team.active);
      if (active) {
        setTeams(loadedTeams);
        setActiveTeamName(loadedActiveTeam?.name ?? null);
        setTeamsError(false);
      }
    }).catch(() => {
      if (active) setTeamsError(true);
    });
    return () => {
      active = false;
    };
  }, []));

  useEffect(() => {
    const activeTeam = teams.find((team) => team.active);
    if (activeTeam && acceptedSchedule?.team_id && acceptedSchedule.team_id !== activeTeam.id) {
      void clearAcceptedSchedule();
      setAcceptedSchedule(null);
      setHasAcceptedSchedule(false);
    }
  }, [acceptedSchedule, teams]);

  async function selectTeam(team: Team) {
    if (team.active) return;
    try {
      const payload = await activateTeam(team.id);
      setTeams((current) => current.map((savedTeam) => ({ ...savedTeam, active: savedTeam.id === team.id })));
      setActiveTeamName(payload.name);
      notifyTeamChanged();
    } catch {
      setTeamsError(true);
    }
  }

  if (showLiveGame && acceptedSchedule) {
    return (
      <LiveScreen
        schedule={acceptedSchedule}
        onExit={() => setShowLiveGame(false)}
        onGameEnded={(report) => {
          setAcceptedSchedule(null);
          setHasAcceptedSchedule(false);
          setShowLiveGame(false);
          router.push({ pathname: '/after-game', params: { data: JSON.stringify(report) } });
        }}
      />
    );
  }

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.topbar}>
            <View>
              <Text style={styles.eyebrow}>MATCHDAY CONTROL</Text>
              <Text style={styles.title}>Rotation Engine</Text>
            </View>
            <TouchableOpacity style={styles.profileButton} accessibilityLabel="Open settings" onPress={() => router.navigate('/settings')}>
              <SymbolView
                name={{ ios: 'gearshape', android: 'settings', web: 'settings' }}
                size={20}
                tintColor={palette.ink}
              />
            </TouchableOpacity>
          </View>

          <View style={styles.seasonCard}>
            <View style={styles.seasonHeading}>
              <View>
                <Text style={styles.cardEyebrow}>CURRENT SEASON</Text>
                <Text style={styles.seasonTitle}>Fall 2026</Text>
              </View>
              <View style={styles.livePill}>
                <View style={[styles.liveDot, statusStyle]} />
                <Text style={[styles.liveText, { color: statusColor }]}>{teamStatus}</Text>
              </View>
            </View>
            <View style={styles.seasonRule} />
            <View style={styles.activeTeamRow}>
              <View style={styles.activeTeamCopy}>
                <Text style={styles.statLabel}>Select Active Team</Text>
                <Text style={styles.activeTeamName} numberOfLines={1}>{activeTeamName ?? '--'}</Text>
              </View>
            </View>
            {!activeTeamName && <Text style={styles.noTeamText}>Create a team to begin setting up your season.</Text>}
            {teams.length > 1 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.teamOptions}>
              {teams.map((team) => (
                <TouchableOpacity
                  key={team.id}
                  onPress={() => selectTeam(team)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: team.active }}
                  style={[styles.teamOption, team.active && styles.teamOptionActive]}>
                  <Text style={[styles.teamOptionText, team.active && styles.teamOptionTextActive]} numberOfLines={1}>{team.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>}
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Next move</Text>
          </View>
          <TouchableOpacity
            style={styles.primaryAction}
            accessibilityRole="button"
            onPress={() => {
              if (!activeTeamName) {
                router.navigate('/team-create');
              } else if (hasAcceptedSchedule && acceptedSchedule) {
                setShowLiveGame(true);
              } else {
                router.navigate('/game');
              }
            }}>
            <View>
              <Text style={styles.primaryEyebrow}>{!activeTeamName ? 'GET STARTED' : hasAcceptedSchedule ? 'ACCEPTED SCHEDULE' : 'GAME 01'}</Text>
              <Text style={styles.primaryTitle}>{!activeTeamName ? 'Create your first team' : hasAcceptedSchedule ? 'Resume Live Game' : 'Build Substitution Schedule'}</Text>
              <Text style={styles.primaryDetail}>{!activeTeamName ? 'Add players to begin setting up rotations' : hasAcceptedSchedule ? 'Continue the saved substitution plan' : 'Select player availability, then generate rotation schedule'}</Text>
            </View>
            <View style={styles.primaryArrow}>
              <SymbolView
                name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }}
                size={22}
                tintColor={palette.panel}
              />
            </View>
          </TouchableOpacity>

        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: palette.paper,
  },
  safeArea: {
    flex: 1,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  content: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: BottomTabInset + Spacing.three,
  },
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 26,
  },
  eyebrow: {
    color: palette.coral,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.8,
  },
  title: {
    color: palette.ink,
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginTop: 5,
  },
  profileButton: {
    alignItems: 'center',
    backgroundColor: palette.panel,
    borderColor: palette.line,
    borderRadius: 16,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    marginRight: 44,
    width: 44,
  },
  seasonCard: {
    backgroundColor: palette.green,
    borderRadius: 16,
    padding: 16,
  },
  seasonHeading: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  cardEyebrow: {
    color: '#a8cdbb',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  seasonTitle: {
    color: '#fffdf8',
    fontSize: 21,
    fontWeight: '800',
    marginTop: 3,
  },
  livePill: {
    alignItems: 'center',
    backgroundColor: palette.paper,
    borderRadius: 20,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  liveDot: {
    backgroundColor: palette.yellow,
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  readyStatusSurface: { backgroundColor: '#2f765c' },
  setupStatusSurface: { backgroundColor: '#715b2a' },
  errorStatusSurface: { backgroundColor: '#713d38' },
  liveText: {
    color: '#f6e7bd',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
  },
  seasonRule: {
    backgroundColor: '#448069',
    height: 1,
    marginVertical: 12,
  },
  statLabel: {
    color: '#b8d4c5',
    fontSize: 12,
    marginTop: 3,
  },
  activeTeamRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  activeTeamCopy: { flex: 1 },
  activeTeamName: {
    color: '#fffdf8',
    fontSize: 17,
    fontWeight: '800',
    marginTop: 2,
  },
  teamOptions: { gap: 6, paddingTop: 10 },
  teamOption: {
    borderColor: '#5c927b',
    borderRadius: 10,
    borderWidth: 1,
    maxWidth: 190,
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  teamOptionActive: { backgroundColor: '#fffdf8', borderColor: '#fffdf8' },
  teamOptionText: { color: '#d3e5da', fontSize: 12, fontWeight: '700' },
  teamOptionTextActive: { color: palette.green },
  sectionHeader: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 11,
    marginTop: 27,
  },
  sectionTitle: {
    color: palette.ink,
    fontSize: 19,
    fontWeight: '800',
  },
  noTeamText: {
    color: '#dcebe2',
    fontSize: 12,
    marginTop: 10,
  },
  primaryAction: {
    alignItems: 'center',
    backgroundColor: palette.coral,
    borderRadius: 18,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 116,
    paddingHorizontal: 19,
    paddingVertical: 17,
  },
  primaryEyebrow: {
    color: '#f9d7c9',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  primaryTitle: {
    color: '#fffaf3',
    fontSize: 20,
    fontWeight: '800',
    marginTop: 7,
  },
  primaryDetail: {
    color: '#f9ddd2',
    fontSize: 12,
    marginTop: 5,
  },
  primaryArrow: {
    alignItems: 'center',
    backgroundColor: '#c45f40',
    borderRadius: 16,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
});
