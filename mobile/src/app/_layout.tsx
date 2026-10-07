import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="about" options={{ headerShown: false }} />
        <Stack.Screen name="team-create" options={{ headerShown: false }} />
        <Stack.Screen name="saved-teams" options={{ headerShown: false }} />
        <Stack.Screen name="team-edit" options={{ headerShown: false }} />
        <Stack.Screen name="position-assignment" options={{ headerShown: false }} />
        <Stack.Screen name="coverage" options={{ headerShown: false }} />
        <Stack.Screen name="schedule" options={{ headerShown: false }} />
        <Stack.Screen name="saved-schedules" options={{ headerShown: false }} />
        <Stack.Screen name="after-game" options={{ headerShown: false }} />
        <Stack.Screen name="after-game-report" options={{ headerShown: false }} />
        <Stack.Screen name="saved-after-game-reports" options={{ headerShown: false }} />
        <Stack.Screen name="season-fairness" options={{ headerShown: false }} />
        <Stack.Screen name="season-totals" options={{ headerShown: false }} />
      </Stack>
    </ThemeProvider>
  );
}
