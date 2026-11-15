/**
 * Shared search input for discovery-style screens: leading magnifier, text
 * input, optional trailing clear button. Renders a fragment — the container
 * row style stays with the caller, so each venue keeps its exact paddings.
 *
 * Replaces four locally-rolled copies that differed only in parameterization:
 * - MarketList.tsx search bar (icon 16, clear 14, UPPERCASE input)
 * - MeteoraPoolsScreen.tsx toolbar field (icon 18, clear 17, "Clear pool search")
 * - PolymarketDiscoverScreen.tsx SearchSheet field (icon 20, `cancel` clear)
 * - PolymarketDiscoverScreen.tsx league-sheet field (icon 20, no clear)
 * - SpotScreen.tsx floating search (icon 16, always-rendered transparent clear)
 *
 * Behavior notes kept exact:
 * - The clear button is hidden while `value` is empty unless `alwaysRender`
 *   is set (Spot renders it transparent when the query is empty).
 * - `clear.onPress` defaults to `onChangeText('')`, which preserves
 *   caller-side side effects (Spot uses an explicit onPress that clears only
 *   the query string, not the expanded-row/route state).
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Fragment } from 'react';
import {
  Pressable,
  TextInput,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

export type DiscoverySearchFieldClear = {
  /** Clears more than just the text at some venues; defaults to onChangeText(''). */
  onPress?: () => void;
  /** Trailing glyph; omit to render a textless (padding-only) clear button. */
  icon?: { name: 'close' | 'cancel'; size: number; color: string };
  style?: StyleProp<ViewStyle>;
  /** Defaults to "Clear search". */
  accessibilityLabel?: string;
  /**
   * Render the clear button even while the value is empty (Spot keeps it in
   * the layout and switches the icon color to transparent instead).
   */
  alwaysRender?: boolean;
};

export function DiscoverySearchField({
  value,
  onChangeText,
  placeholder,
  placeholderTextColor,
  style,
  accessibilityLabel,
  autoCapitalize,
  autoCorrect,
  returnKeyType,
  autoFocus,
  icon,
  clear,
}: {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  placeholderTextColor?: string;
  style?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  autoCorrect?: TextInputProps['autoCorrect'];
  returnKeyType?: TextInputProps['returnKeyType'];
  autoFocus?: boolean;
  /** Leading magnifier; the color/size vary per venue, the glyph does not. */
  icon?: { size: number; color: string };
  clear?: DiscoverySearchFieldClear | null;
}) {
  const showClear = Boolean(clear) && (value.length > 0 || clear!.alwaysRender === true);
  return (
    <Fragment>
      {icon ? <MaterialIcons name="search" size={icon.size} color={icon.color} /> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        returnKeyType={returnKeyType}
        autoFocus={autoFocus}
        accessibilityLabel={accessibilityLabel}
        style={style}
      />
      {showClear ? (
        <Pressable
          onPress={clear!.onPress ?? (() => onChangeText(''))}
          hitSlop={8}
          style={clear!.style}
          accessibilityRole="button"
          accessibilityLabel={clear!.accessibilityLabel ?? 'Clear search'}
        >
          {clear!.icon ? (
            <MaterialIcons name={clear!.icon.name} size={clear!.icon.size} color={clear!.icon.color} />
          ) : null}
        </Pressable>
      ) : null}
    </Fragment>
  );
}
