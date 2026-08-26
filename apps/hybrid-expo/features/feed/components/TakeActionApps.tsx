import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { FEED_COLORS } from '@/features/feed/feed.constants';
import { PHOENIX_MARK_SVG, POLYMARKET_MARK_SVG } from '@/features/home/marketBrandAssets';

interface TakeActionAppsProps {
  onBeforeNavigate?: () => void;
}

type ApplicationRoute = '/markets/polymarket' | '/markets/phoenix';

const APPLICATIONS: {
  name: string;
  hint: string;
  route: ApplicationRoute;
  icon: {
    xml: string;
    width: number;
    height: number;
  };
}[] = [
  {
    name: 'Polymarket',
    hint: 'Prediction markets',
    route: '/markets/polymarket',
    icon: { xml: POLYMARKET_MARK_SVG, width: 22, height: 28 },
  },
  {
    name: 'Phoenix',
    hint: 'Perpetuals',
    route: '/markets/phoenix',
    icon: { xml: PHOENIX_MARK_SVG, width: 26, height: 28 },
  },
];

export function TakeActionApps({ onBeforeNavigate }: TakeActionAppsProps) {
  const router = useRouter();

  function openApplication(route: ApplicationRoute) {
    onBeforeNavigate?.();
    router.push(route);
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>TAKE ACTION</Text>
      <View style={styles.row}>
        {APPLICATIONS.map((application) => (
          <Pressable
            key={application.route}
            accessibilityRole="button"
            accessibilityLabel={`Open ${application.name}`}
            onPress={() => openApplication(application.route)}
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          >
            <View style={styles.mark}>
              <SvgXml
                xml={application.icon.xml}
                width={application.icon.width}
                height={application.icon.height}
              />
            </View>
            <View style={styles.copy}>
              <Text style={styles.name}>{application.name}</Text>
              <Text style={styles.hint}>{application.hint}</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: 8,
  },
  sectionLabel: {
    color: FEED_COLORS.accent,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.1,
    marginTop: 26,
    marginBottom: 14,
  },
  row: {
    flexDirection: 'row',
    gap: 9,
  },
  button: {
    flex: 1,
    minWidth: 0,
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: FEED_COLORS.border,
    backgroundColor: FEED_COLORS.cardDeep,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderCurve: 'continuous',
  },
  mark: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
    borderWidth: 1,
    borderColor: FEED_COLORS.border,
    backgroundColor: FEED_COLORS.screen,
    borderCurve: 'continuous',
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    color: FEED_COLORS.text,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '900',
  },
  hint: {
    color: FEED_COLORS.textDim,
    fontSize: 9,
    lineHeight: 13,
  },
  pressed: {
    opacity: 0.72,
  },
});
