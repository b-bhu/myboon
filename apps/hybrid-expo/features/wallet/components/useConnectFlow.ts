/**
 * useConnectFlow — the sheet's window into the connect step machine.
 *
 * Moved out of ConnectionSheet.tsx (#737). Deliberately reacts during render:
 * while the sheet is visible, one `decided` ref picks exactly one first
 * transition per open, and a late session update reroutes the sheet once.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The connection modal")
 */

import { useCallback, useRef, useState } from 'react';
import {
  INITIAL_CONNECT_FLOW,
  reduceConnectFlow,
  type ConnectFlowEvent,
  type ConnectFlowState,
  type LinkedKind,
} from '@/features/wallet/components/connect.flow';

export function useConnectFlow(
  visible: boolean,
  session: {
    linked: LinkedKind | null;
    privyAuthenticated: boolean;
    hasEmbeddedWallet: boolean;
    privyReady: boolean;
  },
) {
  const [flow, setFlow] = useState<ConnectFlowState>(INITIAL_CONNECT_FLOW);
  const decided = useRef(false);
  let display = flow;

  const openEvent: ConnectFlowEvent = {
    type: 'open',
    linked: session.linked,
    privyAuthenticated: session.privyAuthenticated,
    hasEmbeddedWallet: session.hasEmbeddedWallet,
  };

  if (!visible) {
    decided.current = false;
  } else if (!decided.current && session.privyReady) {
    decided.current = true;
    display = reduceConnectFlow(flow, openEvent);
    if (display !== flow) setFlow(display);
  } else if (
    visible
    && decided.current
    && session.linked
    && flow.linked !== session.linked
    && (flow.step.kind === 'entry' || flow.step.kind === 'fail_setup')
  ) {
    // The session can land a moment after the sheet opens. Show the connected
    // sheet once it does, instead of leaving the user on the email form.
    display = reduceConnectFlow(flow, openEvent);
    if (display !== flow) setFlow(display);
  }

  const dispatch = useCallback((event: ConnectFlowEvent) => {
    setFlow((current) => reduceConnectFlow(current, event));
  }, []);

  return { flow: display, dispatch, deciding: visible && !session.privyReady };
}
