/**
 * ConnectionSheet — the one connection surface in the product.
 *
 * Every entry point that needs a wallet opens this sheet rather than calling
 * `wallet.connect()` directly. Calling connect directly jumps straight to the
 * MWA system chooser on native, so a user who wants email or passkey never sees
 * those options — that gap is what this component closes by construction.
 *
 * The option list is *derived* from `CHAIN_BACKENDS` in `chain.contract`, not
 * hardcoded here. Mobile Wallet Adapter is Solana-only by specification, so an
 * EVM requirement drops the external-wallet row and nothing else. Adding an
 * external EVM transport later is a change to the capability table plus the
 * `BACKEND_OPTIONS` mapping below — no restructuring of this sheet.
 *
 * Visual language follows the four deposit/withdraw modals
 * (`features/perps/DepositModal.tsx`), not the drawer's monospace/uppercase
 * island.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The connection modal")
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import type { Chain, WalletBackend } from '@/features/chain/chain.contract';
import {
  availableOptions,
  type ConnectOption,
} from '@/features/wallet/components/connect.options';
import { useChainActivation } from '@/features/chain/activation';
import { usePrivyWallet } from '@/hooks/usePrivyWallet';
import { usePrivyEvmWallet } from '@/features/chain/usePrivyEvmWallet';
import { useWallet } from '@/hooks/useWallet';
import { semantic, tokens } from '@/theme';

type ConnectStep =
  | { kind: 'options' }
  | { kind: 'email_otp'; email: string }
  | { kind: 'connecting'; backend: WalletBackend }
  | { kind: 'confirm_disconnect' }
  | { kind: 'error'; message: string };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Did the user dismiss the wallet's own prompt?
 *
 * Wallet adapters signal this by throwing, with no error code to key off — so
 * matching the message text is the only option available. Kept deliberately
 * narrow: an unrecognised failure falls through to the error step rather than
 * being silently swallowed as a cancellation.
 */
function isUserCancelled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /plugin closed|user rejected|user denied|request rejected|cancell?ed/i.test(message);
}

