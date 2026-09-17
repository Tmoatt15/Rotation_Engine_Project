import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { getActiveTeam, getActiveTeamId, teamQuery } from '@/team-api';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000';
const palette = {
  ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1',
  green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c',
};
const formats = ['4v4', '5v5', '7v7', '9v9', '11v11'];
const defaultFormations: Record<string, string> = {
  '4v4': '1-2-1', '5v5': '1-2-1', '7v7': '2-3-1', '9v9': '3-3-2', '11v11': '4-4-2',
};

type Settings = {
  game_length_minutes: string;
  game_format: string;
  total_blocks: string;
  formation: string;
  total_games: string;
  substitution_alert: 'none' | 'flash' | 'vibrate' | 'flash_and_vibrate';
  substitution_warning_seconds: string;
};

const fallbackFormationOptions: Record<string, string[]> = {
  '4v4': ['1-2-1', '2-0-2'],
  '5v5': ['1-2-1', '2-0-2', '2-1-1'],
  '7v7': ['2-3-1', '3-2-1', '2-1-2-1'],
  '9v9': ['3-3-2', '3-4-1', '4-3-1'],
  '11v11': ['4-3-3', '4-4-2', '4-2-3-1', '3-4-3'],
};

const initialSettings: Settings = {
  game_length_minutes: '', game_format: '11v11', total_blocks: '', formation: '', total_games: '',
  substitution_alert: 'flash_and_vibrate', substitution_warning_seconds: '30',
};

const alertOptions: Array<{ value: Settings['substitution_alert']; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'flash', label: 'Flash' },
  { value: 'vibrate', label: 'Vibrate' },
  { value: 'flash_and_vibrate', label: 'Flash + Vibrate' },
];

