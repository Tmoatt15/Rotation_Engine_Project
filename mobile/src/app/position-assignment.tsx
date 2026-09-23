import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { getActiveTeam, getActiveTeamId, subscribeToTeamChanges } from '@/team-api';
import { getRoster, getSeasonSettings, updateRoster } from '@/services/team-service';
import { formationPositionRows, rosterMatchesFormation } from '@/position-validation';

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

type Group = 'core' | 'developing' | 'rotational';
type Filter = 'all' | Group;
type Player = {
  name: string;
  group: Group;
  general_positions: string[];
  primary_positions: string[];
  backup_positions: string[];
  excluded_positions: string[];
};
type PositionGroup = 'general_positions' | 'primary_positions' | 'backup_positions' | 'excluded_positions';
type PositionPickerState = { playerName: string; group: PositionGroup; positions: string[]; allowedPositions: string[] } | null;
const ANY_POSITION = 'ANY';

const fallbackFormation = '4-4-2';

type ApiPositionRow = { label?: string; positions?: string[] };

function mapApiPositionRows(rows: ApiPositionRow[]) {
  const rowsByGroup = rows.reduce((groups: Record<string, string[]>, row) => {
    const group = row.label?.includes('FORWARD')
      ? 'F'
      : row.label?.includes('MIDFIELD')
        ? 'M'
        : row.label?.includes('DEFENDER')
          ? 'D'
          : null;
    if (group && Array.isArray(row.positions)) {
      groups[group] = [...(groups[group] ?? []), ...row.positions];
    }
    return groups;
  }, {});
  const mappedRows = (['F', 'M', 'D'] as const)
    .filter((group) => rowsByGroup[group]?.length)
    .map((group) => ({ label: group, groupPositions: [group], exactPositions: rowsByGroup[group] }));
  return mappedRows.length ? mappedRows : null;
}

const groupLabels: Record<Filter, string> = {
  all: 'All players',
  core: 'Core',
  rotational: 'Rotational',
  developing: 'Developing',
};

const groupColors: Record<Group, { background: string; text: string }> = {
  core: { background: palette.coral, text: palette.panel },
  developing: { background: palette.coral, text: palette.panel },
  rotational: { background: palette.coral, text: palette.panel },
};

function displayPlayerName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

function isGoalkeeperAllowed(player: Player): boolean {
  return player.primary_positions.some((position) => position.toUpperCase() === 'GK');
}

function withoutGoalkeeper(positionList: string[]): string[] {
  return positionList.filter((position) => position.toUpperCase() !== 'GK');
}

