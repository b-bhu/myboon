import { tokens } from '@/theme/tokens';

/**
 * Chart-specific visual language. Trading surfaces need more separation and
 * tighter geometry than the broader application theme provides.
 */
export const marketChartTheme = {
  colors: {
    canvas: '#052F3B',
    toolbar: '#073743',
    control: '#093F4C',
    controlSelected: '#0D5060',
    menu: '#083A46',
    menuSelected: 'rgba(17, 138, 178, 0.18)',
    border: 'rgba(156, 184, 194, 0.22)',
    divider: 'rgba(156, 184, 194, 0.16)',
    grid: '#6B95A1',
    axisText: '#86A2AA',
    primaryText: '#E8F2F4',
    secondaryText: '#9CB8C2',
    accent: tokens.colors.primary,
    bullish: tokens.colors.viridian,
    bearish: tokens.colors.vermillion,
    selection: '#C5D8DD',
  },
  metrics: {
    toolbarHeight: 48,
    toolbarInset: 12,
    controlHeight: 32,
    controlRadius: 8,
    controlGap: 8,
    iconSize: 18,
    minimumHitTarget: 44,
    timeframeWidth: 72,
    modeWidth: 92,
    menuWidth: 136,
    menuRowHeight: 40,
    menuRadius: 8,
    menuOffset: 4,
    priceAxisWidth: 48,
    timeAxisHeight: 24,
    liveEdgeGap: 16,
  },
} as const;
