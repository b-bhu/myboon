type PrivySignOutOptions = {
  clearActivation: () => Promise<unknown>;
  logout: () => Promise<void>;
  onClearActivationError?: (error: unknown) => void;
};

type FullSignOutOptions = PrivySignOutOptions & {
  disconnectMwa?: () => Promise<unknown>;
  onMwaDisconnectError?: (error: unknown) => void;
};

export function selectMwaDisconnect({
  hasMwaAccount,
  disconnectMwa,
}: {
  hasMwaAccount: boolean;
  disconnectMwa?: (() => Promise<unknown>) | null;
}): (() => Promise<unknown>) | undefined {
  return hasMwaAccount ? disconnectMwa ?? undefined : undefined;
}

export async function runPrivySignOut({
  clearActivation,
  logout,
  onClearActivationError = (error) => console.warn('Could not clear wallet activation before sign-out.', error),
}: PrivySignOutOptions): Promise<void> {
  try {
    await clearActivation();
  } catch (error) {
    onClearActivationError(error);
  } finally {
    await logout();
  }
}

export async function runFullSignOut({
  disconnectMwa,
  onMwaDisconnectError = (error) => console.warn('Could not disconnect the external Solana wallet during sign-out.', error),
  ...privyOptions
}: FullSignOutOptions): Promise<void> {
  if (disconnectMwa) {
    try {
      await disconnectMwa();
    } catch (error) {
      onMwaDisconnectError(error);
    }
  }

  await runPrivySignOut(privyOptions);
}