export default function RosterScreen() {
  const router = useRouter();
  const [players, setPlayers] = useState<Player[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [positionPicker, setPositionPicker] = useState<PositionPickerState>(null);
  const [positionRows, setPositionRows] = useState(() => formationPositionRows(fallbackFormation));
  const [formation, setFormation] = useState(fallbackFormation);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [teamChangeVersion, setTeamChangeVersion] = useState(0);
  const filteredPlayers = useMemo(
    () => (filter === 'all' ? players : players.filter((player) => player.group === filter))
      .slice()
      .sort((first, second) => displayPlayerName(first.name).localeCompare(displayPlayerName(second.name), undefined, { sensitivity: 'base' })),
    [filter, players],
  );

  useEffect(() => subscribeToTeamChanges(() => setTeamChangeVersion((version) => version + 1)), []);

  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setPositionPicker(null);
    setPositionRows([]);

    async function loadTeamData() {
      try {
        const activeTeam = await getActiveTeam();
        const activeTeamId = activeTeam.id;
        const [rosterPayload, seasonPayload] = await Promise.all([getRoster(activeTeamId), getSeasonSettings(activeTeamId)]);
        if (!Array.isArray(rosterPayload.players)) throw new Error('The roster response did not contain a player list.');
        if (!active) return;
        setTeamId(activeTeamId);
        setTeamName(activeTeam.name);
        setPlayers(rosterPayload.players as Player[]);
        const currentFormation = seasonPayload.formation ?? fallbackFormation;
        setFormation(currentFormation);
        setPositionRows(formationPositionRows(currentFormation));
      } catch (requestError) {
        if (!active) return;
        setPositionRows(formationPositionRows(fallbackFormation));
        setError(requestError instanceof Error ? requestError.message : 'Unable to load roster.');
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadTeamData();
    return () => {
      active = false;
    };
  }, [teamChangeVersion]));

  function updatePlayer(name: string, changes: Partial<Player>) {
    setPlayers((current) => current.map((player) => player.name === name ? { ...player, ...changes } : player));
    setMessage(null);
    setError(null);
  }

  function toggleGoalkeeper(name: string) {
    const player = players.find((candidate) => candidate.name === name);
    if (!player) return;
    const allowed = isGoalkeeperAllowed(player);
    updatePlayer(name, {
      primary_positions: allowed
        ? player.primary_positions.filter((position) => position.toUpperCase() !== 'GK')
        : [...player.primary_positions, 'GK'],
    });
  }

  function openPositionPicker(player: Player, group: PositionGroup) {
    const formationPositions = positionRows.flatMap((row) => row.exactPositions);
    const generalGroups = player.general_positions.map((position) => position.toUpperCase());
    const primaryFormationPositions = generalGroups.includes(ANY_POSITION)
      ? formationPositions
      : formationPositions.filter((position) => {
        const row = positionRows.find((candidate) => candidate.exactPositions.includes(position));
        return row ? generalGroups.includes(row.label) : false;
      });
    const allowedPositions = group === 'general_positions'
      ? [ANY_POSITION, 'D', 'M', 'F']
      : group === 'backup_positions'
        ? ['D', 'M', 'F', ...formationPositions]
        : [ANY_POSITION, ...primaryFormationPositions];
    setPositionPicker({
      playerName: player.name,
      group,
      allowedPositions,
      positions: (group === 'primary_positions' ? withoutGoalkeeper(player[group]) : player[group])
        .filter((position) => allowedPositions.includes(position)),
    });
  }

  function finishPositionPicker() {
    if (!positionPicker) return;
    const player = players.find((candidate) => candidate.name === positionPicker.playerName);
    if (!player) return;
    const positions = positionPicker.positions.includes(ANY_POSITION)
      ? [ANY_POSITION]
      : positionPicker.positions.length === 0 && positionPicker.group === 'general_positions'
        ? [ANY_POSITION]
        : positionPicker.positions;
    updatePlayer(player.name, {
      [positionPicker.group]: positionPicker.group === 'primary_positions' && isGoalkeeperAllowed(player)
        ? [...positions, 'GK']
        : positions,
    });
    setPositionPicker(null);
  }

  async function saveRoster() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const activeTeamId = await getActiveTeamId();
      const payload = await updateRoster(activeTeamId, players);
      setPlayers(payload.players as Player[]);
      setMessage('Season roster saved.');
      router.replace('/');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save roster.');
    } finally {
      setSaving(false);
    }
  }

  const positionsNeedReview = !rosterMatchesFormation(formation, players as Player[]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityLabel="Go back">
                <SymbolView
                  name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
                  size={20}
                  tintColor={palette.ink}
                />
              </Pressable>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>FALL 2026</Text>
                <Text style={styles.title}>{teamName ? `Player Positions for ${teamName}` : 'Player Positions'}</Text>
              </View>
              <View style={styles.countBadge}>
                <Text style={styles.countValue}>{players.length}</Text>
                <Text style={styles.countLabel}>players</Text>
              </View>
            </View>

            <View style={styles.summaryCard}>
              <View style={styles.summaryIcon}>
                <SymbolView
                  name={{ ios: 'person.3.fill', android: 'group', web: 'group' }}
                  size={22}
                  tintColor={palette.green}
                />
              </View>
              <View style={styles.summaryCopy}>
                <Text style={styles.summaryTitle}>When assigning player groups and positions remember:</Text>
                <Text style={styles.summaryDetail}>
                  - Player Groups affect overall playing time (Core = more, Rotational = avg, Developing = less){'\n'}
                  - Too many Core/Developing players can have negative affects on scheduling.{ '\n' }
                  - The order that you select specific positions will affect the scheduling logic (first in list = higher priority)
                </Text>
              </View>
            </View>
            {positionsNeedReview && (
              <View style={styles.warningCard}>
                <SymbolView name={{ ios: 'exclamationmark.triangle.fill', android: 'warning', web: 'warning' }} size={20} tintColor={palette.coral} />
                <Text style={styles.warningText}>Your formation changed. Update player positions to match the current formation.</Text>
              </View>
            )}

            <Text style={styles.filterLabel}>Filter by:</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
              {(Object.keys(groupLabels) as Filter[]).map((key) => {
                const selected = filter === key;
                return (
                  <Pressable
                    key={key}
                    onPress={() => setFilter(key)}
                    style={[styles.filterButton, selected && styles.filterButtonSelected]}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}>
                    <Text style={[styles.filterText, selected && styles.filterTextSelected]}>
                      {groupLabels[key]}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            <View style={styles.listHeader}>
              <Text style={styles.sectionTitle}>{groupLabels[filter]}</Text>
              <Text style={styles.resultCount}>{filteredPlayers.length} shown</Text>
            </View>

            {loading ? <Text style={styles.helperText}>Loading season roster...</Text> : players.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyText}>{error ?? 'No players were returned.'}</Text>
                <Pressable onPress={() => router.replace('/position-assignment')} style={styles.retryButton}>
                  <Text style={styles.retryText}>Retry loading roster</Text>
                </Pressable>
              </View>
            ) : <View style={styles.playerList}>
              {filteredPlayers.map((player, index) => {
                return (
                  <View key={player.name} style={[styles.playerRow, index === filteredPlayers.length - 1 && styles.lastRow]}>
                    <View style={styles.avatarColumn}>
                      <Text style={styles.playerName} numberOfLines={2}>{displayPlayerName(player.name)}</Text>
                      <Pressable
                        onPress={() => toggleGoalkeeper(player.name)}
                        style={[styles.gkButton, isGoalkeeperAllowed(player) && styles.gkButtonSelected]}
                        accessibilityRole="switch"
                        accessibilityState={{ checked: isGoalkeeperAllowed(player) }}
                        accessibilityLabel={`${displayPlayerName(player.name)} goalkeeper eligibility`}>
                        <SymbolView
                          name={{ ios: 'checkmark.shield', android: 'verified_user', web: 'verified_user' }}
                          size={12}
                          tintColor={isGoalkeeperAllowed(player) ? palette.panel : palette.muted}
                        />
                        <Text style={[styles.gkButtonText, isGoalkeeperAllowed(player) && styles.gkButtonTextSelected]}>{isGoalkeeperAllowed(player) ? 'GK Yes' : 'GK No'}</Text>
                      </Pressable>
                    </View>
                    <View style={styles.playerCopy}>
                      <View style={styles.groupPicker}>
                        {(Object.keys(groupLabels) as Filter[]).filter((group): group is Group => group !== 'all').map((group) => (
                          <Pressable key={group} onPress={() => updatePlayer(player.name, { group })} style={[styles.groupOption, player.group === group && { backgroundColor: groupColors[group].background }]}>
                            <Text style={[styles.groupOptionText, player.group === group && { color: groupColors[group].text }]}>{group}</Text>
                          </Pressable>
                        ))}
                      </View>
                      <PositionField label="General" value={player.general_positions} onPress={() => openPositionPicker(player, 'general_positions')} />
                      <PositionField label="Primary" value={withoutGoalkeeper(player.primary_positions)} onPress={() => openPositionPicker(player, 'primary_positions')} />
                      <PositionField label="Backup" value={player.backup_positions} onPress={() => openPositionPicker(player, 'backup_positions')} />
                      <PositionField label="Excluded" value={player.excluded_positions} onPress={() => openPositionPicker(player, 'excluded_positions')} />
                    </View>
                  </View>
                );
              })}
            </View>}
            {message && <Text style={styles.successText}>{message}</Text>}
            {error && <Text style={styles.errorText}>{error}</Text>}
            {!loading && <Pressable onPress={saveRoster} disabled={saving} style={[styles.saveButton, saving && styles.disabledButton]}>
              <Text style={styles.saveText}>{saving ? 'Saving...' : 'Save and return home'}</Text>
              <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={19} tintColor={palette.panel} />
            </Pressable>}
          </ScrollView>
        </SafeAreaView>
      </View>
      <PositionPickerModal
        picker={positionPicker}
        positionRows={positionRows}
        onToggle={(position) => setPositionPicker((current) => current ? {
          ...current,
          positions: current.positions.includes(position)
            ? current.positions.filter((selected) => selected !== position)
            : position === ANY_POSITION
              ? [ANY_POSITION]
              : [...current.positions.filter((selected) => selected !== ANY_POSITION), position],
        } : current)}
        onFinish={finishPositionPicker}
      />
    </>
  );
}

