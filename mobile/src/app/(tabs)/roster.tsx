import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';

import PositionAssignmentScreen from '../position-assignment';
import { blockDurationSummary, calculateBlockDurations, GAME_FORMATS, MAX_GAME_LENGTH_MINUTES, MAX_TOTAL_BLOCKS, MIN_GAME_LENGTH_MINUTES, MIN_TOTAL_BLOCKS, nearestValidBlockCount, validBlockCounts, FORMATIONS_BY_FORMAT } from '@/engine/season';
import type { GameFormat, SeasonSettings, SubstitutionAlert } from '@/engine/models';
import { formationPositionRows } from '@/position-validation';
import { getActiveTeam, getRoster, getSeasonSettings, notifyTeamChanged, updateRoster, updateSeasonSettings } from '@/services/team-service';

const palette = { ink: '#17221f', muted: '#6b7873', panel: '#fffdf8', line: '#e4ded1', green: '#19634b', coral: '#d96f4c' };
const formats = Object.keys(GAME_FORMATS) as GameFormat[];
const alerts: Array<{ value: SubstitutionAlert; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'flash', label: 'Flash' },
  { value: 'vibrate', label: 'Vibrate' },
  { value: 'flash_and_vibrate', label: 'Flash + Vibrate' },
];
const blockStep = (gameLength: number, blocks: number, direction: -1 | 1): number => {
  const counts = validBlockCounts(gameLength);
  const index = counts.indexOf(blocks);
  return counts[Math.max(0, Math.min(counts.length - 1, (index < 0 ? counts.indexOf(nearestValidBlockCount(gameLength, blocks)) : index) + direction))] ?? blocks;
};

function withBlockSettings(value: SeasonSettings, gameLength: number, requestedBlocks: number): SeasonSettings {
  const normalizedLength = Math.max(MIN_GAME_LENGTH_MINUTES, Math.min(MAX_GAME_LENGTH_MINUTES, Math.round(gameLength)));
  const total_blocks = nearestValidBlockCount(normalizedLength, requestedBlocks);
  const block_durations = calculateBlockDurations(normalizedLength, total_blocks);
  return { ...value, game_length_minutes: normalizedLength, total_blocks, block_length_minutes: block_durations[0], block_durations, block_seconds: block_durations.map((minutes) => minutes * 60), base_block_seconds: block_durations[0] * 60 };
}

export default function RosterTab() {
  const [settings, setSettings] = useState<SeasonSettings | null>(null);
  const [draft, setDraft] = useState<SeasonSettings | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [saving, setSaving] = useState(false);

  useFocusEffect(useCallback(() => {
    let active = true;
    getActiveTeam().then(async (team) => {
      const [season] = await Promise.all([getSeasonSettings(team.id), getRoster(team.id)]);
      if (!active) return;
      setSettings(season);
      setDraft(season);
      setConfigured(Boolean(season.formation));
    }).catch(() => undefined);
    return () => { active = false; };
  }, []));

  function openBar() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (configured) setEditing(false);
    else setEditing(true);
  }

  async function save() {
    if (!draft?.game_format || !draft.formation) return;
    setSaving(true);
    try {
      const team = await getActiveTeam();
      const roster = await getRoster(team.id);
      const nextPositions = new Set(formationPositionRows(draft.formation).flatMap((row) => row.exactPositions));
      const changedFormation = settings?.formation !== draft.formation;
      const unmappablePlayers: string[] = [];
      const remapped = roster.players.map((player) => {
        const primary = player.primary_positions.filter((position) => position === 'ANY' || nextPositions.has(position));
        const backup = player.backup_positions.filter((position) => nextPositions.has(position));
        if (changedFormation && (player.primary_positions.length || player.backup_positions.length) && !primary.length && !backup.length) {
          unmappablePlayers.push(player.name);
        }
        return { ...player, primary_positions: primary, backup_positions: backup };
      });
      await updateRoster(team.id, remapped);
      const saved = await updateSeasonSettings(team.id, withBlockSettings(draft, draft.game_length_minutes, draft.total_blocks));
      notifyTeamChanged();
      if (unmappablePlayers.length) {
        const names = unmappablePlayers.length === 1
          ? unmappablePlayers[0]
          : `${unmappablePlayers.slice(0, -1).join(', ')}, and ${unmappablePlayers[unmappablePlayers.length - 1]}`;
        Alert.alert('Check player positions', `We couldn't find a clean spot for ${names} in the new formation — please check their positions.`);
      }
      setSettings(saved);
      setDraft(saved);
      setConfigured(true);
      setEditing(false);
      setExpanded(false);
    } finally {
      setSaving(false);
    }
  }

  function renderSeasonSettings() {
    return (
      <View style={[styles.bar, !configured && styles.barAttention]}>
        <Pressable onPress={openBar} style={[styles.barHeader, !configured && styles.barHeaderAttention]} accessibilityRole="button">
          <View style={styles.setupIcon}>
            <SymbolView name={{ ios: 'exclamationmark.triangle.fill', android: 'warning', web: 'warning' }} size={18} tintColor={palette.coral} />
          </View>
          <View style={styles.barCopy}>
            <Text style={styles.barTitle}>{configured && settings ? `${settings.game_format} · ${settings.formation} · ${settings.total_blocks} blocks` : 'Season Setup Required'}</Text>
            <Text style={styles.barHint}>{expanded ? '' : 'Season settings'}</Text>
          </View>
          <View style={styles.setupButton}><Text style={styles.setupButtonText}>{expanded ? 'Close' : configured ? 'Edit' : 'Configure'}</Text></View>
        </Pressable>
        {expanded && settings && (editing ? (
          <SeasonForm value={draft ?? settings} onChange={setDraft} onCancel={() => { setEditing(false); setExpanded(false); }} onSave={() => void save()} saving={saving} />
        ) : (
          <View style={styles.readOnly}>
            <Text style={styles.detail}>Format: {settings.game_format}</Text>
            <Text style={styles.detail}>Formation: {settings.formation}</Text>
            <Text style={styles.detail}>Games: {settings.total_games} · {settings.game_length_minutes} minutes · {settings.total_blocks} blocks</Text>
            <Pressable onPress={() => setEditing(true)} style={styles.editButton}><Text style={styles.editText}>EDIT</Text></Pressable>
          </View>
        ))}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <PositionAssignmentScreen embedded seasonSettingsContent={renderSeasonSettings()} />
    </View>
  );
}

