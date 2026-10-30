import { Platform } from 'react-native';

// Dev-support side effect: arms the react-test-renderer instance toJSON shim
// in test processes before any component tests run. Inert in app builds (see
// react-test-instance-tojson.ts).
import './react-test-instance-tojson';

export { FEED_TOKENS } from './feed-tokens';
export type {
  FeedBoxTone,
  FeedTokenColorKey,
  FeedTokenRadiusKey,
  FeedTokenSpaceKey,
  FeedTokenTypeKey,
  FeedTokens,
} from './feed-tokens';

/** Monospace family for numbers, prices and small capital labels (DESIGN.md §2). */
export function monoFontFamily(): string {
  return (
    Platform.select({
      android: 'monospace',
      ios: 'Menlo',
      web: 'ui-monospace, monospace',
      default: 'monospace',
    }) ?? 'monospace'
  );
}