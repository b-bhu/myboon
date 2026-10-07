/** Programmatic calls must never inherit the interactive Hermes default. */
export const DEFAULT_HERMES_PROFILE = 'myboon-codex-production'

export function resolveHermesProfile(
  profile?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return profile ?? env.INFERENCE_GATEWAY_HERMES_PROFILE ?? DEFAULT_HERMES_PROFILE
}
