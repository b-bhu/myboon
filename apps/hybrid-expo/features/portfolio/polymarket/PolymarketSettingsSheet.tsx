/**
 * PolymarketSettingsSheet — the Polymarket profile's settings sheet (#740),
 * moved verbatim from `polymarket.portfolio.tsx`. Presentational; every value
 * it renders arrives as a prop from the screen and `usePolymarketSettings`.
 * The sheet was pasted twice in the screen (an early return and the main
 * return); the two copies diffed identical over the whole Modal block, so one
 * copy keeps that behaviour. Pure move — no behaviour change.
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  truncate,
  type PolymarketProfileCurrency,
  type PolymarketSettingsView,
} from '@/features/portfolio/polymarket/polymarket.format';
import { styles } from '@/features/portfolio/polymarket/polymarket.portfolio.styles';
import type { OddsFormat } from '@/hooks/useOddsFormat';
import { semantic, tokens } from '@/theme';

export interface PolymarketSettingsSheetProps {
  visible: boolean;
  settingsView: PolymarketSettingsView;
  setSettingsView: (view: PolymarketSettingsView) => void;
  setSettingsOpen: (open: boolean) => void;
  closeSettings: () => void;
  /** Solana withdrawal target for the security view, from useWallet. */
  solanaAddress: string | null;
  /** Profile currency display choice and its live USD→INR rate. */
  currencyFormat: PolymarketProfileCurrency;
  usdToInrRate: number;
  selectCurrencyFormat: (next: PolymarketProfileCurrency) => void;
  /** Order-composer odds display, owned by useOddsFormat on the screen. */
  oddsFormat: OddsFormat;
  setOddsFormat: (next: OddsFormat) => void;
  /** Quick amounts: saved values plus the amounts view's draft state. */
  quickAmounts: number[];
  quickAmountDraft: string[];
  setQuickAmountDraft: (update: (current: string[]) => string[]) => void;
  quickAmountError: string | null;
  quickAmountSaving: boolean;
  saveQuickAmounts: () => Promise<void>;
  /** MyBoon sign-out request state and its handler. */
  signOutBusy: boolean;
  signOutError: string | null;
  handleSignOut: () => Promise<void>;
  /** Solana withdraw-destination entry, from usePolymarketAccountSetup. */
  handleWithdrawPress: () => void;
  /** The wallet view's disconnect button, owned by the screen. */
  handleDisconnectPolymarket: () => void;
  /** Identity row in the security view, derived on the screen from Privy. */
  authLabel: 'Google' | 'Email' | 'Wallet' | null;
  maskedIdentity: string | null;
  privyAuthMethod: 'email' | 'google' | 'wallet' | null;
  /** Polymarket wallet facts for the wallet view. */
  walletAddress: string | null;
  tradingAddress: string | null;
  polyReady: boolean;
  isEnabled: boolean;
  busy: boolean;
  insetsBottom: number;
}

