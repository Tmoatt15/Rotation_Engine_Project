import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { createBackup, restoreBackup, serializeBackup } from '@/services/backup-service';

const palette = { ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1', green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c' };

export default function BackupScreen() {
  const router = useRouter();
  const [backupText, setBackupText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function exportBackup() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const text = serializeBackup(await createBackup());
      await Share.share({ title: 'Rotation Engine backup', message: text });
      setMessage('Backup ready. Save the shared text somewhere outside Expo Go, such as Files, Notes, or email.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to create the backup.');
    } finally {
      setBusy(false);
    }
  }

  function confirmRestore() {
    Alert.alert('Restore backup?', 'This adds the teams in the backup to the teams currently on this device. It does not delete existing teams.', [
      { text: 'CANCEL', style: 'cancel' },
      { text: 'RESTORE', onPress: () => void restore() },
    ]);
  }

  async function restore() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const count = await restoreBackup(backupText);
      setBackupText('');
      setMessage(`${count} team${count === 1 ? '' : 's'} restored. Return to Home or Roster to view the data.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to restore the backup.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.header}>
              <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityLabel="Go back"><Text style={styles.backText}>‹</Text></Pressable>
              <View><Text style={styles.eyebrow}>DATA SAFETY</Text><Text style={styles.title}>Backup & Restore</Text></View>
            </View>
            <View style={styles.infoCard}>
              <Text style={styles.infoTitle}>Protect your roster</Text>
              <Text style={styles.infoText}>Expo Go can lose local data when it is reinstalled. Export a backup after making roster or season changes, then save it outside the app.</Text>
            </View>
            <Pressable onPress={() => void exportBackup()} disabled={busy} style={styles.primaryButton}><Text style={styles.primaryText}>{busy ? 'Working...' : 'Export Backup'}</Text></Pressable>
            <Text style={styles.sectionTitle}>Restore after reinstall</Text>
            <Text style={styles.helper}>Paste the JSON backup text here, then restore it. Existing teams will not be deleted.</Text>
            <TextInput value={backupText} onChangeText={setBackupText} multiline textAlignVertical="top" placeholder="Paste backup JSON here" placeholderTextColor={palette.muted} style={styles.input} />
            <Pressable onPress={confirmRestore} disabled={busy || !backupText.trim()} style={[styles.restoreButton, (!backupText.trim() || busy) && styles.disabled]}><Text style={styles.restoreText}>Restore Backup</Text></Pressable>
            {message && <Text style={styles.success}>{message}</Text>}
            {error && <Text style={styles.error}>{error}</Text>}
          </ScrollView>
        </SafeAreaView>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.paper },
  safeArea: { flex: 1, maxWidth: MaxContentWidth, width: '100%', alignSelf: 'center' },
  content: { paddingBottom: BottomTabInset + 24, paddingHorizontal: 16, paddingTop: 12 },
  header: { alignItems: 'center', flexDirection: 'row', gap: 13, marginBottom: 22 },
  backButton: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 },
  backText: { color: palette.ink, fontSize: 30, lineHeight: 34 },
  eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 },
  title: { color: palette.ink, fontSize: 28, fontWeight: '800', marginTop: 4 },
  infoCard: { backgroundColor: palette.greenSoft, borderRadius: 15, marginBottom: 16, padding: 15 },
  infoTitle: { color: palette.ink, fontSize: 16, fontWeight: '800' },
  infoText: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 5 },
  primaryButton: { alignItems: 'center', backgroundColor: palette.green, borderRadius: 12, minHeight: 50, justifyContent: 'center' },
  primaryText: { color: palette.panel, fontSize: 13, fontWeight: '900', letterSpacing: 0.5 },
  sectionTitle: { color: palette.ink, fontSize: 18, fontWeight: '800', marginTop: 28 },
  helper: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 5 },
  input: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 12, borderWidth: 1, color: palette.ink, fontSize: 12, minHeight: 180, marginTop: 12, padding: 12 },
  restoreButton: { alignItems: 'center', backgroundColor: palette.coral, borderRadius: 12, minHeight: 50, justifyContent: 'center', marginTop: 12 },
  restoreText: { color: palette.panel, fontSize: 13, fontWeight: '900' },
  disabled: { opacity: 0.45 },
  success: { color: palette.green, fontSize: 13, lineHeight: 19, marginTop: 14 },
  error: { color: palette.coral, fontSize: 13, lineHeight: 19, marginTop: 14 },
});
