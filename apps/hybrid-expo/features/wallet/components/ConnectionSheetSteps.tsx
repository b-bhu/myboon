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
import { Pressable, Text, TextInput, View } from 'react-native';
import {
  CONNECT_COPY,
  type ConnectFlowState,
} from '@/features/wallet/components/connect.flow';
import {
  canRequestOtp,
  resendButtonLabel,
  type OtpCodeSession,
} from '@/features/wallet/components/otp-resend';
import { pasteCode } from '@/features/wallet/components/useEmailOtp';
import { semantic } from '@/theme';
import { styles } from '@/features/wallet/components/ConnectionSheet.styles';
import {
  EmailMark,
  PrimaryButton,
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
