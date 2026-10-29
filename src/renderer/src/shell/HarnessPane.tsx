import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardedRef
} from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  ConnectionMode,
  SelectionMode,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ViewportPortal,
  type Connection,
  type EdgeChange,
  type Node,
  type Edge,
  type EdgeTypes,
  type NodeTypes
} from '@xyflow/react'
import type { HarnessDocument } from '@shared/model/schema'
import { computeFormboard } from '@shared/model/formboard'
import { incidentSegments, isSelfLoopSegment } from '@shared/model/topology'
import { primaryPartNumber } from '@shared/model/bodyParts'
import { useHarnessStore, type PaneView } from '../store'
import {
  documentToFlow,
  parseHandleId,
  sameEndpoint,
  describeEndpoint,
  type FlowNode,
  type BlockNodeData
} from '../flow/toFlow'
import { documentToFormboard } from '../flow/toFormboard'
import { HARNESS_NODE_TYPES, HARNESS_EDGE_TYPES } from '../flow/registry'
import { dragOutcome } from './dragGesture'
import { reconnectOutcome } from './reconnectGesture'
import { nearestBody } from '../flow/nearestBody'
import { nodeCentre } from '../flow/nodeCentre'
import type { PartImageLibrary } from '../usePartImages'
import type { ThemeName } from '../useTheme'
import type { Selection } from '../panel/PropertiesPanel'

const nodeTypes: NodeTypes = HARNESS_NODE_TYPES
const edgeTypes: EdgeTypes = HARNESS_EDGE_TYPES

/**
 * How close (mm, model space) a dropped image file must land to a body dot to
 * be imported for that body's part. The dot draws 6 px wide, so this is the
 * glyph plus a generous margin — enough to be forgiving, tight enough that a drop
 * on empty board is not silently claimed by a distant connector.
 */
const IMAGE_DROP_MM = 8

/** Kinds of element the user can add from the toolbar / context menu. */
export type AddKind = 'connector' | 'terminal' | 'splice'

/** Shared "nothing is selected" set — a fresh one per render would re-seed. */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>()

/** Schematic node types that ARE a placed body — what Delete/Backspace may remove there. */
const isSchematicBody = (type: string | undefined): boolean =>
  type === 'connector' || type === 'freeTerminal' || type === 'splice'

export interface HarnessPaneProps {
  /** Which projection this pane draws: wires-as-edges, or the 1:1 formboard. */
  mode: PaneView
  /** The harness. Electrical truth + layout overlay; edits go through the store. */
  doc: HarnessDocument
  /** Part photos, for the formboard's picture blocks and the image-drop import. */
  parts: PartImageLibrary
  /**
   * The current UI theme. It reaches the canvas ONLY through the projection
   * below (`documentToFlow` puts it in each wire edge's `data`), because React
   * Flow repaints an edge on a data change and not when `<html data-theme>`
   * flips. Do NOT key this component or its `<ReactFlow>` on it — see the note
   * on the `flow` memo.
   */
  theme: ThemeName
  /**
   * Flow node/edge ids to highlight for the shell's treatment selection, already
   * resolved for THIS pane's mode. Memoise it: a fresh set re-seeds the canvas.
   */
  highlighted: ReadonlySet<string>
  /**
   * True while the shell holds a treatment (sleeving/twist/label) selection. The
   * pane then drops its own node/edge selection, so the two never coexist; the
   * other direction is the shell's job when `onSelectionChange` reports one.
   */
  treatmentSelected: boolean
  /**
   * The shell's authoritative selected-id set, applied on every re-seed. This is
   * what makes one click select in BOTH panes: the pane reports upward, the shell
   * stores, and both panes read the same set back. Memoise it — a fresh Set is an
   * effect dependency and would re-seed the canvas on every render.
   *
   * Ids this pane's projection does not contain are simply not applied (a branch
   * point has no schematic node), and the pane does NOT report that loss back —
   * see `onSelectionChange`.
   */
  selectedIds: ReadonlySet<string>
  /**
   * This pane's node/edge selection, whenever it changes. Keep the identity
   * stable (`useCallback`) — it is an effect dependency.
   *
   * The shell must only honour this from the FOCUSED pane: an unfocused pane
   * that cannot draw the current selection reports `none`, and taking that at
   * face value would clear the selection in the pane that CAN draw it.
   */
  onSelectionChange: (sel: Selection) => void
  /** A click on empty canvas; the shell drops its treatment selection. */
  onPaneClick: () => void
  /**
   * A pointer went down anywhere in this pane. The shell makes it the focused
   * pane: toolbar/library adds drop into it, and it is the preferred target of a
   * DRC jump. Fired on the capture phase so it lands before React Flow's own
   * handlers change the selection.
   */
  onFocus: () => void
  /**
   * True when this is the shell's focused pane. Only the focused pane binds
   * the Delete/Backspace keys: React Flow listens for them on `document`, and
   * both panes hold the same `selectedIds`, so an unfocused pane would
   * otherwise delete what a box drawn in the OTHER pane selected.
   */
  focused: boolean
}

