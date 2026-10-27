import { useState, useEffect } from 'react'
import { resolveTextCommit } from './textCommit'
import { resolveNumberCommit } from './numberCommit'

/** A labelled row in the properties panel. */
export function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="pf">
      <span className="pf__label">{label}</span>
      {children}
    </label>
  )
}

/**
 * Text input that holds a local draft and commits on blur / Enter — so an edit
 * is ONE undoable change, not one per keystroke. Re-syncs to `value` when it
 * changes externally (undo, switching selection).
 */
export function TextEdit({
  value,
  onCommit,
  placeholder,
  multiline,
  normalize
}: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  multiline?: boolean
  /** Optional: maps the draft to the value to commit, or null to refuse (the field reverts). */
  normalize?: (draft: string) => string | null
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const commit = (): void => {
    const r = resolveTextCommit(draft, value, normalize)
    if (r.commit !== null) onCommit(r.commit)
    setDraft(r.draft)
  }

  if (multiline) {
    return (
      <textarea
        className="pf__input"
        rows={2}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
      />
    )
  }
  return (
    <input
      className="pf__input"
      type="text"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

/**
 * Numeric input. Commits a parsed number on blur/Enter. If `optional`, an empty
 * field commits `undefined`. Invalid input reverts to the last committed value
 * (the decision is `resolveNumberCommit`).
 *
 * `min` / `max` bound what can be SUBMITTED, not just what the spinner offers:
 * an out-of-range value reverts to the last committed one instead of being
 * committed. Millimetre fields pass `min={0}` so a negative length can never
 * leave the panel (the store action rejects it too — this is the UI half of
 * that pair, so the field doesn't silently look accepted); `minExclusive`
 * refuses `min` itself (a typed segment length must be > 0). A partial entry
 * ("-", "1e") reverts rather than clearing. If `onCommit` returns `false` (the
 * store refused the write) the field reverts too.
 */
export function NumberEdit({
  value,
  onCommit,
  optional,
  step,
  min,
  minExclusive,
  max,
  placeholder
}: {
  value: number | undefined
  onCommit: (v: number | undefined) => void | boolean
  optional?: boolean
  step?: number
  min?: number
  minExclusive?: boolean
  max?: number
  placeholder?: string
}): React.JSX.Element {
  const asText = (v: number | undefined): string => (v === undefined ? '' : String(v))
  const [draft, setDraft] = useState(asText(value))
  useEffect(() => setDraft(asText(value)), [value])

  const commit = (e: React.FocusEvent<HTMLInputElement>): void => {
    const badInput = e.currentTarget.validity.badInput
    const r = resolveNumberCommit(draft, value, { optional, min, minExclusive, max, badInput })
    if (r.action === 'revert') setDraft(asText(value))
    else if (r.action === 'commit' && onCommit(r.value) === false) setDraft(asText(value))
  }

  return (
    <input
      className="pf__input"
      type="number"
      step={step}
      min={min}
      max={max}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

/** A select dropdown that commits immediately (discrete, single undo step). */
export function SelectEdit<T extends string>({
  value,
  options,
  onCommit
}: {
  value: T
  options: { value: T; label: string }[]
  onCommit: (v: T) => void
}): React.JSX.Element {
  return (
    <select
      className="pf__input"
      value={value}
      onChange={(e) => onCommit(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
