/**
 * ConnectionSheet styles - the sheet's StyleSheet, moved verbatim from
 * ConnectionSheet.tsx (#734) so the giant file sheds its 400-line tail.
 *
 * Keys and values are unchanged. ConnectionSheet.tsx keeps the only
 * `ConnectionSheet` export in the app.
 */

import { StyleSheet } from 'react-native';

import { semantic, tokens } from '@/theme';

export const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(3, 31, 44, 0.72)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: semantic.background.screen,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: 1,
    borderColor: semantic.border.muted,
    maxHeight: '92%',
  },
  sheetLifted: {
    paddingBottom: 400,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: semantic.border.muted,
    alignSelf: 'center',
    marginTop: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: tokens.spacing.sm,
    paddingTop: tokens.spacing.sm,
    paddingBottom: tokens.spacing.xs,
  },
  iconBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    paddingTop: 8,
  },
  title: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '600',
    color: semantic.text.primary,
  },
  subtitle: {
    marginTop: 4,
    fontSize: tokens.fontSize.md,
    lineHeight: 20,
    color: semantic.text.dim,
  },
  body: {
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.sm,
    paddingBottom: 36,
    gap: tokens.spacing.md,
  },
  bodyLifted: {
    paddingBottom: tokens.spacing.lg,
  },
  stack: {
    gap: tokens.spacing.sm,
  },
  primaryBtn: {
    width: '100%',
    minHeight: 56,
    borderRadius: 14,
    backgroundColor: tokens.colors.bone,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  primaryText: {
    fontSize: 16,
    fontWeight: '600',
    color: tokens.colors.walletCore,
    textAlign: 'center',
  },
  secondaryBtn: {
    width: '100%',
    minHeight: 56,
    borderRadius: 14,
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  secondaryText: {
    fontSize: 16,
    fontWeight: '600',
    color: semantic.text.primary,
    textAlign: 'center',
  },
  dangerBtn: {
    width: '100%',
    minHeight: 52,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#7a2a3c',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  dangerText: {
    fontSize: 16,
    fontWeight: '600',
    color: tokens.colors.vermillion,
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.85,
  },
  markEmail: {
    backgroundColor: tokens.colors.lift,
  },
  fieldLabel: {
    marginBottom: 8,
    color: semantic.text.dim,
    fontSize: 13,
    fontWeight: '500',
  },
  emailField: {
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: semantic.background.surface,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
  },
  emailFieldFocused: {
    borderColor: tokens.colors.viridian,
  },
  emailFieldInvalid: {
    borderColor: tokens.colors.vermillion,
  },
  emailInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    fontSize: 16,
    color: semantic.text.primary,
    paddingVertical: 0,
  },
  emailError: {
    marginTop: 8,
    color: semantic.text.primary,
    fontSize: 13,
    lineHeight: 18,
  },
  continueGap: {
    marginTop: 12,
  },
  externalWrap: {
    marginTop: 8,
    gap: tokens.spacing.sm,
  },
  externalEntry: {
    minHeight: 52,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: semantic.border.muted,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  externalEntryText: {
    fontSize: 15,
    fontWeight: '500',
    color: semantic.text.primary,
  },
  otpRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: tokens.spacing.sm,
  },
  otpBox: {
    width: 44,
    height: 52,
    borderRadius: 12,
    backgroundColor: semantic.background.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  otpDigit: {
    fontSize: 20,
    fontWeight: '600',
    color: semantic.text.primary,
  },
  hiddenInput: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
  otpTools: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  otpTool: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  pasteText: {
    color: tokens.colors.viridian,
    fontSize: tokens.fontSize.md,
    fontWeight: '500',
  },
  otpToolDisabled: {
    color: semantic.text.dim,
  },
  otpStatus: {
    minHeight: 20,
    color: semantic.text.dim,
    fontSize: 13,
    lineHeight: 18,
  },
  otpStatusError: {
    color: tokens.colors.vermillion,
  },
  wait: {
    alignItems: 'center',
    paddingVertical: 28,
    gap: 6,
  },
  waitTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: semantic.text.primary,
    textAlign: 'center',
  },
  waitBody: {
    fontSize: tokens.fontSize.md,
    lineHeight: 20,
    color: semantic.text.dim,
    textAlign: 'center',
  },
  fail: {
    alignItems: 'stretch',
    gap: tokens.spacing.sm,
    paddingTop: 8,
  },
  failIcon: {
    alignSelf: 'center',
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(239, 71, 111, 0.16)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  errorText: {
    color: tokens.colors.vermillion,
    fontSize: tokens.fontSize.sm,
    lineHeight: 18,
    textAlign: 'center',
  },
  logoutBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: tokens.spacing.md,
  },
  logoutText: {
    color: semantic.text.faint,
    fontSize: tokens.fontSize.md,
    fontWeight: '500',
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
  ident: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.md,
    marginBottom: 2,
  },
  identMark: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: semantic.background.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identText: {
    flex: 1,
    minWidth: 0,
  },
  identName: {
    fontSize: 17,
    fontWeight: '600',
    color: semantic.text.primary,
  },
  identDetail: {
    marginTop: 2,
    fontSize: 13,
    color: semantic.text.faint,
  },
  chainCard: {
    borderRadius: 14,
    backgroundColor: semantic.background.surface,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 6,
  },
  labRow: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacing.sm,
  },
  lab: {
    color: semantic.text.faint,
    fontSize: 12,
    fontWeight: '500',
  },
  copyText: {
    color: tokens.colors.viridian,
    fontSize: 13,
    fontWeight: '500',
  },
  addressValue: {
    fontFamily: 'monospace',
    fontSize: 12.5,
    lineHeight: 18,
    color: semantic.text.dim,
  },
  plain: {
    color: semantic.text.dim,
    fontSize: tokens.fontSize.md,
    lineHeight: 20,
  },
  exportBody: {
    paddingTop: 8,
    paddingBottom: 12,
    gap: 12,
  },
  exportStack: {
    gap: 12,
  },
  exportSteps: {
    gap: 12,
  },
  exportStepText: {
    color: semantic.text.primary,
    fontSize: 16,
    lineHeight: 23,
  },
  exportIndex: {
    color: semantic.text.dim,
    fontWeight: '500',
  },
  exportStrong: {
    fontWeight: '700',
  },
  exportWarning: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: semantic.background.surface,
    color: tokens.colors.accent,
    fontSize: 14,
    lineHeight: 20,
  },
  exportActions: {
    gap: 8,
  },
  primaryBtnCompact: {
    minHeight: 52,
    paddingVertical: 0,
  },
  secondaryBtnCompact: {
    minHeight: 44,
    paddingVertical: 0,
  },
});
