/** #479 Linker + Story (stub; implemented in the next commit). */
import type { DecisionCase, DeciderAnswer } from './deciders.js';
import type { Db } from './states.js';

export const ADDS_NOTHING = 'adds_nothing';
export type RoutingRule = { tokenSlug: string; projectSlug: string; routeTo: string };
export type StoryItem = { id: string; title: string; summary: string | null; occurred_at: string | null };
export type StoryState = { signal: { signal_id: string; text: string | null; excerpt: string | null }; candidates: Array<{ slug: string; name: string; type: string; items: StoryItem[] }> };
export type Interpretation = { status: 'analysed' | 'parked'; parkedReason?: string; fields: Record<string, unknown> };

export function linkerStory(_o: { routingRules: RoutingRule[] }): {
  buildCase(signal: { signal_id: string; text: string | null; excerpt: string | null; link: string | null }, db: Db): Promise<DecisionCase>;
  interpret(answer: DeciderAnswer, c: DecisionCase): Interpretation;
} {
  return {
    async buildCase() { throw new Error('not implemented (#479)'); },
    interpret() { throw new Error('not implemented (#479)'); },
  };
}
