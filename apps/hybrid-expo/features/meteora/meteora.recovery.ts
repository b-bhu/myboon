/** Coordinates read-only pending recovery with the screen's active execution. */
export function createMeteoraRecoveryCoordinator(
  schedule: (callback: () => void) => () => void = (callback) => {
    const timer = setTimeout(callback, 5_000);
    return () => clearTimeout(timer);
  },
) {
  let scope: string | null = null;
  let generation = 0;
  let executing = false;
  let attemptedScope: string | null = null;
  let attemptToken = 0;
  let currentAttemptToken: number | null = null;

  return {
    setScope(next: string | null) {
      if (next === scope) return;
      scope = next;
      generation += 1;
      attemptedScope = null;
    },
    beginAttempt() {
      if (!scope || executing || attemptedScope === scope) return null;
      const attemptScope = scope;
      const attemptGeneration = generation;
      const token = ++attemptToken;
      currentAttemptToken = token;
      attemptedScope = scope;
      let active = true;
      let cancelRetry: (() => void) | null = null;
      const isCurrent = () => active && !executing
        && scope === attemptScope && generation === attemptGeneration && currentAttemptToken === token;
      return {
        isCurrent,
        retry(callback: () => void) {
          if (!isCurrent()) return;
          cancelRetry?.();
          cancelRetry = schedule(() => {
            if (!isCurrent()) return;
            attemptedScope = null;
            callback();
          });
        },
        cancel() {
          if (isCurrent()) {
            attemptedScope = null;
            currentAttemptToken = null;
          }
          active = false;
          cancelRetry?.();
        },
      };
    },
    beginExecution() {
      executing = true;
      generation += 1;
      const executionScope = scope;
      const executionGeneration = generation;
      const isCurrent = () => scope === executionScope && generation === executionGeneration;
      return {
        isCurrent,
        finish(state: string | null) {
          executing = false;
          if (!scope || (isCurrent() && state !== 'submitted' && state !== 'syncing')) return false;
          // A changed wallet needs its own initial lookup after the old
          // execution releases the screen's global execution lock.
          attemptedScope = null;
          return true;
        },
      };
    },
  };
}