/**
 * What the shell can ask of a pane. Everything here needs the React Flow
 * viewport, which is provider-scoped and therefore unreachable from outside —
 * hence a handle rather than props.
 */
export interface HarnessPaneHandle {
  /** Model-mm position at the centre of this pane's viewport. */
  centerFlowPos(): { x: number; y: number }
  /** Model-mm position for a screen point. */
  screenToFlowPos(pt: { x: number; y: number }): { x: number; y: number }
  /** Make `id` the sole selection once it lands in the projection (after an add). */
  selectById(id: string): void
  /** Add a blank body at the centre of this pane's viewport and select it. */
  addAtCenter(kind: AddKind): void
}

/**
 * One canvas: a React Flow instance with its own provider, projecting the
 * document in `mode` and owning every interaction on it — wiring, drags and
 * their document commits, the context menus, the image drop and the pinout
 * leader line. Selection is derived here and reported up; the shell keeps the
 * inspector, the treatment selection and the toolbar.
 *
 * The provider is PER PANE deliberately: React Flow scopes viewport, zoom and
 * node measurements to it, so two panes each need their own to pan and zoom
 * independently.
 */
export const HarnessPane = forwardRef(function HarnessPane(
  props: HarnessPaneProps,
  ref: ForwardedRef<HarnessPaneHandle>
): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <HarnessPaneInner {...props} handleRef={ref} />
    </ReactFlowProvider>
  )
})

