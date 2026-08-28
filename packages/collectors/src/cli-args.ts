/**
 * pnpm may forward the conventional argument separator to package scripts.
 * Accept exactly one leading separator while preserving every subsequent
 * argument for the command-specific parser to validate.
 */
export function packageScriptArgs(argv: readonly string[]): string[] {
  return argv[0] === '--' ? argv.slice(1) : [...argv]
}