function SeasonForm({ value, onChange, onCancel, onSave, saving }: { value: SeasonSettings; onChange: (value: SeasonSettings) => void; onCancel: () => void; onSave: () => void; saving: boolean }) {
  const formations = FORMATIONS_BY_FORMAT[value.game_format];
  const update = (changes: Partial<SeasonSettings>) => onChange({ ...value, ...changes });
  const durations = calculateBlockDurations(value.game_length_minutes, value.total_blocks);
  const setGameLength = (gameLength: number) => onChange(withBlockSettings(value, gameLength, value.total_blocks));
  const setBlocks = (totalBlocks: number) => onChange(withBlockSettings(value, value.game_length_minutes, totalBlocks));
  const setMinutesPerBlock = (minutes: number) => setBlocks(nearestValidBlockCount(value.game_length_minutes, Math.round(value.game_length_minutes / Math.max(1, minutes))));
  return (
    <View style={styles.form}>
      <Text style={styles.label}>Format</Text>
      <View style={styles.options}>{formats.map((format) => <Pressable key={format} onPress={() => update({ game_format: format, formation: GAME_FORMATS[format].default_formation })} style={[styles.option, value.game_format === format && styles.selected]}><Text style={value.game_format === format ? styles.selectedText : styles.optionText}>{format}</Text></Pressable>)}</View>
      <Text style={styles.label}>Formation</Text>
      <View style={styles.options}>{formations.map((formation) => <Pressable key={formation} onPress={() => update({ formation })} style={[styles.option, value.formation === formation && styles.selected]}><Text style={value.formation === formation ? styles.selectedText : styles.optionText}>{formation}</Text></Pressable>)}</View>
      <NumberField label="Games in Season" value={value.total_games} onChange={(total_games) => update({ total_games })} />
      <NumberField label="Game Length (minutes)" value={value.game_length_minutes} onChange={setGameLength} min={MIN_GAME_LENGTH_MINUTES} max={MAX_GAME_LENGTH_MINUTES} />
      <Stepper label="Blocks" value={value.total_blocks} canDecrease={value.total_blocks > MIN_TOTAL_BLOCKS} canIncrease={value.total_blocks < Math.min(MAX_TOTAL_BLOCKS, Math.max(...validBlockCounts(value.game_length_minutes)))} onDecrease={() => setBlocks(blockStep(value.game_length_minutes, value.total_blocks, -1))} onIncrease={() => setBlocks(blockStep(value.game_length_minutes, value.total_blocks, 1))} />
      <Stepper label="Min / block" value={value.block_length_minutes} canDecrease={value.block_length_minutes > 1} canIncrease={value.block_length_minutes < Math.floor(value.game_length_minutes / MIN_TOTAL_BLOCKS)} onDecrease={() => setMinutesPerBlock(value.block_length_minutes - 1)} onIncrease={() => setMinutesPerBlock(value.block_length_minutes + 1)} />
      <Text style={styles.durationSummary}>{blockDurationSummary(durations)}</Text>
      <BlockDurationBar durations={durations} />
      <Text style={styles.label}>Alert method</Text>
      <View style={styles.options}>{alerts.map((alert) => <Pressable key={alert.value} onPress={() => update({ substitution_alert: alert.value })} style={[styles.option, value.substitution_alert === alert.value && styles.selected]}><Text style={value.substitution_alert === alert.value ? styles.selectedText : styles.optionText}>{alert.label}</Text></Pressable>)}</View>
      <NumberField label="Warning timing (seconds)" value={value.substitution_warning_seconds} onChange={(substitution_warning_seconds) => update({ substitution_warning_seconds: Math.max(15, Math.min(60, substitution_warning_seconds)) as 15 | 30 | 60 })} />
      <View style={styles.actions}><Pressable onPress={onCancel} style={styles.cancel}><Text style={styles.optionText}>Cancel</Text></Pressable><Pressable onPress={onSave} disabled={saving} style={styles.save}><Text style={styles.selectedText}>{saving ? 'Saving...' : 'Save'}</Text></Pressable></View>
    </View>
  );
}

