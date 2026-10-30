import Svg, { Polyline } from 'react-native-svg';
import { FEED_TOKENS } from '../feed-design';
import { sampleSparkline } from '../feed-market';
import { heatmapTone } from '../token-heatmap-layout';

interface TokenSparklineProps {
  address: string;
  change: number | null;
  width?: number;
  height?: number;
}

/**
 * Sample polyline sparkline for table rows (48×20 like the mock) and the
 * token sheet, drawn only while FEED mocks are on — the caller decides that,
 * since real tokens have no history here yet. The stroke follows the change
 * tone: viridian up, vermillion down, dim when unknown.
 */
export function TokenSparkline({ address, change, width = 48, height = 20 }: TokenSparklineProps) {
  const values = sampleSparkline(address, Math.round(width / 4) + 1);
  const pad = 2;
  const span = values.length - 1;
  const points = values
    .map((value, index) => {
      const x = span === 0 ? width : (index / span) * width;
      const y = pad + (1 - value) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const tone = heatmapTone(change);
  const stroke = tone === 'up' ? FEED_TOKENS.colors.up : tone === 'down' ? FEED_TOKENS.colors.down : FEED_TOKENS.colors.textDim;

  return (
    <Svg width={width} height={height} accessible={false} importantForAccessibility="no-hide-descendants">
      <Polyline points={points} fill="none" stroke={stroke} strokeWidth={1.2} />
    </Svg>
  );
}