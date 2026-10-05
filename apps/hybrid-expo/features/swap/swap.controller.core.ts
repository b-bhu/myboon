export type SessionSlippageMode = 'auto' | 'fixed' | 'custom';

export interface SwapSessionState {
  slippageMode: SessionSlippageMode;
  customSlippage: string;
  extremeConfirmation: string;
  simulationWarningAccepted: boolean;
  preparedRequestId: string | null;
  asyncSequence: number;
}

export function createSwapSession(): SwapSessionState {
  return {
    slippageMode: 'auto',
    customSlippage: '0.5',
    extremeConfirmation: '',
    simulationWarningAccepted: false,
    preparedRequestId: null,
    asyncSequence: 0,
  };
}

/** Leaving Wallet or changing account/action ends elevated-slippage acknowledgement. */
export function endSwapSession(previous: SwapSessionState): SwapSessionState {
  return {
    ...previous,
    slippageMode: 'auto',
    customSlippage: '0.5',
    extremeConfirmation: '',
    simulationWarningAccepted: false,
    preparedRequestId: null,
    asyncSequence: previous.asyncSequence + 1,
  };
}

export function invalidatePreparedSession(previous: SwapSessionState): SwapSessionState {
  return {
    ...previous,
    preparedRequestId: null,
    simulationWarningAccepted: false,
    asyncSequence: previous.asyncSequence + 1,
  };
}
