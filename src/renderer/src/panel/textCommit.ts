/**
 * What a text field does on blur: the value to commit (null = nothing) and the
 * draft to show afterwards. Without `normalize` this is the plain behaviour —
 * commit when changed, keep the draft. With it, a null result REFUSES the
 * commit and the draft reverts to the current value; otherwise the normalised
 * value is committed (if it changed) and shown.
 */
export function resolveTextCommit(
  draft: string,
  value: string,
  normalize?: (draft: string) => string | null
): { commit: string | null; draft: string } {
  if (!normalize) return { commit: draft !== value ? draft : null, draft }
  const n = normalize(draft)
  if (n === null) return { commit: null, draft: value }
  return { commit: n !== value ? n : null, draft: n }
}
