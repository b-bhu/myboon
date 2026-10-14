import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const TEST_SIGNATURES = {
  UNKNOWN: '4qRsmmedddU7s8tPQYvExhYQ8yQ13trC9LEbUv1Nhy9Ui9ww7q4XfvS6wY3QBxntqnwiwCb51gngVhNgSd7Vy5yA',
  TRANSFER: '4zmtrBKRTtW7rQ21qs1zSwMdZkpTMn2RbR5fzKEUajQWU4hXFTcRN85beozH6z2bJg4i7dsp3sH8rPeaLvVxXuiD',
  LP_METEORA: '3i3N31Zc21bJBB7D4k27jHgY1Yrtc7BVjxVPQHbLBk6xoTf7py316XZEpaaiA59E3MyH5KcHDYv3Xx8fR9ZSXQxG'
} as const;

export function ensureTestEnv(): boolean {
  if (process.env.HELIUS_RPC_URL?.trim()) {
    return true;
  }

  const rootEnvPath = path.resolve(process.cwd(), '../../.env');
  if (!existsSync(rootEnvPath)) {
    return false;
  }

  const content = readFileSync(rootEnvPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const index = trimmed.indexOf('=');
    if (index < 1) {
      continue;
    }

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  return Boolean(process.env.HELIUS_RPC_URL?.trim());
}

export const integrationTestsEnabled = ensureTestEnv();
