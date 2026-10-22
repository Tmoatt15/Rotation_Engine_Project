import { Redirect } from 'expo-router';

export default function MarkUnavailableTab() {
  return <Redirect href="/live?open=unavailable" />;
}
