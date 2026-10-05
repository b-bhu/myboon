import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useEffect, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { swapTheme as color } from '@/features/swap/swap.theme';

export function WalletSecondarySheet({
  visible,
  title,
  onClose,
  children,
  busy = false,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [reducedMotion, setReducedMotion] = useState(true);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReducedMotion(value);
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReducedMotion,
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Modal
      visible={visible}
      transparent
      animationType={reducedMotion ? 'none' : 'slide'}
      onRequestClose={close}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable
          style={styles.backdrop}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel={`Close ${title}`}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
        />
        <View
          style={[
            styles.sheet,
            { paddingBottom: Math.max(insets.bottom, 14), marginTop: insets.top + 12 },
          ]}
          accessibilityViewIsModal
        >
          <View style={styles.heading}>
            <Text accessibilityRole="header" style={styles.title}>
              {title}
            </Text>
            <Pressable
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel={`Close ${title}`}
              disabled={busy}
              accessibilityState={{ disabled: busy }}
              style={styles.close}
            >
              <MaterialIcons name="close" size={24} color={color.text} />
            </Pressable>
          </View>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            contentContainerStyle={styles.body}
          >
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(3,31,44,0.75)' },
  sheet: {
    maxHeight: '90%',
    backgroundColor: color.navy,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: color.border,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 18,
    paddingRight: 8,
    paddingVertical: 8,
    gap: 8,
  },
  title: { flex: 1, color: color.text, fontSize: 21, fontWeight: '700' },
  close: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: 18, paddingBottom: 14, gap: 12 },
});
