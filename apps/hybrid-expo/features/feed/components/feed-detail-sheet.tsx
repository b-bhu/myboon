import type { ReactNode } from 'react';
import { AccessibilityInfo, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useEffect, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FEED_COLORS as color } from '../feed.constants';

export function FeedDetailSheet({ visible, title, onClose, children }: {
  visible: boolean; title: string; onClose: () => void; children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const [reducedMotion, setReducedMotion] = useState(true);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (mounted) setReducedMotion(value); });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReducedMotion);
    return () => { mounted = false; subscription.remove(); };
  }, []);
  return <Modal visible={visible} transparent animationType={reducedMotion ? 'none' : 'slide'} onRequestClose={onClose}>
    <View style={styles.overlay}>
      <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={`Close ${title}`} style={styles.scrim} />
      <View accessibilityViewIsModal style={[styles.sheet, { marginTop: insets.top + 16, paddingBottom: Math.max(16, insets.bottom) }]}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>{title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={`Close ${title}`} onPress={onClose} style={styles.close}><Text style={styles.closeText}>×</Text></Pressable>
        </View>
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.body}>{children}</ScrollView>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(3,31,44,0.78)' },
  sheet: { maxHeight: '90%', backgroundColor: '#031F2C', borderColor: color.border, borderWidth: 1, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
  header: { flexDirection: 'row', alignItems: 'center', paddingLeft: 18, paddingRight: 8, paddingVertical: 8, gap: 8 },
  title: { flex: 1, fontSize: 21, color: color.text, fontWeight: '700' },
  close: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: color.text, fontSize: 30 },
  body: { padding: 18, gap: 14 },
});
