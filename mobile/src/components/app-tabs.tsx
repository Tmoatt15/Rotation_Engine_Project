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

      <NativeTabs.Trigger name="roster">
        <NativeTabs.Trigger.Label>Roster</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf="person.3.fill"
          md="groups"
        />
      </NativeTabs.Trigger>

      {/* The game route is schedule creation; the live route is the active Game tab. */}
      <NativeTabs.Trigger name="game">
        <NativeTabs.Trigger.Label>Create Schedule</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf="calendar.badge.plus"
          md="event"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="live">
        <NativeTabs.Trigger.Label>Game</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf="play.circle.fill"
          md="play_circle"
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
