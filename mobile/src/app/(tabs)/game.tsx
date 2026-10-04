import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { GAME_FORMATS } from '@/engine/season';
import { createPlayer } from '@/engine/rotation';
import { fieldCapacityByHalf, positionCapacityCandidates, positionCapacityDeficits, positionCapacityWarnings, type PositionCapacityDeficit } from '@/engine/quotas';
import { getNextGameNumber, getSavedReports } from '@/services/report-service';
import { generateLocalSchedule } from '@/services/schedule-service';
import { getActiveTeam, getActiveTeamId, getRoster, getSeasonSettings } from '@/services/team-service';

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

type RosterPlayer = { name: string; primary_positions?: string[]; general_positions?: string[]; backup_positions?: string[]; excluded_positions?: string[]; group?: string };

function displayPlayerName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

function capacityPositionWords(position: PositionCapacityDeficit['position']): [string, string] {
  return position === 'D' ? ['defender', 'defender'] : position === 'M' ? ['midfielder', 'midfielder'] : ['forward', 'forward'];
}

type PositionShortage = { position: PositionCapacityDeficit['position']; detail: string; candidates: string[] };

function parsePositionShortage(message: string, roster: RosterPlayer[], totalBlocks: number): PositionShortage | null {
  const blockCapacity = message.match(/Block (\d+): ([DMF]) requires (\d+) players but (?:only )?(\d+) were assigned/);
  const exactAssignment = message.match(/Block (\d+): ([DMF]) players cannot form a complete legal exact-slot assignment/);
  const endpoint = message.match(/Block (\d+): core player (.+?) could not be assigned to the (first|last) block endpoint/);
  const match = blockCapacity ?? exactAssignment ?? endpoint;
  if (!match) return null;
  const position = (match[2] === 'D' || match[2] === 'M' || match[2] === 'F') ? match[2] : (roster.find((player) => player.name === match[2])?.general_positions ?? []).find((candidate) => ['D', 'M', 'F'].includes(candidate)) as PositionCapacityDeficit['position'] | undefined;
  if (!position) return null;
  const [noun] = capacityPositionWords(position);
  const detail = blockCapacity
    ? `Block ${blockCapacity[1]} needs ${blockCapacity[3]} ${blockCapacity[3] === '1' ? noun : `${noun}s`} but only ${blockCapacity[4]} are available.`
    : `The available roster cannot cover every ${noun} slot within playing-time limits.`;
  return { position, detail, candidates: positionCapacityCandidates(position, roster.map((player) => createPlayer(player as Parameters<typeof createPlayer>[0])), totalBlocks) };
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
  const [completedGameCount, setCompletedGameCount] = useState(0);
  const [gameNumber, setGameNumber] = useState('1');
  const [showGameNumberConfirmation, setShowGameNumberConfirmation] = useState(false);
  const [showMaximumLimitConfirmation, setShowMaximumLimitConfirmation] = useState(false);
  const [disableMaximumLimits, setDisableMaximumLimits] = useState(false);
  const [playersOnField, setPlayersOnField] = useState(11);
  const [hasGoalkeeper, setHasGoalkeeper] = useState(true);
  const [totalBlocks, setTotalBlocks] = useState(10);
  const [formation, setFormation] = useState('4-3-3');
  const [rosterPlayers, setRosterPlayers] = useState<RosterPlayer[]>([]);
  const [capacityWarnings, setCapacityWarnings] = useState<string[]>([]);
  const [capacityDeficits, setCapacityDeficits] = useState<PositionCapacityDeficit[]>([]);
  const [showCapacityWarning, setShowCapacityWarning] = useState(false);
  const [positionShortage, setPositionShortage] = useState<PositionShortage | null>(null);
  const recheckCapacityOnFocus = useRef(false);
  const availableCount = playerNames.length - unavailable.size;
  const enteredGameNumber = Number.parseInt(gameNumber, 10);
  const gameNumberWarning = Number.isInteger(enteredGameNumber) && enteredGameNumber <= completedGameCount
    ? `This is not ahead of the ${completedGameCount} completed ${completedGameCount === 1 ? 'game' : 'games'}. Check the number before continuing.`
    : null;

  function loadRoster() {
    setLoadingRoster(true);
    getActiveTeam()
      .then((activeTeam) => {
        setTeamId(activeTeam.id);
        setTeamName(activeTeam.name);
        return Promise.all([getRoster(activeTeam.id), getSavedReports(activeTeam.id), getNextGameNumber(activeTeam.id), getSeasonSettings(activeTeam.id)]);
      })
      .then(([payload, reports, nextGameNumber, settings]) => {
        setCompletedGameCount(reports.length);
        setGameNumber(String(nextGameNumber));
        const formatDetails = GAME_FORMATS[settings.game_format] ?? GAME_FORMATS['11v11'];
        setPlayersOnField(formatDetails.players_on_field);
        setHasGoalkeeper(formatDetails.has_goalkeeper);
        setTotalBlocks(settings.total_blocks ?? 10);
        setFormation(settings.formation ?? '4-3-3');
        const rosterPlayers = payload.players as RosterPlayer[];
        setRosterPlayers(rosterPlayers);
        const eligibleGoalkeepers = rosterPlayers
          .filter((player) => player.primary_positions?.some((position) => position.toUpperCase() === 'GK') || player.group === 'rotational_gk')
          .map((player) => player.name);
        setPlayerNames(rosterPlayers.map((player) => player.name));
        setGoalkeeperNames(eligibleGoalkeepers);
        if (!recheckCapacityOnFocus.current) {
          setFirstHalfGK(null);
          setSecondHalfGK(null);
        }
      })
      .catch((requestError) => setError(requestError instanceof Error ? requestError.message : 'Unable to load roster.'))
        .finally(() => setLoadingRoster(false));
  }

  useFocusEffect(useCallback(() => {
    if (!recheckCapacityOnFocus.current) setUnavailable(new Set());
    loadRoster();
  }, []));

  useEffect(() => {
    if (!loadingRoster && recheckCapacityOnFocus.current && rosterPlayers.length) {
      recheckCapacityOnFocus.current = false;
      requestScheduleGeneration();
    }
  }, [loadingRoster, rosterPlayers]);
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

  function requestScheduleGeneration() {
    if (hasGoalkeeper && (!firstHalfGK || !secondHalfGK)) {
      setError('Choose a goalkeeper for both halves before generating the schedule.');
      return;
    }
    setError(null);
    setDisableMaximumLimits(false);
    const availableRoster = rosterPlayers
      .filter((player) => !unavailable.has(player.name))
      .map((player) => createPlayer(player as Parameters<typeof createPlayer>[0]));
    const warnings = positionCapacityWarnings(formation, availableRoster);
    const deficits = positionCapacityDeficits(formation, availableRoster, totalBlocks, { firstHalfGk: firstHalfGK, secondHalfGk: secondHalfGK });
    if (warnings.length || deficits.length) {
      setCapacityWarnings(warnings);
      setCapacityDeficits(deficits);
      const deficit = deficits[0];
      if (deficit) {
        const [noun] = capacityPositionWords(deficit.position);
        setPositionShortage({ position: deficit.position, detail: `The available roster cannot cover every ${noun} slot within playing-time limits.`, candidates: deficit.candidates });
      } else {
        setPositionShortage(null);
      }
      setShowCapacityWarning(true);
      return;
    }
    continueToGenerationOptions();
  }

  function continueToGenerationOptions() {
    const requiredFieldBlocks = totalBlocks * (playersOnField - (hasGoalkeeper ? 1 : 0));
    const availableFieldPlayers = playerNames
      .filter((name) => !unavailable.has(name))
      .map((name) => rosterPlayers.find((player) => player.name === name))
      .filter((player): player is RosterPlayer => player !== undefined)
      .map((player) => createPlayer(player as Parameters<typeof createPlayer>[0]));
    const normalMaximumCapacity = availableFieldPlayers.reduce((total, player) => total + fieldCapacityByHalf(player, totalBlocks, { firstHalfGk: firstHalfGK, secondHalfGk: secondHalfGK }).reduce((sum, capacity) => sum + capacity, 0), 0);
    const maximumCapacityPressure = normalMaximumCapacity < requiredFieldBlocks;
    if (maximumCapacityPressure) {
      setShowMaximumLimitConfirmation(true);
      return;
    }
    requestGameNumberConfirmation();
  }

  function requestGameNumberConfirmation() {
    setGameNumber(String(completedGameCount + 1));
    setShowGameNumberConfirmation(true);
  }

  async function generateSchedule() {
    const availableGoalkeepers = new Set(goalkeeperNames.filter((name) => !unavailable.has(name)));
    if (hasGoalkeeper && (!firstHalfGK || !secondHalfGK)) {
      setError('Choose a goalkeeper for both halves before generating the schedule.');
      return;
    }
    if (hasGoalkeeper && (!availableGoalkeepers.has(firstHalfGK!) || !availableGoalkeepers.has(secondHalfGK!))) {
      setError('Choose available goalkeeper selections for both halves.');
      return;
    }
    const confirmedGameNumber = Number.parseInt(gameNumber, 10);
    if (!Number.isInteger(confirmedGameNumber) || confirmedGameNumber < 1) {
      setError('Enter a valid game number greater than zero.');
      return;
    }
    setLoading(true);
    setError(null);
    setShowGameNumberConfirmation(false);
    try {
      const activeTeamId = teamId ?? await getActiveTeamId();
      const payload = await generateLocalSchedule({ teamId: activeTeamId, availablePlayerNames: playerNames.filter((name) => !unavailable.has(name)), gameNumber: confirmedGameNumber, firstHalfGk: firstHalfGK, secondHalfGk: secondHalfGK, disableMaximumLimits });
      router.navigate({ pathname: '/schedule', params: { data: JSON.stringify(payload) } });
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Unable to reach the schedule service.';
      const availableRoster = rosterPlayers.filter((player) => !unavailable.has(player.name));
      const shortage = parsePositionShortage(message, availableRoster, totalBlocks);
      if (shortage) {
        setPositionShortage(shortage);
        setCapacityWarnings([]);
        setCapacityDeficits([]);
        setShowCapacityWarning(true);
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }

  function continueWithMaximumChoice(disableLimits: boolean) {
    setDisableMaximumLimits(disableLimits);
    setShowMaximumLimitConfirmation(false);
    requestGameNumberConfirmation();
  }

  function continueWithCapacityOverride() {
    setDisableMaximumLimits(true);
    setShowCapacityWarning(false);
    requestGameNumberConfirmation();
  }

  function tryCapacityGeneration() {
    setShowCapacityWarning(false);
    setDisableMaximumLimits(false);
    requestGameNumberConfirmation();
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Modal visible={showCapacityWarning} transparent animationType="fade" onRequestClose={() => setShowCapacityWarning(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.gameNumberModal}>
            <Text style={styles.modalEyebrow}>POSITION CAPACITY</Text>
            <Text style={styles.modalTitle}>{positionShortage ? `Short on ${capacityPositionWords(positionShortage.position)[0]}s` : 'Some positions are short'}</Text>
            <Text style={styles.modalDetail}>{positionShortage?.detail ?? 'The available roster cannot cover every legal position slot normally:'}</Text>
            <View style={styles.capacityWarningList}>
              {capacityWarnings.map((warning) => <Text key={warning} style={styles.modalWarning}>{warning.replace('Preflight: ', '').replace(/ available ([DMF]) players can cover (\d+) \1 slots\./, (_, position, slots) => ` legal ${position === 'D' ? 'defender' : position === 'M' ? 'midfielder' : 'forward'}${Number(slots) === 1 ? '' : 's'} available for ${slots} ${position === 'D' ? 'defender' : position === 'M' ? 'midfielder' : 'forward'} slots.`)}</Text>)}
              {capacityDeficits.map((deficit) => {
                const [noun] = capacityPositionWords(deficit.position);
                return <Text key={`deficit-${deficit.position}`} style={styles.modalWarning}>The available roster cannot cover every {noun} position slot for this game.</Text>;
              })}
              {(!capacityDeficits.length && positionShortage?.candidates.length) ? <Text style={styles.modalWarning}>Consider making one of these players eligible for {capacityPositionWords(positionShortage.position)[1]}: {positionShortage.candidates.join(', ')}.</Text> : null}
            </View>
            <View style={styles.modalActions}>
              <Pressable onPress={() => { recheckCapacityOnFocus.current = true; setShowCapacityWarning(false); router.push('/position-assignment'); }} style={styles.cancelButton} accessibilityRole="button"><Text style={styles.cancelButtonText}>ASSIGN BACKUP POSITION</Text></Pressable>
              <Pressable onPress={continueWithCapacityOverride} style={styles.confirmButton} accessibilityRole="button"><Text style={styles.confirmButtonText}>TURN OFF LIMITS</Text></Pressable>
              <Pressable onPress={tryCapacityGeneration} accessibilityRole="button"><Text style={styles.cancelButtonText}>Try anyway with limits</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <Modal visible={showMaximumLimitConfirmation} transparent animationType="fade" onRequestClose={() => setShowMaximumLimitConfirmation(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.gameNumberModal}>
            <Text style={styles.modalEyebrow}>LOW ATTENDANCE</Text>
            <Text style={styles.modalTitle}>Everyone may need to play</Text>
            <Text style={styles.modalDetail}>
              {availableCount} players are available for a {playersOnField}-player formation. Keeping maximum limits may leave some required positions unassigned. Turn off maximum limits for this game so available players can play every block?
            </Text>
            <View style={styles.modalActions}>
              <Pressable onPress={() => continueWithMaximumChoice(false)} style={styles.cancelButton} accessibilityRole="button">
                <Text style={styles.cancelButtonText}>KEEP LIMITS</Text>
              </Pressable>
              <Pressable onPress={() => continueWithMaximumChoice(true)} style={styles.confirmButton} accessibilityRole="button">
                <Text style={styles.confirmButtonText}>TURN OFF MAXIMUMS</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <Modal visible={showGameNumberConfirmation} transparent animationType="fade" onRequestClose={() => setShowGameNumberConfirmation(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.gameNumberModal}>
            <Text style={styles.modalEyebrow}>CONFIRM GAME NUMBER</Text>
            <Text style={styles.modalTitle}>Which game is this?</Text>
            <Text style={styles.modalDetail}>
              {completedGameCount} completed {completedGameCount === 1 ? 'game' : 'games'} found. This number affects fairness quotas and rotating starters.
            </Text>
            <TextInput
              autoFocus
              keyboardType="number-pad"
              onChangeText={setGameNumber}
              selectTextOnFocus
              style={styles.gameNumberInput}
              value={gameNumber}
            />
            {gameNumberWarning && <Text style={styles.modalWarning}>{gameNumberWarning}</Text>}
            <View style={styles.modalActions}>
              <Pressable onPress={() => setShowGameNumberConfirmation(false)} style={styles.cancelButton} accessibilityRole="button">
                <Text style={styles.cancelButtonText}>BACK</Text>
              </Pressable>
              <Pressable onPress={() => void generateSchedule()} style={styles.confirmButton} accessibilityRole="button">
                <Text style={styles.confirmButtonText}>CONFIRM & GENERATE</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
                <Text style={styles.eyebrow}>GAME {gameNumber.padStart(2, '0')} · FALL 2026</Text>
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

            {hasGoalkeeper && <View style={styles.goalkeeperCard}>
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
            </View>}

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
              onPress={requestScheduleGeneration}
              style={[styles.primaryAction, availableCount < playersOnField && styles.primaryActionDisabled]}
              disabled={loadingRoster || availableCount < playersOnField || loading}
              accessibilityRole="button">
              <View>
                <Text style={styles.primaryEyebrow}>NEXT STEP</Text>
                <Text style={styles.primaryTitle}>{loading ? 'Generating...' : 'Generate schedule'}</Text>
                <Text style={styles.primaryDetail}>
                  {availableCount < playersOnField ? `At least ${playersOnField} players are needed` : 'Review this game’s availability'}
                </Text>
              </View>
              {loading ? <ActivityIndicator size="small" color={palette.panel} /> : <SymbolView
                name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }}
                size={22}
                tintColor={palette.panel}
              />}
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
  modalOverlay: { alignItems: 'center', backgroundColor: 'rgba(23, 34, 31, 0.55)', flex: 1, justifyContent: 'center', padding: 20 },
  gameNumberModal: { backgroundColor: palette.panel, borderRadius: 20, padding: 22, width: '100%' },
  modalEyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  modalTitle: { color: palette.ink, fontSize: 25, fontWeight: '800', marginTop: 5 },
  modalDetail: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 8 },
  modalWarning: { color: palette.coral, fontSize: 12, lineHeight: 17, marginTop: 10 },
  capacityWarningList: { marginTop: 4 },
  gameNumberInput: { alignSelf: 'flex-start', borderColor: palette.line, borderRadius: 12, borderWidth: 1, color: palette.ink, fontSize: 24, fontWeight: '800', marginTop: 18, minWidth: 90, paddingHorizontal: 15, paddingVertical: 10, textAlign: 'center' },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  cancelButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 12, borderWidth: 1, flex: 1, paddingVertical: 13 },
  cancelButtonText: { color: palette.muted, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  confirmButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 12, flex: 1.4, justifyContent: 'center', paddingHorizontal: 10, paddingVertical: 13 },
  confirmButtonText: { color: palette.panel, fontSize: 10, fontWeight: '900', letterSpacing: 0.7 },
});