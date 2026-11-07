/**
 * ConnectionSheet — the one connection surface in the product.
 *
 * Staged, not a flat list: create a wallet (email / Google → Privy) or use one
 * you already have (Seeker / Phantom → Mobile Wallet Adapter). Already-have
 * calls `connectExternal`, which authorizes MWA and never creates a Privy
 * wallet. Login and wallet setup are separate tries: a bad code stays on the
 * code step, and a failed `waitForWallet` / `create()` retries only the wallet.
 *
 * Visual language follows the approved connect mock
 * (`docs/mockups/wallet-connect`) using this app's theme tokens.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The connection modal")
 */

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import Svg, { Path } from 'react-native-svg';
import type { Chain } from '@/features/chain/chain.contract';
import { useChainActivation } from '@/features/chain/activation';
import { usePrivyEvmWallet } from '@/features/chain/usePrivyEvmWallet';
import { availableOptions } from '@/features/wallet/components/connect.options';
import {
  CONNECT_COPY,
  EXTERNAL_WALLET_CHOICES,
  INITIAL_CONNECT_FLOW,
  assertPrivyHomeUrl,
  beginPrivyExport,
  canGoBack,
  interpretPrivyExportSession,
  classifyWalletSetupError,
  connectedChainLabel,
  externalWaitingLabel,
  isUserCancelled,
  otpFailureMessage,
  reduceConnectFlow,
  sheetChrome,
  showsLogout,
  type ConnectFlowEvent,
  type ConnectFlowState,
  type ExternalWalletChoice,
  type LinkedKind,
} from '@/features/wallet/components/connect.flow';
import { usePrivyWallet } from '@/hooks/usePrivyWallet';
import { useWallet } from '@/hooks/useWallet';
import { selectMwaDisconnect } from '@/features/wallet/signOut';
import { semantic, tokens } from '@/theme';

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
    && (flow.step.kind === 'choice' || flow.step.kind === 'fail_setup')
  ) {
    // The session can land a moment after the sheet opens. Show the connected
    // sheet once it does, instead of leaving the user on the choice screen.
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
  const [sentEmail, setSentEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const exportInFlight = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const otpInput = useRef<TextInput>(null);
  const keyboardLift = useRef(new Animated.Value(0)).current;
  const [lifted, setLifted] = useState(false);

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

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const options = availableOptions(chain);
  const externalAvailable = options.includes('external_wallet');
  const chrome = sheetChrome(flow, { email: sentEmail, externalAvailable });

  const requestClose = useCallback(() => {
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

  const handleExternalWallet = useCallback(async (wallet: ExternalWalletChoice) => {
    // Seeker / Phantom authorize through Mobile Wallet Adapter (external_mwa).
    // connectExternal is that call. This path does not sign in or create a wallet.
    if (busy || chain !== 'solana') return;
    setActionError(null);
    dispatch({ type: 'choose_external', wallet });
    setBusy(true);
    try {
      await solana.connectExternal(wallet === 'phantom' ? 'Phantom' : 'Seeker');
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

  const handleSendEmail = useCallback(async () => {
    const email = emailInput.trim();
    if (!email || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await privy.sendEmailOTP(email);
      setSentEmail(email);
      dispatch({ type: 'code_sent' });
    } catch (error: unknown) {
      setActionError(error instanceof Error && error.message ? error.message : 'Failed to send code');
    } finally {
      setBusy(false);
    }
  }, [busy, dispatch, emailInput, privy]);

  const handleVerifyOTP = useCallback(async () => {
    if (!otpCode.trim() || busy) return;
    setBusy(true);
    setOtpError(null);
    try {
      await privy.loginWithEmailOTP(otpCode.trim());
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
  }, [busy, dispatch, otpCode, privy, runWalletSetup]);

  const handleGoogle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    dispatch({ type: 'start_google' });
    try {
      await privy.loginWithGoogle();
    } catch (error: unknown) {
      if (isUserCancelled(error)) dispatch({ type: 'login_cancelled' });
      else dispatch({ type: 'login_failed' });
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
  }, [busy, dispatch, privy, runWalletSetup]);

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
      setEmailInput('');
      setSentEmail('');
      setOtpCode('');
      setOtpError(null);
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

  const privyDetail = privy.authMethod === 'google' ? 'Google' : 'Email';
  const privyLabel = privy.identityEmail
    ?? privy.identityName
    ?? (privy.authMethod === 'google' ? 'Google account' : 'Email');
  const externalName = flow.externalWallet === 'phantom'
    ? CONNECT_COPY.phantom
    : flow.externalWallet === 'seeker'
      ? CONNECT_COPY.seeker
      : 'Solana wallet';
  const externalDetail = flow.externalWallet === 'seeker'
    ? CONNECT_COPY.seekerHint
    : CONNECT_COPY.phantomHint;

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
            contentContainerStyle={[styles.body, lifted && styles.bodyLifted]}
          >
            {deciding ? (
              <WaitBlock title="Connect" body="Checking your session." />
            ) : null}

            {flow.step.kind === 'choice' ? (
              <View style={styles.stack}>
                <PrimaryButton
                  label={CONNECT_COPY.createWallet}
                  onPress={() => dispatch({ type: 'choose_create' })}
                />
                {externalAvailable ? (
                  <SecondaryButton
                    label={CONNECT_COPY.alreadyHave}
                    onPress={() => dispatch({ type: 'choose_have' })}
                  />
                ) : null}
              </View>
            ) : null}

            {flow.step.kind === 'create' ? (
              <View style={styles.stack}>
                {options.includes('email') ? (
                  <MethodRow
                    title={CONNECT_COPY.continueEmail}
                    detail={CONNECT_COPY.emailHint}
                    mark={<View style={[styles.mark, styles.markEmail]}><EmailMark /></View>}
                    onPress={() => dispatch({ type: 'choose_email' })}
                  />
                ) : null}
                {options.includes('google') ? (
                  <MethodRow
                    title={CONNECT_COPY.continueGoogle}
                    detail={CONNECT_COPY.googleHint}
                    mark={<View style={[styles.mark, styles.markGoogle]}><GoogleMark /></View>}
                    onPress={() => void handleGoogle()}
                    disabled={busy}
                  />
                ) : null}
              </View>
            ) : null}

            {flow.step.kind === 'email' ? (
              <View style={styles.stack}>
                <TextInput
                  style={styles.field}
                  placeholder="you@email.com"
                  placeholderTextColor={semantic.text.faint}
                  value={emailInput}
                  onChangeText={setEmailInput}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  accessibilityLabel="Email address"
                />
                {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}
                <PrimaryButton
                  label={CONNECT_COPY.sendCode}
                  disabled={!emailInput.trim()}
                  busy={busy}
                  onPress={() => void handleSendEmail()}
                />
              </View>
            ) : null}

            {flow.step.kind === 'otp' ? (
              <View style={styles.stack}>
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
                <Pressable onPress={() => void pasteCode(setOtpCode)} accessibilityRole="button" style={styles.pasteBtn}>
                  <Text style={styles.pasteText}>{CONNECT_COPY.paste}</Text>
                </Pressable>
                {otpError ? <Text style={styles.errorText}>{otpError}</Text> : null}
                <PrimaryButton
                  label={CONNECT_COPY.verify}
                  disabled={!otpCode.trim()}
                  busy={busy}
                  onPress={() => void handleVerifyOTP()}
                />
              </View>
            ) : null}

            {flow.step.kind === 'signing_in' ? (
              <WaitBlock title="Signing in" body={CONNECT_COPY.signingInBody} />
            ) : null}

            {flow.step.kind === 'creating' ? (
              <WaitBlock title={CONNECT_COPY.creatingTitle} body={CONNECT_COPY.creatingBody} />
            ) : null}

            {flow.step.kind === 'have' ? (
              <View style={styles.stack}>
                {flow.externalError ? <Text style={styles.errorText}>{flow.externalError}</Text> : null}
                {EXTERNAL_WALLET_CHOICES.map((choice) => (
                  <MethodRow
                    key={choice.id}
                    title={choice.name}
                    detail={choice.detail}
                    mark={choice.id === 'phantom'
                      ? <View style={[styles.mark, styles.markPhantom]}><Text style={styles.markPhantomText}>◈</Text></View>
                      : <View style={[styles.mark, styles.markSeeker]}><Text style={styles.markSeekerText}>S</Text></View>}
                    onPress={() => void handleExternalWallet(choice.id)}
                    disabled={busy}
                  />
                ))}
              </View>
            ) : null}

            {flow.step.kind === 'connecting_external' ? (
              <WaitBlock
                title={CONNECT_COPY.approveTitle}
                body={`Waiting for ${externalWaitingLabel(flow.step.wallet)}.`}
              />
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
                    privy.authMethod === 'google'
                      ? <View style={[styles.identMark, styles.markGoogle]}><GoogleMark /></View>
                      : <View style={[styles.identMark, styles.markEmail]}><EmailMark /></View>
                  ) : flow.externalWallet === 'phantom' ? (
                    <View style={[styles.identMark, styles.markPhantom]}><Text style={styles.markPhantomText}>◈</Text></View>
                  ) : flow.externalWallet === 'seeker' ? (
                    <View style={[styles.identMark, styles.markSeeker]}><Text style={styles.markSeekerText}>S</Text></View>
                  ) : (
                    <View style={[styles.identMark, styles.markEmail]}>
                      <MaterialIcons name="account-balance-wallet" size={18} color={tokens.colors.viridian} />
                    </View>
                  )}
                  <View style={styles.identText}>
                    <Text style={styles.identName}>{flow.linked === 'privy' ? privyLabel : externalName}</Text>
                    <Text style={styles.identDetail}>{flow.linked === 'privy' ? privyDetail : externalDetail}</Text>
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
              <View style={styles.stack}>
                <Text style={styles.warning}>{CONNECT_COPY.exportWarning}</Text>
                <Text style={styles.plain}>{CONNECT_COPY.exportIntro}</Text>
                <PrimaryButton label={CONNECT_COPY.continuePrivy} onPress={handleExportContinue} />
                <SecondaryButton
                  label={CONNECT_COPY.notNow}
                  onPress={() => dispatch({ type: 'export_not_now' })}
                />
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

function WaitBlock({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.wait}>
      <ActivityIndicator size="small" color={tokens.colors.viridian} />
      <Text style={styles.waitTitle}>{title}</Text>
      {body ? <Text style={styles.waitBody}>{body}</Text> : null}
    </View>
  );
}

function FailBlock({
  title,
  body,
  icon = true,
  children,
}: {
  title: string;
  body: string;
  icon?: boolean;
  children: ReactNode;
}) {
  return (
    <View style={styles.fail}>
      {icon ? (
        <View style={styles.failIcon}>
          <MaterialIcons name="error-outline" size={22} color={tokens.colors.vermillion} />
        </View>
      ) : null}
      <Text style={styles.waitTitle}>{title}</Text>
      <Text style={styles.waitBody}>{body}</Text>
      {children}
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  disabled,
  busy,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const off = disabled || busy;
  return (
    <Pressable
      style={({ pressed }) => [styles.primaryBtn, off && styles.disabled, pressed && !off && styles.pressed]}
      disabled={off}
      onPress={onPress}
      accessibilityRole="button"
    >
      {busy ? (
        <ActivityIndicator size="small" color={tokens.colors.walletCore} />
      ) : (
        <Text style={styles.primaryText}>{label}</Text>
      )}
    </Pressable>
  );
}

function SecondaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.secondaryBtn, disabled && styles.disabled, pressed && !disabled && styles.pressed]}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
    >
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

function DangerButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.dangerBtn, disabled && styles.disabled, pressed && !disabled && styles.pressed]}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Text style={styles.dangerText}>{label}</Text>
    </Pressable>
  );
}

function MethodRow({
  title,
  detail,
  mark,
  onPress,
  disabled,
}: {
  title: string;
  detail: string;
  mark: ReactNode;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, disabled && styles.disabled, pressed && !disabled && styles.pressed]}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      {mark}
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowDetail}>{detail}</Text>
      </View>
      <MaterialIcons name="chevron-right" size={22} color={semantic.text.faint} />
    </Pressable>
  );
}

