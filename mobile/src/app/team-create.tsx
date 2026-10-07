import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import type { GameFormat } from '@/engine/models';
import { GAME_FORMATS } from '@/engine/season';
import { activateTeam, createLocalTeam, notifyTeamChanged } from '@/services/team-service';

const palette = {
  ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1',
  green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c',
};
const formats = Object.keys(GAME_FORMATS) as GameFormat[];

export default function CreateTeamScreen() {
  const router = useRouter();
  const [teamName, setTeamName] = useState('');
  const [gameFormat, setGameFormat] = useState<GameFormat>('11v11');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createTeam(destination: '/roster' | '/') {
    const name = teamName.trim();
    if (!name) return;
    setSaving(true);
    setError(null);
    try {
      const payload = await createLocalTeam(name, [], {
        game_format: gameFormat,
        formation: '',
      });
      await activateTeam(payload.id);
      notifyTeamChanged();
      router.replace(destination);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to create team.');
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
              <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityLabel="Go back">
                <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} />
              </Pressable>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>TEAM SETUP</Text>
                <Text style={styles.title}>Create new team</Text>
              </View>
            </View>
            <View style={styles.infoCard}>
              <SymbolView name={{ ios: 'person.3.fill', android: 'group', web: 'group' }} size={22} tintColor={palette.green} />
              <Text style={styles.infoText}>Choose a name and game format. You can add players on the Roster tab.</Text>
            </View>
            <View style={styles.formCard}>
              <Text style={styles.fieldLabel}>Team Name</Text>
              <TextInput
                value={teamName}
                onChangeText={setTeamName}
                placeholder="e.g. U12 United"
                placeholderTextColor={palette.muted}
                style={styles.input}
                autoFocus
              />
              <Text style={[styles.fieldLabel, styles.formatLabel]}>Format</Text>
              <View style={styles.options}>
                {formats.map((format) => (
                  <Pressable
                    key={format}
                    onPress={() => setGameFormat(format)}
                    style={[styles.option, gameFormat === format && styles.optionSelected]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: gameFormat === format }}>
                    <Text style={[styles.optionText, gameFormat === format && styles.optionTextSelected]}>{format}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            {error && <Text style={styles.errorText}>{error}</Text>}
            <Pressable
              onPress={() => void createTeam('/roster')}
              disabled={saving || !teamName.trim()}
              style={[styles.primaryButton, (saving || !teamName.trim()) && styles.disabledButton]}>
              <Text style={styles.primaryButtonText}>{saving ? 'Creating...' : 'Set up roster'}</Text>
              <SymbolView name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }} size={20} tintColor={palette.panel} />
            </Pressable>
            <Pressable onPress={() => void createTeam('/')} disabled={saving || !teamName.trim()} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Done for now</Text>
            </Pressable>
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
  headerCopy: { marginLeft: 13 },
  eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 },
  title: { color: palette.ink, fontSize: 28, fontWeight: '800', marginTop: 4 },
  infoCard: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 17, flexDirection: 'row', gap: 12, marginBottom: 16, padding: 15 },
  infoText: { color: palette.ink, flex: 1, fontSize: 13, lineHeight: 19 },
  formCard: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, padding: 16 },
  fieldLabel: { color: palette.ink, fontSize: 14, fontWeight: '800' },
  formatLabel: { marginTop: 20 },
  input: { backgroundColor: '#f7f4ed', borderColor: palette.line, borderRadius: 10, borderWidth: 1, color: palette.ink, fontSize: 15, minHeight: 46, marginTop: 7, paddingHorizontal: 11, paddingVertical: 10 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  option: { borderColor: palette.line, borderRadius: 9, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 9 },
  optionSelected: { backgroundColor: palette.green, borderColor: palette.green },
  optionText: { color: palette.muted, fontSize: 12, fontWeight: '800' },
  optionTextSelected: { color: palette.panel },
  primaryButton: { alignItems: 'center', backgroundColor: palette.coral, borderRadius: 16, flexDirection: 'row', gap: 9, justifyContent: 'center', marginTop: 18, minHeight: 54 },
  primaryButtonText: { color: palette.panel, fontSize: 15, fontWeight: '800' },
  secondaryButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 16, borderWidth: 1, marginTop: 10, minHeight: 50, justifyContent: 'center' },
  secondaryButtonText: { color: palette.ink, fontSize: 14, fontWeight: '800' },
  disabledButton: { opacity: 0.55 },
  errorText: { color: palette.coral, fontSize: 12, lineHeight: 18, marginTop: 14 },
});