function NumberField({ label, value, onChange, min, max }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number }) {
  return <View><Text style={styles.label}>{label}</Text><TextInput value={String(value)} onChangeText={(text) => { const parsed = Number(text.replace(/\D/g, '')); onChange(Math.max(min ?? 0, Math.min(max ?? Number.MAX_SAFE_INTEGER, parsed || 0))); }} keyboardType="number-pad" style={styles.numberInput} /></View>;
}

function Stepper({ label, value, onDecrease, onIncrease, canDecrease, canIncrease }: { label: string; value: number; onDecrease: () => void; onIncrease: () => void; canDecrease: boolean; canIncrease: boolean }) {
  return <View><Text style={styles.label}>{label}</Text><View style={styles.stepper}><Pressable disabled={!canDecrease} onPress={onDecrease} style={[styles.stepperButton, !canDecrease && styles.disabled]}><Text style={styles.stepperButtonText}>−</Text></Pressable><Text style={styles.stepperValue}>{value}</Text><Pressable disabled={!canIncrease} onPress={onIncrease} style={[styles.stepperButton, !canIncrease && styles.disabled]}><Text style={styles.stepperButtonText}>+</Text></Pressable></View></View>;
}

function BlockDurationBar({ durations }: { durations: number[] }) {
  const minimum = Math.min(...durations);
  return <View style={styles.durationBar}>{durations.map((duration, index) => <View key={`${index + 1}-${duration}`} style={[styles.durationSegment, { flex: duration }, duration > minimum && styles.durationSegmentBonus]}><Text style={styles.durationSegmentText}>{duration}</Text></View>)}</View>;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  bar: { backgroundColor: palette.panel, borderBottomColor: palette.line, borderBottomWidth: 1, padding: 10 },
  barAttention: { backgroundColor: '#fff1e9', borderColor: palette.coral, borderRadius: 12, borderWidth: 1, margin: 8 },
  barHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  barHeaderAttention: { paddingVertical: 2 },
  setupIcon: { alignItems: 'center', backgroundColor: '#ffe0d4', borderRadius: 9, height: 34, justifyContent: 'center', marginRight: 9, width: 34 },
  barCopy: { flex: 1 },
  barTitle: { color: palette.ink, fontSize: 15, fontWeight: '800' },
  barHint: { color: palette.muted, fontSize: 11, marginTop: 3 },
  chevron: { color: palette.green, fontSize: 24, paddingHorizontal: 8 },
  setupButton: { backgroundColor: palette.coral, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7 },
  setupButtonText: { color: palette.panel, fontSize: 11, fontWeight: '900' },
  readOnly: { paddingTop: 10 },
  detail: { color: palette.muted, fontSize: 12, marginTop: 4 },
  editButton: { alignSelf: 'flex-start', backgroundColor: palette.green, borderRadius: 8, marginTop: 10, paddingHorizontal: 12, paddingVertical: 7 },
  editText: { color: palette.panel, fontSize: 11, fontWeight: '800' },
  form: { paddingTop: 12 },
  label: { color: palette.ink, fontSize: 12, fontWeight: '800', marginTop: 10 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  option: { borderColor: palette.line, borderRadius: 7, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 7 },
  selected: { backgroundColor: palette.green, borderColor: palette.green },
  optionText: { color: palette.muted, fontSize: 11, fontWeight: '700' },
  selectedText: { color: palette.panel, fontSize: 11, fontWeight: '800' },
  numberInput: { borderColor: palette.line, borderRadius: 7, borderWidth: 1, color: palette.ink, marginTop: 5, padding: 8 },
  stepper: { alignItems: 'center', flexDirection: 'row', gap: 12, marginTop: 5 },
  stepperButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 7, height: 34, justifyContent: 'center', width: 42 },
  stepperButtonText: { color: palette.panel, fontSize: 22, fontWeight: '800' },
  stepperValue: { color: palette.ink, fontSize: 18, fontWeight: '800', minWidth: 40, textAlign: 'center' },
  disabled: { opacity: 0.35 },
  durationSummary: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 10 },
  durationBar: { flexDirection: 'row', gap: 2, height: 38, marginTop: 8 },
  durationSegment: { alignItems: 'center', backgroundColor: palette.line, justifyContent: 'center', minWidth: 12 },
  durationSegmentBonus: { backgroundColor: palette.coral },
  durationSegmentText: { color: palette.ink, fontSize: 10, fontWeight: '800' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  cancel: { alignItems: 'center', borderColor: palette.line, borderRadius: 8, borderWidth: 1, flex: 1, padding: 10 },
  save: { alignItems: 'center', backgroundColor: palette.coral, borderRadius: 8, flex: 1, padding: 10 },
});