function EmailMark() {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3.5 7.5A2.5 2.5 0 0 1 6 5h12a2.5 2.5 0 0 1 2.5 2.5v9A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5v-9Z"
        stroke={tokens.colors.viridian}
        strokeWidth={1.75}
      />
      <Path
        d="m4.5 8 6.7 5.1a1.5 1.5 0 0 0 1.8 0L19.5 8"
        stroke={tokens.colors.viridian}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function GoogleMark() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <Path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <Path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <Path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(3, 31, 44, 0.72)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: semantic.background.screen,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderColor: semantic.border.muted,
    maxHeight: '92%',
  },
  sheetLifted: {
    paddingBottom: 400,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: semantic.border.muted,
    alignSelf: 'center',
    marginTop: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: tokens.spacing.sm,
    paddingTop: tokens.spacing.sm,
    paddingBottom: tokens.spacing.xs,
  },
  iconBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    paddingTop: 8,
  },
  title: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '600',
    color: semantic.text.primary,
  },
  subtitle: {
    marginTop: 4,
    fontSize: tokens.fontSize.md,
    lineHeight: 20,
    color: semantic.text.dim,
  },
  body: {
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.sm,
    paddingBottom: 36,
    gap: tokens.spacing.md,
  },
  bodyLifted: {
    paddingBottom: tokens.spacing.lg,
  },
  stack: {
    gap: tokens.spacing.sm,
  },
  primaryBtn: {
    width: '100%',
    minHeight: 56,
    borderRadius: 14,
    backgroundColor: tokens.colors.bone,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  primaryText: {
    fontSize: 16,
    fontWeight: '600',
    color: tokens.colors.walletCore,
    textAlign: 'center',
  },
  secondaryBtn: {
    width: '100%',
    minHeight: 56,
    borderRadius: 14,
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  secondaryText: {
    fontSize: 16,
    fontWeight: '600',
    color: semantic.text.primary,
    textAlign: 'center',
  },
  dangerBtn: {
    width: '100%',
    minHeight: 52,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#7a2a3c',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  dangerText: {
    fontSize: 16,
    fontWeight: '600',
    color: tokens.colors.vermillion,
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.85,
  },
  row: {
    minHeight: 56,
    borderRadius: 14,
    backgroundColor: semantic.background.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: semantic.text.primary,
  },
  rowDetail: {
    marginTop: 1,
    fontSize: 13,
    color: semantic.text.faint,
  },
  mark: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markEmail: {
    backgroundColor: tokens.colors.lift,
  },
  markGoogle: {
    backgroundColor: '#fff',
  },
  markSeeker: {
    backgroundColor: '#5b21b6',
  },
  markPhantom: {
    backgroundColor: '#ab9ff2',
  },
  markSeekerText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  markPhantomText: {
    color: '#1b1438',
    fontSize: 16,
    fontWeight: '700',
  },
  field: {
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: semantic.background.surface,
    paddingHorizontal: 14,
    fontSize: 16,
    color: semantic.text.primary,
  },
  otpRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: tokens.spacing.sm,
  },
  otpBox: {
    width: 44,
    height: 52,
    borderRadius: 12,
    backgroundColor: semantic.background.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  otpDigit: {
    fontSize: 20,
    fontWeight: '600',
    color: semantic.text.primary,
  },
  hiddenInput: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
  pasteBtn: {
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pasteText: {
    color: tokens.colors.viridian,
    fontSize: tokens.fontSize.md,
    fontWeight: '500',
  },
  wait: {
    alignItems: 'center',
    paddingVertical: 28,
    gap: 6,
  },
  waitTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: semantic.text.primary,
    textAlign: 'center',
  },
  waitBody: {
    fontSize: tokens.fontSize.md,
    lineHeight: 20,
    color: semantic.text.dim,
    textAlign: 'center',
  },
  fail: {
    alignItems: 'stretch',
    gap: tokens.spacing.sm,
    paddingTop: 8,
  },
  failIcon: {
    alignSelf: 'center',
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(239, 71, 111, 0.16)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  errorText: {
    color: tokens.colors.vermillion,
    fontSize: tokens.fontSize.sm,
    lineHeight: 18,
    textAlign: 'center',
  },
  logoutBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: tokens.spacing.md,
  },
  logoutText: {
    color: semantic.text.faint,
    fontSize: tokens.fontSize.md,
    fontWeight: '500',
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
  ident: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.md,
    marginBottom: 2,
  },
  identMark: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identText: {
    flex: 1,
    minWidth: 0,
  },
  identName: {
    fontSize: 17,
    fontWeight: '600',
    color: semantic.text.primary,
  },
  identDetail: {
    marginTop: 2,
    fontSize: 13,
    color: semantic.text.faint,
  },
  chainCard: {
    borderRadius: 14,
    backgroundColor: semantic.background.surface,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 6,
  },
  labRow: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacing.sm,
  },
  lab: {
    color: semantic.text.faint,
    fontSize: 12,
    fontWeight: '500',
  },
  copyText: {
    color: tokens.colors.viridian,
    fontSize: 13,
    fontWeight: '500',
  },
  addressValue: {
    fontFamily: 'monospace',
    fontSize: 12.5,
    lineHeight: 18,
    color: semantic.text.dim,
  },
  plain: {
    color: semantic.text.dim,
    fontSize: tokens.fontSize.md,
    lineHeight: 20,
  },
  warning: {
    color: semantic.text.primary,
    fontSize: tokens.fontSize.md,
    lineHeight: 20,
  },
});

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
