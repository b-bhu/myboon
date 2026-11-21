// Wallet action mode shell (issue #715, design wallet.html "Action panel
// (four modes)"): the panel body is a fixed 430px at 390x844 in every mode
// (gold area 552px = 65% of 844), and the segmented switch renders the four
// mode labels in this order with Swap first and default.
export type WalletActionMode = 'swap' | 'move' | 'send' | 'receive';

export type WalletActionModeOption = {
  id: WalletActionMode;
  label: string;
  /** Placeholder modes stay disabled and say "Coming soon" when tapped. */
  enabled: boolean;
};

export const WALLET_ACTION_BODY_HEIGHT = 430;

export const WALLET_ACTION_MODES: readonly WalletActionModeOption[] = [
  { id: 'swap', label: 'Swap', enabled: true },
  { id: 'move', label: 'Move', enabled: false },
  { id: 'send', label: 'Send', enabled: false },
  { id: 'receive', label: 'Receive', enabled: true },
];
