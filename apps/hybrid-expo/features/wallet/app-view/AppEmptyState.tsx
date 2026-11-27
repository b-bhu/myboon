/**
 * Wallet app view — the shared tab-body empty note (issue #860, design
 * wallet.html frame "9. States > App connected, no positions", component
 * "Empty state" (.emp); the frame draws it on Pacifica, but the note is the
 * same for every app).
 *
 * `AppEmptyState({ title, line })`: a faint inbox icon (32), the title and
 * the line, centered — `.emp` values: pad 32 top, 16 sides, 24 bottom;
 * title 18 semibold with 12 above and 4 below; line 14 dim. No button and
 * no space reserved for one (the frame's Deposit button is #820: not in
 * this unit; `.emp p` keeps its own look without the button room). The app
 * view header already carries the app name, so the block does not repeat
 * it. Phoenix Positions (Phoenix and Pacifica) and Meteora Positions show
 * it when their list has loaded and is empty; Orders and History keep
 * their own notes.
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { semantic } from '@/theme';

export const AppEmptyState = memo(function AppEmptyState({ title, line }: { title: string; line: string }) {
  return (
    <View style={styles.root}>
      <MaterialIcons name="inbox" size={32} color={semantic.text.faint} />
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.line}>{line}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  // Mock ".emp": centered, pad 32 top, 16 sides, 24 bottom; faint icon 32.
  root: { alignItems: 'center', paddingTop: 32, paddingHorizontal: 16, paddingBottom: 24 },
  // Mock ".emp h3": 18 semibold, 12 above, 4 below.
  title: { color: semantic.text.primary, fontSize: 18, fontWeight: '600', marginTop: 12, marginBottom: 4 },
  // Mock ".emp p": line 14 dim (its 16 bottom margin in the frame is the
  // button room; there is no button and no space reserved for one here).
  line: { color: semantic.text.dim, fontSize: 14 },
});
