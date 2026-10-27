/**
 * What a numeric field does on blur / Enter, given its draft and the current
 * value (pure, so `NumberEdit` is testable without a DOM):
 *
 * - `commit` — call `onCommit(value)` (`undefined` = clear an optional field);
 * - `revert` — refused: show the current value again;
 * - `keep`   — nothing changed, nothing to do.
 *
 * `min` / `max` bound what can be SUBMITTED (inclusive; `minExclusive` makes
 * `min` itself refused too — a typed segment length must be > 0). `badInput`
 * is the input's `validity.badInput`: a `type="number"` field holding a partial
 * entry ("-", "1e", "+") reports `value === ''`, which must revert, not clear.
 */
export type NumberCommit = { action: 'commit'; value: number | undefined } | { action: 'revert' } | { action: 'keep' }

export function resolveNumberCommit(
  draft: string,
  value: number | undefined,
  opts: { optional?: boolean; min?: number; minExclusive?: boolean; max?: number; badInput?: boolean }
): NumberCommit {
  if (opts.badInput) return { action: 'revert' }
  const t = draft.trim()
  if (t === '') {
    if (!opts.optional) return { action: 'revert' }
    return value !== undefined ? { action: 'commit', value: undefined } : { action: 'keep' }
  }
  const n = Number(t)
  const { min, max } = opts
  const aboveMin = min === undefined || (opts.minExclusive ? n > min : n >= min)
  const belowMax = max === undefined || n <= max
  if (!Number.isFinite(n) || !aboveMin || !belowMax) return { action: 'revert' }
  return n !== value ? { action: 'commit', value: n } : { action: 'keep' }
}
