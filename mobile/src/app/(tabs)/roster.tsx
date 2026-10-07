import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import PositionAssignmentScreen from '../position-assignment';
import { GAME_FORMATS, FORMATIONS_BY_FORMAT } from '@/engine/season';
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

export default function RosterTab() {
  const insets = useSafeAreaInsets();
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
      const saved = await updateSeasonSettings(team.id, draft);
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

  return (
    <View style={styles.container}>
      <View style={[styles.bar, { paddingTop: 12 + insets.top }]}>
        <Pressable onPress={openBar} style={styles.barHeader} accessibilityRole="button">
          <View style={styles.barCopy}>
            <Text style={styles.barTitle}>{configured && settings ? `${settings.game_format} · ${settings.formation} · ${settings.total_blocks} blocks` : 'Season setup — tap to finish'}</Text>
            <Text style={styles.barHint}>{expanded ? '' : 'Season settings'}</Text>
          </View>
          <Text style={styles.chevron}>{expanded ? '−' : '+'}</Text>
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
      <PositionAssignmentScreen embedded />
    </View>
  );
}

function SeasonForm({ value, onChange, onCancel, onSave, saving }: { value: SeasonSettings; onChange: (value: SeasonSettings) => void; onCancel: () => void; onSave: () => void; saving: boolean }) {
  const formations = FORMATIONS_BY_FORMAT[value.game_format];
  const update = (changes: Partial<SeasonSettings>) => onChange({ ...value, ...changes });
  return (
    <View style={styles.form}>
      <Text style={styles.label}>Format</Text>
      <View style={styles.options}>{formats.map((format) => <Pressable key={format} onPress={() => update({ game_format: format, formation: GAME_FORMATS[format].default_formation })} style={[styles.option, value.game_format === format && styles.selected]}><Text style={value.game_format === format ? styles.selectedText : styles.optionText}>{format}</Text></Pressable>)}</View>
      <Text style={styles.label}>Formation</Text>
      <View style={styles.options}>{formations.map((formation) => <Pressable key={formation} onPress={() => update({ formation })} style={[styles.option, value.formation === formation && styles.selected]}><Text style={value.formation === formation ? styles.selectedText : styles.optionText}>{formation}</Text></Pressable>)}</View>
      <NumberField label="Games in Season" value={value.total_games} onChange={(total_games) => update({ total_games })} />
      <NumberField label="Game Length (minutes)" value={value.game_length_minutes} onChange={(game_length_minutes) => update({ game_length_minutes })} />
      <NumberField label="Substitution Blocks" value={value.total_blocks} onChange={(total_blocks) => update({ total_blocks })} />
      <Text style={styles.label}>Alert method</Text>
      <View style={styles.options}>{alerts.map((alert) => <Pressable key={alert.value} onPress={() => update({ substitution_alert: alert.value })} style={[styles.option, value.substitution_alert === alert.value && styles.selected]}><Text style={value.substitution_alert === alert.value ? styles.selectedText : styles.optionText}>{alert.label}</Text></Pressable>)}</View>
      <NumberField label="Warning timing (seconds)" value={value.substitution_warning_seconds} onChange={(substitution_warning_seconds) => update({ substitution_warning_seconds: Math.max(15, Math.min(60, substitution_warning_seconds)) as 15 | 30 | 60 })} />
      <View style={styles.actions}><Pressable onPress={onCancel} style={styles.cancel}><Text style={styles.optionText}>Cancel</Text></Pressable><Pressable onPress={onSave} disabled={saving} style={styles.save}><Text style={styles.selectedText}>{saving ? 'Saving...' : 'Save'}</Text></Pressable></View>
    </View>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <View><Text style={styles.label}>{label}</Text><TextInput value={String(value)} onChangeText={(text) => onChange(Number(text.replace(/\D/g, '')) || 0)} keyboardType="number-pad" style={styles.numberInput} /></View>;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  bar: { backgroundColor: palette.panel, borderBottomColor: palette.line, borderBottomWidth: 1, padding: 12 },
  barHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  barCopy: { flex: 1 },
  barTitle: { color: palette.ink, fontSize: 15, fontWeight: '800' },
  barHint: { color: palette.muted, fontSize: 11, marginTop: 3 },
  chevron: { color: palette.green, fontSize: 24, paddingHorizontal: 8 },
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
  actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  cancel: { alignItems: 'center', borderColor: palette.line, borderRadius: 8, borderWidth: 1, flex: 1, padding: 10 },
  save: { alignItems: 'center', backgroundColor: palette.coral, borderRadius: 8, flex: 1, padding: 10 },
});