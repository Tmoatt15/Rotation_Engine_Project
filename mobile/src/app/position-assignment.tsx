import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { getActiveTeam, getActiveTeamId, subscribeToTeamChanges } from '@/services/team-service';
import { getRoster, getSeasonSettings, updateRoster } from '@/services/team-service';
import { formationPositionRows, rosterMatchesFormation } from '@/position-validation';
import { positionHealth, positionHealthMessage, type PositionHealth } from '@/services/roster-health';

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
  number?: number;
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

export default function RosterScreen({ embedded = false, seasonSettingsContent }: { embedded?: boolean; seasonSettingsContent?: ReactNode }) {
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
  const [formationConfigured, setFormationConfigured] = useState(true);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [teamChangeVersion, setTeamChangeVersion] = useState(0);
  const [selectedHealth, setSelectedHealth] = useState<PositionHealth | null>(null);
  const [healthDismissed, setHealthDismissed] = useState(false);
  const [helpExpanded, setHelpExpanded] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerNumber, setNewPlayerNumber] = useState('');
  const [editingNumber, setEditingNumber] = useState<string | null>(null);
  const filteredPlayers = useMemo(
    () => (filter === 'all' ? players : players.filter((player) => player.group === filter))
      .slice()
      .sort((first, second) => displayPlayerName(first.name).localeCompare(displayPlayerName(second.name), undefined, { sensitivity: 'base' })),
    [filter, players],
  );
  const health = useMemo(() => positionHealth(formation, players), [formation, players]);

  useEffect(() => subscribeToTeamChanges(() => setTeamChangeVersion((version) => version + 1)), []);

  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setPositionPicker(null);
    setHealthDismissed(false);
    setFormationConfigured(false);
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
        const storedFormation = seasonPayload.formation || '';
        const currentFormation = storedFormation || fallbackFormation;
        setFormationConfigured(Boolean(storedFormation));
        setFormation(currentFormation);
        setPositionRows(storedFormation ? formationPositionRows(currentFormation) : []);
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
    setHealthDismissed(false);
  }

  function updateGroup(name: string, group: Group) {
    const nextPlayers = players.map((player) => player.name === name ? { ...player, group } : player);
    setPlayers(nextPlayers);
    setMessage(null);
    setError(null);
    setHealthDismissed(false);
    void saveRoster(nextPlayers, false);
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
      const changes: Partial<Player> = {
      [positionPicker.group]: positionPicker.group === 'primary_positions' && isGoalkeeperAllowed(player)
        ? [...positions, 'GK']
        : positions,
      };
      if (positionPicker.group === 'general_positions') {
        changes.primary_positions = positionPicker.positions.includes('GK')
          ? [...player.primary_positions.filter((position) => position.toUpperCase() !== 'GK'), 'GK']
          : player.primary_positions.filter((position) => position.toUpperCase() !== 'GK');
      }
      const updatedPlayers = players.map((candidate) => candidate.name === player.name ? { ...candidate, ...changes } : candidate);
      setPlayers(updatedPlayers);
      setHealthDismissed(false);
    setPositionPicker(null);
      void saveRoster(updatedPlayers, false);
  }

    async function saveRoster(playersToSave = players, returnHome = true) {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const activeTeamId = await getActiveTeamId();
        const payload = await updateRoster(activeTeamId, playersToSave);
      setPlayers(payload.players as Player[]);
      setMessage('Season roster saved.');
        if (returnHome) router.replace('/');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save roster.');
    } finally {
      setSaving(false);
    }
  }

  async function addPlayer() {
      const name = newPlayerName.trim();
      if (!name || players.some((player) => player.name.toLowerCase() === name.toLowerCase())) return;
      const parsedNumber = newPlayerNumber === '' ? undefined : Math.max(0, Math.min(99, Number(newPlayerNumber)));
      const nextPlayers = [...players, {
        name,
        number: parsedNumber,
        group: 'rotational' as const,
        general_positions: [ANY_POSITION],
        primary_positions: [ANY_POSITION],
        backup_positions: [],
        excluded_positions: [],
      }];
      setPlayers(nextPlayers);
      setNewPlayerName('');
      setNewPlayerNumber('');
      await saveRoster(nextPlayers, false);
    }

  async function savePlayerNumber(name: string, raw: string) {
      const digits = raw.replace(/\D/g, '').slice(0, 2);
      const parsed = digits === '' ? undefined : Number(digits);
      const nextPlayers = players.map((player) => player.name === name ? { ...player, number: parsed === undefined ? undefined : Math.min(99, parsed) } : player);
      setPlayers(nextPlayers);
      setEditingNumber(null);
      await saveRoster(nextPlayers, false);
  }

  const positionsNeedReview = formationConfigured && !rosterMatchesFormation(formation, players as Player[]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={80} style={styles.keyboardAvoidingView}>
            <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <View style={styles.header}>
              {!embedded && (
                <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityLabel="Go back">
                  <SymbolView
                    name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
                    size={20}
                    tintColor={palette.ink}
                  />
                </Pressable>
              )}
              <View style={[styles.headerCopy, !embedded && styles.headerCopyWithBack]}>
                <Text style={styles.eyebrow}>FALL 2026</Text>
                <Text style={styles.title}>{teamName ? `Player Positions for ${teamName}` : 'Player Positions'}</Text>
              </View>
              <View style={styles.countBadge}>
                <Text style={styles.countValue}>{players.length}</Text>
                <Text style={styles.countLabel}>players</Text>
              </View>
            </View>

            <Pressable style={styles.summaryCard} onPress={() => setHelpExpanded((expanded) => !expanded)} accessibilityRole="button" accessibilityState={{ expanded: helpExpanded }}>
              <View style={styles.summaryIcon}>
                <SymbolView
                  name={{ ios: 'person.3.fill', android: 'group', web: 'group' }}
                  size={22}
                  tintColor={palette.green}
                />
              </View>
              <View style={styles.summaryCopy}>
                <View style={styles.summaryTitleRow}>
                  <Text style={styles.summaryTitle}>{helpExpanded ? 'When assigning player groups and positions remember:' : 'About player groups & positions'}</Text>
                  <Text style={styles.summaryChevron}>{helpExpanded ? '−' : '›'}</Text>
                </View>
                {helpExpanded && <Text style={styles.summaryDetail}>
                  - Player Groups affect overall playing time (Core = more, Rotational = avg, Developing = less){'\n'}
                  - Too many Core/Developing players can have negative affects on scheduling.{ '\n' }
                  - The order that you select specific positions will affect the scheduling logic (first in list = higher priority)
                </Text>}
              </View>
            </Pressable>
            {seasonSettingsContent}
            {positionsNeedReview && (
              <View style={styles.warningCard}>
                <SymbolView name={{ ios: 'exclamationmark.triangle.fill', android: 'warning', web: 'warning' }} size={20} tintColor={palette.coral} />
                <Text style={styles.warningText}>Your formation changed. Update player positions to match the current formation.</Text>
              </View>
            )}
            {!healthDismissed && formationConfigured && (
              <PositionHealthPanel
                health={health}
                onSelect={setSelectedHealth}
                onDismiss={() => setHealthDismissed(true)}
              />
            )}
            {!formationConfigured && (
              <View style={styles.formationBanner}>
                <Text style={styles.formationHint}>Set a formation above to assign exact Primary, Backup, and Excluded positions.</Text>
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

            <View style={styles.addPlayerCard}>
              <TextInput value={newPlayerName} onChangeText={setNewPlayerName} onSubmitEditing={() => void addPlayer()} placeholder="Player name" placeholderTextColor={palette.muted} style={[styles.addInput, styles.addNameInput]} returnKeyType="done" />
              <TextInput value={newPlayerNumber} onChangeText={(value) => setNewPlayerNumber(value.replace(/\D/g, '').slice(0, 2))} placeholder="#" placeholderTextColor={palette.muted} keyboardType="number-pad" style={[styles.addInput, styles.numberInput]} />
              <Pressable onPress={() => void addPlayer()} disabled={!newPlayerName.trim() || saving} style={styles.addButton}><Text style={styles.addButtonText}>Add</Text></Pressable>
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
                    <View style={styles.playerLeft}>
                      <View style={styles.nameLine}>
                        <Text style={styles.playerName} numberOfLines={1}>{displayPlayerName(player.name)}</Text>
                        {editingNumber === player.name ? (
                          <TextInput autoFocus defaultValue={player.number === undefined ? '' : String(player.number)} onEndEditing={(event) => void savePlayerNumber(player.name, event.nativeEvent.text)} keyboardType="number-pad" style={styles.numberEdit} />
                        ) : (
                          <Pressable onPress={() => setEditingNumber(player.name)} accessibilityLabel={`Edit jersey number for ${player.name}`}>
                            <Text style={styles.numberBadge}>{player.number === undefined ? '#' : `#${player.number}`}</Text>
                          </Pressable>
                        )}
                      </View>
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
                    <View style={styles.playerRight}>
                      <View style={styles.groupPicker}>
                        {(Object.keys(groupLabels) as Filter[]).filter((group): group is Group => group !== 'all').map((group) => (
                          <Pressable key={group} onPress={() => updateGroup(player.name, group)} style={[styles.groupOption, player.group === group && { backgroundColor: groupColors[group].background }]}>
                            <Text
                              style={[styles.groupOptionText, player.group === group && { color: groupColors[group].text }]}
                              numberOfLines={1}
                              adjustsFontSizeToFit
                              minimumFontScale={0.8}>
                              {group}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                      <PositionField label="General" value={player.general_positions} onPress={() => openPositionPicker(player, 'general_positions')} />
                      {formationConfigured ? (
                        <>
                          <PositionField label="Primary" value={withoutGoalkeeper(player.primary_positions)} onPress={() => openPositionPicker(player, 'primary_positions')} />
                          <PositionField label="Backup" value={player.backup_positions} onPress={() => openPositionPicker(player, 'backup_positions')} />
                          <PositionField label="Excluded" value={player.excluded_positions} onPress={() => openPositionPicker(player, 'excluded_positions')} />
                        </>
                      ) : null}
                    </View>
                  </View>
                );
              })}
            </View>}
            {message && <Text style={styles.successText}>{message}</Text>}
            {error && <Text style={styles.errorText}>{error}</Text>}
            {!embedded && !loading && (
              <Pressable onPress={() => void saveRoster()} disabled={saving} style={[styles.saveButton, saving && styles.disabledButton]}>
              <Text style={styles.saveText}>{saving ? 'Saving...' : 'Save and return home'}</Text>
              <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={19} tintColor={palette.panel} />
            </Pressable>)}
            </ScrollView>
          </KeyboardAvoidingView>
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
      <PositionHealthModal health={selectedHealth} onClose={() => setSelectedHealth(null)} />
    </>
  );
}

