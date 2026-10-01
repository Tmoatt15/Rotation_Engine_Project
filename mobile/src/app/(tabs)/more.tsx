import { Stack, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth } from '@/constants/theme';

const palette = { ink: '#17221f', muted: '#6b7873', paper: '#f5f1e8', panel: '#fffdf8', line: '#e4ded1', green: '#19634b', greenSoft: '#dcebe2', coral: '#d96f4c' };

const options = [
  { icon: 'calendar', label: 'Season Settings', detail: 'Format, blocks, and formation', route: '/settings' },
  { icon: 'person.3', label: 'Player Positions', detail: 'Assign and Edit Player Positions', route: '/position-assignment' },
  { icon: 'chart.bar', label: 'Position Analytics', detail: 'View position depth information', route: '/coverage' },
  { icon: 'folder', label: 'Saved Teams', detail: 'Edit or delete saved team rosters', route: '/saved-teams' },
  { icon: 'calendar.badge.clock', label: 'Saved Schedules', detail: 'Open saved game schedules', route: '/saved-schedules' },
  { icon: 'doc.text', label: 'After-Game Reports', detail: 'Review completed game reports', route: '/saved-after-game-reports' },
  { icon: 'chart.line.uptrend.xyaxis', label: 'Season Fairness', detail: 'Review season playing-time balance', route: '/season-fairness' },
  { icon: 'chart.bar.xaxis', label: 'Season Totals', detail: 'Review season player totals', route: '/season-totals' },
  { icon: 'plus.circle', label: 'Create New Team', detail: undefined, route: '/team-create' },
] as const;

export default function MoreScreen() {
  const router = useRouter();
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.header}><Text style={styles.eyebrow}>MATCHDAY CONTROL</Text><Text style={styles.title}>More</Text><Text style={styles.subtitle}>Team and season tools</Text></View>
            <View style={styles.menuCard}>
              {options.map((option, index) => <Pressable key={option.route} onPress={() => router.push(option.route)} style={[styles.menuRow, index === options.length - 1 && styles.lastRow]}><View style={styles.icon}><SymbolView name={option.icon} size={21} tintColor={palette.green} /></View><View style={styles.copy}><Text style={styles.label}>{option.label}</Text>{option.detail && <Text style={styles.detail}>{option.detail}</Text>}</View><SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={18} tintColor={palette.muted} /></Pressable>)}
            </View>
          </ScrollView>
        </SafeAreaView>
      </View>
    </>
  );
}

const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: palette.paper }, safeArea: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center' }, content: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: BottomTabInset + 24 }, header: { marginBottom: 22 }, eyebrow: { color: palette.coral, fontSize: 10, fontWeight: '800', letterSpacing: 1.6 }, title: { color: palette.ink, fontSize: 32, fontWeight: '800', marginTop: 5 }, subtitle: { color: palette.muted, fontSize: 13, marginTop: 5 }, menuCard: { backgroundColor: palette.panel, borderColor: palette.line, borderRadius: 17, borderWidth: 1, paddingHorizontal: 15 }, menuRow: { alignItems: 'center', borderBottomColor: palette.line, borderBottomWidth: 1, flexDirection: 'row', gap: 12, minHeight: 72 }, lastRow: { borderBottomWidth: 0 }, icon: { alignItems: 'center', backgroundColor: palette.greenSoft, borderRadius: 12, height: 40, justifyContent: 'center', width: 40 }, copy: { flex: 1 }, label: { color: palette.ink, fontSize: 15, fontWeight: '800' }, detail: { color: palette.muted, fontSize: 12, marginTop: 4 },
});
