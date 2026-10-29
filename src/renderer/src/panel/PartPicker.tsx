import { useEffect, useMemo, useRef, useState } from 'react'
import type { PartRef } from '@shared/model/schema'
import { refOf, type PartKind } from '@shared/parts/librarySchema'
import { searchParts } from '@shared/parts/search'
import type { PartsLibrary } from '../usePartsLibrary'

const MAX_ROWS = 12

/** The row highlighted when the list opens on `draft`: none for a blank draft,
 *  so Enter on a cleared field clears the part instead of picking the first row. */
export function firstHighlight(draft: string): number {
  return draft.trim() ? 0 : -1
}

/**
 * A `PartRef` field: type to search the library (restricted to `kinds`), pick a
 * row to commit the full ref, or press Enter on free text to commit a bare
 * `{ partNumber }` exactly as the old TextEdit did — a part the library does
 * not know must stay enterable. Clearing the field and pressing Enter (or
 * leaving it) clears the part; the arrow keys still pick from the list.
 * Commits on blur like TextEdit so one edit is one undo step. Shows the
 * resolved library description under the field.
 */
export function PartPicker({
  value,
  kinds,
  library,
  onCommit,
  placeholder
}: {
  value?: PartRef
  kinds: readonly PartKind[]
  library: PartsLibrary
  onCommit: (ref: PartRef | undefined) => void
  placeholder?: string
}): React.JSX.Element {
  const current = value?.partNumber ?? ''
  const [draft, setDraft] = useState(current)
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => setDraft(current), [current])

  const rows = useMemo(
    () => (open ? searchParts(library.parts, draft, { kinds }).slice(0, MAX_ROWS) : []),
    [open, library.parts, draft, kinds]
  )
  const resolved = library.resolve(current)

  const commitText = (): void => {
    const pn = draft.trim()
    if (pn === current) return
    if (!pn) return onCommit(undefined)
    const p = library.resolve(pn)
    onCommit(p && kinds.includes(p.kind) ? refOf(p) : { partNumber: pn })
  }
  const pick = (i: number): void => {
    const p = rows[i]
    if (!p) return commitText()
    setOpen(false)
    setDraft(p.partNumber)
    if (p.partNumber !== current || value?.description !== p.description) onCommit(refOf(p))
  }

  return (
    <div className="pp" ref={root}>
      <input
        className="pf__input"
        type="text"
        value={draft}
        placeholder={placeholder ?? (library.dir ? 'search or type a part number' : 'part number')}
        onChange={(e) => {
          setDraft(e.target.value)
          setOpen(!!library.dir)
          setHi(firstHighlight(e.target.value))
        }}
        onFocus={() => {
          setOpen(!!library.dir)
          setHi(firstHighlight(draft))
        }}
        onBlur={() => {
          setOpen(false)
          commitText()
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            setHi((h) => Math.min(h + 1, rows.length - 1))
            e.preventDefault()
          } else if (e.key === 'ArrowUp') {
            setHi((h) => Math.max(h - 1, 0))
            e.preventDefault()
          } else if (e.key === 'Enter') {
            open && rows.length ? pick(hi) : commitText()
            setOpen(false)
            e.preventDefault()
          } else if (e.key === 'Escape') {
            setOpen(false)
            setDraft(current)
          }
        }}
      />
      {open && rows.length > 0 && (
        <ul className="pp__list" role="listbox">
          {rows.map((p, i) => (
            <li
              key={p.partNumber}
              role="option"
              aria-selected={i === hi}
              className={i === hi ? 'pp__row pp__row--hi' : 'pp__row'}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(i)
              }}
              onMouseEnter={() => setHi(i)}
            >
              <span className="pp__pn">{p.partNumber}</span>
              <span className="pp__desc">{p.description}</span>
            </li>
          ))}
        </ul>
      )}
      {current && (
        <div className="pp__resolved">
          {resolved ? resolved.description : library.dir ? 'not in library' : ''}
        </div>
      )}
    </div>
  )
}