function HarnessPaneInner({
  mode,
  doc,
  parts,
  theme,
  highlighted,
  treatmentSelected,
  selectedIds,
  onSelectionChange,
  onPaneClick,
  onFocus,
  focused,
  handleRef
}: HarnessPaneProps & { handleRef: ForwardedRef<HarnessPaneHandle> }): React.JSX.Element {
  const commitGesture = useHarnessStore((s) => s.commitGesture)
  const addWire = useHarnessStore((s) => s.addWire)
  const reconnectWire = useHarnessStore((s) => s.reconnectWire)
  const removeElements = useHarnessStore((s) => s.removeElements)
  const addConnector = useHarnessStore((s) => s.addConnector)
  const addFreeTerminal = useHarnessStore((s) => s.addFreeTerminal)
  const addSplice = useHarnessStore((s) => s.addSplice)
  const gridVisible = useHarnessStore((s) => s.gridVisible)
  const gridMm = useHarnessStore((s) => s.gridMm)
  const insertBranchPoint = useHarnessStore((s) => s.insertBranchPoint)
  const removeBranchPoint = useHarnessStore((s) => s.removeBranchPoint)
  const removeBranchPoints = useHarnessStore((s) => s.removeBranchPoints)
  const mergeBranchPoints = useHarnessStore((s) => s.mergeBranchPoints)
  const disconnectWireAtBranch = useHarnessStore((s) => s.disconnectWireAtBranch)
  const clearBlockPos = useHarnessStore((s) => s.clearBlockPos)
  const setPictureView = useHarnessStore((s) => s.setPictureView)
  const rotatePicture = useHarnessStore((s) => s.rotatePicture)
  const flipPicture = useHarnessStore((s) => s.flipPicture)

  const { screenToFlowPosition } = useReactFlow()

  // React Flow owns the *view* state (selection, hover, live drag). It is
  // re-seeded from the document whenever the document changes (open, undo,
  // add/remove wire, drag commit). Selection lives here so Delete has a target.
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  // A selection box selects NODES only. React Flow also selects every edge
  // touching a boxed node, which would make the box report the wires/limbs as
  // part of the multi selection and — worse — hand them to Delete. So while a
  // box is being drawn, edge `select: true` changes are dropped (deselects
  // still pass, so the box clears an earlier edge selection). The flag is set
  // in `onSelectionStart`, which React Flow calls BEFORE the box's first
  // selection change — its own `userSelectionActive` is only set after it.
  const boxSelectingRef = useRef(false)
  const onEdgesChangeBoxed = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      onEdgesChange(
        boxSelectingRef.current
          ? changes.filter((c) => !(c.type === 'select' && c.selected))
          : changes
      )
    },
    [onEdgesChange]
  )

  // After an add, this holds the new node id so the next re-seed selects it
  // (opening the properties panel on the new element). Consumed once.
  const pendingSelectRef = useRef<string | null>(null)
  // The shell selection the re-seed last applied, and the selection report the
  // re-seed made stale — see the re-seed effect below.
  const appliedRef = useRef<{ ids: ReadonlySet<string>; treatment: boolean } | null>(null)
  const staleReportRef = useRef<Selection | null>(null)
  const selectionRef = useRef<Selection>({ kind: 'none' })
  const canvasRef = useRef<HTMLDivElement>(null)

  // Only the schematic's wire strokes depend on the theme — the formboard draws
  // on white paper (spec decision 4) and must look identical in both — so the
  // formboard projection is deliberately NOT a function of it and does not
  // re-run `planBoard` on a toggle.
  const projectionTheme = mode === 'formboard' ? undefined : theme

  // The projection. Pure in (doc, mode, images, theme), and memoised apart from
  // the re-seed below because the re-seed also fires when only the SELECTION
  // changed — re-running `planBoard` on every click would be pure waste.
  //
  // THE THEME GOES THROUGH HERE, NOT THROUGH A `key`. A new projection is a new
  // edge `data`, which is a change React Flow already repaints on, and the
  // viewport, selection and drag state all survive it. Keying this pane (or its
  // `<ReactFlow>`) on `theme` would REMOUNT it instead: a pane's first selection
  // report leaves an effect while `nodes` is still `[]`, one commit ahead of its
  // first re-seed, so a focused pane that remounts reports "nothing selected"
  // against a non-empty shell selection and the two alternate until React gives
  // up with "maximum update depth exceeded" (error #185) and the ErrorBoundary
  // takes the renderer. The re-seed below now drops a report it made stale,
  // which closes that loop — but a remount still costs a re-projection and the
  // viewport, so do not key on the theme anyway.
  const flow = useMemo(
    () =>
      mode === 'formboard'
        ? documentToFormboard(doc, { logoDataUri: parts.logo ?? undefined }, parts.images)
        : documentToFlow(doc, projectionTheme),
    [mode, doc, parts.images, parts.logo, projectionTheme]
  )

  // Re-seed from the document, applying the shell's selected-id set so that a
  // click in either pane selects in both and editing a field (which changes the
  // document) doesn't deselect the element.
  //
  // Which selection the re-seed applies, in precedence order:
  //   1. a pending-select id (an add) — it becomes the sole selection;
  //   2. none at all while the shell holds a treatment — a selected treatment
  //      and a selected node/edge are mutually exclusive;
  //   3. otherwise the shell's set (`selectedIds`), which is where this pane's
  //      own last reported selection has come back round from.
  //
  // (2) lives HERE, inside the one effect that writes the selection, rather
  // than in a second effect that deselects afterwards: `CreateActions` in the
  // properties panel edits the document AND selects the new treatment in one
  // handler, so both would run in the same commit and the outcome would depend
  // on which effect was DECLARED first. One effect cannot be mis-ordered.
  // (1) still beats (2): adding an element while a treatment is selected must
  // select the new element — the shell then drops the treatment when this pane
  // reports that non-empty selection.
  //
  // (3) is also the CROSS-PANE channel: the shell pushes the same set to both
  // panes, so one click selects in both. Ids this projection has no element for
  // are silently dropped (a branch point is not a schematic node); that is why
  // the shell only believes `onSelectionChange` from the focused pane.
  //
  // The shell's selection is applied ONLY when it changed (or on an add). When
  // just the projection changed — an edit, a re-listed image folder — the
  // pane's own live selection is kept. And in a commit that does apply the
  // shell's set, this render's selection report is stale (it describes the
  // view being replaced), so the report effect drops it. Both halves matter:
  // without them a re-seed that landed in the same commit as a click applied
  // the shell's PREVIOUS set while the report sent the click up, and from then
  // on each commit undid the last — one commit out of phase, forever — until
  // React gave up with error #185 and the ErrorBoundary took the renderer.
  // A window-focus image re-list arriving mid-click was enough to start it.
  useEffect(() => {
    const pending = pendingSelectRef.current
    pendingSelectRef.current = null
    const applied = appliedRef.current
    const applyShell =
      pending != null || !applied || applied.ids !== selectedIds || applied.treatment !== treatmentSelected
    appliedRef.current = { ids: selectedIds, treatment: treatmentSelected }
    if (applyShell) staleReportRef.current = selectionRef.current
    const nodeSel: ReadonlySet<string> = pending
      ? new Set([pending])
      : treatmentSelected
        ? EMPTY_IDS
        : selectedIds
    // An edge is never the target of an add, so a pending select means "no edge".
    const edgeSel: ReadonlySet<string> = pending || treatmentSelected ? EMPTY_IDS : selectedIds
    const liveIds = (els: { id: string; selected?: boolean }[]): Set<string> =>
      new Set(els.filter((el) => el.selected).map((el) => el.id))
    setNodes((prev) => {
      const sel = applyShell ? nodeSel : liveIds(prev)
      return flow.nodes.map(
        (n) =>
          ({
            ...n,
            selected: sel.has(n.id),
            data: { ...n.data, highlighted: highlighted.has(n.id) }
          }) as FlowNode
      )
    })
    setEdges((prev) => {
      const sel = applyShell ? edgeSel : liveIds(prev)
      return flow.edges.map((e) => ({
        ...e,
        selected: sel.has(e.id),
        data: { ...e.data, highlighted: highlighted.has(e.id) }
      }))
    })
  }, [flow, setNodes, setEdges, highlighted, treatmentSelected, selectedIds])

  // Derive this pane's selection from the React Flow state and report it up —
  // the inspector is the shell's, and in the split view two panes feed one. This
  // is a report, NOT a second writer of selection: it only reads `nodes`/`edges`.
  // It fires on echoes too (the shell pushing a set back re-seeds this pane),
  // which is why the shell compares contents before storing.
  //
  // KEEP THIS MEMOISED on [nodes, edges]. It is what makes the report fire only
  // when the selection actually changed, and that — not effect ordering — is why
  // "+ Sleeving" survives: selecting a treatment makes this pane drop its own
  // selection, and a plain (unmemoised) computation here would re-report the
  // STALE non-empty selection on the next render, which the shell would read as
  // "the user picked a wire" and drop the brand-new treatment again.
  const selection = useMemo<Selection>(() => {
    const ns = nodes.filter((n) => n.selected)
    const es = edges.filter((e) => e.selected)
    const total = ns.length + es.length
    if (total === 0) return { kind: 'none' }
    if (total > 1)
      return { kind: 'multi', count: total, nodeIds: ns.map((n) => n.id), edgeIds: es.map((e) => e.id) }
    if (ns.length === 1) return { kind: 'node', id: ns[0].id }
    return { kind: 'edge', id: es[0].id }
  }, [nodes, edges])
  selectionRef.current = selection

  useEffect(() => {
    // Stale: the re-seed in this same commit just replaced the view it describes.
    if (staleReportRef.current === selection) return
    onSelectionChange(selection)
  }, [selection, onSelectionChange])

  // Add an element at a screen point (cursor or viewport centre), then mark it
  // for auto-selection. screenToFlowPosition maps the click to model mm coords.
  const addAt = useCallback(
    (kind: AddKind, screenPt: { x: number; y: number }) => {
      const pos = screenToFlowPosition(screenPt)
      const id =
        kind === 'connector'
          ? addConnector(pos)
          : kind === 'terminal'
            ? addFreeTerminal(pos)
            : addSplice(pos)
      pendingSelectRef.current = id
    },
    [screenToFlowPosition, addConnector, addFreeTerminal, addSplice]
  )

  // Screen point at the centre of the canvas viewport — what a toolbar add (no
  // cursor position to anchor to) and "Place on board" from the library both
  // drop onto. Falls back to the window centre if the canvas hasn't measured yet.
  const canvasCenterScreenPt = useCallback((): { x: number; y: number } => {
    const r = canvasRef.current?.getBoundingClientRect()
    return r
      ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 }
  }, [])

  // Right-click context menu — carries its own items so the same widget serves
  // adding elements (schematic pane) and add/remove branch point (formboard).
  type MenuItem = { label: string; onClick: () => void }
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  // While a pinout table is being dragged, a leader line joins it to its
  // parent body so the user can see which connector it belongs to. Flow (mm)
  // coordinates; null when nothing relevant is dragging.
  const [tableLeader, setTableLeader] = useState<{
    from: { x: number; y: number }
    to: { x: number; y: number }
  } | null>(null)
  const updateTableLeader = useCallback(
    (node: Node) => {
      if (node.type !== 'pinoutTable') return
      const d = node.data as BlockNodeData
      const parent = nodes.find((n) => n.id === d.refId)
      if (!parent) return
      // The dot is centre-origin: its position IS the body's centre.
      setTableLeader({ from: nodeCentre(node), to: nodeCentre(parent) })
    },
    [nodes]
  )
  const closeMenu = useCallback(() => setMenu(null), [])

  // Close the context menu on Escape or any click elsewhere while it's open.
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeMenu()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('click', closeMenu)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('click', closeMenu)
    }
  }, [menu, closeMenu])

  // Commit a finished drag to the document as one undoable edit (geometry only).
  // Formboard drags write the physical layout (pos); schematic drags write schematicPos.
  const commitDrag = useCallback(
    (dragged: FlowNode[]) => {
      const out = dragOutcome(doc, mode, dragged)
      if (out.kind === 'merge') mergeBranchPoints(out.srcId, out.dstId)
      else commitGesture(out.gesture)
    },
    [commitGesture, mode, doc, mergeBranchPoints]
  )

  // Dropping an image file on a body dot imports it as that part's picture.
  // Formboard only — the schematic has no dots and no picture blocks. The file
  // never enters the renderer: `pathForFile` hands main the OS path and the
  // library copies it, so nothing image-sized crosses the IPC boundary.
  const onImageDrop = useCallback(
    (e: React.DragEvent) => {
      if (mode !== 'formboard') return
      // `onDragOver` already claimed every file drag on the formboard, so the
      // drop is swallowed here whatever the file turns out to be — the handler
      // stays self-consistent rather than relying on what Electron does with a
      // drop the page half-accepted.
      e.preventDefault()
      const file = e.dataTransfer.files[0]
      if (!file || !/\.(png|jpe?g)$/i.test(file.name)) return
      const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const body = nearestBody(computeFormboard(doc).bodies, at, IMAGE_DROP_MM)
      if (!body) return
      const pn = primaryPartNumber(doc, body.id)
      if (!pn) {
        window.alert('That body has no part number yet — set one in the panel first.')
        return
      }
      void parts.importFor(pn, window.api.pathForFile(file))
    },
    [mode, doc, screenToFlowPosition, parts]
  )

  // Dragging pin-to-pin creates a wire. Handles map back to electrical
  // endpoints; loose connection mode allows any pin to any pin (multigraph).
  // Gate to schematic only: in formboard mode edges are segments, not wires,
  // so a pin drag would inject stray straight segments into the loom.
  const onConnect = useCallback(
    (c: Connection) => {
      if (mode !== 'schematic') return
      if (!c.sourceHandle || !c.targetHandle) return
      const a = parseHandleId(c.sourceHandle)
      const b = parseHandleId(c.targetHandle)
      if (!a || !b || sameEndpoint(a, b)) return
      addWire(a, b)
    },
    [addWire, mode]
  )

  // Schematic: drag a wire's end off its pin and drop it on another pin,
  // terminal or splice — the wire keeps everything but that end. Dropped
  // anywhere else, the end snaps back (React Flow's default).
  const onReconnect = useCallback(
    (edge: Edge, conn: Connection) => {
      const out = reconnectOutcome(edge, conn)
      if (out) reconnectWire(edge.id, out.end, out.to)
    },
    [reconnectWire]
  )

  // Reject only a self-loop on the exact same handle; everything else is valid.
  const isValidConnection = useCallback(
    (c: Connection | Edge) => !(c.source === c.target && c.sourceHandle === c.targetHandle),
    []
  )

  // Delete/Backspace in the schematic. Only placed bodies and wires are
  // deletable there — anything else would vanish from the view without the
  // document changing. React Flow adds the wires connected to a deleted body
  // itself; `onDelete` then mirrors the whole gesture into the document as ONE
  // undo entry (B5), so a body and its wires undo together. Formboard edges are
  // segments (layout, not electrical) and its node deletes stay in
  // `onNodesDelete` below.
  const onBeforeDelete = useCallback(
    async ({ nodes: ns, edges: es }: { nodes: FlowNode[]; edges: Edge[] }) =>
      mode === 'schematic'
        ? { nodes: ns.filter((n) => isSchematicBody(n.type)), edges: es }
        : { nodes: ns, edges: es },
    [mode]
  )
  const onDelete = useCallback(
    ({ nodes: ns, edges: es }: { nodes: FlowNode[]; edges: Edge[] }) => {
      if (mode !== 'schematic') return
      removeElements({ bodyIds: ns.map((n) => n.id), wireIds: es.map((e) => e.id) })
    },
    [removeElements, mode]
  )

  // What the shell reaches in for. `selectById` defers to the next re-seed
  // because the node it names does not exist in the projection yet — the add
  // that produced it has only just hit the document. Selecting something that
  // IS already drawn needs no handle: the shell owns the selected-id set and
  // pushes it to both panes.
  useImperativeHandle(
    handleRef,
    () => ({
      centerFlowPos: () => screenToFlowPosition(canvasCenterScreenPt()),
      screenToFlowPos: (pt) => screenToFlowPosition(pt),
      selectById: (id) => {
        pendingSelectRef.current = id
      },
      addAtCenter: (kind) => addAt(kind, canvasCenterScreenPt())
    }),
    [screenToFlowPosition, canvasCenterScreenPt, addAt]
  )

  return (
    // Capture phase: focus must move to this pane BEFORE React Flow's own
    // pointer handlers change its selection, or the shell would gate that
    // change out as coming from the pane it does not yet consider focused.
    //
    // Middle button pans (React Flow, `panOnDrag={[1]}`); preventing its
    // mousedown default stops Chromium's autoscroll cursor from starting too.
    // React Flow's pan is d3-zoom on `mousedown.zoom`, and it still runs:
    // preventDefault does not stop propagation, and d3-zoom's mousedown
    // handler never checks `defaultPrevented`.
    <div
      className="app__canvas"
      ref={canvasRef}
      onPointerDownCapture={() => {
        // A box that never saw its pointerup (cancelled, lost capture) must
        // not leave edges unselectable: every new press starts clean.
        boxSelectingRef.current = false
        onFocus()
      }}
      onMouseDownCapture={(e) => {
        if (e.button === 1) e.preventDefault()
      }}
    >
      <ReactFlow
        className={mode === 'formboard' ? 'rf-formboard' : undefined}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        // Connections are only made in schematic. Disabling connectability in
        // formboard removes wire-making there AND lets a drag grab the node
        // body (not the handle), so branch points/connectors move easily.
        nodesConnectable={mode === 'schematic'}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChangeBoxed}
        // Canvas gestures: left-drag on empty canvas draws a selection box
        // (anything it touches is selected — Partial), middle-drag pans,
        // Shift/⌘/Ctrl-click adds or removes one element. Wheel zoom and
        // trackpad behaviour stay React Flow's defaults.
        selectionOnDrag
        panOnDrag={[1]}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        onSelectionStart={() => {
          boxSelectingRef.current = true
        }}
        onSelectionEnd={() => {
          boxSelectingRef.current = false
        }}
        onConnect={onConnect}
        // Formboard edges are limbs, not wires: they never reconnect.
        onReconnect={mode === 'schematic' ? onReconnect : undefined}
        isValidConnection={isValidConnection}
        onDragOver={(e) => {
          // Only claim the drop when it is a file drag on the formboard;
          // otherwise the browser default (and React Flow's own drag) stands.
          if (mode === 'formboard' && e.dataTransfer.types.includes('Files'))
            e.preventDefault()
        }}
        onDrop={onImageDrop}
        onNodeDragStart={(_e, node) => updateTableLeader(node)}
        onNodeDrag={(_e, node) => updateTableLeader(node)}
        onNodeDragStop={(_e, node, dragged) => {
          setTableLeader(null)
          commitDrag(dragged?.length ? dragged : [node])
        }}
        // Fallback only: React Flow fires this from the nodes-selection
        // rectangle, which is hidden (index.css), so group drags arrive via
        // `onNodeDragStop`'s `dragged` list above.
        onSelectionDragStop={(_e, dragged) => commitDrag(dragged)}
        onEdgeContextMenu={(e, edge) => {
          // Formboard: right-click a segment → menu to add a branch point at the
          // cursor (edge.id === segment id). Schematic edges (wires) get no menu.
          if (mode !== 'formboard') return
          if (!doc.segments.find((s) => s.id === edge.id)) return
          e.preventDefault()
          const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY })
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              {
                label: 'Add branch point',
                onClick: () => insertBranchPoint(edge.id, { x: flow.x, y: flow.y })
              }
            ]
          })
        }}
        onNodeContextMenu={(e, node) => {
          // Formboard: right-click a PICTURE → turn or mirror it, and reset
          // its position if it is pinned. Orientation is independent of the
          // pin, so this menu is offered on an auto-placed picture too.
          if (mode === 'formboard' && node.type === 'pictureBlock') {
            e.preventDefault()
            const picId = node.id.slice('pic:'.length)
            const pinned = (node.data as { pinned: boolean }).pinned
            const view = doc.drawing.blocks?.pictureView?.[picId]
            const items: MenuItem[] = [
              { label: 'Rotate 90° CW', onClick: () => rotatePicture(picId, 90) },
              { label: 'Rotate 90° CCW', onClick: () => rotatePicture(picId, -90) },
              { label: 'Rotate 15° CW', onClick: () => rotatePicture(picId, 15) },
              { label: 'Rotate 15° CCW', onClick: () => rotatePicture(picId, -15) },
              { label: 'Flip horizontal', onClick: () => flipPicture(picId, 'h') },
              { label: 'Flip vertical', onClick: () => flipPicture(picId, 'v') }
            ]
            if (view)
              items.push({
                label: 'Reset orientation',
                onClick: () => setPictureView(picId, { rotationDeg: 0, flipH: false, flipV: false })
              })
            if (pinned)
              items.push({
                label: 'Reset position (auto-place)',
                onClick: () => clearBlockPos('picture', picId)
              })
            setMenu({ x: e.clientX, y: e.clientY, items })
            return
          }
          // Formboard: right-click a pinned table / BOM / tolerance block →
          // give the planner it back. An auto-placed one has nothing to reset,
          // so it gets no menu at all rather than a dead item.
          if (
            mode === 'formboard' &&
            (node.type === 'pinoutTable' || node.type === 'bomBlock' || node.type === 'toleranceBlock')
          ) {
            e.preventDefault()
            if (!(node.data as { pinned: boolean }).pinned) return
            setMenu({
              x: e.clientX,
              y: e.clientY,
              items: [
                {
                  label: 'Reset position (auto-place)',
                  onClick: () =>
                    node.type === 'bomBlock'
                      ? clearBlockPos('bom')
                      : node.type === 'toleranceBlock'
                        ? clearBlockPos('tolerance')
                        : clearBlockPos('pinout', node.id.slice('tbl:'.length))
                }
              ]
            })
            return
          }
          // Formboard: right-click a branch point → break up a bundle
          // (disconnect each member wire) and/or remove a degree-2 bend.
          if (mode !== 'formboard' || node.type !== 'branch') return
          e.preventDefault()
          // Shared derived degree — a self-loop counts once (model/topology.ts).
          const incidentSegs = incidentSegments(doc, node.id)
          const incident = new Set(incidentSegs.map((s) => s.id))
          const items: MenuItem[] = []
          // One "Disconnect …" per wire of a bundle whose limb meets this point.
          const bundle = doc.bundles.find((b) => b.segmentIds.some((sid) => incident.has(sid)))
          if (bundle) {
            for (const wid of bundle.memberWireIds) {
              const w = doc.wires.find((x) => x.id === wid)
              if (!w) continue
              items.push({
                label: `Disconnect ${describeEndpoint(doc, w.ends[0])} → ${describeEndpoint(doc, w.ends[1])} (${w.color.base})`,
                onClick: () => disconnectWireAtBranch(wid, node.id)
              })
            }
          }
          // Remove a plain degree-2 bend (a Y-split fan-out is not removable here;
          // neither is a bend with a self-loop limb — the merge would dangle).
          if (incidentSegs.length === 2 && !incidentSegs.some(isSelfLoopSegment))
            items.push({ label: 'Remove branch point', onClick: () => removeBranchPoint(node.id) })
          if (items.length) setMenu({ x: e.clientX, y: e.clientY, items })
        }}
        onNodesDelete={(deleted) => {
          if (mode !== 'formboard') return
          const branchIds = deleted.filter((n) => n.type === 'branch').map((n) => n.id)
          if (branchIds.length) removeBranchPoints(branchIds)
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault()
          if (mode !== 'schematic') return
          const at = { x: e.clientX, y: e.clientY }
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: 'Add connector here', onClick: () => addAt('connector', at) },
              { label: 'Add free terminal here', onClick: () => addAt('terminal', at) },
              { label: 'Add splice here', onClick: () => addAt('splice', at) }
            ]
          })
        }}
        onPaneClick={() => {
          closeMenu()
          onPaneClick()
        }}
        // Only the focused pane answers Delete (see the `focused` prop): the
        // key handler is document-wide and the selection is shared.
        deleteKeyCode={focused ? ['Backspace', 'Delete'] : null}
        onBeforeDelete={onBeforeDelete}
        onDelete={onDelete}
        // React Flow defaults to 0.5–2×. At 1 mm = 1 px that is far too
        // little zoom to place cavities or read pin labels on the formboard,
        // and too little zoom-out to see a 2 m loom whole.
        minZoom={0.05}
        maxZoom={20}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        {gridVisible && <Background gap={gridMm} />}
        <Controls />
        <MiniMap pannable zoomable />
        {tableLeader && (
          <ViewportPortal>
            <svg className="table-leader" style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
              <line
                x1={tableLeader.from.x}
                y1={tableLeader.from.y}
                x2={tableLeader.to.x}
                y2={tableLeader.to.y}
              />
              <circle cx={tableLeader.to.x} cy={tableLeader.to.y} r={3} />
            </svg>
          </ViewportPortal>
        )}
      </ReactFlow>
      {menu && (
        <div className="ctxmenu" style={{ left: menu.x, top: menu.y }}>
          {menu.items.map((it, i) => (
            <button key={i} className="ctxmenu__item" onClick={it.onClick}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
