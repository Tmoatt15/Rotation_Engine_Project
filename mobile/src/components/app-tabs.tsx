import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';

export default function AppTabs() {
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'unspecified' ? 'light' : scheme];

  return (
    <NativeTabs
      backgroundColor={colors.background}
      indicatorColor={colors.backgroundElement}
      labelStyle={{ selected: { color: colors.text } }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf="house.fill"
          md="home"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="game">
        <NativeTabs.Trigger.Label>Game</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf="sportscourt.fill"
          md="sports_soccer"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="live" hidden />

      <NativeTabs.Trigger name="roster">
        <NativeTabs.Trigger.Label>Roster</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf="person.3.fill"
          md="groups"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="more">
        <NativeTabs.Trigger.Label>More</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf="ellipsis.circle.fill"
          md="more_horiz"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
