/**
 * MarketScreen — the one shared market detail screen (#651).
 *
 * Pure refactor: top bar, price row, range strip + news toggle, reserved RSI
 * slot, news rail, position rows and the pinned action bar are identical for
 * Phoenix, Pacifica, Polymarket and Meteora. Only `chartBody` is venue-swapped.
 * The action bar opens a sheet over the screen (chart still visible behind);
 * its contents carry the venue's moved order form until C (#652) lands.
 */

import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { semantic, tokens } from '@/theme';
import type { MarketDetailViewModel } from '@/features/markets/detail-view-model';
import {
  NewsRailSection,
  PinnedActionBarSection,
  PositionRowsSection,
  PriceRowSection,
  RangeNewsStrip,
  RsiSlot,
  TopBarSection,
} from '@/features/markets/detail-sections';

export interface MarketScreenProps {
  vm: MarketDetailViewModel;
  /** Fallback connect handler when the venue VM does not carry one. */
  onConnect?: () => void;
}

export function MarketScreen({ vm, onConnect }: MarketScreenProps) {
  const insets = useSafeAreaInsets();
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    if (sheetOpen && vm.actionSheet == null) setSheetOpen(false);
  }, [sheetOpen, vm.actionSheet]);

  const openTradeSheet = () => setSheetOpen(true);
  const connectHandler = vm.actionBar.onConnect ?? onConnect;
  /** Bar buttons always open the sheet; a venue-supplied handler runs first (e.g. side preset). */
  const composeOpenSheet = (first?: () => void) => () => {
    first?.();
    openTradeSheet();
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom }]}
        showsVerticalScrollIndicator={false}
      >
        <TopBarSection vm={vm.topBar} />
        <PriceRowSection vm={vm.priceRow} />
        {vm.notice}
        {vm.chartBody}
        <RangeNewsStrip vm={vm.range} />
        <RsiSlot />
        <NewsRailSection stories={vm.newsStories} />
        <PositionRowsSection title={vm.positionsTitle} rows={vm.positionRows} footer={vm.positionsMessage} />
      </ScrollView>

      <PinnedActionBarSection
        vm={
          vm.actionBar.connected
            ? {
                ...vm.actionBar,
                buttons: [
                  { ...vm.actionBar.buttons[0], onPress: composeOpenSheet(vm.actionBar.buttons[0].onPress) },
                  { ...vm.actionBar.buttons[1], onPress: composeOpenSheet(vm.actionBar.buttons[1].onPress) },
                ],
              }
            : { ...vm.actionBar, onConnect: connectHandler }
        }
      />

      <Modal
        visible={sheetOpen && vm.actionSheet != null}
        transparent
        animationType="slide"
        presentationStyle="overFullScreen"
        statusBarTranslucent
        onRequestClose={() => setSheetOpen(false)}
      >
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetBackdrop}>
          <Pressable style={styles.sheetSpacer} onPress={() => setSheetOpen(false)} />
          <View style={[styles.sheetPanel, { paddingBottom: insets.bottom + tokens.spacing.lg }]}>
            <View style={styles.sheetHandle} />
            {vm.actionSheet}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: semantic.background.screen,
  },
  scrollContent: {
    gap: tokens.spacing.sm,
  },
  sheetBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'transparent',
  },
  sheetSpacer: {
    flex: 1,
  },
  sheetPanel: {
    backgroundColor: semantic.background.surfaceRaised,
    borderTopLeftRadius: tokens.spacing.lg,
    borderTopRightRadius: tokens.spacing.lg,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: semantic.border.muted,
    paddingTop: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 44,
    height: 4,
    borderRadius: tokens.radius.full,
    backgroundColor: semantic.border.muted,
    marginBottom: tokens.spacing.sm,
  },
});