export default function SettingsScreen() {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formationOptions, setFormationOptions] = useState<Record<string, string[]>>(fallbackFormationOptions);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useFocusEffect(useCallback(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setMessage(null);

    async function loadSettings() {
      try {
        const activeTeam = await getActiveTeam();
        const response = await fetch(`${API_URL}/season?${teamQuery(activeTeam.id)}`);
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.detail ?? 'Unable to load season settings.');
        if (!active) return;
        setTeamId(activeTeam.id);
        setTeamName(activeTeam.name);
        setEditing(false);
        setSettings({
          game_length_minutes: String(payload.game_length_minutes),
          game_format: payload.game_format,
          total_blocks: String(payload.total_blocks),
          formation: payload.formation,
          total_games: String(payload.total_games),
          substitution_alert: payload.substitution_alert ?? 'flash_and_vibrate',
          substitution_warning_seconds: String(payload.substitution_warning_seconds ?? 30),
        });
        if (payload.formation_options) {
          setFormationOptions(Object.fromEntries(
            Object.entries(fallbackFormationOptions).map(([format, fallbackOptions]) => [
              format,
              [...new Set([...(payload.formation_options[format] ?? []), ...fallbackOptions])],
            ]),
          ));
        }
      } catch (requestError) {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Unable to load settings.');
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadSettings();
    return () => {
      active = false;
    };
  }, []));

  function update(field: keyof Settings, value: string) {
    setSettings((current) => ({ ...current, [field]: value }));
    setMessage(null);
    setError(null);
  }

  async function saveSettings() {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const activeTeamId = await getActiveTeamId();
      const response = await fetch(`${API_URL}/season?${teamQuery(activeTeamId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          game_length_minutes: Number(settings.game_length_minutes),
          game_format: settings.game_format,
          total_blocks: Number(settings.total_blocks),
          formation: settings.formation,
          total_games: Number(settings.total_games),
          substitution_alert: settings.substitution_alert,
          substitution_warning_seconds: Number(settings.substitution_warning_seconds),
          team_id: activeTeamId,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail ?? 'Unable to save season settings.');
      setEditing(false);
      setMessage('Season settings saved.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to save settings.');
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
              <Pressable onPress={() => router.navigate('/' as never)} style={styles.backButton} accessibilityLabel="Go home">
                <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} />
              </Pressable>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>FALL 2026</Text>
                <Text style={styles.title}>{teamName ? `${teamName} Season Settings` : 'Season Settings'}</Text>
              </View>
            </View>

            {loading ? <Text style={styles.helperText}>Loading season settings...</Text> : (
              <>
                {!editing && (
                  <View style={styles.summaryCard}>
                    <Text style={styles.summaryEyebrow}>CURRENT SETTINGS</Text>
                    <View style={styles.summaryDetails}>
                      <SummaryLine label="Format" value={settings.game_format} />
                      <SummaryLine label="Formation" value={settings.formation} />
                      <SummaryLine label="Games in Season" value={settings.total_games} />
                      <SummaryLine label="Game Length" value={`${settings.game_length_minutes} minutes`} />
                      <SummaryLine label="Number of Substitutions Blocks" value={`${settings.total_blocks} per game`} />
                      <SummaryLine label="Substitution Alert" value={alertOptions.find((option) => option.value === settings.substitution_alert)?.label ?? 'Flash + Vibrate'} />
                      <SummaryLine label="Warning Lead" value={`${settings.substitution_warning_seconds} seconds`} />
                    </View>
                    <Pressable onPress={() => setEditing(true)} style={styles.editButton} accessibilityRole="button">
                      <Text style={styles.editButtonText}>EDIT</Text>
                    </Pressable>
                  </View>
                )}

                {editing && (
                  <>
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Games in Season</Text>
                  <Field value={settings.total_games} onChangeText={(value) => update('total_games', value)} />
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Game minutes</Text>
                  <Field value={settings.game_length_minutes} onChangeText={(value) => update('game_length_minutes', value)} />
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Game format</Text>
                  <View style={styles.formatRow}>
                    {formats.map((format) => (
                      <Pressable
                        key={format}
                        onPress={() => {
                          update('game_format', format);
                          update('formation', formationOptions[format]?.[0] ?? defaultFormations[format]);
                        }}
                        style={[styles.formatButton, settings.game_format === format && styles.formatButtonSelected]}>
                        <Text style={[styles.formatText, settings.game_format === format && styles.formatTextSelected]}>{format}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Formation</Text>
                  <View style={styles.formatRow}>
                    {(formationOptions[settings.game_format] ?? []).map((formation) => (
                      <Pressable
                        key={formation}
                        onPress={() => update('formation', formation)}
                        style={[styles.formatButton, settings.formation === formation && styles.formatButtonSelected]}>
                        <Text style={[styles.formatText, settings.formation === formation && styles.formatTextSelected]}>{formation}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Desired Number of Substitution Blocks (including both half starting lineups)</Text>
                  <Field value={settings.total_blocks} onChangeText={(value) => update('total_blocks', value)} />
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Substitution alert</Text>
                  <View style={styles.formatRow}>
                    {alertOptions.map((option) => (
                      <Pressable
                        key={option.value}
                        onPress={() => update('substitution_alert', option.value)}
                        style={[styles.formatButton, settings.substitution_alert === option.value && styles.formatButtonSelected]}>
                        <Text style={[styles.formatText, settings.substitution_alert === option.value && styles.formatTextSelected]}>{option.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>

                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Warn before substitution</Text>
                  <View style={styles.formatRow}>
                    {['15', '30', '60'].map((seconds) => (
                      <Pressable
                        key={seconds}
                        onPress={() => update('substitution_warning_seconds', seconds)}
                        style={[styles.formatButton, settings.substitution_warning_seconds === seconds && styles.formatButtonSelected]}>
                        <Text style={[styles.formatText, settings.substitution_warning_seconds === seconds && styles.formatTextSelected]}>{seconds} seconds</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>

                <Pressable onPress={saveSettings} disabled={saving} style={[styles.saveButton, saving && styles.disabledButton]}>
                  <Text style={styles.saveText}>{saving ? 'Saving...' : 'Save season settings'}</Text>
                  <SymbolView name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={19} tintColor={palette.panel} />
                </Pressable>
                {message && <Text style={styles.successText}>{message}</Text>}
                {error && <Text style={styles.errorText}>{error}</Text>}
                  </>
                )}
              </>
            )}
          </ScrollView>
        </SafeAreaView>
      </View>
    </>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryLine}>
      <Text style={styles.summaryLineLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.summaryLineValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function Field({ value, onChangeText, autoCapitalize = 'none' }: { value: string; onChangeText: (value: string) => void; autoCapitalize?: 'none' | 'characters' }) {
  return (
    <View style={styles.field}>
      <TextInput value={value} onChangeText={onChangeText} keyboardType={autoCapitalize === 'none' ? 'numeric' : 'default'} autoCapitalize={autoCapitalize} style={styles.input} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.paper }, safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' }, content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: BottomTabInset + 24 },
  header: { alignItems: 'center', flexDirection: 'row', marginBottom: 26 }, backButton: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 }, headerCopy: { marginLeft: 13 }, eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 }, title: { color: palette.ink, fontSize: 28, fontWeight: '800', marginTop: 4 },
  section: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, marginBottom: 16, padding: 16 }, sectionTitle: { color: palette.ink, fontSize: 17, fontWeight: '800' }, helperText: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 5 }, formatRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 15 }, formatButton: { borderColor: palette.line, borderRadius: 16, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 9 }, formatButtonSelected: { backgroundColor: palette.green, borderColor: palette.green }, formatText: { color: palette.muted, fontSize: 12, fontWeight: '800' }, formatTextSelected: { color: palette.panel },
  summaryCard: { backgroundColor: palette.greenSoft, borderRadius: 17, marginBottom: 16, padding: 17 }, summaryDetails: { width: '100%' }, summaryEyebrow: { color: palette.green, fontSize: 10, fontWeight: '800', letterSpacing: 1.4, marginBottom: 7 }, summaryLine: { flexDirection: 'row', marginBottom: 5, width: '100%' }, summaryLineLabel: { color: palette.muted, flexShrink: 0, fontSize: 12, fontWeight: '700', width: 205 }, summaryLineValue: { color: palette.ink, flex: 1, fontSize: 12, fontWeight: '800' }, editButton: { alignSelf: 'flex-start', backgroundColor: palette.coral, borderRadius: 10, marginTop: 10, paddingHorizontal: 14, paddingVertical: 9 }, editButtonText: { color: palette.panel, fontSize: 12, fontWeight: '900', letterSpacing: 0.8 },
  fieldRow: { flexDirection: 'row', gap: 10, marginTop: 14 }, field: { flex: 1 }, fieldLabel: { color: palette.muted, fontSize: 11, fontWeight: '700', marginBottom: 6 }, input: { backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 10, borderWidth: 1, color: palette.ink, fontSize: 15, fontWeight: '700', minHeight: 44, paddingHorizontal: 11 }, saveButton: { alignItems: 'center', backgroundColor: palette.coral, borderRadius: 16, flexDirection: 'row', justifyContent: 'center', gap: 9, minHeight: 54 }, disabledButton: { opacity: 0.55 }, saveText: { color: palette.panel, fontSize: 15, fontWeight: '800' }, successText: { color: palette.green, fontSize: 13, fontWeight: '700', marginTop: 14, textAlign: 'center' }, errorText: { color: palette.coral, fontSize: 12, lineHeight: 18, marginTop: 14 },
});