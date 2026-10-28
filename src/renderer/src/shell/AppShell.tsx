import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { runDrc } from '@shared/drc'
import type { EntityRef, Finding } from '@shared/drc'
import type { HarnessDocument } from '@shared/model/schema'
import { primaryPartNumber } from '@shared/model/bodyParts'
import { pictureInfoLine, warningsCentre } from '@shared/print/drawingSet'
import { planBoard } from '@shared/print/board'
import { sheetMm } from '@shared/print/sheet'
import { outsideSheetFindings } from '@shared/print/sheetFindings'
import { computeFormboard } from '@shared/model/formboard'
import { useHarnessStore, type PaneView } from '../store'
import { HarnessPane, type HarnessPaneHandle } from './HarnessPane'
import { resolveJumpTarget, type FlowTarget } from './drcJump'
import { crossViewIds } from './crossView'
import { useFileOps, baseName, buildExport } from '../fileOps'
import { usePartImages } from '../usePartImages'
import { usePartsLibrary } from '../usePartsLibrary'
import { PropertiesPanel, type Selection } from '../panel/PropertiesPanel'
import { DrcPanel } from '../panel/DrcPanel'
import { ExportDialog, type ExportSummary } from '../ExportDialog'
import { LibraryDialog, type LibraryDlgState } from '../LibraryDialog'
import { useTheme } from '../useTheme'
import { runTool } from '../mcp/tools'
import { listLibrary } from '../mcp/library'
import { TopChrome } from './chrome/TopChrome'
import { BottomBar } from './chrome/BottomBar'

/** Which of the (up to two) panes the user last pointed at. */
type PaneSide = 'left' | 'right'

/**
 * Stable key for a finding across recomputes (rule + its referenced entities,
 * + the message so that several ref-less findings of the same rule — e.g. the
 * `repaired-on-load` notices — dismiss one at a time rather than as a block).
 */
function findingKey(f: Finding): string {
  return f.ruleId + '|' + f.refs.map((r) => r.kind + ':' + r.id).join(',') + '|' + f.message
}

/** Flow node/edge ids to highlight for the selected treatment, in the given view. */
function highlightIds(
  doc: HarnessDocument,
  sel: { kind: 'sleeving' | 'twist' | 'label'; id: string } | null,
  viewMode: PaneView
): Set<string> {
  const out = new Set<string>()
  if (!sel) return out
  if (sel.kind === 'twist') {
    const tw = doc.twists.find((t) => t.id === sel.id)
    if (!tw) return out
    if (viewMode === 'schematic') for (const w of tw.wireIds) out.add(w)
    else for (const s of tw.span.segmentIds) out.add(s)
  } else if (sel.kind === 'sleeving') {
    const sl = doc.sleeving.find((x) => x.id === sel.id)
    if (!sl) return out
    if (viewMode === 'formboard') for (const s of sl.span.segmentIds) out.add(s)
    else if (sl.target.type === 'wire') out.add(sl.target.wireId)
  } else {
    const t = doc.labels.find((x) => x.id === sel.id)?.target
    if (!t) return out
    if (t.type === 'wire') out.add(t.wireId)
    else if (t.type === 'branch') out.add(t.segmentId)
    else if (t.type === 'branchPoint') out.add(t.branchId)
  }
  return out
}

/**
 * The flow node/edge ids a canvas selection covers. This is what the shell hands
 * BOTH panes so one click selects in both; a treatment selection contributes
 * nothing here (treatments are not React Flow entities).
 */
function selectionIds(sel: Selection): Set<string> {
  if (sel.kind === 'node' || sel.kind === 'edge') return new Set([sel.id])
  if (sel.kind === 'multi') return new Set([...sel.nodeIds, ...sel.edgeIds])
  return new Set()
}

/**
 * Do two canvas selections cover the same thing? Contents, never identity: a
 * pane rebuilds its `Selection` object on every re-seed, and storing one of
 * those would push a fresh id set back down, re-seed both panes, and report
 * again — a cycle that never settles.
 */
function sameSelection(a: Selection, b: Selection): boolean {
  if (a.kind !== b.kind) return false
  const ia = selectionIds(a)
  const ib = selectionIds(b)
  if (ia.size !== ib.size) return false
  for (const id of ia) if (!ib.has(id)) return false
  return true
}

