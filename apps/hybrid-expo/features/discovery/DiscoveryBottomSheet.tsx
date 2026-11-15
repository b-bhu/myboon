/**
 * Shared bottom-sheet shell for discovery-style screens: Modal → backdrop
 * tap-to-close → grabber → title row (optional close button) → children.
 *
 * Replaces two locally-rolled shells:
 * - PolymarketDiscoverScreen.tsx BottomSheetShell (KeyboardAvoidingView,
 *   slide-up, safe-area-padded sheet, sheetTitleRow + close button)
 * - MeteoraPoolsScreen.tsx SortSheet Modal (fade, backdrop-Pressable-wrapped,
 *   grabber + plain title, no close button)
 *
 * Everything visual stays with the caller via props (backdrop color, sheet /
 * grabber / title styles); the component owns only the shell structure. A
 * plain-view sheet (not the old Meteora stopPropagation Pressable) is enough:
 * taps on non-interactive sheet regions hit the sheet's own view tree, which
 * is not the backdrop responder, so behavior is unchanged.
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Platform, useWindowDimensions } from 'react-native';
import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function DiscoveryBottomSheet({
  visible,
  onClose,
  title,
  children,
  animationType = 'slide',
  statusBarTranslucent = false,
  keyboardAvoiding = false,
  padBottomToSafeArea = false,
  backdropColor,
  rootStyle,
  sheetStyle,
  grabberStyle,
  titleStyle,
  titleRowStyle,
  closeButton,
  backdropStyle,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  animationType?: 'none' | 'slide' | 'fade';
  statusBarTranslucent?: boolean;
  keyboardAvoiding?: boolean;
  padBottomToSafeArea?: boolean;
  /** Dim behind the sheet; also the tap-to-close layer's background. */
  backdropColor?: string;
  /** Wrapper inside the Modal; defaults to a full-screen transparent view. */
  rootStyle?: StyleProp<ViewStyle>;
  sheetStyle?: StyleProp<ViewStyle>;
  grabberStyle?: StyleProp<ViewStyle>;
  titleStyle?: StyleProp<TextStyle>;
  /** Row wrapping title + close button; used only when `closeButton` is set. */
  titleRowStyle?: StyleProp<ViewStyle>;
  closeButton?: ReactNode;
  /**
   * Replaces the default full-width backdrop style
   * ({ flex: 1, backgroundColor: backdropColor, minHeight: height }).
   * Used when a venue's backdrop is absolutely positioned instead (e.g.
   * Polymarket's absoluteFillObject + tinted overlay); put the background
   * color in this style and omit `backdropColor`.
   */
  backdropStyle?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const isIos = Platform.OS === 'ios';
  const sheet = (
    <View style={[sheetStyle, padBottomToSafeArea ? { paddingBottom: Math.max(20, insets.bottom + 12) } : null]}>
      {grabberStyle ? <View style={grabberStyle} /> : null}
      {closeButton && titleRowStyle ? (
        <View style={titleRowStyle}>
          <Text style={titleStyle}>{title}</Text>
          {closeButton}
        </View>
      ) : titleStyle ? (
        <Text style={titleStyle}>{title}</Text>
      ) : null}
      {children}
    </View>
  );
  const shell = (
    <>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close sheet"
        style={backdropStyle ?? { flex: 1, backgroundColor: backdropColor, minHeight: height }}
      />
      {sheet}
    </>
  );
  const inner =
    keyboardAvoiding && isIos ? (
      <KeyboardAvoidingView behavior="padding" style={[{ flex: 1 }, rootStyle]}>
        {shell}
      </KeyboardAvoidingView>
    ) : (
      <View style={[{ flex: 1 }, rootStyle]}>{shell}</View>
    );
  return (
    <Modal
      visible={visible}
      transparent
      animationType={animationType}
      statusBarTranslucent={statusBarTranslucent}
      onRequestClose={onClose}
    >
      {inner}
    </Modal>
  );
}

/** Helper re-exported so venue wrappers can build the standard close button. */
export function DiscoverySheetCloseButton({
  onPress,
  style,
  iconSize,
  iconColor,
  accessibilityLabel = 'Close',
}: {
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  iconSize: number;
  iconColor: string;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable onPress={onPress} style={style} accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
      <MaterialIcons name="close" size={iconSize} color={iconColor} />
    </Pressable>
  );
}
