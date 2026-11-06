import { describe, expect, test, vi } from 'vitest';

import { buildBodyPrompt, BODY_UNAVAILABLE, createHermesBodyClient, type ExecFileImpl } from './hermes-body.js';

describe('createHermesBodyClient (#582, headless oneshot)', () => {
  test('invocation is --ignore-rules + --provider ollama-cloud + model + -z prompt, and never -t', async () => {
    const calls: Array<{ command: string; args: string[]; options: { timeout: number } }> = [];
    const execFileImpl: ExecFileImpl = async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: 'the article body text', stderr: '' };
    };
    const client = createHermesBodyClient({
      model: 'glm-test-1',
      timeoutMs: 5432,
      command: 'hermes-stub',
      execFileImpl,
    });
    const output = await client.runBody({ title: 'A headline', link: 'https://example.test/a', pageText: null });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.command).toBe('hermes-stub');
    expect(call.options.timeout).toBe(5432);
    const args = call.args;
    expect(args.includes('--ignore-rules')).toBe(true);
    expect(args.includes('-t')).toBe(false); // NO browser toolset — headless path
    expect(args.filter((a) => a === '-p').length).toBe(0);
    expect(args[args.indexOf('--provider') + 1]).toBe('ollama-cloud');
    expect(args[args.indexOf('-m') + 1]).toBe('glm-test-1');
    expect(args[args.indexOf('-z') + 1]).toBe(buildBodyPrompt({ title: 'A headline', link: 'https://example.test/a', pageText: null }));
    expect(output).toEqual({ kind: 'body', body: 'the article body text' });
  });

  test('defaults: HERMES_COMMAND, provider ollama-cloud, model glm-5.3-flash', async () => {
    vi.stubEnv('HERMES_COMMAND', '');
    try {
      const calls: Array<{ command: string; args: string[] }> = [];
      const execFileImpl: ExecFileImpl = async (command, args) => {
        calls.push({ command, args });
        return { stdout: 'body', stderr: '' };
      };
      const client = createHermesBodyClient({ model: 'glm-5.3-flash', timeoutMs: 90_000, execFileImpl });
      await client.runBody({ title: null, link: 'https://example.test/a', pageText: null });
      expect(calls[0].command).toBe('hermes');
      expect(calls[0].args[calls[0].args.indexOf('--provider') + 1]).toBe('ollama-cloud');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('BODY_UNAVAILABLE (exact) maps to unavailable', async () => {
    const execFileImpl: ExecFileImpl = async () => ({ stdout: `  ${BODY_UNAVAILABLE}  \n`, stderr: '' });
    const client = createHermesBodyClient({ model: 'm', timeoutMs: 1000, execFileImpl });
    expect(await client.runBody({ title: 't', link: 'https://a', pageText: null })).toEqual({ kind: 'unavailable' });
  });

  test('empty output maps to unavailable', async () => {
    const execFileImpl: ExecFileImpl = async () => ({ stdout: '   \n', stderr: '' });
    const client = createHermesBodyClient({ model: 'm', timeoutMs: 1000, execFileImpl });
    expect(await client.runBody({ title: 't', link: 'https://a', pageText: null })).toEqual({ kind: 'unavailable' });
  });

  test('BODY_UNAVAILABLE mixed into prose still maps to unavailable (conservative drop)', async () => {
    const execFileImpl: ExecFileImpl = async () => ({ stdout: `note: ${BODY_UNAVAILABLE}\nsomething`, stderr: '' });
    const client = createHermesBodyClient({ model: 'm', timeoutMs: 1000, execFileImpl });
    expect(await client.runBody({ title: 't', link: 'https://a', pageText: null })).toEqual({ kind: 'unavailable' });
  });

  test('hard errors carry identity only — never process stdout/stderr content', async () => {
    const timeoutError = Object.assign(new Error('Command failed with SIGTERM'), { killed: true, signal: 'SIGTERM' });
    const client = createHermesBodyClient({
      model: 'm',
      timeoutMs: 1000,
      execFileImpl: async () => { throw timeoutError; },
    });
    await expect(client.runBody({ title: 't', link: 'https://a', pageText: null }))
      .rejects.toThrow('hermes timed out after 1000ms');

    const exitError = Object.assign(new Error('Command failed with exit code 3\nSECRET_STDERR_CONTENT'), { code: 3 });
    const failing = createHermesBodyClient({
      model: 'm',
      timeoutMs: 1000,
      execFileImpl: async () => { throw exitError; },
    });
    await expect(failing.runBody({ title: 't', link: 'https://a', pageText: null }))
      .rejects.toThrow('hermes exited with code 3');

    const enoent = Object.assign(new Error("spawn hermes ENOENT — 'postgres://hunter2'"), { code: 'ENOENT' });
    const missing = createHermesBodyClient({
      model: 'm',
      timeoutMs: 1000,
      execFileImpl: async () => { throw enoent; },
    });
    await expect(missing.runBody({ title: 't', link: 'https://a', pageText: null }))
      .rejects.toThrow('hermes command not found');
  });
});

describe('buildBodyPrompt', () => {
  test('strict body-only contract with page text when present, URL only otherwise', () => {
    const withPage = buildBodyPrompt({ title: 'T', link: 'https://a', pageText: 'page words' });
    expect(withPage).toContain('Output ONLY the body');
    expect(withPage).toContain(BODY_UNAVAILABLE);
    expect(withPage).toContain('Title: T');
    expect(withPage).toContain('page words');

    const urlOnly = buildBodyPrompt({ title: null, link: 'https://a', pageText: null });
    expect(urlOnly).toContain('Title: (none)');
    expect(urlOnly).toContain('Article URL: https://a');
  });
});
