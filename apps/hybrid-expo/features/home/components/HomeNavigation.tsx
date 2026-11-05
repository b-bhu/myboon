import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { tokens } from '@/theme';

export type HomeDestination = 'feed' | 'apps' | 'wallet';

const destinations = [
  { id: 'feed', label: 'Feed', icon: 'dynamic-feed' },
  { id: 'apps', label: 'Apps', icon: 'apps' },
  { id: 'wallet', label: 'Wallet', icon: 'account-balance-wallet' },
] as const;

export function HomeNavigation({
  selected,
  onSelect,
  bottomInset,
}: {
  selected: HomeDestination;
  onSelect: (destination: HomeDestination) => void;
  bottomInset: number;
}) {
  return (
    <View style={[styles.navigation, { paddingBottom: Math.max(bottomInset, 7) }]}>
      {destinations.map(({ id, label, icon }) => (
        <Pressable
          key={id}
          accessibilityRole="tab"
          accessibilityLabel={label}
          accessibilityState={{ selected: selected === id }}
          onPress={() => onSelect(id)}
          style={[styles.destination, selected === id && styles.selected]}
        >
          <MaterialIcons
            name={icon}
            size={20}
            color={selected === id ? tokens.colors.bone : tokens.colors.textDim}
          />
          <Text style={[styles.label, selected === id && styles.selectedLabel]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  navigation: {
    flexDirection: 'row',
    gap: 8,
    padding: 7,
    paddingHorizontal: 14,
    backgroundColor: tokens.colors.walletCore,
    borderTopWidth: 1,
    borderColor: tokens.colors.borderMuted,
  },
  destination: {
    flex: 1,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: 7,
  },
  selected: { backgroundColor: tokens.colors.surface, borderColor: tokens.colors.borderMuted },
  label: { color: tokens.colors.textDim, fontSize: 12, fontWeight: '600' },
  selectedLabel: { color: tokens.colors.bone },
});