export function ConnectionSheet({
  visible,
  chain,
  onClose,
  onConnected,
}: {
  visible: boolean;
  /** The chain the requesting application needs. Drives the option list. */
  chain: Chain;
  onClose: () => void;
  /** Fired after a backend resolves and the chain has been activated. */
  onConnected?: () => void;
}) {
  const privy = usePrivyWallet();
  const evm = usePrivyEvmWallet();
  const solana = useWallet();
  const { activate, deactivate } = useChainActivation();

  const [step, setStep] = useState<ConnectStep>({ kind: 'options' });
  const [emailInput, setEmailInput] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [busy, setBusy] = useState(false);

  const options = availableOptions(chain);

  /**
   * Clear every piece of step state before closing, so a later open never shows
   * a stale OTP screen or a previous error. Mirrors
   * `MeteoraPositionActionSheet.resetAndClose`.
   */
  const resetAndClose = useCallback(() => {
    setStep({ kind: 'options' });
    setEmailInput('');
    setOtpCode('');
    setBusy(false);
    onClose();
  }, [onClose]);

  /**
   * Record intent for the requested chain once a backend has resolved.
   *
   * Only the requested chain is activated. A user who logs in through an EVM
   * application does not get Solana surfaced — that is the dormancy rule, and
   * activating both here would quietly break it.
   *
   * For EVM, Privy auth alone provisions nothing (`createOnLogin: 'off'`), so
   * the embedded wallet is created here at the activation moment.
   */
  const finishConnect = useCallback(async () => {
    if (chain === 'evm' && !evm.isProvisioned) {
      await evm.provision();
    }
    await activate(chain);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    onConnected?.();
    resetAndClose();
  }, [chain, evm, activate, onConnected, resetAndClose]);

  const handleSendEmail = useCallback(async () => {
    const email = emailInput.trim();
    if (!email || busy) return;
    setBusy(true);
    try {
      await privy.sendEmailOTP(email);
      setStep({ kind: 'email_otp', email });
    } catch (error: unknown) {
      setStep({ kind: 'error', message: errorMessage(error, 'Failed to send code') });
    } finally {
      setBusy(false);
    }
  }, [emailInput, busy, privy]);

  const handleVerifyOTP = useCallback(async () => {
    if (!otpCode.trim() || busy) return;
    setBusy(true);
    try {
      await privy.loginWithEmailOTP(otpCode.trim());
      // Solana needs the embedded Solana wallet hydrated before the address is
      // usable. EVM provisions its own wallet in finishConnect.
      if (chain === 'solana') await privy.waitForWallet();
      await finishConnect();
    } catch (error: unknown) {
      setStep({ kind: 'error', message: errorMessage(error, 'Invalid code') });
    } finally {
      setBusy(false);
    }
  }, [otpCode, busy, privy, chain, finishConnect]);

  /**
   * Passkey login, falling back to signup.
   *
   * The drawer falls back on *any* throw, which turns a cancelled login or a
   * network blip into an unexpected signup prompt. Deliberately narrowed: the
   * fallback fires only when the failure looks like "no passkey exists for this
   * user yet". Anything else surfaces as an error step, which is what a user who
   * cancelled expects to see rather than a second system dialog.
   */
  const handlePasskey = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStep({ kind: 'connecting', backend: 'privy_embedded' });
    try {
      try {
        await privy.loginWithPasskey();
      } catch (loginError: unknown) {
        const message = errorMessage(loginError, '').toLowerCase();
        const isNoCredential =
          message.includes('no ')
          || message.includes('not found')
          || message.includes('no account')
          || message.includes('does not exist');
        if (!isNoCredential) throw loginError;
        await privy.signupWithPasskey();
      }
      if (chain === 'solana') await privy.waitForWallet();
      await finishConnect();
    } catch (error: unknown) {
      // Dismissing the system passkey prompt is a choice, not a failure.
      if (isUserCancelled(error)) {
        setStep({ kind: 'options' });
        return;
      }
      setStep({ kind: 'error', message: errorMessage(error, 'Passkey failed') });
    } finally {
      setBusy(false);
    }
  }, [busy, privy, chain, finishConnect]);

  /**
   * External Solana wallet over MWA.
   *
   * The drawer's version swallows every error and closes, so a user who
   * cancelled the wallet chooser or hit a transport failure sees the UI simply
   * vanish with nothing connected. Here the failure surfaces as an error step.
   */
  const handleWalletConnect = useCallback(async (walletName?: string) => {
    if (busy) return;
    setBusy(true);
    setStep({ kind: 'connecting', backend: 'external_mwa' });
    try {
      // Naming the wallet matters on web, where the adapter can enumerate
      // installed extensions: without one it silently connects to `wallets[0]`,
      // so a user with several extensions gets whichever happens to be first
      // rather than the one they meant. On native the argument is ignored —
      // MWA cannot enumerate, and the OS shows its own chooser.
      await solana.connect(walletName);
      await finishConnect();
    } catch (error: unknown) {
      // Cancelling is not a failure. Wallet adapters report a dismissed popup
      // as a thrown error ("Plugin Closed", "User rejected the request"), and
      // showing that as a connection failure blames the user for changing
      // their mind. Return to the options instead.
      if (isUserCancelled(error)) {
        setStep({ kind: 'options' });
        return;
      }
      setStep({
        kind: 'error',
        message: errorMessage(error, 'Could not connect a Solana wallet.'),
      });
    } finally {
      setBusy(false);
    }
  }, [busy, solana, finishConnect]);

  /**
   * A wallet is already connected for the requested chain, so the sheet shows
   * who you are rather than how to connect. Same sheet, two states — opening it
   * from the avatar when connected must not offer to connect again.
   */
  const connectedAddress = chain === 'solana' ? solana.address : evm.address;
  const isConnected = step.kind === 'options' && !!connectedAddress;

  const handleCopyAddress = useCallback(async () => {
    if (!connectedAddress) return;
    await Clipboard.setStringAsync(connectedAddress);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [connectedAddress]);

  /**
   * Confirmation is a step in the sheet, not `Alert.alert`.
   *
   * `Alert.alert` renders nothing on React Native Web — it is a no-op there, so
   * a confirm-then-act flow built on it silently never acts. The old drawer had
   * this bug too, which is why disconnect never worked in a browser.
   */
  const handleDisconnect = useCallback(() => {
    if (busy) return;
    setStep({ kind: 'confirm_disconnect' });
  }, [busy]);

  const confirmDisconnect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Drop the connection first, then the activation record. The reverse
      // order re-activates immediately: activation reconciles from the live
      // connection, so clearing the record while the wallet is still connected
      // just gets undone on the next render.
      if (chain === 'solana' && solana.disconnect) await solana.disconnect();
      else if (privy.isPrivyUser) await privy.disconnect();
      await deactivate(chain);
      resetAndClose();
    } catch (error) {
      setStep({
        kind: 'error',
        message: errorMessage(error, 'Could not disconnect.'),
      });
    } finally {
      setBusy(false);
    }
  }, [busy, chain, deactivate, solana, privy, resetAndClose]);

  const title =
    step.kind === 'email_otp'
      ? 'Enter code'
      : step.kind === 'error'
        ? 'Connection failed'
        : step.kind === 'confirm_disconnect'
          ? 'Disconnect?'
          : isConnected
            ? 'Wallet'
            : 'Connect wallet';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={resetAndClose}>
      {/*
        The sheet is bottom-anchored, so the keyboard covers the email and OTP
        inputs — the user cannot see what they are typing. Lifting the whole
        overlay is simpler than scrolling within the sheet, since its content is
        short enough to fit above the keyboard.
      */}
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable onPress={resetAndClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
              <MaterialIcons name="close" size={18} color={semantic.text.dim} />
            </Pressable>
          </View>

          {isConnected ? (
            <ConnectedStep
              address={connectedAddress}
              busy={busy}
              onCopy={handleCopyAddress}
              onDisconnect={handleDisconnect}
            />
          ) : null}

          {step.kind === 'confirm_disconnect' ? (
            <View style={styles.body}>
              <Text style={styles.infoText}>You can reconnect anytime.</Text>
              <Pressable
                style={({ pressed }) => [
                  styles.disconnectBtn,
                  busy && styles.primaryBtnDisabled,
                  pressed && styles.primaryBtnPressed,
                ]}
                onPress={confirmDisconnect}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Confirm disconnect"
              >
                <MaterialIcons name="power-settings-new" size={14} color={tokens.colors.vermillion} />
                <Text style={styles.disconnectText}>
                  {busy ? 'Disconnecting...' : 'Disconnect'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setStep({ kind: 'options' })}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={styles.backLink}>Cancel</Text>
              </Pressable>
            </View>
          ) : null}

          {step.kind === 'options' && !isConnected ? (
            <OptionsStep
              chain={chain}
              options={options}
              busy={busy}
              emailInput={emailInput}
              onChangeEmail={setEmailInput}
              onSendEmail={handleSendEmail}
              onPasskey={handlePasskey}
              onWalletConnect={handleWalletConnect}
              walletOptions={solana.walletOptions ?? []}
            />
          ) : null}

          {step.kind === 'email_otp' ? (
            <View style={styles.body}>
              <Text style={styles.infoText}>Code sent to {step.email}</Text>
              <View style={styles.inputRow}>
                <MaterialIcons name="pin" size={16} color={semantic.text.faint} />
                <TextInput
                  style={styles.input}
                  placeholder="Enter code"
                  placeholderTextColor={semantic.text.faint}
                  value={otpCode}
                  onChangeText={setOtpCode}
                  keyboardType="number-pad"
                  autoFocus
                />
              </View>
              <Pressable
                style={({ pressed }) => [
                  styles.primaryBtn,
                  (!otpCode.trim() || busy) && styles.primaryBtnDisabled,
                  pressed && styles.primaryBtnPressed,
                ]}
                disabled={!otpCode.trim() || busy}
                onPress={handleVerifyOTP}
                accessibilityRole="button"
              >
                {busy ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.primaryBtnText}>Verify Code</Text>
                )}
              </Pressable>
              <Pressable
                onPress={() => {
                  setOtpCode('');
                  setStep({ kind: 'options' });
                }}
                accessibilityRole="button"
              >
                <Text style={styles.backLink}>Back</Text>
              </Pressable>
            </View>
          ) : null}

          {step.kind === 'connecting' ? (
            <View style={styles.body}>
              <ActivityIndicator size="small" color={semantic.text.accent} />
              <Text style={styles.infoText}>
                {step.backend === 'external_mwa'
                  ? 'Waiting for your wallet app...'
                  : 'Connecting...'}
              </Text>
            </View>
          ) : null}

          {step.kind === 'error' ? (
            <View style={styles.body}>
              <View style={styles.errorRow}>
                <MaterialIcons name="error-outline" size={16} color={tokens.colors.vermillion} />
                <Text style={styles.errorText}>{step.message}</Text>
              </View>
              <Pressable
                style={({ pressed }) => [styles.primaryBtn, pressed && styles.primaryBtnPressed]}
                onPress={() => setStep({ kind: 'options' })}
                accessibilityRole="button"
              >
                <Text style={styles.primaryBtnText}>Try again</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * The sheet when a wallet is already connected: identity, not connection.
 *
 * Address and disconnect only. Balances and positions live in the wallet
 * module — this answers "who am I", not "what do I have".
 */
function ConnectedStep({
  address,
  busy,
  onCopy,
  onDisconnect,
}: {
  address: string;
  busy: boolean;
  onCopy: () => void;
  onDisconnect: () => void;
}) {
  const short = `${address.slice(0, 6)}···${address.slice(-4)}`;

  return (
    <View style={styles.body}>
      <Pressable
        style={({ pressed }) => [styles.addressRow, pressed && styles.primaryBtnPressed]}
        onPress={onCopy}
        accessibilityRole="button"
        accessibilityLabel={`Copy address ${short}`}
      >
        <View style={styles.addressText}>
          <Text style={styles.addressValue}>{short}</Text>
          <Text style={styles.addressHint}>Tap to copy</Text>
        </View>
        <MaterialIcons name="content-copy" size={16} color={semantic.text.dim} />
      </Pressable>

      <Pressable
        style={({ pressed }) => [
          styles.disconnectBtn,
          busy && styles.primaryBtnDisabled,
          pressed && styles.primaryBtnPressed,
        ]}
        onPress={onDisconnect}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel="Disconnect wallet"
      >
        <MaterialIcons name="power-settings-new" size={14} color={tokens.colors.vermillion} />
        <Text style={styles.disconnectText}>{busy ? 'Disconnecting...' : 'Disconnect'}</Text>
      </Pressable>
    </View>
  );
}

function OptionsStep({
  chain,
  options,
  busy,
  emailInput,
  onChangeEmail,
  onSendEmail,
  onPasskey,
  onWalletConnect,
  walletOptions,
}: {
  chain: Chain;
  options: readonly ConnectOption[];
  busy: boolean;
  emailInput: string;
  onChangeEmail: (value: string) => void;
  onSendEmail: () => void;
  onPasskey: () => void;
  onWalletConnect: (walletName?: string) => void;
  /** Detected external wallets. Empty where the platform cannot enumerate. */
  walletOptions: readonly { name: string; icon?: string }[];
}) {
  const hasEmail = options.includes('email');
  const secondary = options.filter((option) => option !== 'email');

  return (
    <View style={styles.body}>
      <Text style={styles.blurb}>
        {chain === 'evm'
          ? 'Sign in to create a wallet that can sign on Polygon and other EVM networks.'
          : 'Sign in, or connect a Solana wallet you already use.'}
      </Text>

      {hasEmail ? (
        <>
          <View style={styles.inputRow}>
            <MaterialIcons name="email" size={16} color={semantic.text.faint} />
            <TextInput
              style={styles.input}
              placeholder="you@email.com"
              placeholderTextColor={semantic.text.faint}
              value={emailInput}
              onChangeText={onChangeEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          <Pressable
            style={({ pressed }) => [
              styles.primaryBtn,
              (!emailInput.trim() || busy) && styles.primaryBtnDisabled,
              pressed && styles.primaryBtnPressed,
            ]}
            disabled={!emailInput.trim() || busy}
            onPress={onSendEmail}
            accessibilityRole="button"
          >
            {busy ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.primaryBtnText}>Continue with Email</Text>
            )}
          </Pressable>
        </>
      ) : null}

      {hasEmail && secondary.length > 0 ? (
        <View style={styles.orRow}>
          <View style={styles.orLine} />
          <Text style={styles.orText}>or</Text>
          <View style={styles.orLine} />
        </View>
      ) : null}

      {secondary.map((option) => {
        if (option === 'passkey') {
          return (
            <Pressable
              key={option}
              style={({ pressed }) => [
                styles.secondaryBtn,
                busy && styles.primaryBtnDisabled,
                pressed && styles.primaryBtnPressed,
              ]}
              disabled={busy}
              onPress={onPasskey}
              accessibilityRole="button"
            >
              <MaterialIcons name="fingerprint" size={16} color={semantic.text.dim} />
              <Text style={styles.secondaryBtnText}>Sign in with Passkey</Text>
            </Pressable>
          );
        }

        // One row per detected wallet where the platform can enumerate them
        // (web, via the wallet adapter). Naming the wallet is what stops the
        // adapter silently defaulting to `wallets[0]`. Native returns an empty
        // list — MWA cannot enumerate — so it falls through to a single button
        // and the OS shows its own chooser.
        if (walletOptions.length > 0) {
          return walletOptions.map((wallet) => (
            <Pressable
              key={wallet.name}
              style={({ pressed }) => [
                styles.secondaryBtn,
                busy && styles.primaryBtnDisabled,
                pressed && styles.primaryBtnPressed,
              ]}
              disabled={busy}
              onPress={() => onWalletConnect(wallet.name)}
              accessibilityRole="button"
              accessibilityLabel={`Connect ${wallet.name}`}
            >
              {wallet.icon ? (
                <Image source={{ uri: wallet.icon }} style={styles.walletIcon} />
              ) : (
                <MaterialIcons name="account-balance-wallet" size={16} color={semantic.text.dim} />
              )}
              <Text style={styles.secondaryBtnText}>{wallet.name}</Text>
            </Pressable>
          ));
        }

        return (
          <Pressable
            key={option}
            style={({ pressed }) => [
              styles.secondaryBtn,
              busy && styles.primaryBtnDisabled,
              pressed && styles.primaryBtnPressed,
            ]}
            disabled={busy}
            onPress={() => onWalletConnect()}
            accessibilityRole="button"
          >
            <MaterialIcons name="account-balance-wallet" size={16} color={semantic.text.dim} />
            <Text style={styles.secondaryBtnText}>Solana Wallet</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: semantic.background.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 1,
    borderColor: semantic.border.muted,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: semantic.border.muted,
  },
  title: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
    color: semantic.text.primary,
    letterSpacing: 1,
  },
  body: {
    padding: tokens.spacing.lg,
    gap: tokens.spacing.md,
    paddingBottom: 40,
    alignItems: 'stretch',
  },
  blurb: {
    fontSize: tokens.fontSize.sm,
    lineHeight: 18,
    color: semantic.text.dim,
    textAlign: 'center',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: semantic.background.lift,
    borderRadius: tokens.radius.md,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    paddingHorizontal: tokens.spacing.md,
    gap: tokens.spacing.sm,
  },
  input: {
    flex: 1,
    fontSize: tokens.fontSize.md,
    color: semantic.text.primary,
    paddingVertical: tokens.spacing.md,
  },
  primaryBtn: {
    backgroundColor: tokens.colors.viridian,
    borderRadius: tokens.radius.md,
    paddingVertical: tokens.spacing.md + 2,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  primaryBtnDisabled: {
    opacity: 0.4,
  },
  primaryBtnPressed: {
    opacity: 0.8,
  },
  primaryBtnText: {
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
    color: '#fff',
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacing.sm,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: tokens.radius.md,
    paddingVertical: tokens.spacing.md + 2,
    minHeight: 44,
  },
  secondaryBtnText: {
    fontSize: tokens.fontSize.md,
    fontWeight: '600',
    color: semantic.text.dim,
  },
  walletIcon: {
    width: 16,
    height: 16,
    borderRadius: 4,
  },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacing.md,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: tokens.radius.md,
    paddingVertical: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.md,
    minHeight: 44,
  },
  addressText: {
    gap: 2,
  },
  addressValue: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.md,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  addressHint: {
    fontSize: tokens.fontSize.xs,
    color: semantic.text.faint,
  },
  disconnectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacing.sm,
    borderWidth: 1,
    borderColor: 'rgba(239,71,111,0.35)',
    borderRadius: tokens.radius.md,
    paddingVertical: tokens.spacing.md + 2,
    minHeight: 44,
  },
  disconnectText: {
    fontSize: tokens.fontSize.md,
    fontWeight: '600',
    color: tokens.colors.vermillion,
  },
  orRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.md,
  },
  orLine: {
    flex: 1,
    height: 1,
    backgroundColor: semantic.border.muted,
  },
  orText: {
    fontSize: tokens.fontSize.sm,
    color: semantic.text.faint,
  },
  infoText: {
    fontSize: tokens.fontSize.sm,
    color: semantic.text.dim,
    textAlign: 'center',
    paddingVertical: tokens.spacing.sm,
  },
  backLink: {
    fontSize: tokens.fontSize.sm,
    color: semantic.text.dim,
    textAlign: 'center',
    paddingVertical: tokens.spacing.sm,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.sm,
    paddingVertical: tokens.spacing.sm,
    paddingHorizontal: tokens.spacing.md,
    backgroundColor: 'rgba(239,71,111,0.08)',
    borderRadius: tokens.radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(239,71,111,0.20)',
  },
  errorText: {
    flex: 1,
    fontSize: tokens.fontSize.sm,
    lineHeight: 18,
    color: tokens.colors.vermillion,
  },
});