function PositionField({ label, value, onPress }: { label: string; value: string[]; onPress: () => void }) {
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
  const pickerRows = picker.group === 'general_positions' && positionRows.length === 0
    ? ['D', 'M', 'F'].map((group) => ({ label: group, groupPositions: [group], exactPositions: [] }))
    : positionRows;
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
            {pickerRows.map((row) => {
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

const healthColors: Record<PositionHealth['status'], { background: string; border: string; text: string; icon: string }> = {
  red: { background: '#fde4dc', border: '#d96f4c', text: '#8f3928', icon: '🔴' },
  yellow: { background: '#fff1c9', border: '#d7a72b', text: '#795b08', icon: '🟡' },
  green: { background: '#dcebe2', border: '#19634b', text: '#19634b', icon: '🟢' },
};

function PositionHealthPanel({ health, onSelect, onDismiss }: { health: PositionHealth[]; onSelect: (value: PositionHealth) => void; onDismiss: () => void }) {
  return (
    <View style={styles.healthCard}>
      <View style={styles.healthHeader}>
        <View>
          <Text style={styles.healthTitle}>Position coverage</Text>
          <Text style={styles.healthSubtitle}>Primary, general, and backup positions</Text>
        </View>
        <Pressable onPress={onDismiss} accessibilityLabel="Dismiss position coverage">
          <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={17} tintColor={palette.muted} />
        </Pressable>
      </View>
      <View style={styles.healthRows}>
        {health.map((item) => {
          const colors = healthColors[item.status];
          return (
            <Pressable key={item.group} onPress={() => onSelect(item)} style={[styles.healthRow, { backgroundColor: colors.background, borderColor: colors.border }]} accessibilityRole="button">
              <Text style={[styles.healthRowLabel, { color: colors.text }]}>{item.label}</Text>
              <Text style={[styles.healthRowCount, { color: colors.text }]}>{item.eligible.length} players {colors.icon}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function PositionHealthModal({ health, onClose }: { health: PositionHealth | null; onClose: () => void }) {
  if (!health) return null;
  const colors = healthColors[health.status];
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.healthModal}>
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalEyebrow}>POSITION COVERAGE</Text>
              <Text style={styles.modalTitle}>{health.label}</Text>
            </View>
            <Pressable onPress={onClose} accessibilityLabel="Close position coverage details" style={styles.modalCloseButton}>
              <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={19} tintColor={palette.ink} />
            </Pressable>
          </View>
          <Text style={[styles.healthDetailCount, { color: colors.text }]}>{health.eligible.length} players {colors.icon}</Text>
          {(['primary', 'general', 'backup'] as const).map((category) => (
            <View key={category} style={styles.healthDetailGroup}>
              <Text style={styles.healthDetailLabel}>{category === 'primary' ? 'Primary' : category === 'general' ? 'General' : 'Backup'}</Text>
              <Text style={styles.healthDetailNames}>{health[category].join(', ') || 'None'}</Text>
            </View>
          ))}
          <Text style={styles.healthTip}>{positionHealthMessage(health)}</Text>
          <Pressable onPress={onClose} style={styles.finishButton} accessibilityRole="button">
            <Text style={styles.finishButtonText}>DONE</Text>
            <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={19} tintColor={palette.panel} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.paper },
  keyboardAvoidingView: { flex: 1 },
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
  headerCopy: { flex: 1 },
  headerCopyWithBack: { marginLeft: 13 },
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
  summaryTitleRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  summaryTitle: { color: palette.ink, fontSize: 15, fontWeight: '800' },
  summaryChevron: { color: palette.green, fontSize: 24, fontWeight: '700', marginLeft: 8 },
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
  healthCard: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, marginBottom: 18, padding: 13 },
  healthHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  healthTitle: { color: palette.ink, fontSize: 15, fontWeight: '800' },
  healthSubtitle: { color: palette.muted, fontSize: 11, marginTop: 3 },
  healthRows: { gap: 7, marginTop: 12 },
  healthRow: { alignItems: 'center', borderRadius: 10, borderWidth: 1, flexDirection: 'row', justifyContent: 'space-between', minHeight: 40, paddingHorizontal: 11 },
  healthRowLabel: { fontSize: 12, fontWeight: '900', textTransform: 'uppercase' },
  healthRowCount: { fontSize: 12, fontWeight: '800' },
  healthModal: { backgroundColor: palette.paper, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 18, paddingBottom: 24 },
  healthDetailCount: { fontSize: 15, fontWeight: '900', marginTop: 18 },
  healthDetailGroup: { borderBottomColor: palette.line, borderBottomWidth: 1, paddingVertical: 12 },
  healthDetailLabel: { color: palette.coral, fontSize: 11, fontWeight: '900', letterSpacing: 1.1, textTransform: 'uppercase' },
  healthDetailNames: { color: palette.ink, fontSize: 13, lineHeight: 19, marginTop: 4 },
  healthTip: { color: palette.muted, fontSize: 13, lineHeight: 19, marginVertical: 16 },
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
  playerRow: { alignItems: 'stretch', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', gap: 10, minHeight: 75, paddingHorizontal: 13, paddingVertical: 10 },
  lastRow: { borderBottomWidth: 0 },
  playerLeft: { flex: 0.82, minWidth: 0 },
  playerRight: { alignItems: 'flex-start', flex: 1, minWidth: 0 },
  avatarColumn: { alignItems: 'center', width: 72 },
  gkButton: { alignItems: 'center', alignSelf: 'flex-start', borderColor: palette.line, borderRadius: 9, borderWidth: 1, flexDirection: 'row', gap: 4, justifyContent: 'center', marginTop: 6, minHeight: 32, paddingHorizontal: 8, paddingVertical: 6, width: 68 },
  gkButtonSelected: { backgroundColor: palette.coral, borderColor: palette.coral },
  gkButtonText: { color: palette.muted, fontSize: 11, fontWeight: '800' },
  gkButtonTextSelected: { color: palette.panel },
  playerName: { color: palette.ink, flexShrink: 1, fontSize: 15, fontWeight: '800' },
  formationBanner: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 12, borderWidth: 1, marginBottom: 16, padding: 12 },
  formationHint: { color: palette.muted, fontSize: 11, lineHeight: 16, marginTop: 8 },
  nameLine: { alignItems: 'center', flexDirection: 'row', flex: 1 },
  numberBadge: { backgroundColor: palette.greenSoft, borderRadius: 6, color: palette.green, fontSize: 11, fontWeight: '800', marginLeft: 6, paddingHorizontal: 5, paddingVertical: 3 },
  numberEdit: { borderColor: palette.green, borderRadius: 6, borderWidth: 1, color: palette.ink, fontSize: 12, marginLeft: 6, paddingHorizontal: 4, paddingVertical: 2, width: 38 },
  addPlayerCard: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 7, marginBottom: 14, padding: 10 },
  addInput: { backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 8, borderWidth: 1, color: palette.ink, minHeight: 40, paddingHorizontal: 9 },
  addNameInput: { flex: 1 },
  numberInput: { width: 42 },
  addButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 8, justifyContent: 'center', minHeight: 40, paddingHorizontal: 12 },
  addButtonText: { color: palette.panel, fontSize: 12, fontWeight: '800' },
  groupPicker: { flexDirection: 'row', flexWrap: 'nowrap', gap: 6, marginTop: 4, width: '100%' },
  groupOption: { alignItems: 'center', backgroundColor: '#f1eee5', borderRadius: 8, flex: 1, justifyContent: 'center', minHeight: 30, minWidth: 0, paddingHorizontal: 3, paddingVertical: 4 },
  groupOptionText: { color: palette.muted, fontSize: 9, fontWeight: '800', textAlign: 'center', textTransform: 'capitalize' },
  positionField: { alignItems: 'center', flexDirection: 'row', marginTop: 8, width: '100%' },
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