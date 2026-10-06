/** A retry appends a new immutable capture; select that observation rather
 * than the oldest capture in SQLite's chronological history. */
export function latestArticleCapture<T extends { authority: string; retrievedAt: string; evidenceId: string }>(artifacts: readonly T[]): T | undefined {
  return artifacts.filter(artifact => artifact.authority === 'source_url').sort((a, b) =>
    Date.parse(b.retrievedAt) - Date.parse(a.retrievedAt) || b.evidenceId.localeCompare(a.evidenceId))[0]
}