function PositionField({ label, value, onPress }: { label: string; value: string[]; onPress: () => void }) {
    <Text style={styles.positionValueText} numberOfLines={1}>{value.includes(ANY_POSITION) ? 'Any' : value.join(', ') || 'None'}</Text>
  return (
    <Pressable style={styles.positionField} onPress={onPress} accessibilityRole="button">
      <Text style={styles.positionFieldLabel}>{label}</Text>
      <View style={styles.positionValue}>
        <Text style={styles.positionValueText} numberOfLines={1}>{value.join(', ') || 'None'}</Text>
        <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={16} tintColor={palette.muted} />
      </View>
    </Pressable>
  );
}

function PositionPickerModal({
  picker,
  positionRows,
  onToggle,
  onFinish,
}: {
  picker: PositionPickerState;
  positionRows: { label: string; groupPositions: string[]; exactPositions: string[] }[];
  onToggle: (position: string) => void;
  onFinish: () => void;
}) {
  if (!picker) return null;
  const useGroupPositions = picker.group === 'general_positions' || picker.group === 'backup_positions';
  const allowExactPositions = picker.group !== 'general_positions';
  const groupLabel = picker.group.replace('_positions', '');
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onFinish}>
      <View style={styles.modalBackdrop}>
        <View style={styles.positionModal}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalEyebrow}>SELECT POSITIONS</Text>
              <Text style={styles.modalTitle}>{groupLabel}</Text>
            </View>
            <Pressable onPress={onFinish} accessibilityLabel="Finish selecting positions" style={styles.modalCloseButton}>
              <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={19} tintColor={palette.ink} />
            </Pressable>
          </View>
          <Text style={styles.modalHint}>Tap each position to add or remove it.</Text>
          <ScrollView contentContainerStyle={styles.positionRows}>
            {(picker.group === 'general_positions' || picker.group === 'primary_positions') && (
              <View style={styles.pickerRow}>
                <Text style={styles.pickerRowLabel}>Flexible</Text>
                <View style={styles.pickerOptions}>
                  <Pressable
                    onPress={() => onToggle(ANY_POSITION)}
                    style={[styles.positionOption, picker.positions.includes(ANY_POSITION) && styles.positionOptionSelected]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: picker.positions.includes(ANY_POSITION) }}>
                    <Text style={[styles.positionOptionText, picker.positions.includes(ANY_POSITION) && styles.positionOptionTextSelected]}>Any</Text>
                  </Pressable>
                </View>
              </View>
            )}
            {positionRows.map((row) => {
              const positions = useGroupPositions
                ? [...row.groupPositions, ...(allowExactPositions ? row.exactPositions : [])]
                : row.exactPositions;
              return (
                <View key={row.label} style={styles.pickerRow}>
                  <Text style={styles.pickerRowLabel}>{row.label}</Text>
                  <View style={styles.pickerOptions}>
                    {positions.filter((position) => picker.allowedPositions.includes(position)).map((position) => {
                      const selected = picker.positions.includes(position);
                      return (
                        <Pressable
                          key={position}
                          onPress={() => onToggle(position)}
                          style={[styles.positionOption, selected && styles.positionOptionSelected]}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}>
                          <Text style={[styles.positionOptionText, selected && styles.positionOptionTextSelected]}>{position}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              );
            })}
          </ScrollView>
          <Pressable onPress={onFinish} style={styles.finishButton} accessibilityRole="button">
            <Text style={styles.finishButtonText}>FINISH</Text>
            <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={19} tintColor={palette.panel} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.paper },
  safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: BottomTabInset + 24 },
  header: { alignItems: 'center', flexDirection: 'row', marginBottom: 22 },
  backButton: {
    alignItems: 'center',
    backgroundColor: palette.panel,
    borderColor: palette.line,
    borderRadius: 14,
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  headerCopy: { flex: 1, marginLeft: 13 },
  eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 },
  title: { color: palette.ink, fontSize: 28, fontWeight: '800', marginTop: 4 },
  countBadge: { alignItems: 'flex-end' },
  countValue: { color: palette.green, fontSize: 23, fontWeight: '800' },
  countLabel: { color: palette.muted, fontSize: 11, marginTop: 1 },
  summaryCard: {
    alignItems: 'center',
    backgroundColor: palette.greenSoft,
    borderRadius: 17,
    flexDirection: 'row',
    marginBottom: 20,
    padding: 15,
  },
  summaryIcon: {
    alignItems: 'center',
    backgroundColor: palette.panel,
    borderRadius: 13,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  summaryCopy: { flex: 1, marginLeft: 12 },
  summaryTitle: { color: palette.ink, fontSize: 15, fontWeight: '800' },
  summaryDetail: { color: palette.muted, fontSize: 12, lineHeight: 17, marginTop: 3 },
  warningCard: {
    alignItems: 'center',
    backgroundColor: '#fde4dc',
    borderColor: palette.coral,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
    padding: 13,
  },
  warningText: {
    color: '#8f3928',
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 18,
  },
  filters: { gap: 8, paddingBottom: 22 },
  filterLabel: { color: palette.muted, fontSize: 12, fontWeight: '800', marginBottom: 8, textTransform: 'uppercase' },
  filterButton: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 18, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 9 },
  filterButtonSelected: { backgroundColor: palette.green, borderColor: palette.green },
  filterText: { color: palette.muted, fontSize: 12, fontWeight: '700' },
  filterTextSelected: { color: '#fffdf8' },
  listHeader: { alignItems: 'baseline', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  sectionTitle: { color: palette.ink, fontSize: 19, fontWeight: '800' },
  resultCount: { color: palette.muted, fontSize: 11 },
  playerList: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, overflow: 'hidden' },
  playerRow: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', minHeight: 75, paddingHorizontal: 13 },
  lastRow: { borderBottomWidth: 0 },
  avatarColumn: { alignItems: 'center', width: 72 },
  gkButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 9, borderWidth: 1, flexDirection: 'row', gap: 4, justifyContent: 'center', marginTop: 6, minHeight: 32, paddingHorizontal: 8, paddingVertical: 6, width: 68 },
  gkButtonSelected: { backgroundColor: palette.coral, borderColor: palette.coral },
  gkButtonText: { color: palette.muted, fontSize: 11, fontWeight: '800' },
  gkButtonTextSelected: { color: palette.panel },
  playerCopy: { flex: 1, marginLeft: 12 },
  playerName: { color: palette.ink, fontSize: 15, fontWeight: '800' },
  groupPicker: { flexDirection: 'row', gap: 6, marginTop: 8 },
  groupOption: { backgroundColor: '#f1eee5', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5 },
  groupOptionText: { color: palette.muted, fontSize: 10, fontWeight: '800', textTransform: 'capitalize' },
  positionField: { alignItems: 'center', flexDirection: 'row', marginTop: 8 },
  positionFieldLabel: { color: palette.muted, fontSize: 10, fontWeight: '800', width: 58 },
  positionValue: { alignItems: 'center', backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 8, borderWidth: 1, flex: 1, flexDirection: 'row', justifyContent: 'space-between', minHeight: 34, paddingHorizontal: 9, paddingVertical: 6 },
  positionValueText: { color: palette.ink, flex: 1, fontSize: 12, marginRight: 6 },
  modalBackdrop: { backgroundColor: 'rgba(23, 34, 31, 0.42)', flex: 1, justifyContent: 'flex-end' },
  positionModal: { backgroundColor: palette.paper, borderTopLeftRadius: 24, borderTopRightRadius: 24, maxHeight: '88%', paddingHorizontal: 18, paddingTop: 18, paddingBottom: 24 },
  modalHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  modalEyebrow: { color: palette.coral, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  modalTitle: { color: palette.ink, fontSize: 26, fontWeight: '800', marginTop: 3, textTransform: 'capitalize' },
  modalCloseButton: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 40, justifyContent: 'center', width: 40 },
  modalHint: { color: palette.muted, fontSize: 12, marginTop: 5 },
  positionRows: { gap: 12, paddingVertical: 20 },
  pickerRow: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 16, borderWidth: 1, padding: 12 },
  pickerRowLabel: { color: palette.coral, fontSize: 12, fontWeight: '900', letterSpacing: 1.2, marginBottom: 9 },
  pickerOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  positionOption: { alignItems: 'center', backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 9, borderWidth: 1, minWidth: 54, paddingHorizontal: 10, paddingVertical: 11 },
  positionOptionSelected: { backgroundColor: palette.green, borderColor: palette.green },
  positionOptionText: { color: palette.ink, fontSize: 12, fontWeight: '800' },
  positionOptionTextSelected: { color: palette.panel },
  finishButton: { alignItems: 'center', backgroundColor: palette.coral, borderRadius: 15, flexDirection: 'row', gap: 8, justifyContent: 'center', minHeight: 54 },
  finishButtonText: { color: palette.panel, fontSize: 15, fontWeight: '900', letterSpacing: 1 },
  saveButton: { alignItems: 'center', backgroundColor: palette.coral, borderRadius: 16, flexDirection: 'row', gap: 9, justifyContent: 'center', marginTop: 18, minHeight: 54 },
  disabledButton: { opacity: 0.55 },
  saveText: { color: palette.panel, fontSize: 15, fontWeight: '800' },
  successText: { color: palette.green, fontSize: 13, fontWeight: '700', marginTop: 14, textAlign: 'center' },
  errorText: { color: palette.coral, fontSize: 12, lineHeight: 18, marginTop: 14 },
  helperText: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 5 },
  emptyCard: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, padding: 18 },
  emptyText: { color: palette.coral, fontSize: 13, lineHeight: 18 },
  retryButton: { alignSelf: 'flex-start', backgroundColor: palette.green, borderRadius: 10, marginTop: 12, paddingHorizontal: 12, paddingVertical: 9 },
  retryText: { color: palette.panel, fontSize: 12, fontWeight: '800' },
});