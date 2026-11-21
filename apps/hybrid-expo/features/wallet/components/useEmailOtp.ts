/**
 * useEmailOtp — the sheet's email entry and OTP step state.
 *
 * Moved out of ConnectionSheet.tsx (#737). Owns the email draft (it survives
 * close), the OTP session with its send lock and 250ms countdown, and the
 * four actions: request the code, continue, resend, verify. A verified code
 * hands straight on to runWalletSetup — login and wallet setup stay separate
 * tries (#316).
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The connection modal")
 */

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { TextInput } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  beginOtpSend,
  canRequestOtp,
  emptyOtpSession,
  finishOtpSend,
  isPrivyRateLimit,
  sessionForEmail,
  type OtpCodeSession,
} from '@/features/wallet/components/otp-resend';
import {
  classifyWalletSetupError,
  emailEntryError,
  otpFailureMessage,
  type ConnectFlowEvent,
  type ConnectFlowState,
} from '@/features/wallet/components/connect.flow';
import type { PrivyWalletState } from '@/hooks/usePrivyWallet';

export function useEmailOtp({
  flow,
  dispatch,
  privy,
  busy,
  setBusy,
  setActionError,
  runWalletSetup,
}: {
  flow: ConnectFlowState;
  dispatch: (event: ConnectFlowEvent) => void;
  privy: PrivyWalletState;
  busy: boolean;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setActionError: Dispatch<SetStateAction<string | null>>;
  runWalletSetup: () => Promise<void>;
}) {
  const [emailInput, setEmailInput] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailFocused, setEmailFocused] = useState(false);
  const [sentEmail, setSentEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpSession, setOtpSession] = useState<OtpCodeSession>(emptyOtpSession);
  const [otpClock, setOtpClock] = useState(() => Date.now());
  const otpSendLock = useRef(false);
  const emailField = useRef<TextInput>(null);

  useEffect(() => {
    if (flow.step.kind !== 'otp') return;
    setOtpClock(Date.now());
    const waiting = otpSession.phase === 'sending' || otpSession.availableAt > Date.now();
    if (!waiting) return;
    const timer = setInterval(() => setOtpClock(Date.now()), 250);
    return () => clearInterval(timer);
  }, [flow.step.kind, otpSession.availableAt, otpSession.phase]);

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
  }, [busy, dispatch, otpSession, privy, setActionError, setBusy]);

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
  }, [busy, dispatch, otpCode, privy, runWalletSetup, sentEmail, setBusy]);

  return {
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
  };
}

export async function pasteCode(setOtpCode: (value: string) => void) {
  const text = (await Clipboard.getStringAsync()) ?? '';
  const digits = text.replace(/\D/g, '').slice(0, 6);
  if (digits) setOtpCode(digits);
}
