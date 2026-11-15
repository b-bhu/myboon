import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { semantic, tokens } from '@/theme';

type OrderMode = 'limit' | 'market';

interface SellFormProps {
  maxShares: number;
  currentPrice: number;
  walletReady: boolean;
  onConfirm: (shares: number, price: number, mode: OrderMode) => void;
  submitting?: boolean;
  status?: 'idle' | 'success' | 'error';
  statusMessage?: string;
}

export function SellForm({ maxShares, currentPrice, walletReady, onConfirm, submitting = false, status = 'idle', statusMessage = '' }: SellFormProps) {
  const [mode, setMode] = useState<OrderMode>('limit');
  const [sharesInput, setSharesInput] = useState('');
  const [priceInput, setPriceInput] = useState(
    currentPrice > 0 ? (currentPrice * 100).toFixed(0) : ''
  );

  const shares = parseFloat(sharesInput) || 0;
  const priceCents = parseFloat(priceInput) || 0;
  const price = priceCents / 100;
  const effectivePrice = mode === 'market' ? currentPrice : price;
  const proceeds = shares * effectivePrice;
  const isValid = shares > 0 && shares <= maxShares && effectivePrice > 0 && effectivePrice < 1;

  useEffect(() => {
    if (currentPrice > 0 && priceInput.trim() === '') {
      setPriceInput((currentPrice * 100).toFixed(0));
    }
  }, [currentPrice, priceInput]);

  function setPercent(pct: number) {
    const amount = Math.floor(maxShares * pct * 100) / 100;
    setSharesInput(amount > 0 ? amount.toString() : '');
  }

  function handleConfirm() {
    if (!isValid || submitting) return;
    onConfirm(shares, price, mode);
  }

  return (
    <View style={styles.container}>
      {/* Mode toggle */}
      <View style={styles.modeRow}>
        <Pressable
          accessibilityRole="tab"
          accessibilityLabel="Limit sell order"
          accessibilityState={{ selected: mode === 'limit' }}
          style={[styles.modeBtn, mode === 'limit' && styles.modeBtnActive]}
          onPress={() => setMode('limit')}
        >
          <Text style={[styles.modeBtnText, mode === 'limit' && styles.modeBtnTextActive]}>
            Limit
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="tab"
          accessibilityLabel="Market sell order"
          accessibilityState={{ selected: mode === 'market' }}
          style={[styles.modeBtn, mode === 'market' && styles.modeBtnActive]}
          onPress={() => setMode('market')}
        >
          <Text style={[styles.modeBtnText, mode === 'market' && styles.modeBtnTextActive]}>
            Market
          </Text>
        </Pressable>
      </View>

      {/* Shares input */}
      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>SHARES</Text>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            accessibilityLabel="Shares to sell"
            value={sharesInput}
            onChangeText={setSharesInput}
            placeholder="0.00"
            placeholderTextColor={semantic.text.faint}
            keyboardType="decimal-pad"
            returnKeyType="done"
          />
          <Text style={styles.inputSuffix}>/ {maxShares.toFixed(2)}</Text>
        </View>
        <View style={styles.pctRow}>
          {[0.25, 0.5, 0.75, 1].map((pct) => (
            <Pressable
              key={pct}
              accessibilityRole="button"
              accessibilityLabel={pct === 1 ? 'Sell maximum shares' : `Sell ${pct * 100} percent of shares`}
              style={styles.pctBtn}
              onPress={() => setPercent(pct)}>
              <Text style={styles.pctBtnText}>{pct === 1 ? 'MAX' : `${pct * 100}%`}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Price input (limit only) */}
      {mode === 'limit' && (
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>PRICE</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              accessibilityLabel="Limit price in cents"
              value={priceInput}
              onChangeText={setPriceInput}
              placeholder={`${Math.round(currentPrice * 100)}`}
              placeholderTextColor={semantic.text.faint}
              keyboardType="decimal-pad"
              returnKeyType="done"
            />
            <Text style={styles.inputSuffix}>cents</Text>
          </View>
        </View>
      )}

      {/* Proceeds estimate */}
      <View style={styles.proceedsRow}>
        <Text style={styles.proceedsLabel}>Est. proceeds</Text>
        <Text style={styles.proceedsVal}>
          ${proceeds > 0 ? proceeds.toFixed(2) : '0.00'}
        </Text>
      </View>

      {/* Confirm button */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={submitting ? 'Submitting sell order' : status !== 'idle' && statusMessage ? statusMessage : 'Confirm sell'}
        accessibilityState={{ disabled: !isValid || submitting, busy: submitting }}
        style={[
          styles.confirmBtn,
          !isValid && styles.confirmBtnDisabled,
          status === 'success' && styles.confirmBtnSuccess,
          status === 'error' && styles.confirmBtnError,
        ]}
        onPress={handleConfirm}
        disabled={!isValid || submitting}
      >
        {submitting ? (
          <ActivityIndicator size="small" color={tokens.colors.backgroundDark} />
        ) : status !== 'idle' && statusMessage ? (
          <Text style={styles.confirmBtnText}>{statusMessage}</Text>
        ) : (
          <Text style={styles.confirmBtnText}>Confirm Sell</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },

  // Mode toggle
  modeRow: {
    flexDirection: 'row',
    gap: 4,
    backgroundColor: semantic.background.surface,
    borderRadius: 8,
    padding: 3,
  },
  modeBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
    minHeight: 36,
    justifyContent: 'center',
  },
  modeBtnActive: {
    backgroundColor: semantic.background.lift,
  },
  modeBtnText: {
    fontFamily: 'monospace',
    fontSize: 9,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: semantic.text.faint,
  },
  modeBtnTextActive: {
    color: semantic.text.primary,
    fontWeight: '700',
  },

  // Field groups
  fieldGroup: {
    gap: 6,
  },
  fieldLabel: {
    fontFamily: 'monospace',
    fontSize: 7,
    letterSpacing: 1.5,
    color: semantic.text.faint,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    borderRadius: 8,
    paddingHorizontal: 12,
    minHeight: 44,
  },
  input: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 16,
    color: semantic.text.primary,
    paddingVertical: 10,
  },
  inputSuffix: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.faint,
    marginLeft: 8,
  },

  // Percent buttons
  pctRow: {
    flexDirection: 'row',
    gap: 6,
  },
  pctBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    alignItems: 'center',
    minHeight: 32,
    justifyContent: 'center',
  },
  pctBtnText: {
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 0.5,
    color: semantic.text.dim,
  },

  // Proceeds
  proceedsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: semantic.border.muted,
  },
  proceedsLabel: {
    fontFamily: 'monospace',
    fontSize: 9,
    color: semantic.text.dim,
  },
  proceedsVal: {
    fontFamily: 'monospace',
    fontSize: 14,
    fontWeight: '700',
    color: semantic.text.primary,
  },

  // Confirm
  confirmBtn: {
    backgroundColor: tokens.colors.vermillion,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
  },
  confirmBtnDisabled: {
    opacity: 0.4,
  },
  confirmBtnSuccess: {
    backgroundColor: tokens.colors.viridian,
  },
  confirmBtnError: {
    backgroundColor: tokens.colors.vermillion,
  },
  confirmBtnText: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: tokens.colors.backgroundDark,
  },
});
