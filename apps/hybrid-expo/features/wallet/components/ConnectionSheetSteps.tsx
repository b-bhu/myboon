/**
 * ConnectionSheetSteps — the sheet's step screens.
 *
 * Moved out of ConnectionSheet.tsx (#739): the email entry, the code step, and
 * the later steps, exactly as the sheet rendered them. The sheet keeps the
 * Modal, the header and the step switch; each step here is presentation over
 * the same state — no new state and no new behaviour.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The connection modal")
 */

import { useRef } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import {
  CONNECT_COPY,
  EXPORT_INSTRUCTIONS,
  type ConnectFlowEvent,
  type ConnectFlowState,
  type ConnectStep,
} from '@/features/wallet/components/connect.flow';
import {
  canRequestOtp,
  resendButtonLabel,
  type OtpCodeSession,
} from '@/features/wallet/components/otp-resend';
import { pasteCode } from '@/features/wallet/components/useEmailOtp';
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

export function EntryStep({
  flow,
  emailAvailable,
  externalAvailable,
  busy,
  emailField,
  emailInput,
  emailError,
  emailFocused,
  otpSession,
  handleContinue,
  handleExternalWallet,
  setEmailInput,
  setEmailError,
  setEmailFocused,
}: {
  flow: ConnectFlowState;
  emailAvailable: boolean;
  externalAvailable: boolean;
  busy: boolean;
  emailField: RefObject<TextInput | null>;
  emailInput: string;
  emailError: string | null;
  emailFocused: boolean;
  otpSession: OtpCodeSession;
  handleContinue: () => Promise<void>;
  handleExternalWallet: () => Promise<void>;
  setEmailInput: Dispatch<SetStateAction<string>>;
  setEmailError: Dispatch<SetStateAction<string | null>>;
  setEmailFocused: Dispatch<SetStateAction<boolean>>;
}) {
  return (
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
  );
}

export function OtpStep({
  busy,
  otpClock,
  otpCode,
  otpError,
  otpSession,
  handleResend,
  handleVerifyOTP,
  setOtpCode,
  setOtpError,
}: {
  busy: boolean;
  otpClock: number;
  otpCode: string;
  otpError: string | null;
  otpSession: OtpCodeSession;
  handleResend: () => Promise<void>;
  handleVerifyOTP: () => Promise<void>;
  setOtpCode: Dispatch<SetStateAction<string>>;
  setOtpError: Dispatch<SetStateAction<string | null>>;
}) {
  const otpInput = useRef<TextInput>(null);
  const resendLabel = resendButtonLabel(otpSession.availableAt, otpClock);
  const resendDisabled = busy || otpSession.phase === 'sending' || !canRequestOtp(otpSession, otpClock);

  return (
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
  );
}

export function ConnectedStep({
  flow,
  privyLabel,
  chainRows,
  copiedKey,
  handleCopy,
  busy,
  dispatch,
}: {
  flow: ConnectFlowState;
  privyLabel: string;
  chainRows: { key: string; label: string; address: string }[];
  copiedKey: string | null;
  handleCopy: (key: string, address: string) => Promise<void>;
  busy: boolean;
  dispatch: (event: ConnectFlowEvent) => void;
}) {
  return (
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
  );
}

export function ExportSteps({
  step,
  dispatch,
  onContinue,
}: {
  step: Extract<ConnectStep, { kind: 'export' } | { kind: 'export_opening' } | { kind: 'export_failed' }>;
  dispatch: (event: ConnectFlowEvent) => void;
  onContinue: () => void;
}) {
  if (step.kind === 'export') {
    return (
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
          <PrimaryButton compact label={CONNECT_COPY.continuePrivy} onPress={onContinue} />
          <SecondaryButton
            compact
            label={CONNECT_COPY.notNow}
            onPress={() => dispatch({ type: 'export_not_now' })}
          />
        </View>
      </View>
    );
  }

  if (step.kind === 'export_opening') {
    return <WaitBlock title={CONNECT_COPY.openingPrivyTitle} body={CONNECT_COPY.openingPrivyBody} />;
  }

  return (
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
  );
}

export function ConfirmDisconnectStep({
  flow,
  actionError,
  busy,
  confirmDisconnect,
  dispatch,
}: {
  flow: ConnectFlowState;
  actionError: string | null;
  busy: boolean;
  confirmDisconnect: () => Promise<void>;
  dispatch: (event: ConnectFlowEvent) => void;
}) {
  return (
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
  );
}