export function PolymarketSettingsSheet({
  visible,
  settingsView,
  setSettingsView,
  setSettingsOpen,
  closeSettings,
  solanaAddress,
  currencyFormat,
  usdToInrRate,
  selectCurrencyFormat,
  oddsFormat,
  setOddsFormat,
  quickAmounts,
  quickAmountDraft,
  setQuickAmountDraft,
  quickAmountError,
  quickAmountSaving,
  saveQuickAmounts,
  signOutBusy,
  signOutError,
  handleSignOut,
  handleWithdrawPress,
  handleDisconnectPolymarket,
  authLabel,
  maskedIdentity,
  privyAuthMethod,
  walletAddress,
  tradingAddress,
  polyReady,
  isEnabled,
  busy,
  insetsBottom,
}: PolymarketSettingsSheetProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={closeSettings}>
      <KeyboardAvoidingView
        style={styles.settingsBackdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close Polymarket profile settings"
          style={StyleSheet.absoluteFill}
          onPress={closeSettings}
        />
        <ScrollView
          style={styles.settingsCard}
          contentContainerStyle={[styles.settingsCardContent, { paddingBottom: Math.max(insetsBottom, 20) + 8 }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          accessibilityViewIsModal
          accessibilityLabel="Polymarket settings dialog">
          <View style={styles.sheetGrabber} />
          <View style={styles.sheetTop}>
            <Text style={styles.settingsEyebrow}>{settingsView === 'security' ? 'Account & security' : 'Polymarket settings'}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close settings" style={styles.sheetClose} onPress={closeSettings}>
              <MaterialIcons name="close" size={18} color={semantic.text.dim} />
            </Pressable>
          </View>
          {settingsView !== 'menu' && (
            <Pressable style={styles.settingsBackRow} onPress={() => setSettingsView('menu')} accessibilityRole="button" accessibilityLabel="Back to Polymarket settings">
              <MaterialIcons name="chevron-left" size={16} color={semantic.text.dim} />
              <Text style={styles.settingsBackText}>Back</Text>
            </Pressable>
          )}

          {settingsView === 'menu' && (
            <>
              <Text style={styles.settingsTitle}>Polymarket settings</Text>
              <Text style={styles.settingsCopy}>Preferences follow you across every market.</Text>
              <Text style={styles.sheetSectionLabel}>Trading display</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open currency display settings"
                style={styles.settingsOption}
                onPress={() => setSettingsView('currency')}
              >
                <View style={styles.settingsOptionIcon}>
                  <MaterialIcons name="payments" size={15} color={tokens.colors.primary} />
                </View>
                <View style={styles.settingsOptionCopy}>
                  <Text style={styles.settingsOptionTitle}>Currency display</Text>
                  <Text style={styles.settingsOptionSub}>{currencyFormat} selected</Text>
                </View>
                <MaterialIcons name="chevron-right" size={18} color={semantic.text.faint} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open odds format settings"
                style={styles.settingsOption}
                onPress={() => setSettingsView('odds')}
              >
                <View style={styles.settingsOptionIcon}>
                  <MaterialIcons name="percent" size={15} color={tokens.colors.accent} />
                </View>
                <View style={styles.settingsOptionCopy}>
                  <Text style={styles.settingsOptionTitle}>Odds format</Text>
                  <Text style={styles.settingsOptionSub}>
                    {oddsFormat === 'probability' ? 'Probability' : oddsFormat === 'decimal' ? 'Decimal' : 'Points'} selected
                  </Text>
                </View>
                <MaterialIcons name="chevron-right" size={18} color={semantic.text.faint} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Edit quick amounts"
                style={styles.settingsOption}
                onPress={() => setSettingsView('amounts')}
              >
                <View style={styles.settingsOptionIcon}>
                  <MaterialIcons name="calculate" size={15} color={tokens.colors.primary} />
                </View>
                <View style={styles.settingsOptionCopy}>
                  <Text style={styles.settingsOptionTitle}>Quick amounts</Text>
                  <Text style={styles.settingsOptionSub}>{quickAmounts.map((amount) => `$${amount}`).join(' · ')}</Text>
                </View>
                <MaterialIcons name="chevron-right" size={18} color={semantic.text.faint} />
              </Pressable>
              <Text style={styles.sheetSectionLabel}>Account</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open account and security"
                style={styles.settingsOption}
                onPress={() => setSettingsView('security')}
              >
                <View style={styles.settingsOptionIcon}>
                  <MaterialIcons name="vpn-key" size={15} color={tokens.colors.viridian} />
                </View>
                <View style={styles.settingsOptionCopy}>
                  <Text style={styles.settingsOptionTitle}>Account &amp; Security</Text>
                  <Text style={styles.settingsOptionSub}>{privyAuthMethod ? `Signed in with ${privyAuthMethod === 'google' ? 'Google' : privyAuthMethod === 'email' ? 'email' : 'wallet'}` : 'Not signed in'}</Text>
                </View>
                <MaterialIcons name="chevron-right" size={18} color={semantic.text.faint} />
              </Pressable>
              <Text style={styles.sheetSectionLabel}>Safety</Text>
              <View style={styles.settingsOption}>
                <View style={styles.settingsOptionIcon}>
                  <MaterialIcons name="verified-user" size={15} color={tokens.colors.viridian} />
                </View>
                <View style={styles.settingsOptionCopy}>
                  <Text style={styles.settingsOptionTitle}>Order review</Text>
                  <Text style={styles.settingsOptionSub}>Payout and maximum loss are always shown</Text>
                </View>
                <Text style={styles.alwaysOnText}>Always on</Text>
              </View>
            </>
          )}

          {settingsView === 'security' && (
            <>
              <Text style={styles.settingsTitle}>Account &amp; Security</Text>
              <Text style={styles.settingsCopy}>Manage how you sign in and where funds can move.</Text>
              <Text style={styles.sheetSectionLabel}>Login</Text>
              <View style={styles.settingsOption}>
                <View style={styles.settingsOptionIcon}>
                  <MaterialIcons name={privyAuthMethod === 'google' ? 'account-circle' : 'email'} size={15} color={tokens.colors.primary} />
                </View>
                <View style={styles.settingsOptionCopy}>
                  <Text style={styles.settingsOptionTitle}>{authLabel ?? 'MyBoon login'}</Text>
                  <Text style={styles.settingsOptionSub}>{maskedIdentity ?? (walletAddress ? truncate(walletAddress) : 'Not connected')}</Text>
                </View>
                <Text style={styles.settingsValue}>{authLabel ?? '—'}</Text>
              </View>
              <Text style={styles.sheetSectionLabel}>Connected wallets</Text>
              <Pressable style={styles.settingsOption} onPress={() => setSettingsView('wallet')} accessibilityRole="button" accessibilityLabel="View Polymarket wallet">
                <View style={styles.settingsOptionIcon}>
                  <MaterialIcons name="account-balance-wallet" size={15} color={tokens.colors.viridian} />
                </View>
                <View style={styles.settingsOptionCopy}>
                  <Text style={styles.settingsOptionTitle}>Polymarket wallet</Text>
                  <Text style={styles.settingsOptionSub}>{walletAddress ? `${truncate(walletAddress)} · ${isEnabled ? 'Connected' : 'Setup needed'}` : 'Not created'}</Text>
                </View>
                <MaterialIcons name="chevron-right" size={18} color={semantic.text.faint} />
              </Pressable>
              <Pressable style={styles.settingsOption} onPress={handleWithdrawPress} accessibilityRole="button" accessibilityLabel="Manage Solana withdrawal destination">
                <View style={styles.settingsOptionIcon}>
                  <MaterialIcons name="north-east" size={15} color={tokens.colors.primary} />
                </View>
                <View style={styles.settingsOptionCopy}>
                  <Text style={styles.settingsOptionTitle}>Withdrawal destination</Text>
                  <Text style={styles.settingsOptionSub}>{solanaAddress ? `${truncate(solanaAddress)} · Solana` : 'Connect a Solana wallet'}</Text>
                </View>
                <MaterialIcons name="chevron-right" size={18} color={semantic.text.faint} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Sign out of MyBoon"
                style={styles.signOutBtn}
                onPress={() => setSettingsView('signout')}>
                <MaterialIcons name="logout" size={15} color={tokens.colors.vermillion} />
                <Text style={styles.signOutText}>Sign out</Text>
              </Pressable>
            </>
          )}

          {settingsView === 'odds' && (
            <>
              <Text style={styles.settingsTitle}>Odds format</Text>
              <Text style={styles.settingsCopy}>How prices show across Polymarket. Books and limit prices always stay in cents.</Text>
              {([
                { key: 'probability', title: 'Probability', sub: '57% — the chance' },
                { key: 'decimal', title: 'Decimal', sub: '1.75 — total return per $1' },
                { key: 'points', title: 'Points', sub: '+75 — profit per $1' },
              ] as const).map((option) => {
                const selected = oddsFormat === option.key;
                return (
                  <Pressable
                    key={option.key}
                    accessibilityRole="button"
                    accessibilityLabel={`Show odds in ${option.title} format`}
                    accessibilityState={{ selected }}
                    style={[styles.currencyOption, selected && styles.currencyOptionSelected]}
                    onPress={() => {
                      setOddsFormat(option.key);
                      setSettingsOpen(false);
                      setSettingsView('menu');
                    }}
                  >
                    <View>
                      <Text style={styles.currencyOptionTitle}>{option.title}</Text>
                      <Text style={styles.currencyOptionSub}>{option.sub}</Text>
                    </View>
                    {selected && <MaterialIcons name="check-circle" size={20} color={tokens.colors.primary} />}
                  </Pressable>
                );
              })}
            </>
          )}

          {settingsView === 'currency' && (
            <>
              <Text style={styles.settingsTitle}>Currency display</Text>
              <Text style={styles.settingsCopy}>Choose how money shows on your Polymarket profile.</Text>
              {(['USD', 'INR'] as const).map((currency) => {
                const selected = currencyFormat === currency;
                return (
                  <Pressable
                    key={currency}
                    accessibilityRole="button"
                    accessibilityLabel={`Show Polymarket profile values in ${currency}`}
                    accessibilityState={{ selected }}
                    style={[styles.currencyOption, selected && styles.currencyOptionSelected]}
                    onPress={() => selectCurrencyFormat(currency)}
                  >
                    <View>
                      <Text style={styles.currencyOptionTitle}>{currency}</Text>
                      <Text style={styles.currencyOptionSub}>
                        {currency === 'USD' ? '$ US dollars' : `₹ Indian rupees · live rate ${usdToInrRate.toFixed(2)}`}
                      </Text>
                    </View>
                    {selected && <MaterialIcons name="check-circle" size={20} color={tokens.colors.primary} />}
                  </Pressable>
                );
              })}
            </>
          )}

          {settingsView === 'wallet' && (
            <>
              <Text style={styles.settingsTitle}>Polymarket wallet</Text>
              <Text style={styles.settingsCopy}>
                The active mobile SDK account owns authentication, approvals, orders, transfers, and redemption for this deposit wallet.
              </Text>
              <View style={styles.walletInfoBox}>
                <View style={styles.walletInfoRow}>
                  <Text style={styles.walletInfoLabel}>Polymarket signer</Text>
                  <Text selectable style={styles.walletInfoValue}>{walletAddress ? truncate(walletAddress) : '--'}</Text>
                </View>
                <View style={styles.walletInfoRow}>
                  <Text style={styles.walletInfoLabel}>Deposit wallet</Text>
                  <Text selectable style={styles.walletInfoValue}>{tradingAddress ? truncate(tradingAddress) : '--'}</Text>
                </View>
                <View style={styles.walletInfoRow}>
                  <Text style={styles.walletInfoLabel}>Network</Text>
                  <Text style={styles.walletInfoValue}>Polygon</Text>
                </View>
              </View>
              <Text style={styles.settingsFinePrint}>
                Your Polymarket wallet is managed through your MyBoon login. Private keys are never displayed here.
              </Text>
              {polyReady && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Disconnect Polymarket"
                  disabled={busy}
                  onPress={handleDisconnectPolymarket}
                  style={[styles.settingsDisconnectBtn, busy && { opacity: 0.5 }]}
                >
                  <Text style={styles.settingsDisconnectText}>
                    {busy ? 'Disconnecting…' : 'Disconnect Polymarket'}
                  </Text>
                </Pressable>
              )}
            </>
          )}

          {settingsView === 'amounts' && (
            <>
              <Text style={styles.settingsTitle}>Quick amounts</Text>
              <Text style={styles.settingsCopy}>Choose the three shortcuts shown in the order composer.</Text>
              <View style={styles.quickAmountRow}>
                {quickAmountDraft.map((value, index) => (
                  <View key={`quick-${index}`} style={styles.quickAmountInputWrap}>
                    <Text style={styles.quickAmountCurrency}>$</Text>
                    <TextInput
                      value={value}
                      onChangeText={(next) => setQuickAmountDraft((current) => current.map((entry, entryIndex) => entryIndex === index ? next : entry))}
                      keyboardType="decimal-pad"
                      placeholder="0"
                      placeholderTextColor={semantic.text.faint}
                      style={styles.quickAmountInput}
                      accessibilityLabel={`Quick amount ${index + 1}`}
                    />
                  </View>
                ))}
              </View>
              {quickAmountError ? <Text selectable style={styles.quickAmountError}>{quickAmountError}</Text> : null}
              <Pressable style={[styles.saveSettingsBtn, quickAmountSaving && styles.btnDisabled]} disabled={quickAmountSaving} onPress={() => void saveQuickAmounts()}>
                <Text style={styles.saveSettingsText}>{quickAmountSaving ? 'Saving…' : 'Save amounts'}</Text>
              </Pressable>
            </>
          )}

          {settingsView === 'signout' && (
            <View style={styles.signOutConfirm}>
              <View style={styles.signOutConfirmIcon}>
                <MaterialIcons name="logout" size={22} color={tokens.colors.vermillion} />
              </View>
              <Text style={styles.settingsTitle}>Sign out of MyBoon?</Text>
              <Text style={styles.settingsCopy}>Your Polymarket positions and pUSD stay with your account. Sign in again to trade, withdraw, or collect.</Text>
              {signOutError ? <Text selectable style={styles.quickAmountError}>{signOutError}</Text> : null}
              <View style={styles.signOutActions}>
                <Pressable style={[styles.staySignedInBtn, signOutBusy && styles.btnDisabled]} disabled={signOutBusy} onPress={() => setSettingsView('security')}>
                  <Text style={styles.staySignedInText}>Stay signed in</Text>
                </Pressable>
                <Pressable style={[styles.confirmSignOutBtn, signOutBusy && styles.btnDisabled]} disabled={signOutBusy} onPress={() => void handleSignOut()}>
                  <Text style={styles.confirmSignOutText}>{signOutBusy ? 'Signing out…' : 'Sign out'}</Text>
                </Pressable>
              </View>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
