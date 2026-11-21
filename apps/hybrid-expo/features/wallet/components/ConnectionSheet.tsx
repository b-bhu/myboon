/**
 * ConnectionSheet — the one connection surface in the product.
 *
 * The first step is an email field and Continue (Privy email OTP), with
 * Connect external wallet underneath on Solana. That action calls
 * `connectExternal` (Mobile Wallet Adapter) and never creates a Privy wallet.
 * Login and wallet setup are separate tries: a bad code stays on the code
 * step, and a failed `waitForWallet` / `create()` retries only the wallet.
 *
 * Visual language follows the connect mock (`docs/mockups/wallet-connect`)
 * using this app's theme tokens. Auth, clipboard, and export are the real
 * calls, not the mock's timers.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The connection modal")
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import type { Chain } from '@/features/chain/chain.contract';
import { useChainActivation } from '@/features/chain/activation';
import { usePrivyEvmWallet } from '@/features/chain/usePrivyEvmWallet';
import { availableOptions } from '@/features/wallet/components/connect.options';
import {
  CONNECT_COPY,
  EXPORT_INSTRUCTIONS,
  INITIAL_CONNECT_FLOW,
  assertPrivyHomeUrl,
  beginPrivyExport,
  canGoBack,
  interpretPrivyExportSession,
  classifyWalletSetupError,
  connectedChainLabel,
  emailEntryError,
  isUserCancelled,
  otpFailureMessage,
  reduceConnectFlow,
  sheetChrome,
  showsLogout,
  type ConnectFlowEvent,
  type ConnectFlowState,
  type LinkedKind,
} from '@/features/wallet/components/connect.flow';
import {
  beginOtpSend,
  canRequestOtp,
  emptyOtpSession,
  finishOtpSend,
  isPrivyRateLimit,
  resendButtonLabel,
  sessionForEmail,
  type OtpCodeSession,
} from '@/features/wallet/components/otp-resend';
import { usePrivyWallet } from '@/hooks/usePrivyWallet';
import { useWallet } from '@/hooks/useWallet';
import { selectMwaDisconnect } from '@/features/wallet/signOut';
import { semantic, tokens } from '@/theme';
import { styles } from '@/features/wallet/components/ConnectionSheet.styles';
import {
  DangerButton,
  EmailMark,
  FailBlock,
  PrimaryButton,
  SecondaryButton,
  WaitBlock,
  WalletMark,
} from '@/features/wallet/components/ConnectionSheetParts';
import { useKeyboardLift } from '@/features/wallet/components/useKeyboardLift';

function useConnectFlow(
  visible: boolean,
  session: {
    linked: LinkedKind | null;
    privyAuthenticated: boolean;
    hasEmbeddedWallet: boolean;
    privyReady: boolean;
  },
) {
  const [flow, setFlow] = useState<ConnectFlowState>(INITIAL_CONNECT_FLOW);
  const decided = useRef(false);
  let display = flow;

  const openEvent: ConnectFlowEvent = {
    type: 'open',
    linked: session.linked,
    privyAuthenticated: session.privyAuthenticated,
    hasEmbeddedWallet: session.hasEmbeddedWallet,
  };

  if (!visible) {
    decided.current = false;
  } else if (!decided.current && session.privyReady) {
    decided.current = true;
    display = reduceConnectFlow(flow, openEvent);
    if (display !== flow) setFlow(display);
  } else if (
    visible
    && decided.current
    && session.linked
    && flow.linked !== session.linked
    && (flow.step.kind === 'entry' || flow.step.kind === 'fail_setup')
  ) {
    // The session can land a moment after the sheet opens. Show the connected
    // sheet once it does, instead of leaving the user on the email form.
    display = reduceConnectFlow(flow, openEvent);
    if (display !== flow) setFlow(display);
  }

  const dispatch = useCallback((event: ConnectFlowEvent) => {
    setFlow((current) => reduceConnectFlow(current, event));
  }, []);

  return { flow: display, dispatch, deciding: visible && !session.privyReady };
}

export function ConnectionSheet({
  visible,
  chain,
  onClose,
  onConnected,
}: {
  visible: boolean;
  /** The chain the requesting application needs. Drives which choices exist. */
  chain: Chain;
  onClose: () => void;
  /** Fired after a backend resolves and the chain has been activated. */
  onConnected?: () => void;
}) {
  const privy = usePrivyWallet();
  const evm = usePrivyEvmWallet();
  const solana = useWallet();
  const { activate, deactivate } = useChainActivation();

  const linked: LinkedKind | null = chain === 'solana'
    ? (solana.source === 'mwa' && solana.connected && solana.address
      ? 'external'
      : privy.connected && privy.address
        ? 'privy'
        : null)
    : (evm.isProvisioned && evm.address ? 'privy' : null);

  const { flow, dispatch, deciding } = useConnectFlow(visible, {
    linked,
    privyAuthenticated: privy.isPrivyUser,
    hasEmbeddedWallet: Boolean((privy.connected && privy.address) || (evm.isProvisioned && evm.address)),
    privyReady: privy.isReady,
  });

  const [emailInput, setEmailInput] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailFocused, setEmailFocused] = useState(false);
  const [sentEmail, setSentEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpSession, setOtpSession] = useState<OtpCodeSession>(emptyOtpSession);
  const [otpClock, setOtpClock] = useState(() => Date.now());
  const otpSendLock = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const exportInFlight = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emailField = useRef<TextInput>(null);
  const otpInput = useRef<TextInput>(null);
  const { keyboardLift, lifted, setLifted } = useKeyboardLift();

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  useEffect(() => {
    if (flow.step.kind !== 'otp') return;
    setOtpClock(Date.now());
    const waiting = otpSession.phase === 'sending' || otpSession.availableAt > Date.now();
    if (!waiting) return;
    const timer = setInterval(() => setOtpClock(Date.now()), 250);
    return () => clearInterval(timer);
  }, [flow.step.kind, otpSession.availableAt, otpSession.phase]);

  const options = availableOptions(chain);
  const emailAvailable = options.includes('email');
  const externalAvailable = options.includes('external_wallet');
  const chrome = sheetChrome(flow, { email: sentEmail });

  const requestClose = useCallback(() => {
    // The typed email stays. Closing and reopening, or backing out of the
    // code step, should still show it.
    setBusy(false);
    setLifted(false);
    keyboardLift.setValue(0);
    onClose();
  }, [keyboardLift, onClose]);

  const finishActivated = useCallback((kind: LinkedKind) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    onConnected?.();
    dispatch({ type: 'wallet_setup_succeeded', linked: kind });
    onClose();
  }, [dispatch, onClose, onConnected]);

  /**
   * Wallet step only. The caller has already signed in. A throw here is a
   * setup failure, never an "Invalid code".
   */
  const runWalletSetup = useCallback(async () => {
    if (chain === 'solana') await privy.waitForWallet();
    else if (!evm.isProvisioned) await evm.provision();
    await activate(chain);
    finishActivated('privy');
  }, [activate, chain, evm, finishActivated, privy]);

  const requestEmailCode = useCallback(async (email: string, resend: boolean) => {
    if (busy || otpSendLock.current) return;
    const now = Date.now();
    const current = sessionForEmail(otpSession, email);
    if (current !== otpSession) setOtpCode('');
    // Continue returns to the code already sent. Resend is the only new send.
    if (!resend && current.delivered) {
      setOtpSession(current);
      setSentEmail(email);
      setOtpError(null);
      dispatch({ type: 'code_sent' });
      return;
    }
    if (!canRequestOtp(current, now)) {
      setOtpSession(current);
      setSentEmail(email);
      if (!resend) dispatch({ type: 'code_sent' });
      return;
    }
    const sending = beginOtpSend(current, email, now);
    if (!sending) return;
    otpSendLock.current = true;
    setOtpSession(sending);
    setOtpClock(now);
    setOtpError(null);
    setEmailError(null);
    setBusy(true);
    setActionError(null);
    try {
      await privy.sendEmailOTP(email);
      setOtpSession((session) => finishOtpSend(session, Date.now(), { ok: true }));
      setOtpClock(Date.now());
      setSentEmail(email);
      dispatch({ type: 'code_sent' });
    } catch (error: unknown) {
      const failedAt = Date.now();
      setOtpSession((session) => finishOtpSend(session, failedAt, { ok: false, error }));
      setOtpClock(failedAt);
      if (isPrivyRateLimit(error) || resend) {
        setSentEmail(email);
        if (!resend) dispatch({ type: 'code_sent' });
      } else {
        dispatch({ type: 'login_failed' });
      }
    } finally {
      otpSendLock.current = false;
      setBusy(false);
    }
  }, [busy, dispatch, otpSession, privy]);

  const handleExternalWallet = useCallback(async () => {
    // Mobile Wallet Adapter (external_mwa). The system chooser picks the wallet.
    // connectExternal is that call. This path does not sign in or create a wallet.
    if (busy || chain !== 'solana') return;
    setActionError(null);
    dispatch({ type: 'choose_external' });
    setBusy(true);
    try {
      await solana.connectExternal();
      await activate('solana');
      finishActivated('external');
    } catch (error: unknown) {
      if (isUserCancelled(error)) {
        dispatch({ type: 'external_cancelled' });
      } else {
        const message = error instanceof Error && error.message
          ? error.message
          : 'Could not connect that wallet.';
        dispatch({ type: 'external_failed', message });
      }
    } finally {
      setBusy(false);
    }
  }, [activate, busy, chain, dispatch, finishActivated, solana]);

  const handleContinue = useCallback(async () => {
    const email = emailInput.trim();
    const invalid = emailEntryError(email);
    if (invalid) {
      setEmailInput(email);
      setEmailError(invalid);
      emailField.current?.focus();
      return;
    }
    if (busy) return;
    setEmailInput(email);
    setEmailError(null);
    await requestEmailCode(email, false);
  }, [busy, emailInput, requestEmailCode]);

  const handleResend = useCallback(async () => {
    if (!sentEmail || busy || otpSendLock.current) return;
    await requestEmailCode(sentEmail, true);
  }, [busy, requestEmailCode, sentEmail]);

  const handleVerifyOTP = useCallback(async () => {
    if (!otpCode.trim() || busy) return;
    setBusy(true);
    setOtpError(null);
    try {
      await privy.loginWithEmailOTP(otpCode.trim(), sentEmail);
    } catch (error: unknown) {
      setOtpError(otpFailureMessage(error));
      dispatch({ type: 'otp_rejected' });
      setBusy(false);
      return;
    }
    dispatch({ type: 'login_succeeded' });
    try {
      await runWalletSetup();
    } catch (error: unknown) {
      dispatch({ type: 'wallet_setup_failed', failure: classifyWalletSetupError(error) });
    } finally {
      setBusy(false);
    }
  }, [busy, dispatch, otpCode, privy, runWalletSetup, sentEmail]);

  const handleRetryWallet = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    dispatch({ type: 'retry_wallet' });
    try {
      await runWalletSetup();
    } catch (error: unknown) {
      dispatch({ type: 'wallet_setup_failed', failure: classifyWalletSetupError(error) });
    } finally {
      setBusy(false);
    }
  }, [busy, dispatch, runWalletSetup]);

  const handleLogout = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await privy.disconnect(selectMwaDisconnect(solana));
      setOtpCode('');
      setOtpError(null);
      setOtpSession(emptyOtpSession());
      setEmailError(null);
      dispatch({ type: 'logout' });
    } catch (error: unknown) {
      setActionError(error instanceof Error && error.message ? error.message : 'Could not log out.');
    } finally {
      setBusy(false);
    }
  }, [busy, dispatch, privy, solana]);

  const handleCopy = useCallback(async (key: string, address: string) => {
    await Clipboard.setStringAsync(address);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setCopiedKey(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedKey(null), 900);
  }, []);

  const handleExportContinue = useCallback(() => {
    if (flow.linked !== 'privy' || exportInFlight.current) return;
    const handoff = beginPrivyExport();
    exportInFlight.current = true;
    dispatch({ type: 'export_continue' });
    void openPrivyExportPage(handoff.url)
      .then((outcome) => {
        dispatch(outcome === 'handed_off' ? { type: 'export_handed_off' } : { type: 'export_failed' });
      })
      .finally(() => {
        exportInFlight.current = false;
      });
  }, [dispatch, flow.linked]);

  const confirmDisconnect = useCallback(async () => {
    if (busy || !flow.linked) return;
    setBusy(true);
    setActionError(null);
    try {
      if (flow.linked === 'external') {
        if (solana.disconnect) await solana.disconnect();
        await deactivate('solana');
      } else if (privy.isPrivyUser) {
        await privy.disconnect(selectMwaDisconnect(solana));
      } else if (solana.disconnect) {
        await solana.disconnect();
        await deactivate(chain);
      }
      setOtpCode('');
      setOtpError(null);
      setOtpSession(emptyOtpSession());
      dispatch({ type: 'disconnected' });
      onClose();
    } catch (error: unknown) {
      setActionError(error instanceof Error && error.message ? error.message : 'Could not disconnect.');
    } finally {
      setBusy(false);
    }
  }, [busy, chain, deactivate, dispatch, flow.linked, onClose, privy, solana]);

  const goBack = useCallback(() => {
    setOtpError(null);
    setActionError(null);
    dispatch({ type: 'back' });
  }, [dispatch]);

  const chainRows = flow.linked === 'external'
    ? (solana.address
      ? [{ key: 'solana', label: connectedChainLabel('solana'), address: solana.address }]
      : [])
    : [
      ...(privy.connected && privy.address
        ? [{ key: 'solana', label: connectedChainLabel('solana'), address: privy.address }]
        : []),
      ...(evm.address
        ? [{ key: 'evm', label: connectedChainLabel('evm'), address: evm.address }]
        : []),
    ];

  const privyLabel = privy.identityEmail ?? privy.identityName ?? CONNECT_COPY.emailDetail;
  const resendLabel = resendButtonLabel(otpSession.availableAt, otpClock);
  const resendDisabled = busy || otpSession.phase === 'sending' || !canRequestOtp(otpSession, otpClock);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={requestClose} statusBarTranslucent navigationBarTranslucent>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? undefined : 'padding'}
      >
        <Animated.View
          style={[
            styles.sheet,
            Platform.OS === 'ios' && lifted && styles.sheetLifted,
            { transform: [{ translateY: Animated.multiply(keyboardLift, -1) }] },
          ]}
        >
          <View style={styles.handle} />
          <View style={styles.header}>
            {canGoBack(flow) ? (
              <Pressable
                onPress={goBack}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Back"
                style={styles.iconBtn}
              >
                <MaterialIcons name="chevron-left" size={28} color={semantic.text.dim} />
              </Pressable>
            ) : (
              <View style={styles.iconBtn} />
            )}
            <View style={styles.headerText}>
              <Text style={styles.title}>{deciding ? 'Connect' : chrome.title}</Text>
              {!deciding && chrome.subtitle ? (
                <Text style={styles.subtitle}>{chrome.subtitle}</Text>
              ) : null}
            </View>
            <Pressable
              onPress={requestClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={styles.iconBtn}
            >
              <MaterialIcons name="close" size={22} color={semantic.text.dim} />
            </Pressable>
          </View>

          <ScrollView
            keyboardShouldPersistTaps="handled"
            bounces={false}
            contentContainerStyle={[
              styles.body,
              flow.step.kind === 'export' && styles.exportBody,
              lifted && styles.bodyLifted,
            ]}
          >
            {deciding ? (
              <WaitBlock title="Connect" body="Checking your session." />
            ) : null}

            {flow.step.kind === 'entry' ? (
              <View style={styles.stack}>
                {emailAvailable ? (
                  <View>
                    <Text style={styles.fieldLabel}>{CONNECT_COPY.emailLabel}</Text>
                    <View
                      style={[
                        styles.emailField,
                        emailFocused && !emailError && styles.emailFieldFocused,
                        emailError && styles.emailFieldInvalid,
                      ]}
                    >
                      <EmailMark color={semantic.text.dim} />
                      <TextInput
                        ref={emailField}
                        style={styles.emailInput}
                        placeholder={CONNECT_COPY.emailPlaceholder}
                        placeholderTextColor={semantic.text.dim}
                        value={emailInput}
                        onChangeText={(value) => {
                          setEmailInput(value);
                          if (emailError) setEmailError(null);
                        }}
                        onFocus={() => setEmailFocused(true)}
                        onBlur={() => setEmailFocused(false)}
                        onSubmitEditing={() => void handleContinue()}
                        keyboardType="email-address"
                        inputMode="email"
                        autoCapitalize="none"
                        autoComplete="email"
                        autoCorrect={false}
                        spellCheck={false}
                        textContentType="emailAddress"
                        enterKeyHint="go"
                        returnKeyType="go"
                        accessibilityLabel={CONNECT_COPY.emailLabel}
                      />
                    </View>
                    {emailError ? (
                      <Text style={styles.emailError} accessibilityLiveRegion="polite">{emailError}</Text>
                    ) : null}
                    <View style={styles.continueGap}>
                      <PrimaryButton
                        label={CONNECT_COPY.continue}
                        busy={busy}
                        onPress={() => void handleContinue()}
                      />
                    </View>
                    {otpSession.phase === 'sending' ? (
                      <Text accessibilityLiveRegion="polite" style={styles.otpStatus}>{otpSession.status}</Text>
                    ) : null}
                  </View>
                ) : null}
                {externalAvailable ? (
                  <View style={styles.externalWrap}>
                    {flow.externalError ? <Text style={styles.errorText}>{flow.externalError}</Text> : null}
                    <Pressable
                      style={({ pressed }) => [
                        styles.externalEntry,
                        busy && styles.disabled,
                        pressed && !busy && styles.pressed,
                      ]}
                      disabled={busy}
                      onPress={() => void handleExternalWallet()}
                      accessibilityRole="button"
                      accessibilityLabel={CONNECT_COPY.connectExternal}
                    >
                      <WalletMark color={semantic.text.dim} />
                      <Text style={styles.externalEntryText}>{CONNECT_COPY.connectExternal}</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            ) : null}

            {flow.step.kind === 'otp' ? (
              <View style={styles.stack}>
                <Text
                  accessibilityLiveRegion="polite"
                  accessibilityRole="text"
                  style={[styles.otpStatus, otpSession.error ? styles.otpStatusError : null]}
                >
                  {otpSession.status}
                </Text>
                <Pressable onPress={() => otpInput.current?.focus()} accessibilityRole="button" accessibilityLabel="One-time code">
                  <View style={styles.otpRow}>
                    {Array.from({ length: 6 }, (_, index) => (
                      <View key={index} style={styles.otpBox}>
                        <Text style={styles.otpDigit}>{otpCode[index] ?? ''}</Text>
                      </View>
                    ))}
                  </View>
                </Pressable>
                <TextInput
                  ref={otpInput}
                  value={otpCode}
                  onChangeText={(value) => {
                    setOtpError(null);
                    setOtpCode(value.replace(/\D/g, '').slice(0, 6));
                  }}
                  keyboardType="number-pad"
                  autoFocus
                  maxLength={6}
                  caretHidden
                  style={styles.hiddenInput}
                  accessibilityLabel="Enter code"
                />
                <View style={styles.otpTools}>
                  <Pressable
                    onPress={() => void pasteCode(setOtpCode)}
                    accessibilityRole="button"
                    accessibilityLabel={CONNECT_COPY.paste}
                    style={styles.otpTool}
                  >
                    <Text style={styles.pasteText}>{CONNECT_COPY.paste}</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void handleResend()}
                    disabled={resendDisabled}
                    accessibilityRole="button"
                    accessibilityLabel={resendLabel}
                    accessibilityState={{ disabled: resendDisabled, busy: otpSession.phase === 'sending' }}
                    style={styles.otpTool}
                  >
                    <Text style={[styles.pasteText, resendDisabled && styles.otpToolDisabled]}>{resendLabel}</Text>
                  </Pressable>
                </View>
                {otpError ? <Text style={styles.errorText}>{otpError}</Text> : null}
                <PrimaryButton
                  label={CONNECT_COPY.verify}
                  disabled={!otpCode.trim() || otpSession.phase === 'sending'}
                  busy={busy && otpSession.phase !== 'sending'}
                  onPress={() => void handleVerifyOTP()}
                />
              </View>
            ) : null}

            {flow.step.kind === 'creating' ? (
              <WaitBlock title={CONNECT_COPY.creatingTitle} body={CONNECT_COPY.creatingBody} />
            ) : null}

            {flow.step.kind === 'connecting_external' ? (
              <WaitBlock title={CONNECT_COPY.approveTitle} body={CONNECT_COPY.approveBody} />
            ) : null}

            {flow.step.kind === 'fail_login' ? (
              <FailBlock title={CONNECT_COPY.signInFailedTitle} body={CONNECT_COPY.signInFailedBody}>
                <PrimaryButton
                  label={CONNECT_COPY.trySignInAgain}
                  onPress={() => dispatch({ type: 'retry_login' })}
                />
              </FailBlock>
            ) : null}

            {flow.step.kind === 'fail_setup' ? (
              <FailBlock
                title={flow.setupFailure ? CONNECT_COPY.setupFailedTitle : CONNECT_COPY.finishSetupTitle}
                body={flow.setupFailure === 'timeout'
                  ? `${CONNECT_COPY.setupFailedLead} ${CONNECT_COPY.setupTimeoutDetail}`
                  : flow.setupFailure === 'create'
                    ? `${CONNECT_COPY.setupFailedLead} ${CONNECT_COPY.setupCreateDetail}`
                    : CONNECT_COPY.finishSetupBody}
              >
                {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}
                <PrimaryButton
                  label={CONNECT_COPY.retryWallet}
                  busy={busy}
                  onPress={() => void handleRetryWallet()}
                />
                {showsLogout(flow) ? (
                  <Pressable
                    onPress={() => void handleLogout()}
                    disabled={busy}
                    accessibilityRole="button"
                    style={styles.logoutBtn}
                  >
                    <Text style={styles.logoutText}>{CONNECT_COPY.logoutAndRestart}</Text>
                  </Pressable>
                ) : null}
              </FailBlock>
            ) : null}

            {flow.step.kind === 'connected' ? (
              <View style={styles.stack}>
                <View style={styles.ident}>
                  {flow.linked === 'privy' ? (
                    <View style={[styles.identMark, styles.markEmail]}>
                      <EmailMark color={tokens.colors.viridian} size={22} />
                    </View>
                  ) : (
                    <View style={styles.identMark}>
                      <WalletMark color={semantic.text.primary} size={22} />
                    </View>
                  )}
                  <View style={styles.identText}>
                    <Text style={styles.identName}>
                      {flow.linked === 'privy' ? privyLabel : CONNECT_COPY.externalWallet}
                    </Text>
                    <Text style={styles.identDetail}>
                      {flow.linked === 'privy' ? CONNECT_COPY.emailDetail : CONNECT_COPY.externalDetail}
                    </Text>
                  </View>
                </View>
                {chainRows.map((row) => (
                  <View key={row.key} style={styles.chainCard}>
                    <View style={styles.labRow}>
                      <Text style={styles.lab}>{row.label}</Text>
                      <Pressable
                        onPress={() => void handleCopy(row.key, row.address)}
                        accessibilityRole="button"
                        accessibilityLabel={`Copy ${row.label} address`}
                      >
                        <Text style={styles.copyText}>
                          {copiedKey === row.key ? CONNECT_COPY.copied : CONNECT_COPY.copy}
                        </Text>
                      </Pressable>
                    </View>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      <Text selectable style={styles.addressValue}>{row.address}</Text>
                    </ScrollView>
                  </View>
                ))}
                <View style={styles.stack}>
                  {flow.linked === 'privy' ? (
                    <SecondaryButton
                      label={CONNECT_COPY.export}
                      onPress={() => dispatch({ type: 'open_export' })}
                    />
                  ) : null}
                  <DangerButton
                    label={CONNECT_COPY.disconnect}
                    disabled={busy}
                    onPress={() => dispatch({ type: 'request_disconnect' })}
                  />
                </View>
              </View>
            ) : null}

            {flow.step.kind === 'export' ? (
              <View style={styles.exportStack}>
                <View accessibilityRole="list" style={styles.exportSteps}>
                  {EXPORT_INSTRUCTIONS.map((parts, index) => (
                    <Text key={index} style={styles.exportStepText}>
                      <Text style={styles.exportIndex}>{index + 1}. </Text>
                      {parts.map((part, partIndex) => (
                        <Text key={partIndex} style={part.emphasis ? styles.exportStrong : undefined}>
                          {part.text}
                        </Text>
                      ))}
                    </Text>
                  ))}
                </View>
                <Text style={styles.exportWarning}>{CONNECT_COPY.exportWarning}</Text>
                <View style={styles.exportActions}>
                  <PrimaryButton compact label={CONNECT_COPY.continuePrivy} onPress={handleExportContinue} />
                  <SecondaryButton
                    compact
                    label={CONNECT_COPY.notNow}
                    onPress={() => dispatch({ type: 'export_not_now' })}
                  />
                </View>
              </View>
            ) : null}

            {flow.step.kind === 'export_opening' ? (
              <WaitBlock title={CONNECT_COPY.openingPrivyTitle} body={CONNECT_COPY.openingPrivyBody} />
            ) : null}

            {flow.step.kind === 'export_failed' ? (
              <View style={styles.stack}>
                <Text style={styles.plain}>{CONNECT_COPY.exportFailed}</Text>
                <PrimaryButton
                  label={CONNECT_COPY.exportTryAgain}
                  onPress={() => dispatch({ type: 'export_retry' })}
                />
                <SecondaryButton
                  label={CONNECT_COPY.backToWallet}
                  onPress={() => dispatch({ type: 'back' })}
                />
              </View>
            ) : null}

            {flow.step.kind === 'confirm_disconnect' ? (
              <FailBlock
                icon={false}
                title={CONNECT_COPY.disconnectTitle}
                body={flow.linked === 'privy' ? CONNECT_COPY.privyDisconnectBody : CONNECT_COPY.disconnectBody}
              >
                {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}
                <DangerButton
                  label={busy ? 'Disconnecting...' : CONNECT_COPY.disconnect}
                  disabled={busy}
                  onPress={() => void confirmDisconnect()}
                />
                <SecondaryButton
                  label={CONNECT_COPY.cancel}
                  disabled={busy}
                  onPress={() => dispatch({ type: 'cancel_disconnect' })}
                />
              </FailBlock>
            ) : null}
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

async function pasteCode(setOtpCode: (value: string) => void) {
  const text = (await Clipboard.getStringAsync()) ?? '';
  const digits = text.replace(/\D/g, '').slice(0, 6);
  if (digits) setOtpCode(digits);
}


/**
 * Open Privy Home in the system browser (Safari view on iOS, Custom Tab on
 * Android). The page stays in that browser. This function returns only whether
 * the handoff started, and it does not read the page, the result URL, or a key.
 */
async function openPrivyExportPage(url: string): Promise<'handed_off' | 'failed'> {
  let safeUrl: string;
  try {
    safeUrl = assertPrivyHomeUrl(url);
  } catch {
    return 'failed';
  }
  try {
    const result = await WebBrowser.openBrowserAsync(safeUrl, {
      dismissButtonStyle: 'close',
      readerMode: false,
      showTitle: true,
      createTask: false,
      showInRecents: false,
      enableDefaultShareMenuItem: false,
    });
    return interpretPrivyExportSession(result);
  } catch {
    return 'failed';
  }
}
