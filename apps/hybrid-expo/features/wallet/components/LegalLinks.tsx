import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { swapTheme as color } from '@/features/swap/swap.theme';

export const PRIVACY_URL = 'https://myboon.tech/privacy';
export const TERMS_URL = 'https://myboon.tech/terms';
export const DELETE_ACCOUNT_URL = 'https://myboon.tech/delete-account';

const links = [
  { label: 'Privacy policy', url: PRIVACY_URL },
  { label: 'Terms of service', url: TERMS_URL },
  { label: 'Delete account', url: DELETE_ACCOUNT_URL },
] as const;

export function LegalLinks() {
  return (
    <View style={styles.section}>
      <Text style={styles.label}>ABOUT</Text>
      <View style={styles.card}>
        {links.map((link, index) => (
          <View key={link.url}>
            {index > 0 ? <View style={styles.divider} /> : null}
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={link.label}
              onPress={() => {
                void Linking.openURL(link.url);
              }}
              style={styles.row}
            >
              <Text style={styles.rowLabel}>{link.label}</Text>
              <MaterialIcons name="open-in-new" size={16} color={color.dim} />
            </Pressable>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  label: { color: color.dim, fontSize: 12, fontWeight: '600', letterSpacing: 0.8 },
  card: {
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.card,
    borderRadius: 12,
    overflow: 'hidden',
  },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowLabel: { color: color.text, fontSize: 14, fontWeight: '600' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: color.border },
});
