/**
 * The ONE canonical "pull strict JSON out of an LLM's stdout" implementation.
 *
 * Before the hermes/ module existed this exact function was copy-pasted in
 * five files (polymarket/researcher.ts, polymarket/editor.ts,
 * polymarket/publisher.ts, entity-manager/extractor.ts,
 * editor-draft/normalizer.ts) with only whitespace-level drift between the
 * copies - the same duplication shape the storage layer had before
 * PipelineStore. Every Hermes call site now imports this instead.
 *
 * Strategy: try the whole (fence-stripped) text as JSON first; if that fails,
 * scan for the first '{' or '[' and bracket-match to its closer, respecting
 * string literals and escapes, then parse just that fragment.
 */
export function extractJson<T>(text: string): T | null {
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  try {
    return JSON.parse(cleaned) as T
  } catch {
    // Continue into fragment extraction.
  }

  const start = cleaned.search(/[{[]/)
  if (start === -1) return null
  const opener = cleaned[start]
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escape = false
  for (let index = start; index < cleaned.length; index += 1) {
    const ch = cleaned[index]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === opener) depth += 1
    else if (ch === closer) depth -= 1
    if (depth === 0) {
      try {
        return JSON.parse(cleaned.slice(start, index + 1)) as T
      } catch {
        return null
      }
    }
  }
  return null
}
