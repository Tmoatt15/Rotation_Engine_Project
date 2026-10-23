import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useSegments } from 'expo-router';
import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';
import { getAcceptedSchedule, subscribeAcceptedSchedule } from '@/live-schedule';

export default function AppTabs() {
  const scheme = useColorScheme();
  const segments = useSegments();
  const colors = Colors[scheme === 'unspecified' ? 'light' : scheme];
  const [hasAcceptedSchedule, setHasAcceptedSchedule] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void getAcceptedSchedule().then((schedule) => {
        if (active) setHasAcceptedSchedule(Boolean(schedule));
      });
    };
    refresh();
    const unsubscribe = subscribeAcceptedSchedule(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const live = segments.includes('live') && hasAcceptedSchedule;

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

      <NativeTabs.Trigger name="roster" hidden={live}>
        <NativeTabs.Trigger.Label>Roster</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="person.3.fill" md="groups" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="game" hidden={live}>
        <NativeTabs.Trigger.Label>Create Schedule</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="calendar.badge.plus" md="event" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="mark-unavailable" hidden={!live}>
        <NativeTabs.Trigger.Label>MARK UNAVAILABLE</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="person.crop.circle.badge.xmark" md="person_off" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="live">
        <NativeTabs.Trigger.Label>{live ? 'ADD PLAYER' : 'Game'}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={live ? 'person.badge.plus' : 'play.circle.fill'} md={live ? 'person_add' : 'play_circle'} />
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
