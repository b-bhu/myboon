/**
 * usePrivyExport — hand a Privy session to Privy Home in the browser.
 *
 * Moved out of ConnectionSheet.tsx (#737). The sheet hands off the session to
 * the system browser and only learns that it started; it never reads the
 * page, the result URL, or a key.
 *
 * Model: docs/modules/wallet/specs/wallet_connectivity.md ("The connection modal")
 */

import { useCallback, useRef } from 'react';
import * as WebBrowser from 'expo-web-browser';
import {
  assertPrivyHomeUrl,
  beginPrivyExport,
  interpretPrivyExportSession,
  type ConnectFlowEvent,
  type ConnectFlowState,
} from '@/features/wallet/components/connect.flow';

export function usePrivyExport({
  flow,
  dispatch,
}: {
  flow: ConnectFlowState;
  dispatch: (event: ConnectFlowEvent) => void;
}) {
  const exportInFlight = useRef(false);

  const handleExportContinue = useCallback(() => {
    if (flow.linked !== 'privy' || exportInFlight.current) return;
    const handoff = beginPrivyExport();
    exportInFlight.current = true;
    dispatch({ type: 'export_continue' });
    void openPrivyExportPage(handoff.url)
      .then((outcome) => {
        dispatch(outcome === 'handed_off' ? { type: 'export_handed_off' } : { type: 'export_failed' });
      })
      .finally(() => {
        exportInFlight.current = false;
      });
  }, [dispatch, flow.linked]);

  return { handleExportContinue };
}

/**
 * Open Privy Home in the system browser (Safari view on iOS, Custom Tab on
 * Android). The page stays in that browser. This function returns only whether
 * the handoff started, and it does not read the page, the result URL, or a key.
 */
async function openPrivyExportPage(url: string): Promise<'handed_off' | 'failed'> {
  let safeUrl: string;
  try {
    safeUrl = assertPrivyHomeUrl(url);
  } catch {
    return 'failed';
  }
  try {
    const result = await WebBrowser.openBrowserAsync(safeUrl, {
      dismissButtonStyle: 'close',
      readerMode: false,
      showTitle: true,
      createTask: false,
      showInRecents: false,
      enableDefaultShareMenuItem: false,
    });
    return interpretPrivyExportSession(result);
  } catch {
    return 'failed';
  }
}
