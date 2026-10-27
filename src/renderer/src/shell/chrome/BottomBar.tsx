import { useEffect, useMemo, useRef, useState } from 'react'
import type { Finding } from '@shared/drc'
import type { HarnessDocument } from '@shared/model/schema'
import type { ThemeName } from '../../useTheme'
import { docStats } from '../stats'
import type { AddKind } from '../HarnessPane'

export interface BottomBarProps {
  /** The harness — the stats chip's only input. */
  doc: HarnessDocument
  /** The findings the DRC panel is currently showing (dismissed ones excluded). */
  findings: Finding[]
  /**
   * Load-time repairs + migrations this file arrived with. The notice itself
   * lives in the DRC panel's header, which is CLOSED by default, and those
   * findings are `info` severity so neither count below sees them — so without
   * a signal here "saving will rewrite your file" would have no visible channel
   * at all. 0 hides it.
   */
  repairCount: number
  /** Is the DRC panel open? */
  drcOpen: boolean
  onToggleDrc: () => void
  /** Two canvases side by side, or one. */
  split: boolean
  setSplit: (split: boolean) => void
  theme: ThemeName
  toggleTheme: () => void
  /** Open the drawing-set export dialog. */
  onExport: () => void
  /** Add a blank body at the centre of the focused pane. */
  onAdd: (kind: AddKind) => void
  /** Open the parts library browser, to place a body from a library part. */
  onAddFromLibrary: () => void
}

/** The Add menu — the same three bodies as the schematic right-click. */
const ADD_ITEMS: { kind: AddKind; label: string }[] = [
  { kind: 'connector', label: 'Connector' },
  { kind: 'terminal', label: 'Free terminal' },
  { kind: 'splice', label: 'Splice' }
]

/**
 * The Add chip and its menu, which opens UPWARD (the bar sits on the bottom
 * edge). Same open/close rules as the view picker: a pointerdown outside or
 * Escape closes it, capture phase because React Flow stops some events.
 */
function AddMenu({
  onAdd,
  onAddFromLibrary
}: {
  onAdd: (kind: AddKind) => void
  onAddFromLibrary: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node | null)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="vp" ref={rootRef}>
      <button
        className={`chip chip--btn${open ? ' chip--on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Add a body to the focused pane"
        aria-label="Add"
      >
        <span className="chip__glyph">＋</span>
        Add
      </button>
      {open && (
        <div className="vp__menu vp__menu--up" role="menu">
          {ADD_ITEMS.map((it) => (
            <button
              key={it.kind}
              className="vp__item"
              role="menuitem"
              onClick={() => {
                onAdd(it.kind)
                setOpen(false)
              }}
            >
              {it.label}
            </button>
          ))}
          <button
            className="vp__item"
            role="menuitem"
            onClick={() => {
              onAddFromLibrary()
              setOpen(false)
            }}
          >
            From library…
          </button>
        </div>
      )}
    </div>
  )
}

/** Total cut length for the chip: metres past a metre, whole millimetres below. */
function formatLength(mm: number): string {
  return mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${Math.round(mm)} mm`
}

/**
 * The floating bottom bar: what the document contains and what to do with it.
 *
 * Like the top strip it is `pointer-events: none` with each control opting back
 * in, so the canvas keeps the space underneath.
 *
 * Add drops a blank body at the centre of the focused pane, or opens the
 * library to place one from a part.
 */
export function BottomBar({
  doc,
  findings,
  repairCount,
  drcOpen,
  onToggleDrc,
  split,
  setSplit,
  theme,
  toggleTheme,
  onExport,
  onAdd,
  onAddFromLibrary
}: BottomBarProps): React.JSX.Element {
  // `docStats` runs `computeCutList`, so it is memoised on the document and not
  // recomputed for a selection click, a theme toggle or a DRC recount.
  const stats = useMemo(() => docStats(doc), [doc])
  const errors = findings.filter((f) => f.severity === 'error').length
  const warnings = findings.filter((f) => f.severity === 'warning').length

  return (
    <div className="chrome chrome--bottom">
      <div className="chrome__group">
        <AddMenu onAdd={onAdd} onAddFromLibrary={onAddFromLibrary} />
        <button
          className={`chip chip--btn${drcOpen ? ' chip--on' : ''}${repairCount > 0 ? ' chip--attn' : ''}`}
          onClick={onToggleDrc}
          title={
            `${findings.length} DRC finding${findings.length === 1 ? '' : 's'}` +
            (repairCount > 0 ? ` · ${repairCount} changed on load — saving rewrites the file` : '') +
            ` — click to ${drcOpen ? 'hide' : 'show'}`
          }
        >
          <span className="chip__dot" style={{ background: 'var(--sev-error)' }} />
          {errors}
          <span className="chip__dot" style={{ background: 'var(--sev-warning)' }} />
          {warnings}
          {repairCount > 0 && (
            <>
              <span className="chip__dot" style={{ background: 'var(--sev-info)' }} />
              {repairCount}
            </>
          )}
          <span className="chip__mute">DRC</span>
        </button>
        <span className="chip chip--stats" title="Wires · total cut length · sheet">
          {stats.wires} wires
          <span className="chip__sep" />
          {formatLength(stats.totalLengthMm)}
          <span className="chip__sep" />
          {stats.sheetLabel}
        </span>
      </div>
      <div className="chrome__group">
        <div className="seg" role="group" aria-label="Canvas layout">
          <button
            className={`seg__btn${split ? '' : ' seg__btn--on'}`}
            onClick={() => setSplit(false)}
            title="One canvas"
          >
            Single
          </button>
          <button
            className={`seg__btn${split ? ' seg__btn--on' : ''}`}
            onClick={() => setSplit(true)}
            title="Two canvases side by side"
          >
            Split
          </button>
        </div>
        <button
          className="chip chip--btn"
          onClick={toggleTheme}
          title={`Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          <span className="chip__glyph">{theme === 'dark' ? '☀' : '☾'}</span>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
        <button className="chip chip--btn chip--primary" onClick={onExport} title="Export the drawing set (PDF)">
          Export
        </button>
      </div>
    </div>
  )
}
