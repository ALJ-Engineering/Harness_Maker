import { useEffect, useMemo, useRef, useState } from 'react'
import { isKnownColor, searchColors } from '@shared/model/colors'
import { screenStroke } from '../flow/screenColors'
import type { ThemeName } from '../useTheme'

/**
 * A wire-colour field: focus it to see every IEC colour with its swatch and
 * name, type to filter ("red", "RD" and "BLK" all work), pick a row to commit
 * its code. Enter or blur on text no row matches commits it as typed
 * (upper-cased), so a `#hex` or an unlisted code stays enterable — the line
 * under the field then says it draws grey. Commits once, like TextEdit, so one
 * edit is one undo step.
 *
 * `adder` is the Stripes variant: it starts empty, every commit is a new value
 * for the caller to append, and it empties again after each one.
 */
export function ColorPicker({
  value,
  onCommit,
  theme,
  placeholder,
  adder
}: {
  value: string
  onCommit: (code: string) => void
  theme: ThemeName
  placeholder?: string
  adder?: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [open, setOpen] = useState(false)
  // Until the user types, the list is the WHOLE palette (not filtered by the
  // current value), with the current colour highlighted.
  const [typed, setTyped] = useState(false)
  const [hi, setHi] = useState(0)
  // Set when a mouse press focuses the field: its mouseup would otherwise drop
  // the select-all that makes typing REPLACE the current code ("RD" + "blk"
  // must not become "RDBLK").
  const keepSelection = useRef(false)
  useEffect(() => setDraft(value), [value])

  const rows = useMemo(() => (open ? searchColors(typed ? draft : '') : []), [open, typed, draft])

  const openPalette = (): void => {
    setOpen(true)
    setTyped(false)
    setHi(Math.max(0, searchColors('').findIndex((c) => c.code === value.toUpperCase())))
  }

  const done = (code: string): void => {
    setOpen(false)
    setTyped(false)
    setDraft(adder ? '' : code)
    if (code !== value) onCommit(code)
  }
  const commitText = (): void => {
    const t = draft.trim().toUpperCase()
    if (!t) return setDraft(value)
    done(t)
  }

  return (
    <div className="pp">
      <input
        className="pf__input"
        type="text"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value)
          setOpen(true)
          setTyped(true)
          setHi(0)
        }}
        onFocus={(e) => {
          e.currentTarget.select()
          keepSelection.current = true
          openPalette()
        }}
        onMouseUp={(e) => {
          if (keepSelection.current) e.preventDefault()
          keepSelection.current = false
        }}
        // After a pick the field keeps focus, so a second click must reopen it.
        onClick={(e) => {
          if (open) return
          e.currentTarget.select()
          openPalette()
        }}
        onBlur={() => {
          keepSelection.current = false
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
            if (open && rows[hi]) done(rows[hi].code)
            else commitText()
            e.preventDefault()
          } else if (e.key === 'Escape') {
            setOpen(false)
            setDraft(value)
          }
        }}
      />
      {open && rows.length > 0 && (
        <ul className="pp__list" role="listbox">
          {rows.map((c, i) => (
            <li
              key={c.code}
              role="option"
              aria-selected={i === hi}
              className={i === hi ? 'pp__row pp__row--hi' : 'pp__row'}
              onMouseDown={(e) => {
                e.preventDefault()
                done(c.code)
              }}
              onMouseEnter={() => setHi(i)}
            >
              <span className="pf__swatch" style={{ background: screenStroke(c.code, theme) }} />
              <span className="pp__pn">{c.code}</span>
              <span className="pp__desc">{c.name}</span>
            </li>
          ))}
        </ul>
      )}
      {!adder && value && !isKnownColor(value) && (
        <div className="pp__resolved">{value} is not an IEC colour code: drawn grey</div>
      )}
    </div>
  )
}