/**
 * The editor shell: document-level state, the toolbar, the inspector, the DRC
 * panel and the modals — and the one or two `HarnessPane`s of the split canvas.
 *
 * The shell owns the SELECTION; the panes own their own React Flow view state.
 * A pane reports its selection up, the shell stores it once and pushes the same
 * id set back to both, so clicking a body in either pane selects it in both and
 * drives the single inspector. Only the FOCUSED pane's report is believed: a
 * pane whose projection has no element for the current selection reports `none`,
 * and taking that at face value would clear the selection in the other pane.
 */
export function AppShell(): React.JSX.Element {
  const doc = useHarnessStore((s) => s.doc)
  const filePath = useHarnessStore((s) => s.filePath)
  const dirty = useHarnessStore((s) => s.dirty)
  const loadRepairs = useHarnessStore((s) => s.loadRepairs)
  const loadMigrations = useHarnessStore((s) => s.loadMigrations)
  const dismissLoadRepairs = useHarnessStore((s) => s.dismissLoadRepairs)
  const addConnectorFromPart = useHarnessStore((s) => s.addConnectorFromPart)
  const addFreeTerminalFromPart = useHarnessStore((s) => s.addFreeTerminalFromPart)
  const addSpliceFromPart = useHarnessStore((s) => s.addSpliceFromPart)
  const undo = useHarnessStore((s) => s.undo)
  const redo = useHarnessStore((s) => s.redo)
  const panes = useHarnessStore((s) => s.panes)
  const setPaneView = useHarnessStore((s) => s.setPaneView)
  const setSplit = useHarnessStore((s) => s.setSplit)
  const refreshPartRefs = useHarnessStore((s) => s.refreshPartRefs)

  const { open, openRecent, save, saveAs, newDoc, exportPdf, exportBom } = useFileOps()

  // The UI theme. It reaches the CANVAS only by being threaded into the pane's
  // projection (see `HarnessPane`'s `flow` memo): React Flow repaints an edge on
  // a data change, never because `<html data-theme>` flipped, so a toggle would
  // otherwise leave every wire on the previous theme's colours until a pan or a
  // click. Everything else under this component re-renders on the state change
  // and re-reads `currentTheme()` for free.
  const { theme, toggleTheme } = useTheme()

  // The canvases. Everything that needs a React Flow viewport (a drop point in
  // mm) goes through these handles, because `useReactFlow` only works inside a
  // pane's own provider — and each pane has its own, which is what lets the two
  // pan and zoom independently.
  const leftPaneRef = useRef<HarnessPaneHandle>(null)
  const rightPaneRef = useRef<HarnessPaneHandle>(null)

  // Which pane the user last pointed at. It decides where a toolbar/library add
  // lands and which view a DRC jump is resolved against first.
  const [focusedPane, setFocusedPane] = useState<PaneSide>('left')
  // With split off there is only the left pane, whatever was focused last.
  const activeSide: PaneSide = panes.split ? focusedPane : 'left'
  const activeView = panes[activeSide]
  // Mirrored into a ref because a pane reports its selection from an EFFECT that
  // runs in the same commit as the pointerdown which moved focus: a value
  // captured in the callback's closure would still name the previous pane.
  const activeSideRef = useRef<PaneSide>(activeSide)
  activeSideRef.current = activeSide
  const focusPane = useCallback((side: PaneSide) => {
    activeSideRef.current = side
    setFocusedPane(side)
  }, [])
  const focusLeft = useCallback(() => focusPane('left'), [focusPane])
  const focusRight = useCallback(() => focusPane('right'), [focusPane])
  // Reset focus when the split closes, so the right pane always MOUNTS
  // UNFOCUSED on the next Split. `activeSide` already clamps to 'left' for
  // reads, but `focusedPane` itself had to be reset too: a pane's first report
  // arrives from an effect while its `nodes` is still `[]` (nothing projected
  // yet), so a right pane that mounted focused would report "nothing selected",
  // be believed, and then alternate with its own re-seed — which lands one
  // commit later — until React gave up with "maximum update depth exceeded".
  // That crashed the renderer into the ErrorBoundary; it is not a cosmetic reset.
  useEffect(() => {
    if (!panes.split) focusPane('left')
  }, [panes.split, focusPane])
  const activePane = useCallback(
    (): HarnessPaneHandle | null =>
      (activeSideRef.current === 'right' ? rightPaneRef : leftPaneRef).current,
    []
  )

  // Part photos. The library is keyed by part number, so the hook is told which
  // part numbers this document uses; its `images` map then feeds the canvas
  // projection, the export and the panel's Picture row from ONE source.
  //
  // Every body ENTITY, not just the drawn ones: an unplaced connector has no
  // picture block but its panel row must still show the library's photo, and
  // a spare entry costs nothing (the planner only draws blocks for bodies the
  // layout placed). Reading the three lists also avoids a third
  // `computeFormboard` per document change.
  const partNumbers = useMemo(() => {
    const out: string[] = []
    for (const b of [...doc.connectors, ...doc.freeTerminals, ...doc.splices]) {
      const pn = primaryPartNumber(doc, b.id)
      if (pn && !out.includes(pn)) out.push(pn)
    }
    return out
  }, [doc])
  const parts = usePartImages(partNumbers)

  // The parts library, listed into memory once and kept in sync with the
  // shared folder; `drcCatalog` is undefined until a folder is chosen so a
  // fresh install isn't flooded with "unresolved part" warnings.
  const library = usePartsLibrary()
  const drcCatalog = library.catalog

  // The board plan's warnings for the fixed sheet. The canvas plans the same
  // board inside each pane's projection memo, out of reach from here, so it is
  // planned once more — memoised on the document and the photo library, the two
  // things the plan depends on, so a selection click or a theme toggle does not
  // re-run it.
  const boardWarnings = useMemo(
    () => planBoard(doc, sheetMm(doc.drawing.sheet), computeFormboard(doc), parts.images).warnings,
    [doc, parts.images]
  )

  // DRC — recompute findings whenever the document changes. Repairs made by the
  // load-time reconcile ride along as `info` findings: the panel already has
  // per-finding dismissal, so they need no UI of their own beyond the notice in
  // the DRC panel's header. They live in the store, not in `doc`, so they
  // survive edits until the document is saved (or the notice is dismissed).
  const findings = useMemo(
    () => [
      ...loadRepairs.map(
        (r): Finding => ({
          ruleId: 'repaired-on-load',
          severity: 'info',
          message: `Repaired on load (${r.kind}) — ${r.message}`,
          refs: []
        })
      ),
      // Loader-level migrations (an older file's shape, an invalid sheet) sit
      // beside the reference repairs — same panel, same dismissal, same notice.
      ...loadMigrations.map(
        (m): Finding => ({
          ruleId: 'migrated-on-load',
          severity: 'info',
          message: `Migrated on load — ${m}`,
          refs: []
        })
      ),
      ...runDrc(doc, drcCatalog),
      // Anything the one printed sheet would cut off (spec §1: flagged, not
      // accommodated) — one warning per body, branch point, segment, label or block.
      ...outsideSheetFindings(boardWarnings, doc)
    ],
    [doc, drcCatalog, loadRepairs, loadMigrations, boardWarnings]
  )
  const [showDrc, setShowDrc] = useState(false)
  const [exportDlg, setExportDlg] = useState(false)
  const [libraryDlg, setLibraryDlg] = useState<LibraryDlgState>(null)
  // Built only while the dialog is open — building the drawing set is not free
  // on a large harness. Always the document's own sheet: there is no per-export
  // paper choice any more (the sheet is fixed on the formboard).
  const exportSummary = useMemo((): ExportSummary | null => {
    if (!exportDlg) return null
    const o = buildExport(doc, parts.images, { logoDataUri: parts.logo ?? undefined })
    return {
      pages: o.pageCount,
      warning: warningsCentre(o.warnings),
      info: pictureInfoLine(o.bodiesWithoutPicture.length)
    }
  }, [exportDlg, doc, parts.images, parts.logo])
  // Dismissed findings stay hidden until Reset; ones that resolve (vanish from
  // `findings` on the next recompute) simply stop being shown — their stale key
  // in the set is harmless. `dismissedShown` counts only still-present ones.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const visibleFindings = useMemo(
    () => findings.filter((f) => !dismissed.has(findingKey(f))),
    [findings, dismissed]
  )
  const dismissedShown = findings.length - visibleFindings.length
  const dismissFinding = useCallback(
    (f: Finding) => setDismissed((prev) => new Set(prev).add(findingKey(f))),
    []
  )
  const resetDismissed = useCallback(() => setDismissed(new Set()), [])

  // Treatment (sleeving/twist/label) selection — mutually exclusive with the
  // canvas selection below; managed entirely outside React Flow because
  // treatments are not nodes/edges.
  const [treatmentSel, setTreatmentSel] = useState<{
    kind: 'sleeving' | 'twist' | 'label'
    id: string
  } | null>(null)

  // The authoritative canvas selection, as the focused pane last reported it.
  const [paneSelection, setPaneSelection] = useState<Selection>({ kind: 'none' })

  // What the properties panel inspects: a selected treatment wins over the canvas.
  const selection: Selection = treatmentSel ?? paneSelection

  // …and what BOTH panes select. Memoised on `paneSelection`, which only changes
  // when its CONTENTS change, so the set's identity is stable and the panes'
  // re-seed effect does not fire on every render.
  const selectedIds = useMemo(() => selectionIds(paneSelection), [paneSelection])

  // A pane's selection report.
  //
  // Only the focused pane is believed. Both panes are handed the same id set,
  // but a pane whose projection has no element for some id (a branch point is
  // not a schematic node) applies less than it was given and then reports that
  // smaller selection back — which, taken at face value, would wipe out the
  // selection in the pane that CAN draw it. A user-driven change always starts
  // with a pointerdown, which focuses the pane first.
  //
  // Nothing is stored when the contents are unchanged: the shell pushing a set
  // down re-seeds the pane, which reports it straight back, and re-storing it
  // would push again — a cycle with no fixed point.
  //
  // A non-empty canvas selection clears the treatment selection (mutual
  // exclusivity). Doing it here rather than in an effect on `paneSelection`
  // keeps it race-free against `selectTreatment`: selecting a treatment makes
  // the panes report an EMPTY selection, which must not undo it.
  const handlePaneSelection = useCallback((side: PaneSide, sel: Selection) => {
    if (side !== activeSideRef.current) return
    setPaneSelection((prev) => (sameSelection(prev, sel) ? prev : sel))
    if (sel.kind !== 'none') setTreatmentSel(null)
  }, [])
  const onLeftSelection = useCallback(
    (sel: Selection) => handlePaneSelection('left', sel),
    [handlePaneSelection]
  )
  const onRightSelection = useCallback(
    (sel: Selection) => handlePaneSelection('right', sel),
    [handlePaneSelection]
  )

  const clearTreatmentSel = useCallback(() => setTreatmentSel(null), [])

  // The inspector's × — the one control the floating card adds. It clears BOTH
  // selections: the panes read the now-empty id set back on their next re-seed
  // and deselect themselves, which is the same path a click on empty canvas
  // takes. Guarded on contents so it cannot push a fresh `none` object into a
  // state that already holds one (see `sameSelection`).
  const clearSelection = useCallback(() => {
    setTreatmentSel(null)
    setPaneSelection((prev) => (prev.kind === 'none' ? prev : { kind: 'none' }))
  }, [])

  // Select a treatment from the panel list / on creation. The panes clear their
  // own selection off `treatmentSelected`, so the two never coexist.
  const selectTreatment = useCallback(
    (kind: 'sleeving' | 'twist' | 'label', id: string) => setTreatmentSel({ kind, id }),
    []
  )

  // Highlight sets, resolved PER PANE for the view that pane is showing — a
  // twist highlights wires in the schematic and segments on the formboard, so
  // one shared set would light up the wrong ids in one of them. The canvas
  // selection rides along the same way: a wire picked in the schematic lights
  // its route's segments on the formboard and a segment lights its wires in the
  // schematic (`crossViewIds`). A treatment and a canvas selection never
  // coexist, so at most one half contributes. Memoised: a fresh Set on every
  // render would re-seed that pane's canvas.
  const highlightedLeft = useMemo(
    () => new Set([...highlightIds(doc, treatmentSel, panes.left), ...crossViewIds(doc, selectedIds, panes.left)]),
    [doc, treatmentSel, selectedIds, panes.left]
  )
  const highlightedRight = useMemo(
    () => new Set([...highlightIds(doc, treatmentSel, panes.right), ...crossViewIds(doc, selectedIds, panes.right)]),
    [doc, treatmentSel, selectedIds, panes.right]
  )

  // Route File/Edit-menu actions (and their accelerators) to the handlers.
  useEffect(() => {
    return window.api.onMenuAction((action) => {
      if (action === 'open') open()
      else if (action === 'save') save()
      else if (action === 'saveAs') saveAs()
      else if (action === 'new') newDoc()
      else if (action === 'undo') undo()
      else if (action === 'redo') redo()
      else if (action === 'exportDrawingSet') setExportDlg(true)
      else if (action === 'exportBom') exportBom()
      else if (action === 'openLibrary') {
        setLibraryDlg({ mode: 'browse' })
      } else if (action === 'refreshPartRefs') {
        if (!library.catalog) {
          window.alert('Set the parts library folder first (Settings ▸ Parts library folder…).')
        } else {
          const n = refreshPartRefs(library.catalog)
          window.alert(n ? `Updated ${n} part reference(s) from the library.` : 'All part references already match the library.')
        }
      }
    })
  }, [open, save, saveAs, newDoc, undo, redo, exportBom, library.catalog, refreshPartRefs])

  // File ▸ Open Recent ▸ <file>.
  useEffect(() => window.api.onOpenRecent((path) => void openRecent(path)), [openRecent])

  // Keep the window title in sync with file name + dirty state.
  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${baseName(filePath)} — Harness Editor`
  }, [filePath, dirty])

  // Keep the main process informed of unsaved changes so its window-close guard
  // can prompt before discarding them.
  useEffect(() => {
    window.api.setDirty(dirty)
  }, [dirty])

  // Model-mm drop point for an add with no cursor to anchor to — today only
  // "Place on board" from the library: the centre of the FOCUSED pane's
  // viewport. The refs are set on mount, so the fallback only ever guards a call
  // that cannot happen (no button exists to press before the panes are there).
  const addDropPos = useCallback(
    (): { x: number; y: number } => activePane()?.centerFlowPos() ?? { x: 0, y: 0 },
    [activePane]
  )

  // The views a DRC jump may land in, focused pane first: a finding whose ref
  // has no element in the focused view (a branch point, with the schematic
  // focused) still jumps if the OTHER visible pane can show it.
  const jumpViews = useMemo(
    (): PaneView[] => (panes.split ? [activeView, panes[activeSide === 'left' ? 'right' : 'left']] : [panes.left]),
    [panes, activeView, activeSide]
  )
  const jumpTarget = useCallback(
    (ref: EntityRef): FlowTarget | null => resolveJumpTarget(doc, ref, jumpViews),
    [doc, jumpViews]
  )
  // What the DRC panel greys out: exactly the refs the jump below would no-op on.
  const resolveRefToFlowId = useCallback(
    (ref: EntityRef): string | null => jumpTarget(ref)?.id ?? null,
    [jumpTarget]
  )

  // Clicking a DRC finding selects the referenced element. It goes into the
  // SHELL's selection, not into one pane: the panes read it back on their next
  // re-seed, so whichever of them can draw it shows it selected and the
  // inspector agrees. No-ops if the ref resolves in neither visible view.
  const handleDrcSelect = useCallback(
    (ref: EntityRef) => {
      const t = jumpTarget(ref)
      if (!t) return
      const next: Selection = { kind: t.kind, id: t.id }
      setPaneSelection((prev) => (sameSelection(prev, next) ? prev : next))
      setTreatmentSel(null)
    },
    [jumpTarget]
  )

  // The MCP server's document tools (`mcp/tools.ts`): main forwards an agent's
  // call here. Registered once; what it needs from the shell changes with the
  // panes, so it reads that through a ref. The library is listed fresh per call:
  // a part an agent has just added with `library_put` must resolve without
  // waiting for `usePartsLibrary`'s re-list.
  const mcpRef = useRef({ addDropPos, jumpTarget, handleDrcSelect })
  mcpRef.current = { addDropPos, jumpTarget, handleDrcSelect }
  useEffect(
    () =>
      window.api.onMcpCall((name, args) =>
        runTool(name, args, {
          library: listLibrary,
          placeAt: () => mcpRef.current.addDropPos(),
          select: (ref) => {
            if (!mcpRef.current.jumpTarget(ref)) return false
            mcpRef.current.handleDrcSelect(ref)
            return true
          },
          save: (path, text) => window.api.saveDocument(path, text)
        })
      ),
    []
  )

  return (
    <div className="app">
      <div className="app__body">
        <div className="app__panes">
          <TopChrome
            fileLabel={doc.drawing.titleBlock?.partNumber || baseName(filePath)}
            dirty={dirty}
            revision={doc.drawing.titleBlock?.revision}
            onSearchParts={() => setLibraryDlg({ mode: 'browse' })}
            panes={panes}
            setPaneView={setPaneView}
          />
          <HarnessPane
            ref={leftPaneRef}
            mode={panes.left}
            doc={doc}
            parts={parts}
            theme={theme}
            highlighted={highlightedLeft}
            treatmentSelected={treatmentSel !== null}
            selectedIds={selectedIds}
            onSelectionChange={onLeftSelection}
            onPaneClick={clearTreatmentSel}
            onFocus={focusLeft}
            focused={activeSide === 'left'}
          />
          {panes.split && <div className="app__divider" />}
          {panes.split && (
            <HarnessPane
              ref={rightPaneRef}
              mode={panes.right}
              doc={doc}
              parts={parts}
              theme={theme}
              highlighted={highlightedRight}
              treatmentSelected={treatmentSel !== null}
              selectedIds={selectedIds}
              onSelectionChange={onRightSelection}
              onPaneClick={clearTreatmentSel}
              onFocus={focusRight}
              focused={activeSide === 'right'}
            />
          )}
          <BottomBar
            doc={doc}
            findings={visibleFindings}
            repairCount={loadRepairs.length + loadMigrations.length}
            drcOpen={showDrc}
            onToggleDrc={() => setShowDrc((v) => !v)}
            split={panes.split}
            setSplit={setSplit}
            theme={theme}
            toggleTheme={toggleTheme}
            onExport={() => setExportDlg(true)}
            onAdd={(kind) => activePane()?.addAtCenter(kind)}
            onAddFromLibrary={() => setLibraryDlg({ mode: 'browse' })}
          />
        </div>
        <PropertiesPanel
          selection={selection}
          viewMode={activeView}
          theme={theme}
          parts={parts}
          library={library}
          onSaveToLibrary={(p) => setLibraryDlg({ mode: 'edit', part: p, isNew: !library.byPn.has(p.partNumber) })}
          onSelectTreatment={selectTreatment}
          onClearSelection={clearSelection}
        />
        {showDrc && (
          <DrcPanel
            findings={visibleFindings}
            onSelect={handleDrcSelect}
            resolve={resolveRefToFlowId}
            onDismiss={dismissFinding}
            dismissedCount={dismissedShown}
            onReset={resetDismissed}
            repairCount={loadRepairs.length + loadMigrations.length}
            onDismissRepairs={dismissLoadRepairs}
          />
        )}
      </div>
      {exportDlg && exportSummary && (
        <ExportDialog
          sheet={doc.drawing.sheet}
          summary={exportSummary}
          onClose={() => setExportDlg(false)}
          onExport={() => {
            setExportDlg(false)
            void exportPdf(parts.images)
          }}
        />
      )}
      {libraryDlg && (
        <LibraryDialog
          state={libraryDlg}
          library={library}
          parts={parts}
          onClose={() => setLibraryDlg(null)}
          onPlace={(part) => {
            const pos = addDropPos()
            const id =
              part.kind === 'connector'
                ? addConnectorFromPart(pos, part, library.resolve)
                : part.kind === 'terminal'
                  ? addFreeTerminalFromPart(pos, part)
                  : part.kind === 'splice'
                    ? addSpliceFromPart(pos, part)
                    : null
            if (id) activePane()?.selectById(id)
            setLibraryDlg(null)
          }}
        />
      )}
    </div>
  )
}
