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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Keyboard,
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
  | { kind: 'confirm_disconnect'; chain: Chain }
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
  /**
   * How far the sheet is lifted so the keyboard does not cover it.
   *
   * The sheet stays bottom-anchored and simply translates upward by the
   * keyboard's height — one continuous motion, driven by the keyboard's own
   * show/hide events so it uses the same duration and easing the OS does.
   *
   * An earlier version re-anchored the sheet to the top of the screen while a
   * field held focus. That required cross-fading between two positions, which
   * read as the sheet vanishing and reappearing somewhere else rather than as
   * a sheet moving.
   */
  const keyboardLift = useRef(new Animated.Value(0)).current;
  /** True while the sheet is lifted, so the body can shed its bottom padding. */
  const [lifted, setLifted] = useState(false);

  /**
   * Track the keyboard and lift the sheet by exactly its height.
   *
   * iOS only. Android's manifest sets `windowSoftInputMode="adjustResize"`, so
   * the OS already shrinks the window and a bottom-anchored sheet rides up on
   * its own; animating it here as well is what made the sheet jitter
   * previously — two systems moving the same view.
   *
   * `keyboardWillShow` fires *before* the keyboard animates and carries the
   * OS's own duration, so matching it makes the sheet and the keyboard move as
   * one. (Android has no `will` event, which is the other reason this is
   * iOS-only.)
   */
  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    const onShow = Keyboard.addListener('keyboardWillShow', (event) => {
      setLifted(true);
      Animated.timing(keyboardLift, {
        toValue: event.endCoordinates.height,
        duration: event.duration || 250,
        useNativeDriver: true,
      }).start();
    });

    const onHide = Keyboard.addListener('keyboardWillHide', (event) => {
      Animated.timing(keyboardLift, {
        toValue: 0,
        duration: event.duration || 250,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setLifted(false);
      });
    });

    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, [keyboardLift]);

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
    // The keyboard's hide event does not fire when the sheet unmounts with a
    // field still focused, so the lift is reset here rather than left to
    // carry over into the next open.
    setLifted(false);
    keyboardLift.setValue(0);
    onClose();
  }, [onClose, keyboardLift]);

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
      // Throws with a readable message when the account has an unusable wallet
      // (entropy missing on this device), which the error step then shows.
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
   * Google login.
   *
   * Unlike email and passkey, this leaves the app: Privy opens a browser for
   * Google's consent screen and returns through the `myboon` deep link declared
   * in `app.json`. Signup and login are the same call — Privy creates the
   * account if the Google identity is new.
   */
  const handleGoogle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStep({ kind: 'connecting', backend: 'privy_embedded' });
    try {
      await privy.loginWithGoogle();
      if (chain === 'solana') await privy.waitForWallet();
      await finishConnect();
    } catch (error: unknown) {
      // Closing the browser without finishing is a choice, not a failure.
      if (isUserCancelled(error)) {
        setStep({ kind: 'options' });
        return;
      }
      setStep({ kind: 'error', message: errorMessage(error, 'Google sign-in failed') });
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
  /**
   * Every wallet this session actually holds, not just the requested chain's.
   *
   * The avatar opens this sheet for Solana (the provider's default), so a user
   * whose only wallet is the Privy EVM one saw an empty connect screen and had
   * no way to sign out — the disconnect control was reachable only from a chain
   * they had not connected. Listing both chains makes the sheet report the
   * session rather than one slice of it.
   */
  const connectedWallets = useMemo(
    () => [
      ...(solana.address
        ? [{ chain: 'solana' as Chain, label: 'Solana', address: solana.address }]
        : []),
      ...(evm.address
        ? [{ chain: 'evm' as Chain, label: 'Polygon / EVM', address: evm.address }]
        : []),
    ],
    [solana.address, evm.address],
  );

  const isConnected = step.kind === 'options' && connectedWallets.length > 0;

  const handleCopyAddress = useCallback(async (address: string) => {
    await Clipboard.setStringAsync(address);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, []);

  /**
   * Confirmation is a step in the sheet, not `Alert.alert`.
   *
   * `Alert.alert` renders nothing on React Native Web — it is a no-op there, so
   * a confirm-then-act flow built on it silently never acts. The old drawer had
   * this bug too, which is why disconnect never worked in a browser.
   */
  const handleDisconnect = useCallback((target: Chain) => {
    if (busy) return;
    setStep({ kind: 'confirm_disconnect', chain: target });
  }, [busy]);

  const confirmDisconnect = useCallback(async () => {
    if (busy) return;
    const target = step.kind === 'confirm_disconnect' ? step.chain : chain;
    setBusy(true);
    try {
      // Drop the connection first, then the activation record. The reverse
      // order re-activates immediately: activation reconciles from the live
      // connection, so clearing the record while the wallet is still connected
      // just gets undone on the next render.
      //
      // An external Solana wallet can be dropped on its own. The Privy embedded
      // wallets cannot: one login owns every chain, so signing out of Privy ends
      // both. `privy.disconnect()` calls `clearActivation()` for that reason,
      // and deactivating the single requested chain afterwards would be a no-op
      // over an already-cleared record.
      if (target === 'solana' && solana.source !== 'privy' && solana.disconnect) {
        await solana.disconnect();
        await deactivate(target);
      } else if (privy.isPrivyUser) {
        await privy.disconnect();
      } else if (solana.disconnect) {
        await solana.disconnect();
        await deactivate(target);
      }
      resetAndClose();
    } catch (error) {
      setStep({
        kind: 'error',
        message: errorMessage(error, 'Could not disconnect.'),
      });
    } finally {
      setBusy(false);
    }
  }, [busy, chain, step, deactivate, solana, privy, resetAndClose]);

  const title =
    step.kind === 'email_otp'
      ? 'Enter code'
      : step.kind === 'error'
        ? 'Connection failed'
        : step.kind === 'confirm_disconnect'
          ? 'Disconnect?'
          : isConnected
            ? (connectedWallets.length > 1 ? 'Wallets' : 'Wallet')
            : 'Connect wallet';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={resetAndClose}>
      {/*
        The sheet stays bottom-anchored and slides up by the keyboard's height
        when it opens, so the email and OTP inputs clear it without the sheet
        ever changing position on screen or disappearing.

        `translateY` rather than `KeyboardAvoidingView`: `behavior="padding"`
        resizes the sheet, which reflows its contents mid-animation. Moving the
        whole view leaves the layout untouched, and `useNativeDriver` runs it
        off the JS thread so it tracks the keyboard smoothly.

        iOS only — see the listener above for why Android is left to
        `adjustResize`.

        The sheet carries a fixed `paddingBottom` equal to the screen height
        while lifted, so its own background fills the strip the translate opens
        up underneath it — otherwise the dark overlay shows through between the
        sheet and the keyboard. It is a plain style rather than an animated one
        because padding cannot be driven natively, and mixing a JS-driven
        property into this animation would put it back on the JS thread.
      */}
      <View style={styles.overlay}>
        <Animated.View
          style={[
            styles.sheet,
            lifted && styles.sheetLifted,
            { transform: [{ translateY: Animated.multiply(keyboardLift, -1) }] },
          ]}
        >
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable onPress={resetAndClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
              <MaterialIcons name="close" size={18} color={semantic.text.dim} />
            </Pressable>
          </View>

          {isConnected ? (
            <ConnectedStep
              wallets={connectedWallets}
              busy={busy}
              onCopy={handleCopyAddress}
              onDisconnect={handleDisconnect}
            />
          ) : null}

          {step.kind === 'confirm_disconnect' ? (
            <View style={styles.body}>
              {/*
                Say what actually happens. One Privy login owns every embedded
                chain, so signing out of it drops Solana and EVM together —
                promising a per-chain disconnect it cannot deliver would be a
                lie the next screen exposes.
              */}
              <Text style={styles.infoText}>
                {privy.isPrivyUser && !(step.chain === 'solana' && solana.source !== 'privy')
                  ? 'This signs you out of Privy and disconnects every wallet in this session. You can sign back in anytime.'
                  : 'You can reconnect anytime.'}
              </Text>
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
              compactBody={lifted}
              onGoogle={handleGoogle}
              onWalletConnect={handleWalletConnect}
              walletOptions={solana.walletOptions ?? []}
            />
          ) : null}

          {step.kind === 'email_otp' ? (
            <View style={[styles.body, lifted && styles.bodyLifted]}>
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
        </Animated.View>
      </View>
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
  wallets,
  busy,
  onCopy,
  onDisconnect,
}: {
  /** Every wallet held this session, one row each. */
  wallets: readonly { chain: Chain; label: string; address: string }[];
  busy: boolean;
  onCopy: (address: string) => void;
  onDisconnect: (chain: Chain) => void;
}) {
  return (
    <View style={styles.body}>
      {wallets.map((wallet) => {
        const short = `${wallet.address.slice(0, 6)}···${wallet.address.slice(-4)}`;
        return (
          <View key={wallet.chain} style={styles.walletGroup}>
            <Text style={styles.chainLabel}>{wallet.label}</Text>
            <Pressable
              style={({ pressed }) => [styles.addressRow, pressed && styles.primaryBtnPressed]}
              onPress={() => onCopy(wallet.address)}
              accessibilityRole="button"
              accessibilityLabel={`Copy ${wallet.label} address ${short}`}
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
              onPress={() => onDisconnect(wallet.chain)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`Disconnect ${wallet.label} wallet`}
            >
              <MaterialIcons name="power-settings-new" size={14} color={tokens.colors.vermillion} />
              <Text style={styles.disconnectText}>
                {busy ? 'Disconnecting...' : `Disconnect ${wallet.label}`}
              </Text>
            </Pressable>
          </View>
        );
      })}
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
  compactBody,
  onGoogle,
  onWalletConnect,
  walletOptions,
}: {
  chain: Chain;
  options: readonly ConnectOption[];
  busy: boolean;
  emailInput: string;
  onChangeEmail: (value: string) => void;
  onSendEmail: () => void;
  /** True while the sheet is lifted, so the body can drop its bottom padding. */
  compactBody: boolean;
  onGoogle: () => void;
  onWalletConnect: (walletName?: string) => void;
  /** Detected external wallets. Empty where the platform cannot enumerate. */
  walletOptions: readonly { name: string; icon?: string }[];
}) {
  const hasEmail = options.includes('email');
  const secondary = options.filter((option) => option !== 'email');

  return (
    <View style={[styles.body, compactBody && styles.bodyLifted]}>
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
        if (option === 'google') {
          return (
            <Pressable
              key={option}
              style={({ pressed }) => [
                styles.secondaryBtn,
                busy && styles.primaryBtnDisabled,
                pressed && styles.primaryBtnPressed,
              ]}
              disabled={busy}
              onPress={onGoogle}
              accessibilityRole="button"
            >
              <MaterialIcons name="account-circle" size={16} color={semantic.text.dim} />
              <Text style={styles.secondaryBtnText}>Continue with Google</Text>
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
  /**
   * Extends the sheet's own background below its content while it is lifted,
   * so the strip the `translateY` opens up underneath shows sheet rather than
   * the dark overlay. Any value at least as tall as the tallest keyboard works;
   * the excess is simply off-screen.
   */
  sheetLifted: {
    paddingBottom: 400,
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
  /**
   * `body`'s 40pt bottom padding clears the home indicator on a resting bottom
   * sheet. Lifted above the keyboard there is no home indicator to clear, so
   * it is only dead space between the last control and the keyboard.
   */
  bodyLifted: {
    paddingBottom: tokens.spacing.lg,
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
  walletGroup: {
    gap: tokens.spacing.sm,
  },
  chainLabel: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: semantic.text.faint,
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
