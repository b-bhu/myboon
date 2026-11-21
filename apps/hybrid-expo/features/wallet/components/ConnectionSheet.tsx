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
import { useCallback, useState } from 'react';
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import type { Chain } from '@/features/chain/chain.contract';
import { useChainActivation } from '@/features/chain/activation';
import { usePrivyEvmWallet } from '@/features/chain/usePrivyEvmWallet';
import { availableOptions } from '@/features/wallet/components/connect.options';
import {
  CONNECT_COPY,
  EXPORT_INSTRUCTIONS,
  canGoBack,
  connectedChainLabel,
  sheetChrome,
  showsLogout,
  type LinkedKind,
} from '@/features/wallet/components/connect.flow';
import { usePrivyWallet } from '@/hooks/usePrivyWallet';
import { useWallet } from '@/hooks/useWallet';
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
import { useConnectFlow } from '@/features/wallet/components/useConnectFlow';
import { useEmailOtp } from '@/features/wallet/components/useEmailOtp';
import { useWalletSetup } from '@/features/wallet/components/useWalletSetup';
import { useSheetDisconnect } from '@/features/wallet/components/useSheetDisconnect';
import { useCopyAddress } from '@/features/wallet/components/useCopyAddress';
import { usePrivyExport } from '@/features/wallet/components/usePrivyExport';
import { EntryStep, OtpStep } from '@/features/wallet/components/ConnectionSheetSteps';

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

  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { keyboardLift, lifted, setLifted } = useKeyboardLift();

  const requestClose = useCallback(() => {
    // The typed email stays. Closing and reopening, or backing out of the
    // code step, should still show it.
    setBusy(false);
    setLifted(false);
    keyboardLift.setValue(0);
    onClose();
  }, [keyboardLift, onClose]);

  const { runWalletSetup, handleExternalWallet, handleRetryWallet } = useWalletSetup({
    chain,
    dispatch,
    privy,
    evm,
    activate,
    onClose,
    onConnected,
    solana,
    busy,
    setBusy,
    setActionError,
  });

  const {
    emailInput,
    setEmailInput,
    emailError,
    setEmailError,
    emailFocused,
    setEmailFocused,
    emailField,
    sentEmail,
    otpCode,
    setOtpCode,
    otpError,
    setOtpError,
    otpSession,
    setOtpSession,
    otpClock,
    handleContinue,
    handleResend,
    handleVerifyOTP,
  } = useEmailOtp({ flow, dispatch, privy, busy, setBusy, setActionError, runWalletSetup });

  const options = availableOptions(chain);
  const emailAvailable = options.includes('email');
  const externalAvailable = options.includes('external_wallet');
  const chrome = sheetChrome(flow, { email: sentEmail });

  const { handleLogout, confirmDisconnect } = useSheetDisconnect({
    flow,
    dispatch,
    privy,
    solana,
    chain,
    deactivate,
    onClose,
    busy,
    setBusy,
    setActionError,
    setOtpCode,
    setOtpError,
    setOtpSession,
    setEmailError,
  });
  const { copiedKey, handleCopy } = useCopyAddress();
  const { handleExportContinue } = usePrivyExport({ flow, dispatch });

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
              <EntryStep
                flow={flow}
                emailAvailable={emailAvailable}
                externalAvailable={externalAvailable}
                busy={busy}
                emailField={emailField}
                emailInput={emailInput}
                emailError={emailError}
                emailFocused={emailFocused}
                otpSession={otpSession}
                handleContinue={handleContinue}
                handleExternalWallet={handleExternalWallet}
                setEmailInput={setEmailInput}
                setEmailError={setEmailError}
                setEmailFocused={setEmailFocused}
              />
            ) : null}

            {flow.step.kind === 'otp' ? (
              <OtpStep
                busy={busy}
                otpClock={otpClock}
                otpCode={otpCode}
                otpError={otpError}
                otpSession={otpSession}
                handleResend={handleResend}
                handleVerifyOTP={handleVerifyOTP}
                setOtpCode={setOtpCode}
                setOtpError={setOtpError}
              />
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
