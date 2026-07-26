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
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
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
  | { kind: 'error'; message: string };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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
  const { activate } = useChainActivation();

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
  const handleWalletConnect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStep({ kind: 'connecting', backend: 'external_mwa' });
    try {
      await solana.connect();
      await finishConnect();
    } catch (error: unknown) {
      setStep({
        kind: 'error',
        message: errorMessage(error, 'Could not connect a Solana wallet.'),
      });
    } finally {
      setBusy(false);
    }
  }, [busy, solana, finishConnect]);

  const title =
    step.kind === 'email_otp'
      ? 'Enter code'
      : step.kind === 'error'
        ? 'Connection failed'
        : 'Connect wallet';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={resetAndClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable onPress={resetAndClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
              <MaterialIcons name="close" size={18} color={semantic.text.dim} />
            </Pressable>
          </View>

          {step.kind === 'options' ? (
            <OptionsStep
              chain={chain}
              options={options}
              busy={busy}
              emailInput={emailInput}
              onChangeEmail={setEmailInput}
              onSendEmail={handleSendEmail}
              onPasskey={handlePasskey}
              onWalletConnect={handleWalletConnect}
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
      </View>
    </Modal>
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
}: {
  chain: Chain;
  options: readonly ConnectOption[];
  busy: boolean;
  emailInput: string;
  onChangeEmail: (value: string) => void;
  onSendEmail: () => void;
  onPasskey: () => void;
  onWalletConnect: () => void;
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

      {secondary.map((option) => (
        <Pressable
          key={option}
          style={({ pressed }) => [
            styles.secondaryBtn,
            busy && styles.primaryBtnDisabled,
            pressed && styles.primaryBtnPressed,
          ]}
          disabled={busy}
          onPress={option === 'passkey' ? onPasskey : onWalletConnect}
          accessibilityRole="button"
        >
          <MaterialIcons
            name={option === 'passkey' ? 'fingerprint' : 'account-balance-wallet'}
            size={16}
            color={semantic.text.dim}
          />
          <Text style={styles.secondaryBtnText}>
            {option === 'passkey' ? 'Sign in with Passkey' : 'Solana Wallet'}
          </Text>
        </Pressable>
      ))}
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
