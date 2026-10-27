/**
 * Parse the formboard length label's inline input on Enter / a changed blur:
 * a number > 0 to type, `null` to clear the typed length (empty field), or
 * `'cancel'` to leave the segment as it was. `badInput` is the input's
 * `validity.badInput` — a `type="number"` field holding a partial entry
 * ("-", "1e", "+") reports `value === ''`, which must cancel, never clear.
 * Zero, negatives and non-numbers cancel too (the store refuses them anyway).
 */
export function parseLengthInput(raw: string, badInput: boolean): number | null | 'cancel' {
  if (badInput) return 'cancel'
  const t = raw.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? n : 'cancel'
}

/**
 * Enter and blur share one rule: a draft equal to the prefill is "I only
 * looked" and commits nothing (otherwise Enter would pin an untyped limb to its
 * rounded drawn length, or round a fractional typed one). Otherwise as
 * `parseLengthInput`.
 */
export function resolveLengthCommit(
  draft: string,
  prefill: string,
  badInput: boolean
): number | null | 'cancel' | 'skip' {
  if (!badInput && draft.trim() === prefill) return 'skip'
  return parseLengthInput(draft, badInput)
}
