import { createHash } from 'node:crypto';

/**
 * sha256 hex (lowercase, 64 chars) of `${source}\u0000${source_id}`.
 * The NUL separator prevents boundary collisions: signalId('ab', 'c') must
 * never equal signalId('a', 'bc'). Matches signal_id in atlas.signals /
 * atlas.decisions.
 */
export function signalId(source: string, sourceId: string): string {
  return rawHash(`${source}\u0000${sourceId}`);
}

/** sha256 hex (lowercase, 64 chars) of the raw bytes or string. */
export function rawHash(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex');
}