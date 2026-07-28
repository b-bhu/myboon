import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PortfolioPosition } from '@/features/predict/predict.api';
import { redeemPosition } from '@/features/predict/predict.api';
import type { Signer } from '@/features/chain/chain.contract';
import { formatPredictTitle } from '@/features/predict/formatPredictTitle';
import { formatRedeemError, logRedeemError } from '@/features/predict/redeemErrors';
import { semantic, tokens } from '@/theme';

interface RedeemableSectionProps {
  positions: PortfolioPosition[];
  polygonAddress: string | null;
  signer: Signer | null;
  onRedeemed?: () => void;
}

function redeemablePositionKey(position: PortfolioPosition): string {
  return `${position.conditionId}-${position.outcomeIndex ?? 'outcome'}-${position.asset ?? 'asset'}`;
}

export function RedeemableSection({ positions, polygonAddress, signer, onRedeemed }: RedeemableSectionProps) {
  const [, setCollectingKeys] = useState<Set<string>>(() => new Set());
  const visiblePositions = positions.filter((position) =>
    (position.currentValue ?? 0) >= 0.01
  );
  if (visiblePositions.length === 0) return null;

  const totalRedeemable = visiblePositions.reduce((sum, p) => sum + (p.currentValue ?? 0), 0);

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <Text style={styles.title}>Redeemable</Text>
        <Text style={styles.total}>${totalRedeemable.toFixed(2)}</Text>
      </View>

      {visiblePositions.map((p, i) => (
        <RedeemRow
          key={`${p.conditionId}-${p.outcomeIndex}-${i}`}
          position={p}
          polygonAddress={polygonAddress}
          signer={signer}
          onRedeemed={() => {
            setCollectingKeys((current) => {
              const next = new Set(current);
              next.add(redeemablePositionKey(p));
              return next;
            });
            onRedeemed?.();
          }}
        />
      ))}
    </View>
  );
}

function RedeemRow({
  position: p,
  polygonAddress,
  signer,
  onRedeemed,
}: {
  position: PortfolioPosition;
  polygonAddress: string | null;
  signer: Signer | null;
  onRedeemed?: () => void;
}) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const value = p.currentValue ?? 0;

  async function handleRedeem() {
    if (!polygonAddress || !signer || status === 'loading' || status === 'success') return;

    setStatus('loading');
    setErrorMsg('');

    try {
      const result = await redeemPosition(signer, polygonAddress, {
        conditionId: p.conditionId,
        asset: p.asset,
        outcomeIndex: p.outcomeIndex,
        negativeRisk: p.negativeRisk,
      });
      if (result.ok) {
        setStatus('success');
        onRedeemed?.();
      } else {
        const error = new Error(result.error ?? 'Redeem failed');
        logRedeemError('redeemable-section', error, p);
        setStatus('error');
        setErrorMsg(formatRedeemError(error));
      }
    } catch (err) {
      logRedeemError('redeemable-section', err, p);
      setStatus('error');
      setErrorMsg(formatRedeemError(err));
    }
  }

  return (
    <View style={styles.rowWrap}>
      <View style={styles.row}>
        <View style={[styles.outcomeBadge, styles.badgePos]}>
          <Text style={[styles.outcomeBadgeText, styles.posText]}>
            {p.outcome?.toUpperCase() ?? 'YES'}
          </Text>
        </View>
        <View style={styles.info}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {formatPredictTitle({ title: p.title, slug: p.slug || p.eventSlug })}
          </Text>
          <Text style={styles.rowShares}>{p.size.toFixed(2)} shares</Text>
        </View>
        <Pressable
          style={[
            styles.redeemBtn,
            status === 'loading' && styles.redeemBtnBusy,
            status === 'success' && styles.redeemBtnSuccess,
            status === 'error' && styles.redeemBtnError,
          ]}
          onPress={handleRedeem}
          disabled={status === 'loading' || status === 'success'}
          accessibilityLabel={`Redeem $${value.toFixed(2)} from ${p.title}`}
          accessibilityState={{ disabled: status === 'loading' || status === 'success', busy: status === 'loading' }}
        >
          {status === 'loading' ? (
            <View style={styles.redeemBtnContent}>
              <ActivityIndicator size="small" color={tokens.colors.viridian} />
              <Text style={styles.redeemBtnText}>Redeeming</Text>
            </View>
          ) : status === 'success' ? (
            <Text style={styles.redeemBtnText}>Collecting</Text>
          ) : status === 'error' ? (
            <Text style={[styles.redeemBtnText, styles.errorText]}>Try again</Text>
          ) : (
            <Text style={styles.redeemBtnText}>Redeem ${value.toFixed(2)}</Text>
          )}
        </Pressable>
      </View>
      {status === 'error' && (
        <Text style={styles.rowErrorText}>{errorMsg}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginHorizontal: tokens.spacing.lg,
    marginTop: 12,
    gap: 6,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  title: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: semantic.text.dim,
  },
  total: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '700',
    color: tokens.colors.viridian,
  },
  rowWrap: {
    gap: 5,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    padding: 10,
    minHeight: 44,
  },
  outcomeBadge: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 3,
  },
  outcomeBadgeText: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    fontWeight: '700',
  },
  badgePos: { backgroundColor: 'rgba(52,199,123,0.12)' },
  posText: { color: tokens.colors.viridian },
  info: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 9.5,
    color: semantic.text.primary,
    lineHeight: 13,
  },
  rowShares: {
    fontFamily: 'monospace',
    fontSize: 7.5,
    color: semantic.text.faint,
  },
  redeemBtn: {
    backgroundColor: 'rgba(74,140,111,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(74,140,111,0.25)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 32,
    justifyContent: 'center',
  },
  redeemBtnBusy: {
    minWidth: 94,
  },
  redeemBtnSuccess: {
    backgroundColor: 'rgba(74,140,111,0.25)',
  },
  redeemBtnError: {
    borderColor: 'rgba(217,83,79,0.4)',
    backgroundColor: 'rgba(217,83,79,0.1)',
  },
  redeemBtnText: {
    fontFamily: 'monospace',
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: tokens.colors.viridian,
  },
  redeemBtnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  errorText: {
    color: tokens.colors.vermillion,
  },
  rowErrorText: {
    paddingHorizontal: 10,
    fontSize: 10,
    lineHeight: 14,
    color: tokens.colors.vermillion,
  },
});
