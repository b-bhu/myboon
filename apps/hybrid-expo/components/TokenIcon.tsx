/**
 * The one token icon component, replacing Pacifica's SVG-fetch TokenIcon
 * (PacificaMarketListScreen.tsx:32-59) and Meteora's Image-based TokenMark /
 * TokenPair (MeteoraPoolsScreen.tsx:119-156). See
 * docs/modules/wallet/PRDs/2026_08_11_token_identity_and_venue_adapters_PRD.md,
 * "Shared market list shell" and "What a user actually sees".
 *
 * Three-tier fallback, in order, and this is the important rule: a tier is
 * skipped only when its field is EMPTY (null/undefined/''), never because a
 * request came back non-200. An HTTP error on tier 1 still tries to render
 * tier 1's URL (expo-image handles the failed load and we chain onError),
 * we only skip straight to a later tier up front when the field itself is
 * missing.
 *
 *   1. identity.iconUrl, resolved through tokenIconUrl() — our own origin.
 *   2. venueIconUrl — the venue's own CDN icon (Meteora today). A
 *      slightly-off icon beats no icon on a pool row.
 *   3. letter box — identity.fallbackLetter when an identity resolved,
 *      otherwise the caller-supplied `letter` prop.
 *
 * SVG choice: rendered through expo-image (v3), not react-native-svg's
 * SvgXml + a hand-rolled text-fetch cache (Pacifica's old approach). expo-image
 * v3 decodes SVGs natively on both platforms, and folding the fetch-as-text
 * dance into a plain <Image uri> lets one component handle PNG/SVG/whatever
 * the identity service returns without branching on extension, plus we get
 * expo-image's disk+memory caching for free. If expo-image's SVG support
 * proves unreliable in practice, resurrect the svgCache/SvgXml branch here
 * for `.svg` URLs specifically — the fetch-as-text idiom is: cache the
 * fetched XML string in a module-level Map keyed by URL, fall back on
 * fetch/parse failure. Not needed today.
 */

import { Image, type ImageStyle } from 'expo-image';
import { memo, useMemo, useState } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { tokenIconUrl, type TokenIdentity } from '@/lib/token-identity';
import { semantic, tokens } from '@/theme';

export interface TokenIconProps {
  identity?: TokenIdentity | null;
  venueIconUrl?: string | null;
  letter: string;
  size?: number;
  tint?: string;
}

const DEFAULT_SIZE = 28;

type Tier = 'identity' | 'venue' | 'letter';

/** First non-empty tier to attempt, given what's available. */
function firstTier(identityUrl: string | null, venueUrl: string | null | undefined): Tier {
  if (identityUrl) return 'identity';
  if (venueUrl) return 'venue';
  return 'letter';
}

export const TokenIcon = memo(function TokenIcon({
  identity,
  venueIconUrl,
  letter,
  size = DEFAULT_SIZE,
  tint,
}: TokenIconProps) {
  const identityUrl = useMemo(() => tokenIconUrl(identity?.iconUrl), [identity?.iconUrl]);
  // BOTH tiers go through tokenIconUrl. Venue icon paths from our own API
  // (pacifica.ts / phoenix.ts set `iconPath`) are ORIGIN-RELATIVE, e.g.
  // "/tokens/icon/pepe". Handing that straight to <Image> resolves it against
  // whatever origin the app happens to be served from — on Expo web that is
  // localhost:8081, so every icon 404s against the dev server instead of the
  // API. Absolute venue URLs (Meteora's CDN) pass through untouched.
  const venueUrl = useMemo(() => tokenIconUrl(venueIconUrl), [venueIconUrl]);
  const resolvedLetter = (identity?.fallbackLetter || letter || '?').charAt(0).toUpperCase() || '?';

  // Reset which tier we're attempting whenever the source URLs change (new row data).
  const [tier, setTier] = useState<Tier>(() => firstTier(identityUrl, venueUrl));
  const [tierKey, setTierKey] = useState(`${identityUrl ?? ''}|${venueUrl ?? ''}`);
  const nextKey = `${identityUrl ?? ''}|${venueUrl ?? ''}`;
  if (nextKey !== tierKey) {
    setTierKey(nextKey);
    setTier(firstTier(identityUrl, venueUrl));
  }

  const boxStyle: StyleProp<ViewStyle> = [
    styles.box,
    { width: size, height: size, borderRadius: size / 2 },
  ];

  if (tier === 'identity' && identityUrl) {
    return (
      <View
        style={boxStyle}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Image
          source={{ uri: identityUrl }}
          style={[styles.image, imageSize(size)]}
          onError={() => setTier(venueIconUrl ? 'venue' : 'letter')}
          contentFit="cover"
          cachePolicy="disk"
        />
      </View>
    );
  }

  if (tier === 'venue' && venueUrl) {
    return (
      <View
        style={boxStyle}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Image
          source={{ uri: venueUrl }}
          style={[styles.image, imageSize(size)]}
          onError={() => setTier('letter')}
          contentFit="cover"
          cachePolicy="disk"
        />
      </View>
    );
  }

  return (
    <View
      style={[boxStyle, styles.fallback, tint ? { backgroundColor: tint } : null]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[styles.fallbackText, tint ? styles.fallbackTextOnTint : null]}>
        {resolvedLetter}
      </Text>
    </View>
  );
});

/**
 * The overlapped two-token layout (Meteora's `SOL / USDC` pair mark),
 * ported from MeteoraPoolsScreen.tsx:119-136. Each leg goes through the
 * same three-tier TokenIcon so the fallback letter box stays visually
 * identical to every single-token row — `tint` is the one sanctioned
 * override, letting Meteora keep its cyan/violet pair tinting.
 */
export interface TokenPairIconProps {
  x: { identity?: TokenIdentity | null; venueIconUrl: string | null; letter: string; tint?: string };
  y: { identity?: TokenIdentity | null; venueIconUrl: string | null; letter: string; tint?: string };
  size?: number;
}

const PAIR_ICON_SIZE = 26;

export const TokenPairIcon = memo(function TokenPairIcon({
  x,
  y,
  size = PAIR_ICON_SIZE,
}: TokenPairIconProps) {
  const wrapperSize = size + 12;
  return (
    <View style={[styles.pairWrapper, { width: wrapperSize, height: size + 4 }]}>
      <TokenIcon
        identity={x.identity}
        venueIconUrl={x.venueIconUrl}
        letter={x.letter}
        tint={x.tint}
        size={size}
      />
      <View style={styles.pairSecond}>
        <TokenIcon
          identity={y.identity}
          venueIconUrl={y.venueIconUrl}
          letter={y.letter}
          tint={y.tint}
          size={size}
        />
      </View>
    </View>
  );
});

function imageSize(size: number): ImageStyle {
  return { width: size, height: size, borderRadius: size / 2 };
}

const styles = StyleSheet.create({
  box: {
    overflow: 'hidden',
  },
  image: {
    backgroundColor: semantic.background.surfaceRaised,
  },
  fallback: {
    backgroundColor: semantic.background.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallbackText: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSize.xs,
    fontWeight: '700',
    color: semantic.text.dim,
  },
  fallbackTextOnTint: {
    color: '#07111B',
    fontWeight: '900',
  },
  pairWrapper: {
    position: 'relative',
  },
  pairSecond: {
    position: 'absolute',
    right: 0,
    bottom: 0,
  },
});
