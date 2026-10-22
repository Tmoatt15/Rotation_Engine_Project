import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useSegments } from 'expo-router';
import { useColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';

export default function AppTabs() {
  const scheme = useColorScheme();
  const segments = useSegments();
  const colors = Colors[scheme === 'unspecified' ? 'light' : scheme];
  const live = segments.includes('live');

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

      {live && <NativeTabs.Trigger name="add-player">
        <NativeTabs.Trigger.Label>ADD PLAYER</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="person.badge.plus" md="person_add" />
      </NativeTabs.Trigger>}
      {live && <NativeTabs.Trigger name="mark-unavailable">
        <NativeTabs.Trigger.Label>MARK UNAVAILABLE</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="person.crop.circle.badge.xmark" md="person_off" />
      </NativeTabs.Trigger>}
      {!live && <NativeTabs.Trigger name="roster">
        <NativeTabs.Trigger.Label>Roster</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="person.3.fill" md="groups" />
      </NativeTabs.Trigger>}
      {!live && <NativeTabs.Trigger name="game">
        <NativeTabs.Trigger.Label>Create Schedule</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="calendar.badge.plus" md="event" />
      </NativeTabs.Trigger>}
      {!live && <NativeTabs.Trigger name="live">
        <NativeTabs.Trigger.Label>Game</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="play.circle.fill" md="play_circle" />
      </NativeTabs.Trigger>}

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
