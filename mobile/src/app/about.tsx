import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState, type ReactNode } from 'react';
import { Alert, InteractionManager, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';
import { copyDiagnosticSnapshot, getDefaultDiagnosticFilename, shareDiagnosticSnapshot } from '@/services/diagnostic-service';
import { buildHash } from '@/buildInfo';

const palette = { ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1', green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c' };

const targets = [
  { label: 'Core 70–80%', detail: 'Your more experienced players. They start and finish games.' },
  { label: 'Rotational 50–60%', detail: 'Regular contributors who rotate through the lineup.' },
  { label: 'Developing 40–50%', detail: 'Newer players getting meaningful game time as they grow.' },
];

export default function AboutScreen() {
  const router = useRouter();
  const [sharing, setSharing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [filename, setFilename] = useState('');
  const [nameDialogVisible, setNameDialogVisible] = useState(false);

  async function openExportDialog() {
    setMessage(null);
    try {
      setFilename(await getDefaultDiagnosticFilename());
      setNameDialogVisible(true);
    } catch {
      setMessage('Unable to prepare diagnostic snapshot.');
    }
  }

  async function exportDiagnostics() {
    setNameDialogVisible(false);
    setSharing(true);
    setMessage(null);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          settled = true;
          reject(new Error('Diagnostic export timed out after 10 seconds.'));
        }, 10000);
        InteractionManager.runAfterInteractions(() => {
          if (settled) return;
          void shareDiagnosticSnapshot(filename).then(
            () => {
              if (!settled) {
                settled = true;
                clearTimeout(timeout);
                resolve();
              }
            },
            (error: unknown) => {
              if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(error);
              }
            },
          );
        });
      });
      setMessage('Diagnostic snapshot is ready to share.');
    } catch (exportError) {
      const detail = exportError instanceof Error ? exportError.message : 'Unknown export error.';
      console.error('[diagnostic] Export failed:', exportError);
      setMessage('Unable to create diagnostic snapshot.');
      Alert.alert('Diagnostic export failed', detail);
    } finally {
      setSharing(false);
    }
  }

  async function copyDiagnostics() {
    setMessage(null);
    try {
      await copyDiagnosticSnapshot();
      setMessage('Diagnostic JSON copied. Paste it into Notes or a message.');
    } catch (copyError) {
      const detail = copyError instanceof Error ? copyError.message : 'Unknown clipboard error.';
      console.error('[diagnostic] Clipboard copy failed:', copyError);
      Alert.alert('Copy failed', detail);
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.header}>
              <Pressable onPress={() => router.back()} style={styles.backButton} accessibilityLabel="Go back">
                <SymbolView name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={palette.ink} />
              </Pressable>
              <View>
                <Text style={styles.eyebrow}>MATCHDAY CONTROL</Text>
                <Text style={styles.title}>About</Text>
              </View>
            </View>

            <Section title="Playing time targets">
              {targets.map((target) => (
                <View key={target.label} style={styles.targetRow}>
                  <Text style={styles.targetLabel}>{target.label}</Text>
                  <Text style={styles.detail}>{target.detail}</Text>
                </View>
              ))}
            </Section>

            <Section title="About">
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Build:</Text>
                <Text style={styles.detail}>{buildHash}</Text>
              </View>
            </Section>

            <Section title="Diagnostics">
              <Text style={styles.detail}>Share a snapshot when you need help reviewing a schedule or game.</Text>
              <Pressable onPress={() => void openExportDialog()} disabled={sharing} style={[styles.shareButton, sharing && styles.disabledButton]}>
                <Text style={styles.shareText}>{sharing ? 'Preparing...' : 'Share diagnostic snapshot'}</Text>
                <SymbolView name={{ ios: 'square.and.arrow.up', android: 'share', web: 'share' }} size={18} tintColor={palette.panel} />
              </Pressable>
              <Pressable onPress={() => void copyDiagnostics()} disabled={sharing} style={styles.copyButton}>
                <Text style={styles.copyText}>Copy diagnostic JSON</Text>
              </Pressable>
              {message && <Text style={styles.message}>{message}</Text>}
            </Section>
          </ScrollView>
        </SafeAreaView>
      </View>
      <Modal visible={nameDialogVisible} transparent animationType="fade" onRequestClose={() => setNameDialogVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.nameDialog}>
            <Text style={styles.dialogTitle}>Name your backup file</Text>
            <TextInput
              value={filename}
              onChangeText={setFilename}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.filenameInput}
              accessibilityLabel="Backup filename"
            />
            <View style={styles.dialogActions}>
              <Pressable onPress={() => setNameDialogVisible(false)} style={styles.cancelButton}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable onPress={() => void exportDiagnostics()} disabled={!filename.trim() || sharing} style={[styles.saveButton, (!filename.trim() || sharing) && styles.disabledButton]}>
                <Text style={styles.saveText}>Save & Share</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.paper },
  safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' },
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: BottomTabInset + 24 },
  header: { alignItems: 'center', flexDirection: 'row', gap: 13, marginBottom: 24 },
  backButton: { alignItems: 'center', backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 14, borderWidth: 1, height: 42, justifyContent: 'center', width: 42 },
  eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 },
  title: { color: palette.ink, fontSize: 30, fontWeight: '800', marginTop: 4 },
  section: { marginBottom: 20 },
  sectionTitle: { color: palette.ink, fontSize: 18, fontWeight: '800', marginBottom: 9 },
  card: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 16, borderWidth: 1, padding: 15 },
  targetRow: { borderBottomColor: palette.line, borderBottomWidth: 1, paddingVertical: 11 },
  targetLabel: { color: palette.green, fontSize: 14, fontWeight: '800' },
  detail: { color: palette.muted, fontSize: 13, lineHeight: 19, marginTop: 4 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between' },
  infoLabel: { color: palette.ink, fontSize: 14, fontWeight: '800' },
  shareButton: { alignItems: 'center', backgroundColor: palette.coral, borderRadius: 12, flexDirection: 'row', gap: 8, justifyContent: 'center', marginTop: 14, minHeight: 48, paddingHorizontal: 12 },
  shareText: { color: palette.panel, fontSize: 13, fontWeight: '800' },
  copyButton: { alignItems: 'center', borderColor: palette.line, borderRadius: 12, borderWidth: 1, justifyContent: 'center', marginTop: 10, minHeight: 44, paddingHorizontal: 12 },
  copyText: { color: palette.green, fontSize: 13, fontWeight: '800' },
  message: { color: palette.green, fontSize: 12, marginTop: 10 },
  disabledButton: { opacity: 0.55 },
  modalBackdrop: { alignItems: 'center', backgroundColor: 'rgba(23, 34, 31, 0.45)', flex: 1, justifyContent: 'center', padding: 20 },
  nameDialog: { backgroundColor: palette.panel, borderRadius: 16, padding: 20, width: '100%' },
  dialogTitle: { color: palette.ink, fontSize: 18, fontWeight: '800', marginBottom: 14 },
  filenameInput: { borderColor: palette.line, borderRadius: 10, borderWidth: 1, color: palette.ink, minHeight: 46, paddingHorizontal: 12 },
  dialogActions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', marginTop: 16 },
  cancelButton: { alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingHorizontal: 12 },
  cancelText: { color: palette.muted, fontSize: 13, fontWeight: '700' },
  saveButton: { alignItems: 'center', backgroundColor: palette.coral, borderRadius: 10, justifyContent: 'center', minHeight: 44, paddingHorizontal: 14 },
  saveText: { color: palette.panel, fontSize: 13, fontWeight: '800' },
});
