/**
 * Connection sheet step machine.
 *
 * Locks the inline email entry, the #316 split between a bad code and a
 * wallet-setup failure, and the rule that the external-wallet action never
 * becomes a Privy login.
 *
 * Run: pnpm --filter hybrid-expo test:wallet
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONNECT_COPY,
  EXPORT_INSTRUCTIONS,
  INITIAL_CONNECT_FLOW,
  PRIVY_HOME_URL,
  assertPrivyHomeUrl,
  beginPrivyExport,
  interpretPrivyExportSession,
  classifyWalletSetupError,
  connectedChainLabel,
  connectedTitle,
  emailEntryError,
  externalConnectBackend,
  isUserCancelled,
  otpFailureMessage,
  reduceConnectFlow,
  sheetChrome,
  showsLogout,
  type ConnectFlowEvent,
  type ConnectFlowState,
} from './connect.flow';

const TIMEOUT_ERROR = new Error('Privy wallet is still preparing. Please try again in a moment.');
const CREATE_ERROR = new Error('Failed to create Privy wallet');

function apply(state: ConnectFlowState, events: ConnectFlowEvent[]): ConnectFlowState {
  return events.reduce(reduceConnectFlow, state);
}

function signedInCreating(): ConnectFlowState {
  return apply(INITIAL_CONNECT_FLOW, [
    { type: 'code_sent' },
    { type: 'login_succeeded' },
  ]);
}

describe('login and wallet setup stay separate (#316)', () => {
  it('a wrong code stays on the OTP step and uses Invalid code', () => {
    const otp = apply(INITIAL_CONNECT_FLOW, [
      { type: 'code_sent' },
    ]);
    const rejected = reduceConnectFlow(otp, { type: 'otp_rejected' });

    assert.equal(rejected, otp);
    assert.equal(rejected.step.kind, 'otp');
    assert.equal(rejected.setupAttempts, 0);
    assert.equal(otpFailureMessage(new Error('')), CONNECT_COPY.invalidCode);
    assert.equal(otpFailureMessage(new Error('Code expired')), 'Code expired');
  });

  it('login ok then waitForWallet timeout is a wallet-setup failure, not Invalid code', () => {
    const failed = reduceConnectFlow(signedInCreating(), {
      type: 'wallet_setup_failed',
      failure: classifyWalletSetupError(TIMEOUT_ERROR),
    });

    assert.equal(failed.step.kind, 'fail_setup');
    assert.equal(failed.setupFailure, 'timeout');
    assert.equal(failed.setupAttempts, 1);
    assert.equal(failed.setupOutstanding, true);
    assert.equal(CONNECT_COPY.setupTimeoutDetail.includes(CONNECT_COPY.invalidCode), false);
    assert.notEqual(CONNECT_COPY.setupFailedLead, CONNECT_COPY.invalidCode);
  });

  it('login ok then create() throws is its own wallet-setup failure', () => {
    const failed = reduceConnectFlow(signedInCreating(), {
      type: 'wallet_setup_failed',
      failure: classifyWalletSetupError(CREATE_ERROR),
    });

    assert.equal(failed.setupFailure, 'create');
    assert.equal(CONNECT_COPY.setupCreateDetail.includes(CONNECT_COPY.invalidCode), false);
    assert.notEqual(CONNECT_COPY.setupTimeoutDetail, CONNECT_COPY.setupCreateDetail);
  });

  it('retry runs wallet setup again and does not return to the code step', () => {
    const failed = reduceConnectFlow(signedInCreating(), {
      type: 'wallet_setup_failed',
      failure: 'timeout',
    });
    const retried = reduceConnectFlow(failed, { type: 'retry_wallet' });

    assert.equal(retried.step.kind, 'creating');
    assert.equal(retried.setupAttempts, 1);
    assert.equal(reduceConnectFlow(retried, { type: 'code_sent' }).step.kind, 'creating');
    assert.equal(reduceConnectFlow(retried, { type: 'choose_external' }).step.kind, 'creating');
  });

  it('closing and reopening while still signed in resumes wallet setup', () => {
    const failed = reduceConnectFlow(signedInCreating(), {
      type: 'wallet_setup_failed',
      failure: 'timeout',
    });
    const reopened = reduceConnectFlow(failed, {
      type: 'open',
      linked: null,
      privyAuthenticated: true,
      hasEmbeddedWallet: false,
    });

    assert.equal(reopened.step.kind, 'fail_setup');
    assert.equal(reopened.setupAttempts, 1);
    assert.equal(reopened.setupFailure, 'timeout');
    assert.equal(reopened.setupOutstanding, true);
  });

  it('a restored Privy session with no wallet resumes setup instead of asking for a code', () => {
    const opened = reduceConnectFlow(INITIAL_CONNECT_FLOW, {
      type: 'open',
      linked: null,
      privyAuthenticated: true,
      hasEmbeddedWallet: false,
    });

    assert.equal(opened.step.kind, 'fail_setup');
    assert.equal(opened.setupFailure, null);
    assert.equal(showsLogout(opened), false);
  });

  it('a signed-in user who already has a wallet on another chain is not told setup failed', () => {
    const opened = reduceConnectFlow(INITIAL_CONNECT_FLOW, {
      type: 'open',
      linked: null,
      privyAuthenticated: true,
      hasEmbeddedWallet: true,
    });

    assert.equal(opened.step.kind, 'entry');
  });

  it('the third wallet-setup failure offers log out, and that sign-out returns to the email form', () => {
    let state = signedInCreating();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      state = reduceConnectFlow(state, { type: 'wallet_setup_failed', failure: 'timeout' });
      if (attempt < 2) {
        assert.equal(showsLogout(state), false);
        state = reduceConnectFlow(state, { type: 'retry_wallet' });
      }
    }

    assert.equal(state.setupAttempts, 3);
    assert.equal(showsLogout(state), true);
    assert.equal(CONNECT_COPY.logoutAndRestart, 'Log out and start over');

    const loggedOut = reduceConnectFlow(state, { type: 'logout' });
    assert.equal(loggedOut.step.kind, 'entry');
    assert.equal(loggedOut.setupAttempts, 0);
    assert.equal(loggedOut.setupOutstanding, false);
    assert.equal(loggedOut.linked, null);
  });

  it('reopening after the wallet exists shows the connected sheet', () => {
    const failed = reduceConnectFlow(signedInCreating(), {
      type: 'wallet_setup_failed',
      failure: 'create',
    });
    const opened = reduceConnectFlow(failed, {
      type: 'open',
      linked: 'privy',
      privyAuthenticated: true,
      hasEmbeddedWallet: true,
    });

    assert.equal(opened.step.kind, 'connected');
    assert.equal(opened.linked, 'privy');
    assert.equal(opened.setupOutstanding, false);
    assert.equal(connectedTitle('privy'), 'Wallets');
  });
});

describe('the first sheet is email, then one external wallet', () => {
  it('opens on the email form and keeps an invalid address there', () => {
    assert.equal(INITIAL_CONNECT_FLOW.step.kind, 'entry');
    assert.equal(sheetChrome(INITIAL_CONNECT_FLOW, {}).title, 'Connect to MyBoon');
    assert.equal(CONNECT_COPY.continue, 'Continue');
    assert.equal(CONNECT_COPY.connectExternal, 'Connect external wallet');
    assert.equal(emailEntryError(''), CONNECT_COPY.emailInvalid);
    assert.equal(emailEntryError('not-an-email'), CONNECT_COPY.emailInvalid);
    assert.equal(emailEntryError('  user@example.com  '), null);
    assert.equal(reduceConnectFlow(INITIAL_CONNECT_FLOW, { type: 'login_succeeded' }).step.kind, 'entry');
  });

  it('Continue sends the code, Back returns to the same form, and a send failure retries sign-in', () => {
    const otp = reduceConnectFlow(INITIAL_CONNECT_FLOW, { type: 'code_sent' });
    assert.equal(otp.step.kind, 'otp');
    assert.equal(sheetChrome(otp, { email: 'user@example.com' }).subtitle, 'Sent to user@example.com');

    const back = reduceConnectFlow(otp, { type: 'back' });
    assert.equal(back.step.kind, 'entry');
    assert.equal(back.history.length, 0);

    const failed = reduceConnectFlow(INITIAL_CONNECT_FLOW, { type: 'login_failed' });
    assert.equal(failed.step.kind, 'fail_login');
    assert.equal(failed.setupAttempts, 0);
    assert.equal(CONNECT_COPY.signInFailedBody, "Couldn't verify your email.");

    const retried = reduceConnectFlow(failed, { type: 'retry_login' });
    assert.equal(retried.step.kind, 'entry');
    assert.equal(reduceConnectFlow(otp, { type: 'login_failed' }), otp);
  });
});

describe('external wallet is the shared adapter and never Privy', () => {
  it('uses one external action on the adapter, with no provider list', () => {
    assert.equal(externalConnectBackend(), 'external_mwa');
    assert.equal(CONNECT_COPY.connectExternal, 'Connect external wallet');
    assert.equal(CONNECT_COPY.externalWallet, 'External wallet');
    assert.equal(JSON.stringify(CONNECT_COPY).includes('Solana Wallet'), false);
    assert.equal(JSON.stringify(CONNECT_COPY).includes('Google'), false);
    assert.equal(JSON.stringify(CONNECT_COPY).includes('Seeker'), false);
    assert.equal(JSON.stringify(CONNECT_COPY).includes('Phantom'), false);
  });

  it('a cancelled or failed external connect returns to the email form and does not create Privy', () => {
    const waiting = reduceConnectFlow(INITIAL_CONNECT_FLOW, { type: 'choose_external' });
    assert.equal(waiting.step.kind, 'connecting_external');
    assert.equal(waiting.linked, null);
    assert.equal(waiting.setupOutstanding, false);
    assert.equal(sheetChrome(waiting, {}).title, 'Waiting for wallet');

    const cancelled = reduceConnectFlow(waiting, { type: 'external_cancelled' });
    assert.equal(cancelled.step.kind, 'entry');
    assert.equal(cancelled.linked, null);
    assert.equal(cancelled.setupAttempts, 0);
    assert.equal(cancelled.setupOutstanding, false);

    const failed = reduceConnectFlow(waiting, {
      type: 'external_failed',
      message: 'Could not connect that wallet.',
    });
    assert.equal(failed.step.kind, 'entry');
    assert.equal(failed.linked, null);
    assert.equal(failed.externalError, 'Could not connect that wallet.');
    assert.equal(reduceConnectFlow(failed, { type: 'retry_wallet' }), failed);
    assert.equal(reduceConnectFlow(failed, { type: 'login_succeeded' }).step.kind, 'entry');
  });

  it('an external session opens the Wallet sheet, not Wallets, and cannot export', () => {
    const connected = reduceConnectFlow(INITIAL_CONNECT_FLOW, {
      type: 'open',
      linked: 'external',
      privyAuthenticated: false,
      hasEmbeddedWallet: false,
    });

    assert.equal(connected.step.kind, 'connected');
    assert.equal(connectedTitle('external'), 'Wallet');
    assert.equal(reduceConnectFlow(connected, { type: 'open_export' }), connected);
    assert.equal(connectedChainLabel('evm'), 'EVM');
    assert.equal(connectedChainLabel('solana'), 'Solana');
  });

  it('treats a dismissed wallet sheet as a cancel, and anything else as a failure', () => {
    assert.equal(isUserCancelled(new Error('Plugin Closed')), true);
    assert.equal(isUserCancelled(new Error('User rejected the request')), true);
    assert.equal(isUserCancelled(new Error('Could not connect that wallet.')), false);
  });
});

describe('Privy export entry', () => {
  const connected = () => reduceConnectFlow(INITIAL_CONNECT_FLOW, {
    type: 'open',
    linked: 'privy',
    privyAuthenticated: true,
    hasEmbeddedWallet: true,
  });

  it('warns, then hands a Privy session to Privy Home without claiming the key was copied', () => {
    const entry = reduceConnectFlow(connected(), { type: 'open_export' });
    assert.equal(entry.step.kind, 'export');
    assert.equal(sheetChrome(entry, {}).subtitle, '');
    assert.equal(CONNECT_COPY.exportWarning, 'Keep your private key to yourself.');
    const steps = EXPORT_INSTRUCTIONS.map((parts) => parts.map((part) => part.text).join(''));
    assert.deepEqual(steps, [
      'Sign in to Privy with your MyBoon email.',
      'Open My Apps → MyBoon.',
      'Choose your wallet and follow the export instructions.',
    ]);
    assert.equal(EXPORT_INSTRUCTIONS[0][1]?.emphasis, true);
    assert.equal(EXPORT_INSTRUCTIONS[1][1]?.emphasis, true);
    assert.equal(EXPORT_INSTRUCTIONS[1][3]?.emphasis, true);
    const entryCopy = `${steps.join(' ')} ${CONNECT_COPY.exportWarning}`;
    assert.doesNotMatch(entryCopy, /never sees|simulated|disclaimer|no keys were exported/i);

    const notNow = reduceConnectFlow(entry, { type: 'export_not_now' });
    assert.equal(notNow.step.kind, 'connected');
    assert.equal(notNow.linked, 'privy');

    const opening = reduceConnectFlow(entry, { type: 'export_continue' });
    assert.equal(opening.step.kind, 'export_opening');

    const returned = reduceConnectFlow(opening, { type: 'export_handed_off' });
    assert.equal(returned.step.kind, 'connected');
    assert.equal(returned.linked, 'privy');
    assert.equal(returned.history.length, 0);

    assert.deepEqual(beginPrivyExport(), { status: 'open_browser', url: PRIVY_HOME_URL });
    assert.equal(assertPrivyHomeUrl(PRIVY_HOME_URL), 'https://home.privy.io');
    assert.equal(new URL(PRIVY_HOME_URL).search, '');
  });

  it('stays on the failure step when Privy does not open, and try again returns to the warning', () => {
    const opening = apply(connected(), [
      { type: 'open_export' },
      { type: 'export_continue' },
    ]);
    const failed = reduceConnectFlow(opening, { type: 'export_failed' });
    assert.equal(failed.step.kind, 'export_failed');
    assert.match(CONNECT_COPY.exportFailed, /nothing was exported/i);

    const retry = reduceConnectFlow(failed, { type: 'export_retry' });
    assert.equal(retry.step.kind, 'export');
    assert.equal(retry.linked, 'privy');

    const left = reduceConnectFlow(failed, { type: 'back' });
    assert.equal(left.step.kind, 'connected');
  });

  it('treats a closed or opened browser as a handoff, and anything else as a failure to open', () => {
    assert.equal(interpretPrivyExportSession({ type: 'cancel' }), 'handed_off');
    assert.equal(interpretPrivyExportSession({ type: 'dismiss' }), 'handed_off');
    assert.equal(interpretPrivyExportSession({ type: 'opened' }), 'handed_off');
    assert.equal(interpretPrivyExportSession({ type: 'locked' }), 'failed');
    assert.equal(interpretPrivyExportSession({ type: 'success' }), 'failed');
    assert.equal(interpretPrivyExportSession(null), 'failed');
  });

  it('refuses any export URL that is not the bare Privy Home address', () => {
    assert.throws(() => assertPrivyHomeUrl('https://home.privy.io/export?address=secret'));
    assert.throws(() => assertPrivyHomeUrl('https://home.privy.io/#key'));
    assert.throws(() => assertPrivyHomeUrl('http://home.privy.io'));
    assert.throws(() => assertPrivyHomeUrl('https://evil.example/?next=https://home.privy.io'));
    assert.throws(() => assertPrivyHomeUrl('not a url'));
  });

  it('ignores export events unless a Privy session is on the matching step', () => {
    const privy = connected();
    assert.equal(reduceConnectFlow(privy, { type: 'export_continue' }), privy);
    assert.equal(reduceConnectFlow(privy, { type: 'export_handed_off' }), privy);
    assert.equal(reduceConnectFlow(privy, { type: 'export_failed' }), privy);
    assert.equal(reduceConnectFlow(privy, { type: 'export_retry' }), privy);

    const external = reduceConnectFlow(INITIAL_CONNECT_FLOW, {
      type: 'open',
      linked: 'external',
      privyAuthenticated: false,
      hasEmbeddedWallet: false,
    });
    const untouched = apply(external, [
      { type: 'open_export' },
      { type: 'export_continue' },
      { type: 'export_handed_off' },
      { type: 'export_failed' },
      { type: 'export_retry' },
      { type: 'export_not_now' },
    ]);
    assert.equal(untouched, external);
  });
});

describe('ConnectionSheet wires the external path off Privy', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'ConnectionSheet.tsx'),
    'utf8',
  );

  it('does not offer a generic Solana Wallet row, Google, or the Privy-creating connect()', () => {
    assert.equal(source.includes('Solana Wallet'), false);
    assert.equal(source.includes('loginWithGoogle'), false);
    assert.equal(source.includes('solana.connect('), false);
    assert.equal(source.includes('connectExternal'), true);
    assert.equal(source.includes('482193'), false);
    assert.equal(/Continue with Google|Create a new wallet|I already have a wallet/.test(source), false);
  });

  it('the external handler does not log in, wait for, or create a Privy wallet', () => {
    const start = source.indexOf('const handleExternalWallet');
    const end = source.indexOf('const handleContinue');
    assert.ok(start >= 0 && end > start);
    const body = source.slice(start, end);
    assert.equal(/waitForWallet|\.provision\(|loginWith|sendEmailOTP|Phantom|Seeker/.test(body), false);
    assert.match(body, /connectExternal\(\)/);
    assert.match(body, /external_mwa|activate\('solana'\)/);
  });

  it('checks the email, then calls Privy sendCode, and keeps the draft across close', () => {
    const start = source.indexOf('const requestEmailCode');
    const end = source.indexOf('const handleVerifyOTP');
    assert.ok(start >= 0 && end > start);
    const body = source.slice(start, end);
    const checked = body.indexOf('emailEntryError');
    const sent = body.indexOf('sendEmailOTP');
    assert.ok(checked >= 0 && sent >= 0);
    assert.match(body, /emailEntryError[\s\S]*requestEmailCode\(email, false\)/);
    assert.match(body, /sendEmailOTP\(email\)/);
    assert.match(body, /login_failed/);
    assert.equal(/loginWithGoogle|waitForWallet|482193/.test(body), false);
    assert.match(source, /loginWithEmailOTP\(otpCode\.trim\(\), sentEmail\)/);
    assert.match(body, /Resend code|handleResend/);
    assert.match(source, /accessibilityLiveRegion="polite"/);

    const closeStart = source.indexOf('const requestClose');
    const closeEnd = source.indexOf('const finishActivated');
    assert.equal(source.slice(closeStart, closeEnd).includes('setEmailInput'), false);
    assert.match(source, /Clipboard\.getStringAsync/);
    assert.match(source, /Clipboard\.setStringAsync/);
  });

  it('opens Privy Home in the system browser and does not read a key', () => {
    const start = source.indexOf('async function openPrivyExportPage');
    assert.ok(start >= 0);
    const body = source.slice(start);
    assert.match(body, /WebBrowser\.openBrowserAsync/);
    assert.match(body, /assertPrivyHomeUrl/);
    assert.equal(/exportWallet|console\.|Clipboard|privateKey|mnemonic/.test(body), false);
    assert.match(source, /flow\.linked !== 'privy'/);
    const exportRow = source.indexOf('CONNECT_COPY.export');
    const privyBranch = source.lastIndexOf("flow.linked === 'privy'", exportRow);
    assert.ok(privyBranch >= 0 && exportRow > privyBranch);
  });
});
