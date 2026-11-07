import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OTP_RESEND_LABEL,
  PRIVY_EMAIL_SEND_LIMIT,
  PRIVY_EMAIL_SEND_WINDOW_MS,
  beginOtpSend,
  canRequestOtp,
  emptyOtpSession,
  finishOtpSend,
  isPrivyRateLimit,
  nextSendAt,
  readRetryDelayMs,
  resendButtonLabel,
  sessionForEmail,
} from './otp-resend';

const EMAIL = 'user@example.com';
const T0 = 1_700_000_000_000;

describe('Privy email resend deadline', () => {
  it('does not invent the mock 30 second timer after a successful send', () => {
    assert.equal(PRIVY_EMAIL_SEND_LIMIT, 5);
    assert.equal(PRIVY_EMAIL_SEND_WINDOW_MS, 5 * 60 * 1000);
    assert.notEqual(PRIVY_EMAIL_SEND_WINDOW_MS, 30_000);

    const started = beginOtpSend(emptyOtpSession(), EMAIL, T0);
    assert.ok(started);
    assert.equal(started.status, 'Sending code…');
    const sent = finishOtpSend(started, T0 + 40, { ok: true });
    assert.equal(sent.phase, 'sent');
    assert.equal(sent.status, 'Code sent.');
    assert.equal(sent.availableAt, 0);
    assert.equal(canRequestOtp(sent, T0 + 40), true);
    assert.equal(resendButtonLabel(sent.availableAt, T0 + 40), OTP_RESEND_LABEL);
  });

  it('ignores a second tap while Privy is still sending', () => {
    const sending = beginOtpSend(emptyOtpSession(), EMAIL, T0);
    assert.ok(sending);
    assert.equal(beginOtpSend(sending, EMAIL, T0), null);
    assert.equal(beginOtpSend(sending, EMAIL, T0 + 1), null);
  });

  it('counts five accepted sends, then keeps one absolute deadline across reentry', () => {
    let session = emptyOtpSession();
    for (let index = 0; index < PRIVY_EMAIL_SEND_LIMIT; index += 1) {
      const started = beginOtpSend(session, EMAIL, T0 + index);
      assert.ok(started, `send ${index + 1} should start`);
      session = finishOtpSend(started, T0 + index, { ok: true });
    }
    const deadline = T0 + PRIVY_EMAIL_SEND_WINDOW_MS;
    assert.equal(session.availableAt, deadline);
    assert.equal(session.phase, 'resent');
    assert.equal(nextSendAt(session.sentAt, T0 + 10_000), deadline);

    const later = T0 + 90_000;
    assert.equal(session.availableAt, deadline);
    assert.equal(canRequestOtp(session, later), false);
    assert.equal(beginOtpSend(session, EMAIL, later), null);
    assert.equal(resendButtonLabel(session.availableAt, later), 'Resend code · 3:30');
    assert.equal(sessionForEmail(session, ' USER@example.com ').availableAt, deadline);
  });

  it('uses Privy’s retry hint on 429, and the documented window when it gives none', () => {
    const sending = beginOtpSend(emptyOtpSession(), EMAIL, T0);
    assert.ok(sending);
    const hinted = Object.assign(new Error('Please wait 12 seconds'), {
      status: 429,
      code: 'too_many_requests',
      retryAfter: 12,
    });
    assert.equal(isPrivyRateLimit(hinted), true);
    assert.equal(readRetryDelayMs(hinted), 12_000);
    const waited = finishOtpSend(sending, T0, { ok: false, error: hinted });
    assert.equal(waited.availableAt, T0 + 12_000);
    assert.equal(waited.delivered, false);
    assert.match(waited.status, /12 seconds/);
    assert.equal(beginOtpSend(waited, EMAIL, T0 + 1_000), null);

    const bare = beginOtpSend(emptyOtpSession(), EMAIL, T0);
    assert.ok(bare);
    const limited = finishOtpSend(bare, T0, {
      ok: false,
      error: { status: 429, code: 'too_many_requests', error: 'Too many requests' },
    });
    assert.equal(limited.availableAt, T0 + PRIVY_EMAIL_SEND_WINDOW_MS);
    assert.equal(limited.status, 'Too many requests');
  });

  it('does not start a cooldown for an ordinary send failure', () => {
    const sending = beginOtpSend(emptyOtpSession(), EMAIL, T0);
    assert.ok(sending);
    const failed = finishOtpSend(sending, T0, { ok: false, error: new Error('Network down') });
    assert.equal(failed.availableAt, 0);
    assert.equal(failed.status, 'Network down');
    assert.equal(canRequestOtp(failed, T0), true);
    assert.equal(isPrivyRateLimit(new Error('Network down')), false);
  });

  it('a different email drops the previous code session', () => {
    const started = beginOtpSend(emptyOtpSession(), EMAIL, T0);
    assert.ok(started);
    const sent = finishOtpSend(started, T0, { ok: true });
    const other = sessionForEmail(sent, 'other@example.com');
    assert.equal(other.delivered, false);
    assert.equal(other.sentAt.length, 0);
    assert.equal(other.availableAt, 0);
    const again = beginOtpSend(other, 'other@example.com', T0 + 5);
    assert.equal(again?.status, 'Sending code…');
  });
});
