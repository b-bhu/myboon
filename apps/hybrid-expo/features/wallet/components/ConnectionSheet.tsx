/**
 * The app-wide wallet surface.
 *
 * The provider owns the single mounted instance. Screens pass either a manager
 * intent or a chain-specific requirement; this component only renders and
 * fulfils that intent.
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useChainActivation } from '@/features/chain/activation';
import type { Chain, WalletBackend } from '@/features/chain/chain.contract';
import { usePrivyEvmWallet } from '@/features/chain/usePrivyEvmWallet';
import type { ConnectOption } from '@/features/wallet/components/connect.options';
import {
  deriveWalletSheetPresentation,
  type WalletRowPresentation,
  type WalletSessionSnapshot,
  type WalletSheetIntent,
} from '@/features/wallet/components/walletSheet.presentation';
import { usePrivyWallet } from '@/hooks/usePrivyWallet';
import { useWallet } from '@/hooks/useWallet';
import { semantic, tokens } from '@/theme';

const SUPPORT_URL = 'https://www.myboon.tech/';

type SheetStep =
  | { kind: 'options' }
  | { kind: 'email_otp'; email: string }
  | { kind: 'connecting'; backend: WalletBackend; chain: Chain }
  | { kind: 'confirm_disconnect'; wallet: WalletRowPresentation }
  | { kind: 'error'; message: string };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function isUserCancelled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /plugin closed|user rejected|user denied|request rejected|cancell?ed/i.test(message);
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}···${address.slice(-4)}`;
}

export function ConnectionSheet({
  visible,
  intent,
  onClose,
  onTechnicalFailure,
  onRetry,
}: {
  visible: boolean;
  intent: WalletSheetIntent;
  onClose: () => void;
  onTechnicalFailure: (error: Error) => void;
  onRetry: () => void;
}) {
  const privy = usePrivyWallet();
  const evm = usePrivyEvmWallet();
  const solana = useWallet();
  const { activation, isHydrated, activate, deactivate } = useChainActivation();

  const [step, setStep] = useState<SheetStep>({ kind: 'options' });
  const [emailInput, setEmailInput] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [busy, setBusy] = useState(false);
  const keyboardLift = useRef(new Animated.Value(0)).current;
  const [lifted, setLifted] = useState(false);

  const targetChain: Chain = intent.kind === 'requirement' ? intent.chain : 'solana';

  const session = useMemo<WalletSessionSnapshot>(() => ({
    activationHydrated: isHydrated,
    privyAuthenticated: evm.isPrivyUser,
    embeddedProvisionedChains: [
      ...(privy.connected ? ['solana' as const] : []),
      ...(evm.isProvisioned ? ['evm' as const] : []),
    ],
    accounts: [
      {
        chain: 'solana',
        address: solana.connected ? solana.address : null,
        active: activation.solana,
        usable: solana.connected && !!solana.address && !!solana.signMessage,
        source: solana.source === 'mwa' ? 'external_wallet' : 'myboon_wallet',
      },
      {
        chain: 'evm',
        address: evm.address,
        active: activation.evm,
        usable: evm.isProvisioned && !!evm.address && !!evm.request && !evm.needsRecovery,
        source: 'myboon_wallet',
      },
    ],
    recoveryChains: [
      ...(privy.needsRecovery && !(solana.connected && solana.source === 'mwa')
        ? ['solana' as const]
        : []),
      ...(evm.needsRecovery ? ['evm' as const] : []),
    ],
  }), [
    activation.evm,
    activation.solana,
    evm.address,
    evm.isPrivyUser,
    evm.isProvisioned,
    evm.needsRecovery,
    evm.request,
    isHydrated,
    privy.connected,
    privy.needsRecovery,
    solana.address,
    solana.connected,
    solana.signMessage,
    solana.source,
  ]);

  const presentation = useMemo(
    () => deriveWalletSheetPresentation(intent, session),
    [intent, session],
  );

  const resetState = useCallback(() => {
    setStep({ kind: 'options' });
    setEmailInput('');
    setOtpCode('');
    setBusy(false);
    setLifted(false);
    keyboardLift.setValue(0);
  }, [keyboardLift]);

  const resetAndClose = useCallback(() => {
    Keyboard.dismiss();
    resetState();
    onClose();
  }, [onClose, resetState]);

  useEffect(() => {
    if (visible) resetState();
  }, [intent, resetState, visible]);

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

  useEffect(() => {
    if (Platform.OS === 'ios') return;
    const onShow = Keyboard.addListener('keyboardDidShow', () => setLifted(true));
    const onHide = Keyboard.addListener('keyboardDidHide', () => setLifted(false));
    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, []);

  const reportFailure = useCallback((error: unknown, fallback: string) => {
    const technicalFailure = asError(error, fallback);
    onTechnicalFailure(technicalFailure);
    setStep({ kind: 'error', message: errorMessage(technicalFailure, fallback) });
  }, [onTechnicalFailure]);

  const retry = useCallback(() => {
    onRetry();
    setStep({ kind: 'options' });
  }, [onRetry]);

  const activateMyboonWallet = useCallback(async (chain: Chain) => {
    if (chain === 'evm') await evm.provision();
    else await privy.waitForWallet();
    await activate(chain);
    if (Platform.OS === 'ios') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }, [activate, evm, privy]);

  const handleUseMyboon = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStep({ kind: 'connecting', backend: 'privy_embedded', chain: targetChain });
    try {
      await activateMyboonWallet(targetChain);
      setStep({ kind: 'options' });
    } catch (error) {
      reportFailure(error, `Could not prepare your ${targetChain === 'evm' ? 'Polygon' : 'Solana'} wallet.`);
    } finally {
      setBusy(false);
    }
  }, [activateMyboonWallet, busy, reportFailure, targetChain]);

  const handleSendEmail = useCallback(async () => {
    const email = emailInput.trim();
    if (!email || busy) return;
    setBusy(true);
    try {
      await privy.sendEmailOTP(email);
      setStep({ kind: 'email_otp', email });
    } catch (error) {
      reportFailure(error, 'Failed to send the email code.');
    } finally {
      setBusy(false);
    }
  }, [busy, emailInput, privy, reportFailure]);

  const handleVerifyOTP = useCallback(async () => {
    const code = otpCode.trim();
    if (!code || busy) return;
    setBusy(true);
    try {
      await privy.loginWithEmailOTP(code);
      await activateMyboonWallet(targetChain);
      setStep({ kind: 'options' });
    } catch (error) {
      reportFailure(error, 'Could not verify the email code.');
    } finally {
      setBusy(false);
    }
  }, [activateMyboonWallet, busy, otpCode, privy, reportFailure, targetChain]);

  const handleGoogle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStep({ kind: 'connecting', backend: 'privy_embedded', chain: targetChain });
    try {
      await privy.loginWithGoogle();
      await activateMyboonWallet(targetChain);
      setStep({ kind: 'options' });
    } catch (error) {
      if (isUserCancelled(error)) {
        setStep({ kind: 'options' });
      } else {
        reportFailure(error, 'Google sign-in failed.');
      }
    } finally {
      setBusy(false);
    }
  }, [activateMyboonWallet, busy, privy, reportFailure, targetChain]);

  const handleExternalWallet = useCallback(async (walletName?: string) => {
    if (busy) return;
    setBusy(true);
    setStep({ kind: 'connecting', backend: 'external_mwa', chain: 'solana' });
    try {
      await solana.connect(walletName);
      await activate('solana');
      setStep({ kind: 'options' });
    } catch (error) {
      if (isUserCancelled(error)) {
        setStep({ kind: 'options' });
      } else {
        reportFailure(error, 'Could not connect a Solana wallet.');
      }
    } finally {
      setBusy(false);
    }
  }, [activate, busy, reportFailure, solana]);

  const handleCopy = useCallback(async (address: string) => {
    await Clipboard.setStringAsync(address);
    if (Platform.OS === 'ios') {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }, []);

  const confirmDisconnect = useCallback(async () => {
    if (busy || step.kind !== 'confirm_disconnect') return;
    const { wallet } = step;
    setBusy(true);
    try {
      if (wallet.chain === 'solana' && wallet.source === 'external_wallet') {
        await solana.disconnect?.();
        // Deliberately do not activate an embedded Solana wallet here. A new
        // signer must be chosen explicitly through the in-app wallet action.
        await deactivate('solana');
      } else {
        // Privy authentication is shared by its embedded chain wallets. Preserve
        // a separately connected external Solana session across that logout.
        const keepExternalSolana = solana.connected && solana.source === 'mwa';
        await privy.disconnect();
        if (keepExternalSolana) await activate('solana');
      }
      setStep({ kind: 'options' });
    } catch (error) {
      reportFailure(error, 'Could not disconnect the wallet.');
    } finally {
      setBusy(false);
    }
  }, [activate, busy, deactivate, privy, reportFailure, solana, step]);

  const renderBaseContent = () => {
    if (presentation.kind === 'preparing') {
      return <StatusBody icon="hourglass-empty" text={presentation.body} loading />;
    }

    if (presentation.kind === 'recovery') {
      return (
        <View style={styles.body}>
          <RecoveryNotice body={presentation.body} />
          {presentation.reassurance ? <Text style={styles.reassurance}>{presentation.reassurance}</Text> : null}
          <PrimaryButton
            label={presentation.actionLabel ?? 'Open myboon support'}
            onPress={() => void Linking.openURL(SUPPORT_URL)}
            icon="support-agent"
          />
        </View>
      );
    }

    if (presentation.kind === 'requirement_satisfied') {
      return (
        <View style={styles.body}>
          <StatusBody icon="check-circle" text={presentation.body} />
          <WalletRows wallets={presentation.wallets} onCopy={handleCopy} />
          {presentation.reassurance ? <Text style={styles.reassurance}>{presentation.reassurance}</Text> : null}
        </View>
      );
    }

    if (presentation.kind === 'manage_wallets') {
      return (
        <View style={styles.body}>
          <WalletRows
            wallets={presentation.wallets}
            onCopy={handleCopy}
            onDisconnect={(wallet) => setStep({ kind: 'confirm_disconnect', wallet })}
          />
          {presentation.recoveryChains.length > 0 ? (
            <>
              <RecoveryNotice body="A recorded wallet cannot sign on this device. Contact myboon support before creating another wallet." />
              <SecondaryButton label="Open myboon support" icon="support-agent" onPress={() => void Linking.openURL(SUPPORT_URL)} />
            </>
          ) : null}
        </View>
      );
    }

    return (
      <OptionsBody
        actionLabel={presentation.actionLabel}
        options={presentation.options}
        busy={busy}
        compact={lifted}
        emailInput={emailInput}
        onChangeEmail={setEmailInput}
        onSendEmail={handleSendEmail}
        onGoogle={handleGoogle}
        onExternalWallet={handleExternalWallet}
        onUseMyboon={handleUseMyboon}
        walletOptions={solana.walletOptions ?? []}
        reassurance={presentation.reassurance}
      />
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={resetAndClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? undefined : 'height'}
      >
        <Pressable style={styles.backdrop} onPress={resetAndClose} accessibilityLabel="Dismiss wallet sheet" />
        <Animated.View
          style={[
            styles.sheet,
            Platform.OS === 'ios' && lifted && styles.sheetLifted,
            { transform: [{ translateY: Animated.multiply(keyboardLift, -1) }] },
          ]}
        >
          <View style={styles.rail}>
            <Text style={styles.railText}>{presentation.contextRail}</Text>
          </View>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.title}>
                {step.kind === 'email_otp'
                  ? 'Enter code'
                  : step.kind === 'connecting'
                    ? 'Preparing wallet'
                    : step.kind === 'confirm_disconnect'
                      ? 'Disconnect wallet?'
                      : step.kind === 'error'
                        ? 'Wallet connection failed'
                        : presentation.title}
              </Text>
              {step.kind === 'options' ? <Text style={styles.subtitle}>{presentation.body}</Text> : null}
            </View>
            <Pressable
              style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
              onPress={resetAndClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <MaterialIcons name="close" size={20} color={semantic.text.dim} />
            </Pressable>
          </View>

          {step.kind === 'options' ? renderBaseContent() : null}

          {step.kind === 'email_otp' ? (
            <View style={[styles.body, lifted && styles.bodyLifted]}>
              <Text style={styles.infoText}>We sent a code to {step.email}.</Text>
              <InputRow icon="pin" value={otpCode} onChangeText={setOtpCode} placeholder="Enter code" keyboardType="number-pad" autoFocus />
              <PrimaryButton label={busy ? 'Verifying…' : 'Verify code'} onPress={handleVerifyOTP} disabled={!otpCode.trim() || busy} loading={busy} />
              <TextButton label="Back" onPress={() => { setOtpCode(''); setStep({ kind: 'options' }); }} />
            </View>
          ) : null}

          {step.kind === 'connecting' ? (
            <StatusBody
              loading
              icon="hourglass-empty"
              text={step.backend === 'external_mwa'
                ? 'Waiting for your wallet app…'
                : step.chain === 'evm'
                  ? 'Creating your Polygon wallet…'
                  : privy.connected
                    ? 'Activating your Solana wallet…'
                    : 'Creating your Solana wallet…'}
            />
          ) : null}

          {step.kind === 'confirm_disconnect' ? (
            <View style={styles.body}>
              <Text style={styles.infoText}>
                {step.wallet.source === 'external_wallet'
                  ? 'Solana will become inactive. myboon will not silently switch transactions to another signer.'
                  : 'This signs you out and disconnects the Polygon and Solana wallets linked to this account. A separate external Solana wallet stays connected.'}
              </Text>
              <DangerButton label={busy ? 'Disconnecting…' : `Disconnect ${step.wallet.chainLabel}`} disabled={busy} onPress={confirmDisconnect} />
              <TextButton label="Cancel" disabled={busy} onPress={() => setStep({ kind: 'options' })} />
            </View>
          ) : null}

          {step.kind === 'error' ? (
            <View style={styles.body}>
              <View style={styles.errorRow}>
                <MaterialIcons name="error-outline" size={18} color={tokens.colors.vermillion} />
                <Text style={styles.errorText}>{step.message}</Text>
              </View>
              <PrimaryButton label="Try again" onPress={retry} />
            </View>
          ) : null}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function OptionsBody({
  actionLabel,
  options,
  busy,
  compact,
  emailInput,
  onChangeEmail,
  onSendEmail,
  onGoogle,
  onExternalWallet,
  onUseMyboon,
  walletOptions,
  reassurance,
}: {
  actionLabel: string | null;
  options: readonly ConnectOption[];
  busy: boolean;
  compact: boolean;
  emailInput: string;
  onChangeEmail: (value: string) => void;
  onSendEmail: () => void;
  onGoogle: () => void;
  onExternalWallet: (walletName?: string) => void;
  onUseMyboon: () => void;
  walletOptions: readonly { name: string; icon?: string }[];
  reassurance: string | null;
}) {
  const hasEmail = options.includes('email');
  const hasGoogle = options.includes('google');
  const hasExternal = options.includes('external_wallet');

  return (
    <View style={[styles.body, compact && styles.bodyLifted]}>
      {actionLabel ? <PrimaryButton label={actionLabel} onPress={onUseMyboon} disabled={busy} icon="account-balance-wallet" /> : null}
      {hasEmail ? (
        <>
          <InputRow icon="email" value={emailInput} onChangeText={onChangeEmail} placeholder="you@email.com" keyboardType="email-address" />
          <PrimaryButton label={busy ? 'Sending…' : 'Continue with email'} onPress={onSendEmail} disabled={!emailInput.trim() || busy} loading={busy} />
        </>
      ) : null}
      {(hasEmail || actionLabel) && (hasGoogle || hasExternal) ? <Divider /> : null}
      {hasGoogle ? <SecondaryButton label="Continue with Google" icon="account-circle" onPress={onGoogle} disabled={busy} /> : null}
      {hasExternal && walletOptions.length > 0
        ? walletOptions.map((wallet) => (
            <ExternalWalletButton key={wallet.name} wallet={wallet} disabled={busy} onPress={() => onExternalWallet(wallet.name)} />
          ))
        : null}
      {hasExternal && walletOptions.length === 0 ? (
        <SecondaryButton label="Connect external wallet" icon="account-balance-wallet" onPress={() => onExternalWallet()} disabled={busy} />
      ) : null}
      {reassurance ? <Text style={styles.reassurance}>{reassurance}</Text> : null}
    </View>
  );
}

function WalletRows({
  wallets,
  onCopy,
  onDisconnect,
}: {
  wallets: readonly WalletRowPresentation[];
  onCopy: (address: string) => void;
  onDisconnect?: (wallet: WalletRowPresentation) => void;
}) {
  return (
    <View style={styles.walletList}>
      {wallets.map((wallet) => (
        <View key={wallet.chain} style={styles.walletCard}>
          <View style={styles.walletCardHeader}>
            <View style={styles.walletIdentity}>
              <Text style={styles.walletChain}>{wallet.displayLabel}</Text>
              <Text style={styles.walletSource}>{wallet.sourceLabel}</Text>
            </View>
          </View>
          <Pressable
            style={({ pressed }) => [styles.addressRow, pressed && styles.pressed]}
            onPress={() => onCopy(wallet.address)}
            accessibilityRole="button"
            accessibilityLabel={`Copy ${wallet.chainLabel} address ${shortAddress(wallet.address)}`}
          >
            <Text style={styles.address}>{shortAddress(wallet.address)}</Text>
            <MaterialIcons name="content-copy" size={17} color={semantic.text.dim} />
          </Pressable>
          {onDisconnect ? <DangerButton label={`Disconnect ${wallet.chainLabel}`} onPress={() => onDisconnect(wallet)} /> : null}
        </View>
      ))}
    </View>
  );
}

function RecoveryNotice({ body }: { body: string }) {
  return (
    <View style={styles.recoveryNotice}>
      <MaterialIcons name="phonelink-erase" size={20} color={semantic.text.dim} />
      <View style={styles.recoveryCopy}>
        <Text style={styles.recoveryTitle}>Wallet unavailable on this device</Text>
        <Text style={styles.recoveryBody}>{body}</Text>
      </View>
    </View>
  );
}

function StatusBody({ text, icon, loading = false }: { text: string; icon: keyof typeof MaterialIcons.glyphMap; loading?: boolean }) {
  return (
    <View style={styles.statusBody}>
      {loading ? <ActivityIndicator size="small" color={semantic.text.accent} /> : <MaterialIcons name={icon} size={26} color={tokens.colors.viridian} />}
      <Text style={styles.infoText}>{text}</Text>
    </View>
  );
}

function InputRow({ value, onChangeText, placeholder, icon, keyboardType, autoFocus = false }: {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  keyboardType: 'email-address' | 'number-pad';
  autoFocus?: boolean;
}) {
  return (
    <View style={styles.inputRow}>
      <MaterialIcons name={icon} size={18} color={semantic.text.faint} />
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={semantic.text.faint}
        keyboardType={keyboardType}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

function PrimaryButton({ label, onPress, disabled = false, loading = false, icon }: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  icon?: keyof typeof MaterialIcons.glyphMap;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.primaryButton, disabled && styles.disabled, pressed && styles.pressed]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
    >
      {loading ? <ActivityIndicator size="small" color="#fff" /> : icon ? <MaterialIcons name={icon} size={18} color="#fff" /> : null}
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({ label, icon, onPress, disabled = false }: {
  label: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.secondaryButton, disabled && styles.disabled, pressed && styles.pressed]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
    >
      <MaterialIcons name={icon} size={18} color={semantic.text.dim} />
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function ExternalWalletButton({ wallet, onPress, disabled }: {
  wallet: { name: string; icon?: string };
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.secondaryButton, disabled && styles.disabled, pressed && styles.pressed]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Connect ${wallet.name}`}
    >
      {wallet.icon ? <Image source={{ uri: wallet.icon }} style={styles.walletIcon} /> : <MaterialIcons name="account-balance-wallet" size={18} color={semantic.text.dim} />}
      <Text style={styles.secondaryButtonText}>{wallet.name}</Text>
    </Pressable>
  );
}

function DangerButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.dangerButton, disabled && styles.disabled, pressed && styles.pressed]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
    >
      <MaterialIcons name="power-settings-new" size={16} color={tokens.colors.vermillion} />
      <Text style={styles.dangerButtonText}>{label}</Text>
    </Pressable>
  );
}

function TextButton({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable style={({ pressed }) => [styles.textButton, pressed && styles.pressed]} onPress={onPress} disabled={disabled} accessibilityRole="button">
      <Text style={styles.textButtonText}>{label}</Text>
    </Pressable>
  );
}

function Divider() {
  return (
    <View style={styles.divider}>
      <View style={styles.dividerLine} />
      <Text style={styles.dividerText}>or</Text>
      <View style={styles.dividerLine} />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.74)' },
  sheet: {
    backgroundColor: semantic.background.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderColor: semantic.border.muted,
    overflow: 'hidden',
  },
  sheetLifted: { paddingBottom: 400 },
  rail: {
    minHeight: 28,
    justifyContent: 'center',
    paddingHorizontal: tokens.spacing.lg,
    backgroundColor: semantic.background.lift,
    borderBottomWidth: 1,
    borderBottomColor: semantic.border.muted,
  },
  railText: {
    fontFamily: 'monospace',
    fontSize: 10,
    letterSpacing: 1.4,
    color: semantic.text.accent,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.lg,
    paddingBottom: tokens.spacing.md,
  },
  headerCopy: { flex: 1, gap: 5 },
  title: { fontSize: 20, fontWeight: '700', color: semantic.text.primary, letterSpacing: -0.3 },
  subtitle: { fontSize: tokens.fontSize.sm, lineHeight: 19, color: semantic.text.dim },
  closeButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginTop: -10, marginRight: -10 },
  body: { paddingHorizontal: tokens.spacing.lg, paddingBottom: 40, paddingTop: tokens.spacing.sm, gap: tokens.spacing.md },
  bodyLifted: { paddingBottom: tokens.spacing.lg },
  statusBody: { minHeight: 126, alignItems: 'center', justifyContent: 'center', gap: tokens.spacing.md, paddingHorizontal: tokens.spacing.lg, paddingBottom: 36 },
  infoText: { fontSize: tokens.fontSize.sm, lineHeight: 20, textAlign: 'center', color: semantic.text.dim },
  reassurance: { fontSize: tokens.fontSize.xs, lineHeight: 17, color: semantic.text.faint, textAlign: 'center' },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: tokens.spacing.sm, minHeight: 48, paddingHorizontal: tokens.spacing.md, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: tokens.radius.md, backgroundColor: semantic.background.lift },
  input: { flex: 1, minHeight: 46, fontSize: tokens.fontSize.md, color: semantic.text.primary },
  primaryButton: { minHeight: 48, paddingHorizontal: tokens.spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: tokens.spacing.sm, borderRadius: tokens.radius.md, backgroundColor: tokens.colors.viridian },
  primaryButtonText: { fontSize: tokens.fontSize.md, fontWeight: '700', color: '#fff' },
  secondaryButton: { minHeight: 48, paddingHorizontal: tokens.spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: tokens.spacing.sm, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: tokens.radius.md, backgroundColor: semantic.background.lift },
  secondaryButtonText: { fontSize: tokens.fontSize.md, fontWeight: '600', color: semantic.text.dim },
  walletIcon: { width: 18, height: 18, borderRadius: 5 },
  disabled: { opacity: 0.42 },
  pressed: { opacity: 0.76 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: tokens.spacing.md },
  dividerLine: { flex: 1, height: 1, backgroundColor: semantic.border.muted },
  dividerText: { fontSize: tokens.fontSize.sm, color: semantic.text.faint },
  walletList: { gap: tokens.spacing.md },
  walletCard: { gap: tokens.spacing.sm, padding: tokens.spacing.md, borderRadius: tokens.radius.md, borderWidth: 1, borderColor: semantic.border.muted, backgroundColor: semantic.background.lift },
  walletCardHeader: { minHeight: 40, flexDirection: 'row', alignItems: 'center' },
  walletIdentity: { flex: 1, gap: 2 },
  walletChain: { fontSize: tokens.fontSize.md, fontWeight: '700', color: semantic.text.primary },
  walletSource: { fontSize: tokens.fontSize.xs, color: semantic.text.faint },
  addressRow: { minHeight: 44, paddingHorizontal: tokens.spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: tokens.radius.md, backgroundColor: semantic.background.surface },
  address: { fontFamily: 'monospace', fontSize: tokens.fontSize.sm, color: semantic.text.dim },
  dangerButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: tokens.spacing.sm, borderWidth: 1, borderColor: 'rgba(239,71,111,0.35)', borderRadius: tokens.radius.md },
  dangerButtonText: { fontSize: tokens.fontSize.sm, fontWeight: '600', color: tokens.colors.vermillion },
  textButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  textButtonText: { fontSize: tokens.fontSize.sm, fontWeight: '600', color: semantic.text.dim },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: tokens.spacing.sm, padding: tokens.spacing.md, borderWidth: 1, borderColor: 'rgba(239,71,111,0.25)', borderRadius: tokens.radius.md, backgroundColor: 'rgba(239,71,111,0.08)' },
  errorText: { flex: 1, fontSize: tokens.fontSize.sm, lineHeight: 19, color: tokens.colors.vermillion },
  recoveryNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: tokens.spacing.md, padding: tokens.spacing.md, borderWidth: 1, borderColor: semantic.border.muted, borderRadius: tokens.radius.md, backgroundColor: semantic.background.lift },
  recoveryCopy: { flex: 1, gap: 4 },
  recoveryTitle: { fontSize: tokens.fontSize.sm, fontWeight: '700', color: semantic.text.primary },
  recoveryBody: { fontSize: tokens.fontSize.xs, lineHeight: 17, color: semantic.text.dim },
});
