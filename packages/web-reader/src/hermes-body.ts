/**
 * #582 thin Hermes oneshot client (the headless fallback path): execs the
 * `hermes` CLI bufferless (execFile) with `--ignore-rules`, provider
 * ollama-cloud, the configured model (-m), the strict body-only prompt via
 * `-z`, and NEVER a `-t` browser toolset and never a chat session. Error
 * messages carry exit/signal identity only — never process output — so a
 * failure log cannot leak prompt or page content (same discipline as
 * collectors' HermesService, minus its limiters and circuits: this worker's
 * own concurrency bound is the parallel-batch cap).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const DEFAULT_COMMAND = 'hermes';
const DEFAULT_PROVIDER = 'ollama-cloud';
const DEFAULT_MODEL = 'glm-5.3-flash';
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
/** Page text handed to the prompt is capped so one call stays bounded. */
const PAGE_TEXT_PROMPT_CHARS = 24_000;
/** Exactly this token means "no readable body" (case-insensitive match). */
export const BODY_UNAVAILABLE = 'BODY_UNAVAILABLE';

export type ExecFileImpl = (
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface HermesBodyInput {
  /** The signal's title (atlas.signals.text); may be null. */
  title: string | null;
  /** The article URL. */
  link: string;
  /** Plain-fetched page text when plain extraction produced something, else null. */
  pageText: string | null;
}

export type HermesBodyOutput =
  | { kind: 'body'; body: string }
  | { kind: 'unavailable' };

/** Injectable Hermes runner: one strict body-only oneshot per call. */
export type HermesBodyRunner = (input: HermesBodyInput) => Promise<HermesBodyOutput>;

export interface HermesBodyClient {
  runBody(input: HermesBodyInput): Promise<HermesBodyOutput>;
}

export interface HermesBodyClientOptions {
  model: string;
  timeoutMs: number;
  /** CLI command; defaults to HERMES_COMMAND, then 'hermes'. */
  command?: string;
  provider?: string;
  /** Test seam; production uses node:child_process execFile. */
  execFileImpl?: ExecFileImpl;
  maxBufferBytes?: number;
}

const execFileAsync = promisify(execFile) as unknown as ExecFileImpl;

export function buildBodyPrompt(input: HermesBodyInput): string {
  const title = input.title?.trim() || '(none)';
  const pageText = input.pageText?.trim();
  const context = pageText
    ? `Page text fetched over HTTP (may be a teaser or partial):\n${pageText.slice(0, PAGE_TEXT_PROMPT_CHARS)}`
    : `Article URL: ${input.link}`;
  return [
    'You extract news article bodies. Given an article title and either the page text fetched over HTTP or the article URL, output the readable article body.',
    'Output ONLY the body as plain text: no title, no commentary, no markdown fences, no summary. Use only what the given material actually says; never invent or complete content.',
    `If the body cannot be read from the given material, output exactly this single line and nothing else: ${BODY_UNAVAILABLE}`,
    '',
    `Title: ${title}`,
    context,
  ].join('\n');
}

export function createHermesBodyClient(options: HermesBodyClientOptions): HermesBodyClient {
  const command = options.command?.trim() || process.env.HERMES_COMMAND?.trim() || DEFAULT_COMMAND;
  const provider = options.provider ?? DEFAULT_PROVIDER;
  const timeoutMs = options.timeoutMs;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const execFileImpl = options.execFileImpl ?? execFileAsync;

  function toHardError(error: unknown): Error {
    const e = error as { code?: unknown; killed?: unknown; signal?: unknown };
    if (e.code === 'ENOENT') return new Error('hermes command not found');
    if (e.killed === true) return new Error(`hermes timed out after ${timeoutMs}ms`);
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new Error(`hermes output exceeded max buffer ${maxBufferBytes}`);
    if (typeof e.code === 'number') return new Error(`hermes exited with code ${e.code}`);
    if (typeof e.code === 'string') return new Error(`hermes exited with ${e.code}`);
    return new Error('hermes oneshot failed');
  }

  return {
    async runBody(input: HermesBodyInput): Promise<HermesBodyOutput> {
      const prompt = buildBodyPrompt(input);
      const args = [
        '--ignore-rules',
        '--provider', provider,
        '-m', options.model,
        '-z', prompt,
      ];
      let stdout: string;
      try {
        ({ stdout } = await execFileImpl(command, args, {
          timeout: timeoutMs,
          maxBuffer: maxBufferBytes,
          env: { ...process.env },
        }));
      } catch (error) {
        throw toHardError(error);
      }
      const trimmed = stdout.trim();
      if (!trimmed || trimmed.toUpperCase().includes(BODY_UNAVAILABLE)) {
        return { kind: 'unavailable' };
      }
      return { kind: 'body', body: trimmed };
    },
  };
}
