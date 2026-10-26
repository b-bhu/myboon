import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppTopBar, AppTopBarIconButton } from '@/components/AppTopBar';
import { WaitlistForm } from '@/features/waitlist/WaitlistForm';
import { semantic } from '@/theme';

/** Full-screen waitlist; stands in for swap and spot in waitlist mode. */
export function WaitlistScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <AppTopBar left={<AppTopBarIconButton icon="arrow-back" onPress={back} accessibilityLabel="Back" />} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <WaitlistForm onDone={back} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.background.screen },
  content: { padding: 20, paddingTop: 32 },
});

export default WaitlistScreen;
