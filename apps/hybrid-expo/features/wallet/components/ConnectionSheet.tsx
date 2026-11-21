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
 *
 * The step screens live in ConnectionSheetSteps.tsx (#739); this file keeps the
 * Modal, the header and the step switch.
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
  canGoBack,
  connectedChainLabel,
  sheetChrome,
  showsLogout,
  type LinkedKind,
} from '@/features/wallet/components/connect.flow';
import { usePrivyWallet } from '@/hooks/usePrivyWallet';
import { useWallet } from '@/hooks/useWallet';
import { semantic } from '@/theme';
import { styles } from '@/features/wallet/components/ConnectionSheet.styles';
import {
  FailBlock,
  PrimaryButton,
  WaitBlock,
} from '@/features/wallet/components/ConnectionSheetParts';
import { useKeyboardLift } from '@/features/wallet/components/useKeyboardLift';
import { useConnectFlow } from '@/features/wallet/components/useConnectFlow';
import { useEmailOtp } from '@/features/wallet/components/useEmailOtp';
import { useWalletSetup } from '@/features/wallet/components/useWalletSetup';
import { useSheetDisconnect } from '@/features/wallet/components/useSheetDisconnect';
import { useCopyAddress } from '@/features/wallet/components/useCopyAddress';
import { usePrivyExport } from '@/features/wallet/components/usePrivyExport';
import {
  ConnectedStep,
  ConfirmDisconnectStep,
  EntryStep,
  ExportSteps,
  OtpStep,
} from '@/features/wallet/components/ConnectionSheetSteps';

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
              <ConnectedStep
                busy={busy}
                chainRows={chainRows}
                copiedKey={copiedKey}
                dispatch={dispatch}
                flow={flow}
                handleCopy={handleCopy}
                privyLabel={privyLabel}
              />
            ) : null}

            {flow.step.kind === 'export'
              || flow.step.kind === 'export_opening'
              || flow.step.kind === 'export_failed' ? (
              <ExportSteps
                dispatch={dispatch}
                onContinue={handleExportContinue}
                step={flow.step}
              />
            ) : null}

            {flow.step.kind === 'confirm_disconnect' ? (
              <ConfirmDisconnectStep
                actionError={actionError}
                busy={busy}
                confirmDisconnect={confirmDisconnect}
                dispatch={dispatch}
                flow={flow}
              />
            ) : null}
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
