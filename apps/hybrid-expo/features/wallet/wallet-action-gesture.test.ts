import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createReverseGesture,
  WALLET_ACTION_MENU,
  WALLET_ACTION_MENU_IDS,
  type WalletGestureScheduler,
} from './wallet-action-gesture';

class FakeScheduler implements WalletGestureScheduler {
  private now = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.now = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.now = end;
  }

  get pendingCount(): number {
    return this.timers.size;
  }
}

function setup() {
  const scheduler = new FakeScheduler();
  const events: string[] = [];
  let enabled = true;
  const gesture = createReverseGesture({
    scheduler,
    isEnabled: () => enabled,
    onSingleTap: () => events.push('single'),
    onDoubleTap: () => events.push('double'),
  });
  return {
    scheduler,
    events,
    gesture,
    setEnabled: (next: boolean) => {
      enabled = next;
    },
  };
}

test('a single tap is deferred once, then reverses after 300ms', () => {
  const { scheduler, events, gesture } = setup();

  gesture.handleTap();
  assert.deepEqual(events, []);
  assert.equal(scheduler.pendingCount, 1);

  scheduler.advance(299);
  assert.deepEqual(events, []);
  scheduler.advance(1);
  assert.deepEqual(events, ['single']);
  assert.equal(scheduler.pendingCount, 0);
});

test('a second tap within the window cancels the single and opens the menu', () => {
  const { scheduler, events, gesture } = setup();

  gesture.handleTap();
  scheduler.advance(150);
  gesture.handleTap();

  assert.deepEqual(events, ['double']);
  assert.equal(scheduler.pendingCount, 0);
  scheduler.advance(300);
  assert.deepEqual(events, ['double']);
});

test('three taps resolve as one double tap followed by a fresh single tap', () => {
  const { scheduler, events, gesture } = setup();

  gesture.handleTap();
  scheduler.advance(100);
  gesture.handleTap();
  gesture.handleTap();
  assert.deepEqual(events, ['double']);
  scheduler.advance(300);
  assert.deepEqual(events, ['double', 'single']);
});

test('cancel resets the tap window and leaves no queued reversal', () => {
  const { scheduler, events, gesture } = setup();

  gesture.handleTap();
  gesture.cancel();
  assert.equal(scheduler.pendingCount, 0);
  scheduler.advance(300);
  assert.deepEqual(events, []);

  gesture.handleTap();
  scheduler.advance(300);
  assert.deepEqual(events, ['single']);
});

test('disabled state is checked synchronously before a delayed callback', () => {
  const { scheduler, events, gesture, setEnabled } = setup();

  gesture.handleTap();
  setEnabled(false);
  scheduler.advance(300);
  assert.deepEqual(events, []);
  assert.equal(scheduler.pendingCount, 0);

  gesture.handleTap();
  assert.deepEqual(events, []);
  assert.equal(scheduler.pendingCount, 0);
});

test('disabled state prevents a double callback and clears its pending single', () => {
  const { scheduler, events, gesture, setEnabled } = setup();

  gesture.handleTap();
  setEnabled(false);
  gesture.handleTap();
  scheduler.advance(300);
  assert.deepEqual(events, []);
  assert.equal(scheduler.pendingCount, 0);
});

test('dispose cancels a pending tap and ignores future taps', () => {
  const { scheduler, events, gesture } = setup();

  gesture.handleTap();
  gesture.dispose();
  assert.equal(scheduler.pendingCount, 0);
  scheduler.advance(300);
  gesture.handleTap();
  assert.deepEqual(events, []);
});

test('update supplies the latest callbacks without replacing the recognizer', () => {
  const { scheduler, events, gesture } = setup();
  const latest: string[] = [];

  gesture.update({
    onSingleTap: () => latest.push('single'),
    onDoubleTap: () => latest.push('double'),
  });
  gesture.handleTap();
  scheduler.advance(300);
  assert.deepEqual(events, []);
  assert.deepEqual(latest, ['single']);
});

test('menu ids expose the four discoverable Wallet actions', () => {
  assert.deepEqual(WALLET_ACTION_MENU_IDS, ['swap', 'send', 'receive', 'transfer']);
  assert.deepEqual(
    WALLET_ACTION_MENU.map((entry) => entry.label),
    ['Swap', 'Send', 'Receive', 'Transfer'],
  );
});
