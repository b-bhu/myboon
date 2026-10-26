import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import {
  WAITLIST_ERROR_COPY,
  joinWaitlist,
  validateEmail,
  validateXHandle,
  type WaitlistErrorCode,
} from '@/features/waitlist/waitlist.api';
import { WAITLIST_CTA, WAITLIST_PITCH } from '@/features/waitlist/waitlist.mode';
import { semantic, tokens } from '@/theme';

/** Email (required) + X handle (optional), then a plain "You're on the list". */
export function WaitlistForm({ onDone }: { onDone?: () => void }) {
  const [email, setEmail] = useState('');
  const [xHandle, setXHandle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<WaitlistErrorCode | null>(null);
  const [joined, setJoined] = useState(false);

  async function submit() {
    if (submitting) return;
    if (!validateEmail(email)) return setError('invalid_email');
    if (!validateXHandle(xHandle)) return setError('invalid_x_handle');
    setError(null);
    setSubmitting(true);
    const result = await joinWaitlist(email, xHandle);
    setSubmitting(false);
    if (result.ok) setJoined(true);
    else setError(result.code);
  }

  if (joined) {
    return (
      <View style={styles.success} accessibilityLiveRegion="polite">
        <MaterialIcons name="check-circle" size={44} color={tokens.colors.viridian} />
        <Text style={styles.title}>You&apos;re on the list</Text>
        <Text style={styles.pitch}>We&apos;ll email you when wallet and trading open up.</Text>
        {onDone ? (
          <Pressable accessibilityRole="button" onPress={onDone} style={styles.button}>
            <Text style={styles.buttonText}>Done</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const emailError = error === 'invalid_email';
  const handleError = error === 'invalid_x_handle';
  const formError = error && !emailError && !handleError ? WAITLIST_ERROR_COPY[error] : null;

  return (
    <View style={styles.form}>
      <Text style={styles.title}>{WAITLIST_CTA}</Text>
      <Text style={styles.pitch}>{WAITLIST_PITCH}</Text>

      <Text style={styles.label}>Email</Text>
      <TextInput
        value={email}
        onChangeText={(value) => { setEmail(value); if (emailError) setError(null); }}
        placeholder="you@example.com"
        placeholderTextColor={semantic.text.faint}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        inputMode="email"
        accessibilityLabel="Email"
        editable={!submitting}
        style={[styles.input, emailError && styles.inputError]}
      />
      {emailError ? <Text style={styles.fieldError}>{WAITLIST_ERROR_COPY.invalid_email}</Text> : null}

      <Text style={styles.label}>X handle <Text style={styles.optional}>(optional)</Text></Text>
      <View style={[styles.input, styles.handleRow, handleError && styles.inputError]}>
        <Text style={styles.at}>@</Text>
        <TextInput
          value={xHandle}
          onChangeText={(value) => { setXHandle(value); if (handleError) setError(null); }}
          placeholder="yourhandle"
          placeholderTextColor={semantic.text.faint}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={16}
          accessibilityLabel="X handle"
          editable={!submitting}
          style={styles.handleInput}
        />
      </View>
      {handleError ? <Text style={styles.fieldError}>{WAITLIST_ERROR_COPY.invalid_x_handle}</Text> : null}

      {formError ? (
        <View style={styles.banner} accessibilityLiveRegion="polite">
          <MaterialIcons name="error-outline" size={16} color={tokens.colors.vermillion} />
          <Text style={styles.bannerText}>{formError}</Text>
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={WAITLIST_CTA}
        accessibilityState={{ disabled: submitting, busy: submitting }}
        disabled={submitting}
        onPress={() => void submit()}
        style={({ pressed }) => [styles.button, (pressed || submitting) && styles.pressed]}
      >
        {submitting
          ? <ActivityIndicator color={tokens.colors.backgroundDark} />
          : <Text style={styles.buttonText}>{WAITLIST_CTA}</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 8 },
  success: { alignItems: 'center', gap: 10, paddingVertical: 24 },
  title: { color: semantic.text.primary, fontSize: 22, fontWeight: '800', textAlign: 'center' },
  pitch: { color: semantic.text.dim, fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: 12 },
  label: { color: semantic.text.dim, fontSize: 12, fontWeight: '700', marginTop: 6 },
  optional: { color: semantic.text.faint, fontWeight: '400' },
  input: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    backgroundColor: semantic.background.surface,
    color: semantic.text.primary,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  inputError: { borderColor: tokens.colors.vermillion },
  handleRow: { flexDirection: 'row', alignItems: 'center' },
  at: { color: semantic.text.faint, fontSize: 15, marginRight: 2 },
  handleInput: { flex: 1, minHeight: 46, color: semantic.text.primary, fontSize: 15 },
  fieldError: { color: tokens.colors.vermillion, fontSize: 12 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    padding: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(239, 71, 111, 0.12)',
  },
  bannerText: { flex: 1, color: semantic.text.primary, fontSize: 13 },
  button: {
    marginTop: 14,
    minHeight: 50,
    alignSelf: 'stretch',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colors.accent,
  },
  buttonText: { color: tokens.colors.backgroundDark, fontSize: 15, fontWeight: '800' },
  pressed: { opacity: 0.75 },
});
