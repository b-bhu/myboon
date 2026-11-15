/**
 * Shared empty / error / info card for discovery-style screens.
 *
 * Single source of truth for the state-card markup that previously lived
 * in three places with three different prop names:
 * - features/markets/MarketList.tsx (MarketListFailure / MarketListEmptyState)
 * - features/polymarket/PolymarketDiscoverScreen.tsx (StateCard, `body` prop)
 * - features/spot/SpotScreen.tsx (StateCard, `message` prop)
 *
 * All styling stays with the caller: every color and every style key is a
 * prop, so each venue keeps its exact current look. The only behavior the
 * component owns is the element order (icon, title, message, retry) and the
 * retry button's accessibility wiring (role "button", label falls back to
 * the button text).
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Pressable, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

export type DiscoveryStateCardRetry = {
  onPress: () => void;
  /** Button text, e.g. "Try again" or "Reset search". */
  label: string;
  /** VoiceOver/TalkBack label; defaults to `label`. */
  accessibilityLabel?: string;
};

export type DiscoveryStateCardIcon = {
  name: keyof typeof MaterialIcons.glyphMap;
  size: number;
  color: string;
  /** Optional wrapping View (MarketList uses one, Spot renders the icon bare). */
  wrapStyle?: StyleProp<ViewStyle>;
};

export function DiscoveryStateCard({
  title,
  message,
  icon,
  retry,
  containerStyle,
  titleStyle,
  messageStyle,
  retryButtonStyle,
  retryTextStyle,
}: {
  title: string;
  message?: string;
  icon?: DiscoveryStateCardIcon;
  retry?: DiscoveryStateCardRetry;
  containerStyle?: StyleProp<ViewStyle>;
  titleStyle: StyleProp<TextStyle>;
  messageStyle?: StyleProp<TextStyle>;
  retryButtonStyle?: StyleProp<ViewStyle>;
  retryTextStyle?: StyleProp<TextStyle>;
}) {
  return (
    <View style={containerStyle}>
      {icon ? (
        icon.wrapStyle ? (
          <View style={icon.wrapStyle}>
            <MaterialIcons name={icon.name} size={icon.size} color={icon.color} />
          </View>
        ) : (
          <MaterialIcons name={icon.name} size={icon.size} color={icon.color} />
        )
      ) : null}
      <Text style={titleStyle}>{title}</Text>
      {message ? <Text style={messageStyle}>{message}</Text> : null}
      {retry ? (
        <Pressable
          onPress={retry.onPress}
          style={retryButtonStyle}
          accessibilityRole="button"
          accessibilityLabel={retry.accessibilityLabel ?? retry.label}
        >
          <Text style={retryTextStyle}>{retry.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
