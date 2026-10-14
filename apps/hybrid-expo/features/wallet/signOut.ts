type PrivySignOutOptions = {
  clearActivation: () => Promise<unknown>;
  logout: () => Promise<void>;
  onClearActivationError?: (error: unknown) => void;
};

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
