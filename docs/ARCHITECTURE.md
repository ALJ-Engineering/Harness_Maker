# Architecture — orientation for a new session

_Written 2026-08-24 from a four-agent audit of HEAD `e3700e2`; updated after the session-11
fix batch (B1–B5), on 2026-08-27 for the **PDF drawing set**, and on 2026-08-28 for the
**unified 1:1 drawing set**, on 2026-08-28 for **formboard dot bodies + part pictures**
(692 tests green, branch `feature/formboard-dot-bodies`), and on 2026-08-29 for the **parts
library** (760 tests, 43 files, branch `feature/parts-library`, after its final-review fix wave),
and on 2026-10-16 for the **dark shell** (820 tests, 46 files, branch `feature/dark-shell`:
the CSS token layer, `shell/` — `AppShell` + `HarnessPane` + floating chrome — and theme-aware
wire colours; see "Theming" below).
This is the **durable code
map**: how the app works and where things live. For intent/rationale, read `docs/harness-editor-spec.md`.
Update this file only when the architecture itself changes._

_Numbering note: the "session N" tags below follow `docs/ARCHITECTURE.md`'s own per-branch
count — sessions 13–15 here are the four feature branches STATUS groups under its
"Session 12" heading. The PDF drawing set is STATUS's session 13 and is tagged by name,
not by number, to avoid compounding the drift._

## What this is, in one breath

An Electron + React 19 + TypeScript wire-harness editor producing manufacturing-grade
formboard drawings (**one** PDF: the drawing set — ONE fixed 1:1 drawing sheet at the chosen
A4–A0 paper or 914 mm plotter roll, then A4-landscape BOM / Wiring Table / Cutlist pages) plus a correct BOM/cut
list. React Flow draws the canvas;
Zustand + Immer hold the document; everything follows the two-layer rule: **electrical truth
and drawing geometry are separate, linked only by stable ids** (see `docs/harness-editor-spec.md`).

## Getting started

```bash
npm run dev        # Electron app with HMR
npm test           # vitest, node env, *.test.ts only (no DOM, no .test.tsx)
npm run typecheck  # tsc on BOTH tsconfigs (node = main/preload/shared, web = renderer/shared)
npm run build      # typecheck + bundle to out/

# 1:1 gate — needs poppler + Python 3 on PATH (Node, not bash, so both run on Windows too)
node scripts/probe-pdf-export.mjs [outDir] [paper] [orientation]   # real export of the demo doc
node scripts/check-pdf-scale.mjs <drawing-set.pdf> 1               # measure the 100 mm bar
```

- Test env is `environment: 'node'` — no DOM, no `window.api`, so UI components / IPC /
  `fileOps.ts` are untestable under the current vitest config (and the include glob excludes
  `.test.tsx`). Anything UI-flavoured is verified via `npm run dev` by hand.
- `src/shared/` is compiled by **both** tsconfigs: never import DOM types or Electron there.
- Path aliases (`@shared/*`, `@renderer/*`) are declared in **three** places: the tsconfigs,
  `electron.vite.config.ts` (renderer build only — main/preload get none, so they use relative
  imports), and `vitest.config.ts`.
- Dev-only debugging: `window.__harnessStore` exposes the store in the running app.

## The three layers, as built

| Layer | Collections | Rule |
|---|---|---|
| Electrical | `connectors`, `freeTerminals`, `splices`, `wires`, `cables` | never stores a position |
| Layout (mm) | `drawing`, `placements`, `branchPoints`, `segments`, `wireRoutes`, `bundles` | never stores connectivity; references electrical ids. Since 0.4.0 a `Placement.pos` is the formboard **dot centre** (the length datum), not a body's top-left corner |
| Annotations | `sleeving`, `twists`, `labels` | bridge: reference both, carry geometry |

Key shapes (`src/shared/model/schema.ts` — live source of truth; `docs/harness-schema.ts` is
the spec snapshot, currently **in sync**, but it is typechecked by nothing — keep them in sync
by hand):

- `Endpoint` = 4-way union `{cavity}|{splice}|{freeTerminal}|{shield}` — the hinge that lets a
  pin, splice, ring lug, and shield drain all terminate a wire.
- `Wire.ends: [Endpoint, Endpoint]` — a spliced run is TWO wires sharing a `Splice` endpoint.
- `RouteNode = {type:'branch'; branchId}|{type:'body'; refId}` — the only layout→electrical touch
  point, and since 0.4.0 it names a **body** (a `Placement.refId`: connector / free terminal /
  splice / cable), never a cavity. Keys `b:<branchId>` / `n:<refId>` (`geometry.routeNodeKey`,
  `endpoints.bodyKey`). One body = one dot = one limb per direction: cavity-level route nodes
  would have made four wires from one connector to one branch point into four coincident
  segments. Which cavity a wire lands in is still electrical truth in `Wire.ends`.
- `Placement` carries dual geometry: `pos` (physical/formboard **dot centre** — drives lengths)
  and `schematicPos` (view-only), plus `schematicExitSide`. `cavityExitSide` is **gone** (0.4.0):
  a dot has no sides, so the exit-side selector and `setExitSide`'s `'physical'` target are
  schematic-only now.
- `Label.anchor?: {segmentId, fraction}` — when present, the label bead is
  lerp(segment ends, fraction) and `pos` is ignored; the label slides only along its segment.
- Derived, never stored: nets (`nets.ts` union-find), splice/branch degree (`topology.ts` —
  ONE helper, see below), segment length,
  wire length (`wireLength`: `specified` ▸ `derived` = Σ segments + `max(0, addLengthMm)` ▸
  `unknown` — never 0), bundle membership (`syncBundles`).

## Code map

| Path | What lives there |
|---|---|
| `src/shared/model/schema.ts` | Types only. `SCHEMA_VERSION = '0.6.1'` (0.6.1 = additive `Segment.specifiedLengthMm?` — a limb's typed manufacturing length, which overrides its drawn length for every manufacturing output (see "Typed segment length" below); `serialize.ts` drops a non-finite / ≤ 0 / non-number value with an `invalid segment specifiedLengthMm dropped` note; no migration; 0.6.0 = the fixed drawing sheet — `PaperSize` gains `A0` and `Plotter` with `SheetConfig.lengthMm`, plus `DrawingConfig.sheetOrigin?`; 0.5.2 = additive `Placement.schematicPinOrderReversed?` — the schematic symbol mirrored top↔bottom, set by `setPinOrderReversed`; no migration; 0.5.1 = additive `Wire.coreName?` / `Wire.corePair?` — a cable core's library core name and pair label, set by `addCableFromPart`; no migration, older files load unchanged; 0.5.0 = `designator` on `FreeTerminal` and `Splice`, backfilled on load by `designators.ts`; 0.4.0 = body-keyed `RouteNode`, dot-centre `Placement.pos`, no `cavityExitSide`, `DrawingBlocks.picture`; **0.4.1** adds `DrawingBlocks.pictureView?: Record<Id, PictureView>` with `PictureView = { rotationDeg?, flipH?, flipV? }` — how THIS document shows a body's part photo. Purely additive, so a 0.4.0 file loads with no note and no migration; the `minor < 4` migration gate is unchanged) — the PDF drawing set added the typed `TitleBlock`/`Approval` and `DrawingConfig.sheet` (`DEFAULT_SHEET` = A3 landscape; the unified drawing set REMOVED `TEMPLATE_DEFAULT_SHEET` and added **`DrawingConfig.blocks?: DrawingBlocks`** = `{ pinout?: Record<Id, Vec2>; bom?: Vec2; picture?: Record<Id, Vec2> }`, pinned block top-lefts in model mm — `pinout` keyed by connector **or free-terminal** id, `picture` (0.4.0) by connector, free terminal **or splice**, since a splice owns a part picture but no pinout table); `parseDocumentWithNotes` migrates 0.1.0 documents (legacy `sheets[]` → `sheet`, legacy `Record<string,string>` `titleBlock` → the typed shape), validates `drawing.sheet` per field against `DEFAULT_SHEET`, drops a `blocks.pinout` / `blocks.picture` pin whose id names no owner (pinout: connector ∪ free terminal; picture: those ∪ splices) or whose coords are non-finite, with a `invalid drawing-block position dropped` note, validates `blocks.pictureView` the same way FIELD BY FIELD (unknown body, non-object entry, non-finite `rotationDeg` or non-boolean flip ⇒ that field dropped, same note) and runs what survives through `normaliseView` — a normalised angle or an entry that comes out IDENTITY is silently canonicalised, not reported, because absent IS identity, runs the **0.3 → 0.4 body-node migration** (see `serialize.ts` below), refuses a file whose schema MAJOR is newer than this build's, and reports what it changed through `LoadInfo.migrated` → `store.loadMigrations` → `migrated-on-load` DRC findings. `parseDocument` is the thin document-only wrapper. |
| `src/shared/model/document.ts` | `emptyDocument` / `demoDocument` / `brokenDemoDocument` (DRC test fixture). |
| `src/shared/model/anchors.ts` | **Anchor lookup + text metrics.** Since 0.4.0 there is no pin math left anywhere: a body is ONE dot, so the whole module is the font constants (`PT_TO_MM`, `MIN_FONT`, `LABEL_FONT`, `estTextWidthMm`) plus **`placementPos(doc, refId)`** — the dot centre, or null if unplaced. `connectorLayout` / `terminalLayout` / `spliceLayoutAnchor` / `PIN_PITCH` / `MIN_CONNECTOR` etc. are DELETED, and so is `endpointAnchor` (session 15: composing `endpoints.endpointBodyId` + `placementPos` left it with no production caller). Also **the single cavity DISPLAY order**: `natCompare` + `sortedCavities(connector)` (session 14) — every place that lists cavities (schematic `ConnectorNode`, panel cavity table, pinout table, BOM walk, DRC findings) goes through it, and it returns a COPY so stored order never changes. `placementPos` is what `formboard.ts` draws a dot at; `geometry.resolveNodePos` resolves the SAME point from a `RouteNode`, so the 1:1 print and the measured length agree by construction (`anchors.test.ts` asserts it). Imports only `schema` — never formboard/geometry (cycle). `formboard.ts` re-exports the font constants. |
| `src/shared/model/geometry.ts` | `routeNodeKey` (`b:<branchId>` / **`n:<refId>`**), `resolveNodePos` (body case = the body's `Placement.pos`, i.e. the dot), `segmentLengthMm` (always the **drawn** length — node to node), **`effectiveSegmentLengthMm`** (typed `Segment.specifiedLengthMm` ?? drawn — what every manufacturing output uses; `wireLength`, `spanLengthMm` and so `bundleLengthMm` sum it), **`segmentLengthBroken`** (typed and drawn ≥ `BROKEN_LENGTH_TOL_MM` = 0.5 mm apart — "no longer rounds to the typed value"; false when untyped or unresolved), `routeConnected`, `spanLengthMm`, `bundleLengthMm`, `wireLength`, `isValidLengthMm` (session 14 — the one predicate for hand-entered mm overrides: finite && ≥0; **0 is legal**, `undefined` means derive). |
| `src/shared/model/topology.ts` | **Derived degree, one definition** (session 14): `isSelfLoopSegment`, `incidentSegments`, `branchDegree`, `spliceWires`, `spliceDegree`. **degree = distinct incident edges; a self-loop counts ONCE.** Four sites used to derive it independently and two disagreed about self-loops. Used by `drc/index.ts`, `routing.ts` (`applyRemoveBranchPoint`), `store.ts` (`removeBranchPoints`), `flow/toFormboard.ts` (bend vs Y-split ⇒ `deletable`), `shell/HarnessPane.tsx` (branch context menu). Self-loops are not creatable through the store (a merge that would make one drops it) but can arrive in hand-authored JSON — DRC's `self-loop-segment` flags them, and every branch op refuses a bend with a self-loop limb (merging across one would dangle the segment on the deleted node). |
| `src/shared/model/rescale.ts` | **The rescale op** (session 25, typed segment length): `sideNodeKeys(doc, segId, toward)` (BFS over `doc.segments` minus S — never geometry, never wires — from the `toward` end; `'loop'` if the other end is reachable), `checkRescaleSegment` (dry run) and `applyRescaleSegment(draft, segId, toward)` → `RescaleResult` (`ok` / `loop` / `not-broken` / `unresolved` / `no-segment`). See "Typed segment length" under the routing ops. |
| `src/shared/model/routing.ts` | The bug-prone topology ops — see next section. 694 lines, 50 tests. |
| `src/shared/model/treatments.ts` | Span/anchor derivation: `twistSpanSegments`, `sleevingFromSegments`, `sleevingBundleFromSegments`, `projectFraction`, `defaultAnchor`, `anchorMmFromNearestEnd`. Plus **the one contiguity authority** (session 13): `largestContiguousRun` (cursor walk over shared route nodes; dead/repeat ids break the chain) and `isSpanContiguous` — used by BOTH the store guard and DRC, so "is this a legal Span?" is answered in exactly one place. |
| `src/shared/model/reconcile.ts` | **`reconcileDocument(doc) → {doc, repairs}`** (session 15) — the ONE load-time repair pass. Pure: composes the existing heal helpers over a freshly parsed document (drop refs to missing entities → `pruneDanglingBranchLabels` → `reconcileLabelAnchors` → `healSpans` → `syncBundles`) plus the R1 cable policy, and reports each change as `Repair {kind, entityId, message}`. Input never mutated; a clean document comes back BY REFERENCE with `repairs: []` (so a clean file loads un-dirty and round-trips byte-identically). `healSpans` is scoped to spans that actually LOST a segment — run doc-wide it would also silently "fix" a non-contiguous span of live segments, which is `non-contiguous-span`'s call, not a repair. Everything judgement-shaped is deliberately left to DRC: dangling wire endpoints, `Wire.cableId` → missing cable, non-contiguous spans, self-loops, invalid lengths, and orphaned/under-connected branch points and splices (a degree-0 branch point stays and keeps reporting `branchpoint-degree`). Runs on LOAD ONLY — never on an edit. |
| `src/shared/model/formboard.ts` | **`computeFormboard(doc, bom = computeBom(doc)) → FbLayout`** — the ONE mm layout that drives both the formboard canvas and the 1:1 SVG (view == print by construction). Since 0.4.0 a placed connector / free terminal / splice is one **`FbBody { id, kind, pos, label, labelPos }`**: a filled dot of radius `BODY_DOT_R = 1.8` at `placement.pos` with its label offset by `BODY_LABEL_OFFSET` — the same glyph a branch point uses, so the builder sees one kind of node. `bodyLabel(name, items)` makes `C2 [14, 15]` = designator + the **BOM item numbers** of the body's parts, which is why this model module imports `export/bom.ts` (`computeBom` + `bomItemsForParts`): a deliberate, recorded layering exception — the label is display data, the BOM is where item numbers are assigned, and duplicating the numbering would be worse. The `bom` parameter exists so a caller that already computed one (the print path) does not pay for it twice. |
| `src/shared/model/designators.ts` | Body reference designators (session 21). `DESIGNATOR_PREFIX` (`X` / `T` / `SP`), `nextDesignator(prefix, taken)` (**lowest free** number — the store uses it for all three prefixes), `allDesignators(doc)`, and `backfillDesignators(doc)` (the 0.4 → 0.5 load migration). Duplicates are flagged by the `duplicate-designator` DRC rule; ids are never derived from designators. |
| `src/shared/model/bodyParts.ts` | Which `PartRef`s a placed body owns — ONE definition, used by the body label and by the picture planner. `bodyKindOf`, `bodyPartNumbers` (housing/part first, then contacts, seals, plugs; deduped), `primaryPartNumber` (the part a photo is keyed by). Imports `schema` + `anchors` only. |
| `src/shared/model/` (rest) | `endpoints.ts` (`endpointHandleId` = the React Flow handle id **in the schematic only** now; plus the body-node helpers `bodyKey(refId)` → `n:<refId>`, `bodyNode`, `endpointBodyId` (the placed entity a wire end lands on — connector for a cavity, the terminal / splice itself, the cable for a shield) and `endpointBodyKey`), `describe.ts`, `colors.ts` (IEC→hex, hex-validated), `nets.ts`, `serialize.ts` (lenient parse, backfills missing arrays, validates `drawing.sheet`, gates the schema major, reports migration notes — and owns the **0.3 → 0.4 migration** `migrateToBodyRouteNodes`: move each `Placement.pos` from the old body's top-left to the dot centre the old pin layout implied (`legacyBodyAnchor`, which reconstructs it from the dropped `cavityExitSide` and the cavity count), re-key every route node from `endpoint` to `body`, coalesce the segments that became coincident, and drop any that became a self-loop. Notes: `placement moved to body dot centre`, `cavityExitSide dropped (formboard bodies are dots)`, `route nodes migrated to body keys`, `coincident segments coalesced (n → m)`, `self-loop segment dropped`), `ids.ts`, **`pictureView.ts`** (0.4.1: `IDENTITY_VIEW` / `normaliseView` / `isIdentityView` — pure, imports `./schema` only; `print/picture.ts` re-exports them for the drawing callers). |
| `src/shared/print/` | **The PDF page builders — pure, DOM-free, no Electron.** `sheet.ts` (`SheetMm`, `Rect`, **`sheetMm(cfg)`** (paper → mm; computes Plotter from `lengthMm` × `PLOTTER_ROLL_WIDTH_MM` = 914, landscape = length horizontal; replaced `paperSizeMm`), `frameRect`, `PAGE_MARGIN=10`, `TEMPLATE_MARGIN=8`, **`DOCUMENT_PAGE_SHEET`** = A4 landscape — print code, not user data, so it lives here and not in the model), `text.ts` (`PT`, `fmt`, `escapeXml`, `svgText`, and the **em-table text metrics** `estimateTextWidthMm`/`fitText`/`wrapText` — there is no DOM to measure with, so every column width is estimated), `tables.ts` (`Column`/`Row`/`TableStyle`, `tableWidth`, `rowHeight`, `paginateRows`, `renderTable`), `tableData.ts` (document → `TableSpec`: `bomSheetTable`, `bomPageTable`, `wiringTable`, `cutlistTable`, `connectorPinouts` — `wiringTable` appends, after the plain-wire rows and per cable in `doc.cables` order, one row per core (`coreWireIds`) and the drain wire (referenced only by `shield.drainWireId`): conductor `<cable>.<coreName>` (colour name when `coreName` is absent; the drain is `<cable>.drain`), `twistedWith` = the other cores of the same cable sharing `corePair`, emitted only for wires whose `cableId` equals the cable's id (a wire without it already prints as a plain row — a legacy drain must not print twice), conductor PN = the cable's PN, length `with cable`, notes `core of`/`drain of <cable>`, drain `from` is always the shield side; the cut list is unchanged — the wiring/cutlist adapters join the cut list on **`CutRow.sourceId`**, never on position, so their own `doc.wires` walk cannot silently drift out of step with `computeCutList`'s; BOM `Description` is single-line `fitText`-clipped in v1), `titleBlock.ts` (`renderTitleBlock`, `PrintBranding`, `TITLE_BLOCK_W=150`/`_H=30`), `frame.ts` (`renderPageFrame`, `renderFooter`, `wrapPage`, `HEADER_H=20`, `FOOTER_H=6`; the header's value column is derived from the sheet width so it cannot run under the logo on A4 portrait — page 1 has NO header, only a footer, because its title block already carries the same fields), `pageModel.ts` (`Page`/`PageSet`), **`board.ts`** (**`planBoard(doc, sheet, layout?, images?) → BoardPlan`** — THE 1:1 board plan, all model mm at scale 1. It places **two** kinds of block, pinout tables and **part pictures**, in one pass ordered *pinned tables → pinned pictures → unpinned tables → unpinned pictures* (`placeBlocks`): pinned blocks (from `drawing.blocks`) are taken verbatim and treated as obstacles, unpinned ones get the candidate/push-out search. A candidate is offset from the **union of the body's dot rect and its label rect** (`bodyRect` / `bodyLabelRect`, both exported for tests) — the dot alone would have made the chosen side depend on how long the designator is — and the preferred side is `awaySide(body, layout)`, the side pointing away from the body's incident segments, so a block never lands on the limbs leaving the dot. `plan.pictures` holds the placed picture blocks — each sized with the document's **`drawing.blocks.pictureView[bodyId]`** (normalised; carried on `PlacedBlock.view`, absent for the identity), because a turned photo has a different bounding box and a block sized upright would print outside its own frame — and **`plan.bodiesWithoutPicture`** the bodies whose primary part has no image (the export dialog's info line, never a warning). The obstacle machinery is the one inherited from the deleted `drawingSheet.ts` (`collides()`, `CLEARANCE`, and **wire runs + run labels as obstacles** — a run is a LINE tested by Liang–Barsky against the candidate rect inflated `WIRE_CLEARANCE`, never its AABB, which for a long diagonal would reject everything), the BOM block below the harness (then the sheet's free corners). **There is ONE fixed sheet, no tile grid**: `sheetRect` = the printable area at `contentOrigin = doc.drawing.sheetOrigin ?? framedSheetOrigin(layout)` (the harness-only bbox minus `TEMPLATE_GUTTER`; `sheetOrigin` is pinned by `setDocument` on open/new and the CLI never writes it, so the sheet never moves when anything is dragged), and the title block sits in the bottom-right corner of `sheetRect`. Unpinned blocks are placed INSIDE the sheet (`placeBlocks`/`planBom` take `bounds`; a candidate that crosses the edge may be slid on by `clampInto`, at most `MAX_CLAMP_SHIFT` = 50 mm; if nothing fits the block stays beside its body and is flagged). **One placement pass** (the title-block rect is an obstacle from the start; the old two-pass nudge is gone). Nothing is ever accommodated: whatever lies outside `sheetRect` is flagged, not drawn onto extra paper. Also owns `sheet` on the plan (so a renderer cannot be handed a mismatched one), `sheetRect`, `framedSheetOrigin`, `TEMPLATE_GUTTER`, `TILE_STRIP_H`, `WIRE_CLEARANCE`, `MAX_CLAMP_SHIFT`, `BOM_BLOCK_ID`, `printableSize`; warnings `table-overlap:<id>` / `table-over-wire:<id>` (both cover **pictures as well as tables**) / `title-block-over-content`, none of which is ever printed, and **`outside-sheet:<body|branch|segment|label>:<id>`** / **`outside-sheet:block:<pinout|picture|bom>:<id>`** (tested by drawn EXTENT, one warning per entity — body: dot rect + designator label rect; branch: the dot; segment: either end or its gauge/length (or wire-count) label rect; label: its text rect, plus the bead of an anchored label; block: its rect not inside the sheet; the BOM's code is `outside-sheet:block:bom:bom`). `sheetFindings.ts` (`outsideSheetFindings(warnings, doc)`) turns those into DRC `Finding`s (`ruleId: 'outside-sheet'`, warning; bodies, branch points and segments carry a ref, labels and blocks none; an unknown block kind gets a generic message). Known limitations: a square part picture on the demo's X1 finds no clear spot on A3 and is flagged; an outside-sheet finding for a cable does not jump on click (`drcJump` has no cable target); the plan is computed twice per document change (AppShell findings + the canvas). **`picture.ts`** (the part-picture block, its sizing AND the view helpers: `PartImage {href, pxW, pxH}` / `PartImages` = photos **by part number**, `PICTURE_W = 30`, `PICTURE_MAX_H = 30`, `IDENTITY_VIEW` / **`normaliseView`** (angle → [0, 360), identity keys dropped, so `{}` IS the identity and JSON equality is view equality) / `isIdentityView` **re-exported** from `model/pictureView.ts`, where they are DEFINED — the loader and the store canonise a view too, and a model file must not import the print layer to do it, `pictureBlockSize(image, view = IDENTITY_VIEW)` → `{w, h, imgH, iw, ih}`: width is fixed, so a rotation changes the HEIGHT — the photo's unit box is turned by θ and its bounding box `(|cos| + ih·|sin|, |sin| + ih·|cos|)` is scaled to 30 mm, then shrunk again if that would pass `PICTURE_MAX_H`; the quarter turns use EXACT trig (`Math.sin(Math.PI)` = 1.2e-16 would otherwise size a half-turned block 4e-15 mm taller than an unturned one) and the unit aspect is CLAMPED to `[PICTURE_MIN_IMG_H / PICTURE_W, PICTURE_W / PICTURE_MIN_IMG_H]` (changes no real photo; keeps a `pxH` of 0/negative/NaN from dividing the scale by zero once turned, and a `pxW` of 0 from collapsing the drawn photo to a sliver). `iw`/`ih` are the PHOTO's own drawn size, not the block's. `renderPictureBlock(size, image, caption, view)` — frame, `<image>`, `fitText`-clipped caption; an identity view emits exactly the markup it always did (no transform group, so the canvas≡print `toBe` test stays byte-for-byte), a non-identity one wraps the image in ONE `translate(w/2 imgH/2) rotate(θ) scale(sx sy)` group about the centre of the frame's image area. SVG applies a transform list RIGHT TO LEFT, so the scale acts in the PHOTO's own axes and the rotation then turns the result — `flipH` on a photo already on its side reads as a vertical mirror on screen, and the panel thumbnail's CSS `rotate(...) scale(...)` composes identically. The pad comes off the FRAME in both paths: the photo box is shrunk until its ROTATED bbox fits `w - 2p` by `imgH - 2p`, so a flip or a half turn paints the photo at exactly the size the identity view does (insetting the photo's own axes instead cost a height-capped portrait ~7 % the moment it was flipped). The constants live HERE and `board.ts` re-exports them: `board.ts` needs `pictureBlockSize` to reserve a rect, so the other direction would be an import cycle. The image is never fetched or decoded here — `href` is a `parts-image://` URL on the canvas and a `data:` URI in the print window, and `pxW`/`pxH` only give the aspect), `drawingSet.ts` (**`buildDrawingSet(doc, drawingSheet, branding, images = {}) → DrawingSetOutput { parts, pageCount, warnings, bodiesWithoutPicture }`** — `images` is the only way a picture reaches the print path; plus `pictureInfoLine(n)`, the "n bodies have no picture" line the export dialog shows as INFO — part 0 = the ONE 1:1 drawing page at `drawing.sheet`, part 1 = BOM + Wiring + Cutlist at `DOCUMENT_PAGE_SHEET` (A4 landscape), `Page N of M` continuous across both; plus `warningsCentre(warnings)`, the one-line UI summary, which counts every `outside-sheet:` code into `⚠ n item(s) outside the drawing sheet — choose a larger sheet or move them`), `template.ts` (`renderBoardPage(doc, plan, branding, layout, {pageNoStart, pageCount}) → Page` — the paper comes from `plan.sheet`; ONE page, id `drawing`, with the plan's blocks and the title block drawn in CONTENT space inside a nested `<svg>` whose viewBox starts at `contentOrigin` and spans the printable area, so anything outside is clipped off the sheet; no registration marks or overlap bands; `TEMPLATE_GUTTER=15` / **`TILE_STRIP_H=13`** keep their names, are DEFINED IN `board.ts` and merely re-exported here — the strip's first row is the PAGE-SPACE `<g class="scale-bar-page">` 100 mm check bar; strip captions `Drawing` and `1:1 — verify scale bar = 100 mm · Page N of M`), `html.ts` (`pageSetToHtml(set, title)` → the single printable HTML string, `@page { size: Wmm Hmm; margin: 0 }`, and a `<title>` → Chromium's `/Title`). |
| `src/shared/export/` | `svg.ts` (**`renderDrawingGroup(layout, {textScale, scaleBar})` → the `<g>` body reused by BOTH PDF outputs**; `documentToSvg` survives as an internal/test-only whole-file renderer — there is no SVG export action any more), `bom.ts` (`computeBom` — length-based parts report Σ metres with `partialLength` undercount flag; cable cores skipped; `Bundle.part` → a `loom tape` line, length = `bundleLengthMm` = Σ of the bundle's segments; `computeCutList` — one row per non-core wire + one per cable, each carrying `sourceId` (the Wire/Cable id) as the adapters' join key; **not** emitted in `cutListToCsv`), `html.ts` (self-contained report), (`tiling.ts` is deleted: nothing paginates the drawing any more). |
| `src/shared/drc/` | `runDrc(doc, catalog?)` — **22 rules** (listed below). |
| `src/shared/parts/catalog.ts` | `PartCatalog { resolve(pn) }` seam, its 6-entry `StubCatalog`, and the live implementation **`LibraryCatalog(parts: LibraryPart[])`** — `resolve` stays synchronous because the parts-library listing already loaded the whole folder into memory before `LibraryCatalog` is constructed: the listing itself IS the prefetch cache the old note asked for, so a live adapter needed no signature change to `runDrc` after all. `LibraryCatalog.part(pn)` also exposes the full `LibraryPart` (cavity template etc.) for callers that need more than a `CatalogEntry`. |
| `src/shared/parts/librarySchema.ts` | The parts library's own record schema — separate from the harness schema on purpose (a document must never depend on the library). `LIBRARY_VERSION` (**1.1.0**: a `cable` record may carry `cable: { cores: LibraryCableCore[] {name, color, stripes?, gauge, pair?}, shield?: {drain}, jacketColor? }`; parsed LENIENTLY like connectors, so a cable record with no cores still loads — the harness CLI enforces ≥1 core), `PART_KINDS` (11 kinds), `LibraryPart`/`LibraryCavity`, `refOf(part) → PartRef` (the only shape a document ever receives from the library), `newLibraryPart(kind, pn)`, `serializeLibraryPart`, and the hand-written **`parseLibraryPart(text, expectedStem?)`** (mirrors `parseSettings`: never throws, returns `{part} | {error}`, drops unknown keys, requires `partNumber`/`kind`/`description`, rejects a `connector` kind with no `connector.cavities`, rejects duplicate cavity positions, and — the trip hazard below — rejects a record whose `sanitisePartNumber(partNumber)` disagrees with `expectedStem`). `TERMINAL_KINDS`/`SPLICE_KINDS`/`GENDERS` hand-duplicate the unions imported from `model/schema.ts` for validation (deferred: no keep-in-sync comment yet). |
| `src/shared/parts/search.ts` | `searchParts(parts, query, {kinds?})` — pure, whitespace-split AND-of-terms over `partNumber \| description \| manufacturer`, ranked (part-number prefix ▸ part-number substring ▸ elsewhere), ties by part number. Backs both `PartPicker` and `LibraryDialog`'s search box. |
| `src/shared/parts/instantiate.ts` | Library record → document entity, and back — pure (ids and the resolver are injected, so it is tested without the store or Zustand). `instantiateConnector(part, designator, resolve, newId)` builds cavities from `LibraryCavity[]`, resolving each `defaultPin`/`defaultSeal` PN through `resolve` into a full `PartRef` via `refOf`, falling back to a bare `{partNumber}` if the resolver can't find it (DRC then flags it as unresolved rather than the instantiation silently dropping it). `instantiateFreeTerminal`/`instantiateSplice` are the terminal/splice equivalents. The inverse — `partFromConnector`/`partFromFreeTerminal`/`partFromSplice` — builds the `LibraryPart` a document entity implies (used by `Save to library…`), reading cavity order through `sortedCavities` (`anchors.ts`) so the template matches the panel's displayed order. |
| `src/renderer/src/store.ts` | Zustand+Immer document store. `applyEdit(recipe)` is THE atomic undoable primitive; history = whole-doc snapshot refs (Immer structural sharing), limit 200; `dirty = doc !== savedDoc` (reference compare, so undo-to-saved clears dirty).
`setDocument(doc, path, load?: LoadInfo)` — `LoadInfo = {repairs, onDiskDoc?}`: when a
load-time reconcile changed something, the UNREPAIRED document becomes `savedDoc`, so the
same reference compare makes the load dirty (saving will rewrite the file). `loadRepairs`
holds the repairs until a save / new document / `dismissLoadRepairs()`.
`setBlockPos(move: BlockMove)` / `clearBlockPos(kind, id?)` pin and un-pin a drawing block in
`doc.drawing.blocks` (one undoable edit each; no history entry for an unchanged value or an
unknown id), and `commitGesture` gained **`blockMoves`** so a drag of a table together with a
connector is ONE history entry. **`BlockKind = 'pinout' | 'bom' | 'picture'`** since 0.4.0 — a
picture block pins exactly like a table. **`setPictureView(bodyId, patch)` / `rotatePicture(bodyId, deltaDeg)` /
`flipPicture(bodyId, axis)`** (0.4.1) merge into `drawing.blocks.pictureView` — one undoable
edit each, no history for an unknown body or a merged view that normalises to the stored one,
and the identity view is DELETED rather than stored (with the emptied `pictureView` map and
`blocks` object). Orientation is independent of the pin: an auto-placed picture can be turned,
and `clearBlockPos('picture', id)` leaves the angle alone.
`setExitSide(connectorId, side)` is **schematic-only** (it lost its `target` argument with
`cavityExitSide`). **`addWire` creates no segment and no route when both ends resolve to the
SAME body** — a jumper between two cavities of one connector has no limb to draw, so DRC's
`unrouted-wire` reports it as a **warning** ("jumper within one body — set a specified length
(mm)"), cleared by `specifiedLengthMm`; two DIFFERENT bodies with no route stay an error.
**ONE LIMB = ONE SEGMENT** (session 15 final review, C1): when both ends DO resolve to two
different bodies, `addWire` routes through **`existingOrNewSegment(d, ba, bb, newSegId)`** —
the segment already joining that unordered node pair if there is one, a fresh one otherwise —
then calls `syncBundles`, so a second wire between X1 and X2 shares the one limb and the limb
becomes a bundle. It used to push a new segment every time: two coincident lines, two stacked
length labels on the 1:1 print, `bundle` never true, and insert-branch-point splitting only
one of them. `removeWires`' segment GC is the matching half — a segment dies only when the
LAST wireRoute (and bundle) referencing it is gone.
**Parts-library actions** (all single undoable edits via `applyEdit`, `refOf(part)` from
`librarySchema.ts` the only shape a library record contributes to a document): `addCableFromPart(part, name, cores, drain?)` (one undo step: a `Cable` from a library cable record, one core `Wire` per entry with `cableId` set and routed through `existingOrNewSegment` like `addWire` — both share an internal `addWire` draft helper — and the drain as a `cableId` wire kept OUT of `coreWireIds`, referenced only by `shield.drainWireId`; a drain is accepted on ANY record with a shield block — `shield.drain` only means the record has a dedicated drain strand and supplies the drain's gauge/colour defaults — and refused without one or when a core is itself named `drain`; the drain has no route, and `ruleUnroutedWire` skips a wire with `cableId` plus a `shield` end on that same cable; returns the cable id or `null` on a refused input) / `addConnectorFromPart(pos, part, resolve)` / `addFreeTerminalFromPart(pos, part)` /
`addSpliceFromPart(pos, part)` push a new body built by `instantiate.ts`'s
`instantiateConnector`/`instantiateFreeTerminal`/`instantiateSplice` plus its `Placement`, same
`cascade` as the plain `addConnector`/`addFreeTerminal`/`addSplice`. `applyCavityTemplate(connectorId, part, resolve)` refuses (returns `false`, no history entry) if
any of the connector's current cavities is referenced by a wire — cavities carry wires, so
overwriting the list is only safe when none is wired yet — otherwise replaces
`housing`/`cavities`/`gender` from a fresh `instantiateConnector` call and returns `true`.
`refreshPartRefs(catalog)` walks every `PartRef` in the document (housings, cavity pin/seal/
plug, terminal part/seal, splice part, wire spec, cable part, bundle part, sleeving part,
branch tie), rewrites `description`/`manufacturer` from whatever the catalog resolves, and
does a dry run first so a no-op refresh pushes no history entry (return value is the count of
refs actually changed). |
| `src/renderer/src/App.tsx` | **Three lines.** `export { AppShell as default } from './shell/AppShell'` — the entry point `main.tsx` imports, and nothing else. Everything that used to live here is in `shell/`. |
| `src/renderer/src/main.tsx` | React root + `ErrorBoundary`. Sets `document.documentElement.setAttribute('data-theme','dark')` BEFORE the first render, so there is no light flash while `useTheme` fetches the persisted value. The only site that imports `index.css`. |
| `src/renderer/src/shell/AppShell.tsx` | **The shell** (`feature/dark-shell`, 523 lines): document/dirty/undo state, the menu-action listener, `usePartImages` + `usePartsLibrary`, the DRC findings memo (load repairs + migrations prepended as `info` findings), dismissal, the export/library modals, and the **selection**. It renders `TopChrome`, one or two `HarnessPane`s, `BottomBar`, the `PropertiesPanel` inspector card and the `DrcPanel` popover. **There is no toolbar** — the docked header is gone; adds are the canvas context menu, files are the native File menu. **The shell owns the authoritative canvas selection** (`paneSelection` + the memoised `selectedIds` set) and pushes the same set to BOTH panes, so one click selects in both; `selection = treatmentSel ?? paneSelection` is what the inspector reads. Only the FOCUSED pane's `onSelectionChange` is believed (`activeSideRef`), because a pane whose projection has no element for an id reports a smaller selection that would otherwise wipe the pane that CAN draw it. `focusedPane` is **reset to `'left'` whenever the split closes** — see trip hazard 18. Split arbitration: `panes` (store) decides how many panes render; `activeSide` clamps to `'left'` when `split` is off; `jumpViews` orders the DRC jump focused-pane-first. Helpers defined here: `findingKey`, `highlightIds` (per pane, per mode), `selectionIds`, `sameSelection` (CONTENTS, never identity — identity compare makes the report/push cycle never settle). |
| `src/renderer/src/shell/HarnessPane.tsx` | **One canvas** (`feature/dark-shell`) — a `ReactFlowProvider` wrapping `HarnessPaneInner`, **one provider per pane** because React Flow scopes viewport, zoom and node measurement to it, which is what lets the two panes pan independently. `useReactFlow` has exactly one call site, inside this file. Owns `nodes`/`edges`, the `flow` projection memo, the re-seed effect, `commitDrag` (a thin caller of the pure `shell/dragGesture.ts` `dragOutcome`: branch merge-on-drop within 10 mm, formboard only ▸ label anchor projection ▸ plain position commit), the canvas gestures (box select, middle pan — see below), `onConnect`, edge-delete → `removeWires`, the image drop, both context menus and the pinout leader line. Props: `mode` (`PaneView`), `doc`, `parts`, **`theme`**, `highlighted`, `treatmentSelected`, **`selectedIds`**, `onSelectionChange`, `onPaneClick`, **`onFocus`** (fired on `onPointerDownCapture`, so focus moves before React Flow's own handlers change the selection), **`focused`** (only the focused pane binds `deleteKeyCode` — see Canvas gestures). Memoise `highlighted` and `selectedIds` — both are effect dependencies and a fresh Set re-seeds the canvas. Handle: `centerFlowPos` / `screenToFlowPos` / `selectById` (arms `pendingSelectRef` for the next re-seed, for a just-added element). There is no `selectExisting` any more: the DRC jump writes the SHELL's selection and both panes read it back. Three invariants live here and each has already cost a bug — see the boundary section below and trip hazards 18–19. |
| `src/renderer/src/shell/chrome/` | The floating chrome. Both strips are `pointer-events: none` with each control opting back in, so the canvas keeps the space underneath. `TopChrome.tsx` — the file chip (part number or file base name, `•` when dirty), the `REV x` badge, a parts-search button, and **one `ViewPicker` per VISIBLE pane**. The file chip is INERT (its dropdown is branch 2); New/Open/Save/Save As are the native File menu with their accelerators, which is why deleting the docked header stranded nothing. `ViewPicker.tsx` — a chip opening a menu of the views with a `✓` on the current one, writing only its own side; its `VIEWS` table is where branch 2's Parts/Connections views land. `BottomBar.tsx` — a DISABLED Add button (branch 2), the DRC chip (error/warning dot counts, plus an `info` dot and `chip--attn` when `repairCount > 0`, which is the only visible signal that a loaded file was repaired/migrated — the notice itself is in the DRC popover's header and that is closed by default), the stats chip (`docStats`), the Single/Split segmented control, the theme toggle and Export. |
| `src/renderer/src/shell/stats.ts` | **`docStats(doc)`** → `{wires, totalLengthMm, sheetLabel}` for the bottom bar's chip. Pure, node-testable (`stats.test.ts`). A cut row with `lengthMm: null` contributes 0, never `NaN`. **Not free** — it runs `computeCutList` — so `BottomBar` memoises it on `doc`. Known population mismatch (deferred): `wires` is `doc.wires.length` and counts cable cores, while `computeCutList` excludes cores from `totalLengthMm`. |
| `src/renderer/src/shell/drcJump.ts` | **`refFlowTarget(doc, ref, viewMode)`** and **`resolveJumpTarget(doc, ref, views)`** — which React Flow element a DRC finding stands for, **per view**. Extracted from the shell precisely so the mode-dependent branches are unit-testable (`drcJump.test.ts`, 11 tests, mutation-checked): a branch point is a formboard node and `null` in the schematic; a wire is a schematic edge and `null` on the formboard; a segment the reverse; a cavity resolves to its owning connector's node. `resolveJumpTarget` takes the visible views focused-pane-first and returns the first that can draw the ref, so a finding that resolves only in the other pane still jumps, and one that resolves in neither is a no-op rather than a selection nothing displays. The same function backs the DRC panel's greying-out, so what looks clickable is exactly what works. |
| `src/renderer/src/useTheme.ts` | **`useTheme()`** → `{theme, setTheme, toggleTheme}`: the UI theme, mirrored onto `<html data-theme>` in an effect and persisted through `window.api.getTheme/setTheme` into `userData/settings.json`. Starts `'dark'`, so there is no light flash before the stored value arrives; a `userChosenRef` guard stops an in-flight `getTheme()` from clobbering a toggle that happened while it was resolving. **`currentTheme()`** reads the attribute back for render paths too deep to prop-thread — but note it is only correct AFTER the effect has run, so any component whose colours depend on the theme takes it as a PROP (`PropertiesPanel`) or through the projection (`WireEdge`), never by calling `currentTheme()` in its own render body. Today `currentTheme()` survives only as `WireEdge`'s fallback for a projection built without a theme. |
| `src/renderer/src/flow/screenColors.ts` | **The screen-only wire colour.** `screenStroke(base, theme)` = `strokeForColor(base)` (the print colour, `shared/model/colors.ts`, untouched) lifted to `DARK_WIRE_BLACK = '#e8e9ec'` when the theme is dark and the stroke's relative luminance is below `NEAR_BLACK_LUMINANCE = 0.18` — BK would otherwise vanish into `--canvas-bg`. `relativeLuminance` is the unweighted sRGB sum, NOT the gamma-corrected WCAG formula (do not confuse the two when computing contrast ratios for the token layer). **Print never imports this module**: exactly two renderer consumers, `WireEdge` and `PropertiesPanel`'s swatches. `FormboardSegmentEdge` deliberately keeps `strokeForColor` and its `#999` bundle grey — it draws on the white sheet. `DARK_WIRE_BLACK` duplicates the `--wire-black` token in `index.css` on purpose (this module is loaded by a node-env test with no DOM, so it cannot read a CSS variable); each definition carries a comment naming the other. |
| `src/renderer/src/index.css` | The single stylesheet, imported once (`main.tsx`). Opens with the **theme token layer** — see "Theming" below. 47 custom properties, ~166 `var()` uses. |
| `src/renderer/src/usePartsLibrary.ts` | **`usePartsLibrary() → PartsLibrary`** — mirrors `usePartImages`: lists the whole folder into memory (`{dir, parts, byPn, datasheets: Set<stem>, errors}`), re-listing on mount, `settings:changed`, `library:changed`, and window `focus` (a colleague may have pushed to the shared folder), plus after every mutation (the `after(promise)` helper). Exposes the memoised **`catalog: LibraryCatalog \| undefined`** (`undefined` with no folder set, so `runDrc`'s `stale-or-unresolved-partref` rule stays off on a fresh install) and the mutation callbacks (`write`, `remove`, `importDatasheet`, `openDatasheet`, `removeDatasheet`, `chooseDir`). `Listing`'s type is derived as `Awaited<ReturnType<typeof window.api.libraryList>>` rather than importing `LibraryListingDto` by name, because `env.d.ts` ends in `export {}` and so is a module whose interfaces are not visible outside it. **Deferred perf note:** `catalog` is keyed on `listing.parts`, a fresh array every refresh, so its identity — and therefore the DRC findings memo that depends on it — changes on every window focus even when nothing in the library changed; fine at library/document sizes seen so far, worth a stable content key if it shows up in profiling. |
| `src/renderer/src/LibraryDialog.tsx`, `LibraryPartForm.tsx` | The parts-library browser + editor (NOT under `panel/` — top-level renderer components). `LibraryDialog`: left pane search box + kind filter + result list (`searchParts` over `library.parts`, PN/description + picture/datasheet glyphs), right pane detail for the selection (picture via `PictureRow`'s image lookup, fields, a read-only cavity table for connectors, `Open datasheet`) plus `New…`/`Duplicate`/`Delete`/**`Place on board`** (calls `store.add*FromPart` at the viewport centre for `connector \| terminal \| splice` kinds only, then closes). With no library folder set it collapses to a single `Set the parts library folder…` button; `library.errors` renders as a collapsible list so a corrupt file is visible, not silently dropped. `LibraryPartForm` is the one place a `LibraryPart` record is authored — kind-specific fields (gender/mates-with/cavity template for connectors, kind/stud for terminals, kind for splices, gauge/colour for wire), the `PictureRow` and datasheet buttons, and `Save`/`Cancel`; switching `Kind` reseeds the kind-specific block via `newLibraryPart` while carrying description/manufacturer/datasheet/notes forward. `LibraryDialog` wraps `library.write` with the duplicate-part-number and empty-part-number checks before calling `onSave`. |
| `src/renderer/src/flow/` | Node/edge components + the two pure projections: `toFlow.ts` (schematic: placements + wires as bezier edges; no branch points/labels — cavity handles live here, `endpointHandleId`) and `toFormboard.ts` (`documentToFormboard(doc, branding = {}, images = {})` — a thin mapping over `computeFormboard`, plus the **board furniture** from `planBoard`. Every `FbBody` becomes ONE **`formboardBody`** node (`FormboardBodyNode.tsx`; `FormboardConnectorNode.tsx` is deleted) with `origin: [0.5, 0.5]` so the dot AND its single handle — id **`n:<refId>`**, whatever cavity the wire lands in — sit on the model coordinate, and a drag commits `node.position` straight back as the placement. The dot's label is drawn at a **screen-only** offset (`BODY_LABEL_OFFSET` is print mm and would start under the 6 px screen dot). Board blocks: one `formboardSheet` node with the reserved id **`__sheet`** (the ONE fixed sheet: paper edge, printable-area outline, the title block, and a `⚠ n` warnings badge; it sits at `sheetOrigin` and never moves), one `pinoutTable` node **`tbl:<connectorOrFreeTerminalId>`** per planned table, one **`pictureBlock`** node **`pic:<bodyId>`** per planned picture and one `bomBlock` node **`__bom`**, each drawn with the SAME `renderTable` SVG the print path uses — the canvas and the PDF are the same pixels, asserted with `toBe` in `toFormboard.test.ts`. `SheetNode.tsx` / `BlockNode.tsx` render them (`BlockNode` draws tables, the BOM block and pictures alike — it is handed finished SVG); Right-clicking a `pictureBlock` opens the ORIENTATION menu (`shell/HarnessPane.tsx onNodeContextMenu`) whether or not it is pinned — ±90°, ±15°, *Flip horizontal* / *vertical*, *Reset orientation* (only when a view exists) and *Reset position (auto-place)* (only when pinned); tables and the BOM block keep the pinned-only reset menu. `nearestBody.ts` answers "which dot was this file dropped on" (null past `maxMm`, so a drop on empty board is a no-op, not a surprise import); the sheet is `draggable/selectable/deletable: false` at `zIndex -10`, blocks are draggable at `zIndex 5`. `branding` is a parameter (`{ logoDataUri? }`) rather than an import: the app ships with **no logo of its own** (`src/renderer/src/branding.ts` and the bundled PNG are deleted, there is no `BRANDING` export) — the logo comes from the parts library folder (`<library>/branding/logo.svg`, else `logo.png`, else `logo.jpg`/`logo.jpeg`; svg preferred) and `shell/HarnessPane.tsx` passes `{ logoDataUri: parts.logo }`; tests pass nothing. No logo means the logo cell is left empty (there is no text fallback). |
| `src/renderer/src/panel/` | `PropertiesPanel.tsx` (per-entity editors + `CreateActions` gating + `TreatmentsList`; the formboard pin-exit-side selector is gone; **six** `PartRef` fields — housing, cavity pin, terminal part, splice part, wire spec, bundle tape — are now `PartPicker` rows fed by the panel-wide `library: PartsLibrary` prop; terminal seal, cable part, sleeving part and branch tie have no panel field yet, so they stay untouched), `PartPicker.tsx` (the combobox: type to search `library.parts` filtered to the field's valid `kinds`, arrow keys + Enter to pick a row which commits a full `PartRef` via `refOf`, Enter on free text commits a bare `{partNumber}` exactly as the old `TextEdit` did so nothing becomes impossible, `onMouseDown` + `e.preventDefault()` on each row keeps focus so the row commit runs before the input's `onBlur` — do not switch that to `onClick`; the resolved description shows greyed underneath), `PictureRow.tsx` (the part-photo row: thumbnail, *Add…* / *Replace…* / *Remove*, and the "no parts image folder set" state), `DrcPanel.tsx`, `fields.tsx` (commit-on-blur inputs = one undo step per edit). |
| `src/renderer/src/fileOps.ts` | `useFileOps` — open/save/export via `window.api`; **`buildExport(doc, sheet, images, branding)`** wraps `buildDrawingSet` with the `branding` it is given (`exportPdf` reads the logo fresh from `window.api.libraryLogoDataUrl()` at export time), and **`exportPdf(sheet, images)`** first re-points every picture at a `data:` URI (`withDataUris` + `parts:imageDataUrl`, only for the parts this document actually shows) because the hidden print window is a different `BrowserWindow` and Chromium will not fetch `parts-image://` from inside the printed document — an unresolvable href prints a blank frame; reads `getState()` so callbacks never go stale. **`skippedPictureLine(skipped)`** (session 15 final review) builds the `⚠ n picture(s) skipped…` line appended to the post-export alert when `parts:imageDataUrl` returned null for a picture the canvas showed (spec §5.3's promised >5 MB warning; the export dialog's summary is synchronous and cannot know file sizes). **`loadFromText(content)`** (session 15) is the pure open pipeline — parse → `reconcileDocument` → `LoadInfo` — split out of the callback so it IS testable in the node env (`fileOps.test.ts`). |
| `src/main/pdf.ts` + `src/main/pdfArgs.ts` + `src/main/pdfMerge.ts` | The PDF transport. `pdfArgs.ts` is deliberately **electron-free** so vitest can load it: `validateExportPdfArgs(unknown)` (1–4 `parts`, EVERY one with a string `html` and finite `widthMm`/`heightMm` in (0, `PLOTTER_MAX_LENGTH_MM` = 5000]) is the first statement of the handler, and `htmlFileNameFor` names the temp file (Chromium puts the loaded document's file name into the PDF `/Title`). `pdfMerge.ts` is electron-free too: `mergePdfs(Uint8Array[])` concatenates the parts with **`pdf-lib`** — `copyPages` clones each page dictionary MediaBox included, so the 1:1 drawing page comes out exactly the size Chromium made it (measured), and part 0's `/Title` is carried over by hand because the Info dict is NOT cloned. `pdf.ts` registers `doc:exportPdf`: validate → save dialog → `renderExportToPdf` → write. **`renderExportToPdf(args)` renders the parts SEQUENTIALLY** through `renderPartToPdf` (one hidden window at a time, closed before the next opens — the print path is fragile, see the trip hazards) and merges them; a single part is returned unmerged. `renderPartToPdf` is: hidden `BrowserWindow` (`show:false`, `sandbox:true`, `contextIsolation:true`, `javascript:false` — the print HTML is static SVG) → **`loadFile` from a `mkdtemp` temp dir, always** → `printToPDF({ pageSize: mm/25.4, margins:'none', printBackground:true, preferCSSPageSize:true })` → `close()` the window → `rm` the temp dir in a nested `finally`. Two Electron behaviours are load-bearing here and are commented in the file: `win.destroy()` (not `close()`) after `printToPDF` wedges the NEXT export with `ERR_FAILED` and kills the process with SIGTRAP; and a `data:` URL over ~2 MB fails `ERR_INVALID_URL`, which is why there is no data-URL path at all. |
| `src/main/settings.ts` | `SettingsFile` over `userData/settings.json`. Since the parts library: `Settings { partsLibraryDir?: string }` — **`partsImageDir` is REMOVED, with no backwards compatibility**: an old settings file with `partsImageDir` simply parses as "no library set" (`parseSettings` only reads `partsLibraryDir`), and existing pictures must be moved into `<lib>/images` by hand. `LIBRARY_SUBDIRS = { parts, images, datasheets }` and **`imageDirOf(s) = s.partsLibraryDir ? join(s.partsLibraryDir, LIBRARY_SUBDIRS.images) : undefined`** live here too — the one place "where do pictures live" is answered, called from `partsImagesIpc.ts`. Electron-free (the path is injected), so it is unit-tested. `patch()` merges and writes (non-atomic — deferred minor). Agent access adds `mcpEnabled?: boolean` and `mcpPort?: number` (integer 1–65535, else dropped) with `DEFAULT_MCP_PORT` = 47100 / `mcpPortOf(s)`, read by both the app and `harness mcp`. |
| `src/main/partsLibrary.ts` | **The parts library on disk, electron-free** (tested against tmp dirs like `partsImages.test.ts`): `ensureLibraryDirs(dir)` (creates `parts/ images/ datasheets/`), `listParts(dir) → {parts, datasheets: Set<stem>, errors}` (reads every `parts/*.json` through `parseLibraryPart`, one bad file → an `errors` entry, never thrown; joins `datasheets/*.pdf` stems in the same pass so the renderer needs one call), `readPart`/`writePart` (validate-then-atomic-write, `.tmp` → `rename`), `deletePart(dir, pn, {withFiles})`, `importDatasheet(dir, pn, srcPath, maxBytes = DATASHEET_MAX_BYTES)` (stat-then-copy, `%PDF-` header check via `partsImages.ts`'s `readHeader`, 50 MB default cap), `datasheetPath`/`removeDatasheet`. Every path derived from a part number goes through `insideDir` (realpath + basename guard, same shape as `resolveImageFile`); every WRITE additionally goes through **`writableSubdir(dir, sub)`**, which `mkdir`s the subfolder then realpath-verifies it still resolves inside `dir` before `writePart`/`importDatasheet` touch it — added in a fix round because the read-side guard alone let a symlinked `datasheets/` pointed outside the library become a write target. |
| `src/main/partsLibraryIpc.ts` | The Electron half of the library: `chooseLibraryDir(win?)` (folder picker → `ensureLibraryDirs` → `settings.patch({partsLibraryDir})` → broadcasts BOTH `settings:changed` and `library:changed`) and `registerPartsLibraryHandlers()`, which wires the eight `library:*` **invoke** channels (`getDir`, `chooseDir`, `list`, `writePart`, `deletePart`, `importDatasheet`, `openDatasheet`, `removeDatasheet` — IPC table below) and calls `broadcast('library:changed')` after every mutating one so every open window re-lists; counting that M→R broadcast, nine `library:*` channels exist in total. Imports `settings` from `partsImagesIpc.ts` (one `SettingsFile` instance, shared) rather than constructing its own. |
| `src/main/partsImages.ts` | **The parts image library, electron-free** (hence testable): `resolveImageFile` (realpath + basename guard — a stem may not escape the configured folder, symlinks included), `readHeader(path, bytes = 128 KiB)` (session 15 final review — `open()` + one bounded `read()`; a header sniff must not pull a folder of DSLR JPEGs into the main process; reused by `partsLibrary.ts`'s datasheet `%PDF-` check), `listImages(dir)` → `{ stem: {pxW, pxH, mtimeMs} }` keyed by FILE STEM (sizes off `readHeader`, not the whole file), `importImage` (stat before read, 5 MB cap, copies to `<stem>.<ext>`), `removeImage`, `imageDataUrl` (5 MB cap enforced by `stat` BEFORE the `readFile`), `resolveForPart`. Sizes come from `imageSize.ts`, which reads PNG/JPEG headers only — no image decoder. Callers now pass `imageDirOf(settings)` (`settings.ts`) rather than a raw `partsImageDir` field. |
| `src/main/partsImagesIpc.ts` | The Electron half: the **`parts-image://`** protocol (registered `standard` + `secure` BEFORE `whenReady`, else Chromium ignores it; `protocol.handle` resolves the stem out of the URL path with a `decodeURIComponent` try/catch → 404), the `parts:*` handlers, and the `settings:changed` broadcast to every window. Every handler resolves its folder via **`imageDirOf(await settings.read())`** — there is no more direct `partsImageDir` field access. Hrefs are **`parts-image://img/<stem>?v=<mtimeMs>`** — see trip hazard 15. `parts:chooseImageDir` is **DELETED** (no more direct image-folder picker): `Settings ▸ Parts library folder…` in `menu.ts` calls `chooseLibraryDir` (`partsLibraryIpc.ts`) instead, which creates all three library subfolders and tolerates having no focused window (on macOS the app outlives its windows). |
| `src/shared/parts/images.ts` | `sanitisePartNumber` (everything outside `[A-Za-z0-9._-]` → `_`; this is the file stem for pictures, datasheets AND now `parts/<stem>.json` records), `imageHref`, `PARTS_IMAGE_SCHEME` — shared because the renderer keys its lookup with the same function main names files with, and `partsLibrary.ts` / `librarySchema.ts` reuse it as the ONE stem function for the whole library folder, not just pictures. |
| `src/main/` + `src/preload/` (rest) | Electron shell + context-isolated bridge. See IPC table. |
| `src/main/mcp/` + `src/renderer/src/mcp/` + `src/shared/mcp.ts` | **The in-app MCP server** (Settings ▸ Agent access): agents edit the open document live. See "MCP server". |
| `src/cli/` + `scripts/build-cli.mjs` | **The headless `harness` CLI** — creates/edits `.harness.json` files and library records through the store, refusing incomplete parts and wrong pinouts. See "CLI" below. |

## The store ↔ React Flow boundary (read this before touching HarnessPane.tsx)

React Flow holds **view state** (selection, hover, live drag). The store holds **truth**.
The bridge is the re-seed effect in `shell/HarnessPane.tsx` (~line 195): on any doc/mode change it
recomputes the whole projection and rebuilds nodes/edges, carrying `selected` forward **by id**.
Continuous gestures never touch the store — only `onNodeDragStop → commitDrag` and blur-commits
write back, each as one `applyEdit`.

**Which half owns what** (since the canvas left `App.tsx` on `feature/dark-shell`): the PANE owns
`nodes`/`edges`, the re-seed and every canvas handler; the SHELL owns the document,
`treatmentSel` and the **authoritative selected-id set**. Selection flows **up and back down** —
the pane derives a `Selection` from its own nodes/edges and reports it through
`onSelectionChange`, the shell stores it once and pushes the same `selectedIds` set to BOTH panes,
which apply it in the re-seed. That round trip is what makes one click select in both panes, and
it settles in one lap only because the shell compares **contents** before storing
(`sameSelection`): a pane rebuilds its `Selection` object on every re-seed, so an identity compare
would push a fresh set down, re-seed, report again, and never reach a fixed point. The inspector
reads `treatmentSel ?? paneSelection`. Treatments (sleeving/twist/label) are not RF entities:
they live in the shell's `treatmentSel`, mutually exclusive with node/edge selection, and drive a
`data.highlighted` flag (orange halo) on member nodes/edges via the `highlighted` prop, which the
shell resolves per pane with `highlightIds(doc, treatmentSel, mode)`.

Only the FOCUSED pane's report is believed. An unfocused pane whose projection contains no element
for some id (a branch point is not a schematic node) applies less than it was given and reports
that smaller selection; taken at face value it would clear the selection in the pane that CAN draw
it. A user-driven change always begins with a pointerdown, which focuses the pane first — hence
`onPointerDownCapture`, on the capture phase, ahead of React Flow's own handlers.

Four rules hold this together. **Each of them has already cost a bug; none of them is
cosmetic.**

1. **`HarnessPane` must keep exactly ONE effect that writes node/edge selection** — the re-seed
   (`HarnessPane.tsx:264`, the only caller of `setNodes`/`setEdges` with a `selected:` field). Its
   precedence is: a pending-select id (an add) ▸ nothing at all while `treatmentSelected` ▸ the
   shell's `selectedIds`. The treatment-clear used to be a second, standalone effect, and then the
   outcome hinged on **declaration order**: the panel's `CreateActions` edits the document AND
   selects the new treatment in ONE handler, so both effects landed in the same commit and
   "+ Sleeving" silently left the wire selected and dropped the treatment. Folding the rule into
   the one effect removes the ordering entirely. Neither exclusivity rule may become a standalone
   `useEffect` — the other direction (canvas → treatment) lives in the shell's `onSelectionChange`
   callback, for the same reason.
2. **The pane's `selection` must stay a `useMemo` on `[nodes, edges]`** (`HarnessPane.tsx:305`).
   THAT, not effect ordering, is what makes treatment exclusivity work: selecting a treatment makes
   the pane drop its own selection, and a plain computation here would re-report the STALE
   non-empty selection on the next render, which the shell would read as "the user picked a wire"
   and use to drop the brand-new treatment again. The memo is the thing that makes the report fire
   only when the selection actually changed. The effect at `:316` that calls `onSelectionChange` is
   a READER — it never writes selection — and that is why rule 1 still says "exactly one".
3. **No `HarnessPane` may be keyed on anything** — not on `theme`, not on `mode`, not on the pane
   side. See trip hazard 18; this one shipped as a renderer crash.
4. **The re-seed applies the shell's set only when that set CHANGED, and drops the report it
   made stale.** Two refs in `HarnessPane` carry this: `appliedRef` (the `selectedIds` /
   `treatmentSelected` pair the re-seed last applied) and `staleReportRef` (the `Selection`
   object of the render whose view the re-seed just replaced). When only the projection changed
   (an edit, a re-listed image folder, a theme toggle) the pane's live React Flow selection is
   kept. When the shell's set did change, that render's report describes a view that is being
   overwritten in the same commit, so the report effect returns early and the next render reports
   what is actually shown. Without both, a projection change landing between React Flow's select
   commit and the shell's re-render made the re-seed apply the shell's PREVIOUS set while the
   report sent the click up, and each commit then undid the last, one commit out of phase, until
   React threw error #185 and the ErrorBoundary took the renderer. It was intermittent and looked
   like "clicking a connector sometimes crashes the app". The same lag was behind the
   mount-focused-pane crash rule 3 and trip hazard 18 describe; this closes it rather than
   starving it of triggers. Reproduced deterministically over CDP by toggling the theme a few ms
   after an in-page click (4/4 crashes on `dev/v1` before the fix); see STATUS session 20.

**Canvas gestures** (both panes, `feature/box-select`): left-drag on empty canvas draws a
selection box (`selectionOnDrag`, `SelectionMode.Partial` — anything the box touches), middle-drag
pans (`panOnDrag={[1]}`; `.app__canvas`'s `onMouseDownCapture` prevents the middle-button default
so Chromium's autoscroll does not start alongside — React Flow's pan is d3-zoom listening on
`mousedown.zoom`, which still runs, because `preventDefault` does not stop propagation and d3-zoom's
mousedown handler never checks `defaultPrevented`), Shift/⌘/Ctrl-click toggles one element
(`multiSelectionKeyCode`), wheel/trackpad stay React Flow's defaults. Three things make the box
fit this app, each checked by breaking it in the running app:
- **The box selects nodes only.** React Flow also selects every edge touching a boxed node; those
  would join the `multi` report and Delete would take the wires/limbs. `onEdgesChangeBoxed` drops
  edge `select: true` changes while `boxSelectingRef` is set — set in `onSelectionStart` (which
  React Flow calls before the box's first selection change; its own `userSelectionActive` is set
  after it), cleared in `onSelectionEnd` and on every pointerdown.
- **React Flow's nodes-selection rectangle is hidden** (`.react-flow__nodesselection
  { display: none }` in `index.css`). Over the selected nodes' bounds it swallowed every click, so
  Shift-click could not take one item back out, and it focused itself so arrow keys moved nodes in
  view state only, never committed. Dragging any selected node still moves the whole selection
  (`onNodeDragStop`'s `dragged` list → `commitDrag` → `dragOutcome`, one undo entry; with the
  rectangle hidden `onSelectionDragStop` no longer fires and is kept only as a harmless fallback).
  An anchored label dragged in a group is projected onto the POST-move segment (the drag's node
  moves are applied to a copy of the doc first), so it keeps its fraction instead of sliding.
- **The `__sheet` node is `selectable: false`** (and `pointer-events: none`), so the box never
  picks the page and a press on the page is a press on the pane.
The box is just a React Flow selection change, so it rides the normal report/re-seed path above;
nothing in the selection sync was changed for it.

**Delete belongs to the focused pane only.** React Flow's delete key handler listens on
`document`, and both panes are handed the same `selectedIds`, so with both bound a formboard box
over bodies made the SCHEMATIC pane delete those bodies and their wires (formboard bodies are
`deletable: false`, so the formboard itself deletes nothing). `HarnessPane` takes a `focused` prop
(`AppShell`'s `activeSide`) and passes `deleteKeyCode={focused ? ['Backspace', 'Delete'] : null}`.

Known behaviour, not fixed: **Shift is both the multi-select key and React Flow's
`selectionKeyCode`**, so Shift+left-drag that starts ON a node draws a box instead of dragging,
and holding Shift blocks the middle-button pan. Middle-button autoscroll suppression on
Windows/Linux is an **open manual check** — macOS has no middle-click autoscroll and Playwright
cannot show it.

Position queries cross the boundary through `HarnessPaneHandle`, not props: `useReactFlow` only
works inside the pane's provider, so a library "Place on board" add goes through the ref. The DRC
jump does NOT — it writes the shell's selection and lets both panes read it back, because an
imperative write into an unfocused pane would be gated out and strand the inspector.

**Pane state is a VIEW preference in the store, not document data** (`feature/dark-shell`):
`panes: {split, left, right}` with `setPaneView(side, view)` / `setSplit(split)`. Like
`gridVisible`/`gridMm` they use the plain `set`, never `applyEdit`, so they push no history entry
and never make the document dirty; they are not persisted either. `setViewMode` is GONE —
`PaneView` (`'schematic' | 'formboard'`, widened in branch 2) replaced it.

Only `setDocument` / `newDocument` / the pane and grid preferences bypass history — everything
else funnels
through `applyEdit`. `mergeBranchPoints` / `disconnectWireAtBranch` / `removeBranchPoint`
pre-check feasibility so a failed gesture pushes no empty undo entry — preserve that pattern
(`insertBranchPoint` currently doesn't; known nit).

## Routing ops and the five reference classes

Any topology change must keep these consistent: **(1)** `wireRoutes[].path` (ordered,
directional ends[0]→ends[1]), **(2)** `bundles[].segmentIds` (unordered/document order),
**(3)** sleeving/twist `span` (ordered + start/end fractions), **(4)** `labels[].target`,
**(5)** `labels[].anchor` (`segmentId` + `fraction`, flip-aware) — plus segment/branch-point GC.

| Op (`routing.ts`) | Gesture | Calls `syncBundles` / `reconcileLabelAnchors`? |
|---|---|---|
| `applyInsertBranchPoint` | right-click segment → add branch point (splits it, orientation-aware fraction remap incl. reversed single-segment routes) | no / no — nothing vanishes |
| `applyRemoveBranchPoint` | delete a degree-2 bend (merges its two segments; span/anchor **fractions left verbatim** — documented limitation). Degree via `topology.incidentSegments`; refuses when either limb is a self-loop | no / no — spans stay contiguous by substitution (regression-tested) |
| `applyMergeBranchPoints` | drag branch point onto another (≤10 mm) — fuses them; parallel limbs coalesce into ONE shared segment = bundle authoring | yes / yes — plus `healSpans` |
| `applyDisconnectWireAtBranch` | context-menu "Disconnect …" — bypasses ONE branch point for one wire, keeps the rest of its route | yes (before segment GC) / yes — plus `healSpans` after the GC |
| `syncBundles` | derives Bundle entities = maximal connected runs of ≥2-wire segments; ids stable by max overlap (id + `name` + `part` inherited from the best-overlapping prior bundle); **the one place bundle ids change**, so it prunes bundle-targeted sleeving/labels | — |
| `reconcileLabelAnchors` | heals anchors whose segment vanished (re-derive via `defaultAnchor`, else drop the anchor, never the label) | — |
| `healSpans(doc, hadSegments?)` | the span counterpart (session 13, R3/R4): trims every sleeving/twist span to the **largest surviving contiguous run**, drops a `startFraction`/`endFraction` whose reference segment is no longer first/last, and REMOVES a treatment whose span the op emptied. Pair it with `spansWithSegments(doc)` captured BEFORE the op, so a span authored empty (the twist UI does that on purpose) is not mistaken for one the op emptied. | — |

`store.removeWires(ids)` (and `removeWire` = the single-id wrapper) runs the cascade in
`removeWiresFromDraft`: per-wire prunes (routes, wire-targeted sleeving/labels, twist members)
→ cable-core/drain prune (session 13, R1: a removed core leaves its `Cable`, and a cable
whose last core went is removed unless a surviving wire still names it) → `syncBundles` →
segment GC → `healSpans` → branch-point GC → `pruneDanglingBranchLabels` →
`reconcileLabelAnchors`. **Segment GC roots are wire routes + bundles ONLY** — never
sleeving/twist spans (session 13, R4): a segment is a layout edge whose existence follows the
wires through it, and rooting on treatments left wire-less "ghost" segments on the canvas.

`addSleeving` / `addTwist` return **`Id | null`**: they refuse a span that is not one
contiguous chain of live segments (session 13, R2) — a rejected span is a no-op that pushes NO
history entry, and the panel only selects what actually got created. The EMPTY span stays
legal. Batch gesture actions (session 11, B5): `removeBranchPoints(ids)`
(returns actual removals) and `commitGesture` (node + free-label + anchor moves, one edit) —
one user gesture is one undo entry. `setBundlePart(bundleId, part?)` (session 12) sets/clears a
bundle's loom tape — one undoable edit, no history entry for a missing id; the panel exposes it
under Segment info when the selected formboard segment belongs to a bundle.

`setWireLengthOverride(wireId, mm?)` / `setWireAllowance(wireId, mm?)` (session 14) are the
**validating boundary** for `Wire.specifiedLengthMm` / `Wire.addLengthMm`: both return
`boolean`, and a negative / NaN / non-finite value (or an unknown wire id) writes nothing and
pushes NO history entry. `0` is accepted — an explicit zero-length override, distinct from
`undefined` = derive from the route. A write of the value already stored succeeds silently
with no history entry. The panel's `NumberEdit` gained `min`/`max`, which bound what can be
SUBMITTED (out-of-range reverts), and both mm fields pass `min={0}`. Its decision is the pure
`panel/numberCommit.ts` `resolveNumberCommit` (session 25): `minExclusive` refuses `min` itself, a
partial entry (`validity.badInput` — `"-"`, `"1e"` report `value === ''`) reverts instead of clearing,
and an `onCommit` that returns `false` (the store refused) reverts the draft.

### Typed segment length (session 25, spec §3)

`Segment.specifiedLengthMm?` is a **layout-layer** length: the limb's real manufacturing length when
the user typed one. Cut list, wiring table, BOM length lines, sleeving / tape and the PDF all use
`effectiveSegmentLengthMm` (typed ?? drawn); `segmentLengthMm` stays the drawn length (geometry and
the broken check). `Wire.specifiedLengthMm` still wins over the route sum for that wire, and a wire
routed through typed segments stays `derived` on the cut list.

- **`store.setSegmentLength(segId, mm | null): boolean`** — the validating boundary: `mm` must pass
  `isValidLengthMm` AND be > 0; `null` deletes the key. Unknown id, refused value or unchanged write →
  `false`, no history entry (unlike `setWireMm`, unchanged is `false`).
- **Topology ops keep the effective length.** `applyInsertBranchPoint` splits a typed value in
  proportion to the two DRAWN pieces `|a−pos|` and `|pos−b|` (second half by subtraction, so the sum is
  exact; a half ≤ `SPLIT_EPS_MM` gets no key — a 0 is never stored). `applyRemoveBranchPoint` heals to
  `(typedA ?? drawnA) + (typedB ?? drawnB)` when either half was typed (untyped if a drawn half cannot
  be resolved). `applyMergeBranchPoints` keeps the canonical's value, else the first duplicate's; two
  different values → the canonical's wins, no finding (ruling).
- **`store.rescaleSegment(segId, toward: 'from' | 'to'): RescaleResult`** — dry-runs
  `checkRescaleSegment`, then ONE `applyEdit` on `ok`. `applyRescaleSegment` moves the `toward` end
  along S's own line by `typed − drawn`, and every route node on that side (`sideNodeKeys`) rigidly by
  the same vector `d`: branch points `pos += d`; placements freeze `schematicPos` first (as
  `applyNodePositions` does) then `pos += d`; that body's PINNED `drawing.blocks.pinout` / `picture`
  `+= d` (unpinned blocks are left to the planner, no block entries created); a FREE label moves when
  its target moved rigidly — a `branchPoint` target in the side, or a `branch` (segment) target whose
  both ends are in the side (never S itself). Anchored labels, spans, bundles and routes follow by
  reference. `sheetOrigin` never moves. Refusals write nothing.
- **Formboard label UI** (`flow/FormboardSegmentEdge.tsx`, `SegmentLengthLabel`): the edge's
  `source` / `target` are the segment's `from` / `to`, and its data carries `lengthMm` (effective),
  `specifiedLengthMm?`, `broken` and `segmentId`. Click the label → the length part becomes a
  `type="number"` input prefilled with the rounded effective length; Enter commits via
  `parseLengthInput` (`flow/lengthInput.ts`: empty → `null` = clear; a `badInput` partial entry, 0,
  negatives → cancel), Esc cancels, blur commits only a changed value. Every interactive element is
  `nodrag nopan` and stops pointerdown; the input stops key events (so Backspace/Delete never reach
  the pane). While `broken` the text is `#d32f2f` and two 8 px triangles sit on the limb axis either
  side of the label (placed from the label box, measured only while they show), each calling
  `rescaleSegment`; `loop` / `unresolved` raise a `window.alert`. The Properties panel's segment
  section shows "Drawn length" (read-only) and "Typed length (mm)" (`NumberEdit`, `min={0}
  minExclusive`), plus a hint while broken.
- **Print:** a broken single-wire segment label prints `fill="#d32f2f"` in `renderDrawingGroup`
  (literal, print path); bundle limbs print only the wire count, as before. DRC
  `segment-length-off-scale` flags each broken limb.

## Theming (read before touching a colour anywhere)

**The renderer is tokenised. `src/shared/print/` is not, and must never become so.**

`index.css` opens with the token layer: `:root` carries the **dark** values (dark is the DEFAULT —
there is no attribute to set for it) and `:root[data-theme='light']` overrides them. 47 custom
properties, ~166 `var()` uses. `main.tsx` writes `data-theme` on `<html>` before the first render;
`useTheme` rewrites it in an effect and persists the choice through `settings:getTheme` /
`settings:setTheme` into `userData/settings.json` (`Settings.theme?`, `themeOf(s)` = the stored
value or `'dark'`). React Flow's own chrome follows along because the `--xy-*` variables are
pointed at our tokens.

Three token ROLES, deliberately distinct — mixing them is the contrast bug this branch fixed twice:

- `--sev-error` / `--sev-warning` / `--sev-info` / `--accent` — the signal HUE, identical in both
  themes. Dots, borders, and the base of a 12 % tint.
- `--sev-*-text` — that hue tuned to read AS foreground text over a themed surface. Same as the
  signal hue in dark; darker, contrast-checked shades in light.
- `--info-solid` (`#1565c0`) — a SOLID fill under a FIXED foreground (`color: #fff` on a primary
  button). `--sev-info` (`#3b9cf5`) is ~2.9:1 against white and must not be used this way.

**The print path reads no token, ever.** No *production* file under `src/shared/` contains a
`var(--` token — `grep -rn "var(--" src/shared/ --include="*.ts" --include="*.tsx" | grep -v
'\.test\.ts'` returns nothing (the plain `grep -rn "var(--" src/shared/` returns 8 hits, but
they're all inside `drawingSet.test.ts`, the guard test that necessarily names the string it
forbids). Nothing under `src/shared/` imports `useTheme` or `screenColors`. The reason is not
tidiness: the printed sheet is white paper and the PDF is a manufacturing drawing that must look
the same on every machine, in every theme, forever. A token in `shared/print/` resolves against whatever
document Chromium happens to be printing, and the hidden print window defines no tokens at all —
so an undefined `var()` falls back to the CSS **initial** value for that property. Measured: a
`fill` falls back to BLACK (the text survives but changes colour), a `stroke` falls back to
**`none`** and the mark simply disappears — i.e. a line can vanish from a manufacturing drawing
with every other check green. `scripts/check-pdf-scale.mjs` does not notice (the scale bar measures
geometry) and neither did any unit test until this rule was given one.

**The guard is `drawingSet.test.ts`'s `no theme token reaches the print path`**, two tests:

- the **rendered** check builds a real drawing set (the drawing page + the A4 BOM / Wiring / Cutlist
  pages, a title block with a logo, pinout tables, the BOM block and a part picture) and asserts
  that no page's SVG — and no part's full `pageSetToHtml` output, which is the exact string
  Chromium loads — contains `var(`;
- the **source** check scans every production `.ts` under `src/shared/print/` and
  `src/shared/export/` for `var(`, because the demo document has no sleeving, twists, labels,
  branch points or bundles, so several drawing-group colour sites are never reached by any
  fixture.

Both match `var(` rather than `var(--`: `var( --ink )` is valid CSS and slips past the narrower
literal. Both were mutation-checked against five deliberate leaks — a `fill`, a `stroke`, one on
an unrendered code path in `export/svg.ts`, one in `html.ts`'s `<style>` block, and the whitespace
evasion — and each failed for the right reason before being reverted.

**What stays light on screen**, because it renders ON the white formboard sheet and the canvas
must keep matching the PDF. `documentToFlow` (schematic, dark canvas) emits only
`connector`/`freeTerminal`/`splice`/`wire`; everything else — `branch`, `label`, `formboardBody`,
`formboardSheet`, `pinoutTable`, `bomBlock`, `pictureBlock`, `formboardSegment` — comes from
`documentToFormboard`, i.e. from the sheet. These 14 selectors therefore keep their light-theme
literals and reference **no** token (verified by parsing `index.css`; re-run that check after any
CSS change):

`.node--branch`, `.node--branch-hl`, `.node--fb-dot`, `.node--fb-dot-selected`,
`.node--fb-dot__label`, `.node--label`, `.node--label-sel`, `.node--label-hl`,
`.node--sheet-warn`, `.node--block`, `.node--block-pinned`, `.node--block-selected`,
`.react-flow__node-formboardSheet`, `.table-leader` — **plus every `.rf-formboard` descendant
rule** (two today: `.react-flow.rf-formboard`, which paints the whole formboard pane white with literal `--xy-background-*` overrides so the sheet's marks never sit on the dark canvas, and `.rf-formboard .react-flow__handle`).

In TS the same split is: `WireEdge` and `PropertiesPanel`'s swatches use `screenStroke(base,
theme)`; `FormboardSegmentEdge` keeps `strokeForColor` and `#999` (and its length label's `#444` /
broken `#d32f2f` are inline literals; `.segment-length-input` in `index.css` only hides the spinner); `shared/export/svg.ts` and
`shared/print/tables.ts` keep `strokeForColor`. The theme reaches the canvas ONLY by riding in each
wire edge's `data` through `documentToFlow(doc, theme?)` — never by keying anything (trip hazard
18), and never by a `currentTheme()` call in a render body (trip hazard 19).

## IPC / `window.api` surface

The API shape is hand-duplicated in **three files that must stay in lockstep**:
`src/main/menu.ts` (MenuAction union), `src/preload/index.ts` (bridge), and
`src/renderer/src/env.d.ts` (`PreloadApi` — drift is silent until it type-errors).
`MenuAction`'s old `exportSvg` / `exportTemplate` are both gone: there is **one** PDF item.
File ▸ Export ▸ `Drawing set (PDF)…` (`exportDrawingSet`) / `BOM & Cut List (CSV)…`
(`exportBom`). The parts library added two more actions: `openLibrary` (⌘L, the top
chrome's parts-search button and the `Parts library…` menu item — opens `LibraryDialog` in
browse mode) and
`refreshPartRefs` (`Edit ▸ Update part descriptions from library`).

| Channel | Method | Purpose |
|---|---|---|
| `doc:open` (invoke) | `openDocument()` | open dialog + read; null on cancel |
| `doc:save` (invoke) | `saveDocument(path, content)` | write to known path |
| `doc:saveAs` (invoke) | `saveDocumentAs(content, defaultPath?)` | save dialog + write |
| `doc:exportFiles` (invoke) | `exportFiles(files, …)` | one dialog → writes `base + suffix` per file (BOM export = .html + -bom.csv + -cutlist.csv). The SVG export that used to ride this channel is **gone**. |
| `doc:exportPdf` (invoke) | `exportPdf({parts: {html, widthMm, heightMm}[], defaultPath?, title?})` | payload validated by `pdfArgs.ts` FIRST, then save dialog → one hidden window per part in turn → `printToPDF` → `mergePdfs` → returns the written path (null on cancel). One part per PAPER SIZE: Chromium prints a single page size per call, and the drawing set mixes the 1:1 drawing page with A4 document pages. |
| `doc:dirty` (send) | `setDirty(bool)` | feeds the main-process close guard (Cancel / Don't Save — there is no Save button) |
| `menu:action` (M→R) | `onMenuAction(cb)` | native menu → renderer dispatch; ⌘Z/⌘⇧Z accelerators live in the MAIN process menu, not a renderer keydown handler |
| `parts:getImageDir` (invoke) | `partsGetImageDir()` | the configured library folder's `images/` subfolder resolved via `imageDirOf`, or null |
| `parts:listImages` (invoke) | `partsListImages()` | the whole library as `{ stem: {href, pxW, pxH} }` — **keyed by file STEM**, hrefs already `?v=<mtime>`-stamped |
| `parts:importImage` (invoke) | `partsImportImage(partNumber, srcPath?)` | copy a photo into the library for a part; no `srcPath` ⇒ open dialog. `srcPath` is renderer-supplied (a dropped file) and is type-checked here and stat-checked in `importImage` |
| `parts:removeImage` (invoke) | `partsRemoveImage(partNumber)` | delete that part's photo |
| `parts:imageDataUrl` (invoke) | `partsImageDataUrl(partNumber)` | the photo as a `data:` URI — what `exportPdf` inlines for the print window |
| `parts-image://img/<stem>?v=<mtime>` (protocol) | — | how the CANVAS paints a photo. Not IPC: a privileged custom scheme served by `protocol.handle` |
| `library:logoDataUrl` (invoke) | `libraryLogoDataUrl()` | the title-block / page-header logo as a `data:` URI, or null. Implemented by `src/main/branding.ts` `logoDataUrl(libDir)`: looks for `<lib>/branding/logo.svg`, else `logo.png`, else `logo.jpg`/`logo.jpeg` (svg preferred), 2 MB cap, the bytes must match the extension, reads only inside `<lib>/branding`. The renderer gets it as `logo` on the `usePartImages` hook result (refreshed with the image listing) |
| `library:getDir` (invoke) | `libraryGetDir()` | the configured `partsLibraryDir`, or null |
| `library:chooseDir` (invoke) | `libraryChooseDir()` | folder picker → `ensureLibraryDirs` → persists `partsLibraryDir` → broadcasts `settings:changed` AND `library:changed` |
| `library:list` (invoke) | `libraryList()` | the whole library: parsed `parts: LibraryPart[]`, which stems have a datasheet (`string[]` over the wire, a `Set` in the renderer hook), and parse `errors: {file, error}[]` |
| `library:writePart` (invoke) | `libraryWritePart(part)` | validate (`parseLibraryPart`) then atomic write; `{ok: true} \| {error}` |
| `library:deletePart` (invoke) | `libraryDeletePart(partNumber, withFiles)` | removes the record, optionally its picture and datasheet too |
| `library:importDatasheet` (invoke) | `libraryImportDatasheet(partNumber, srcPath?)` | copy a PDF in as the part's datasheet; no `srcPath` ⇒ open dialog; `null` = cancelled/no library, `{error}` = rejected (not a file, no `%PDF-` header, over the cap) |
| `library:openDatasheet` (invoke) | `libraryOpenDatasheet(partNumber)` | `shell.openPath` on the guarded `datasheets/<stem>.pdf`, falling back to `shell.openExternal(datasheetUrl)` only for an `http(s)://` URL |
| `library:removeDatasheet` (invoke) | `libraryRemoveDatasheet(partNumber)` | deletes the datasheet file |
| `library:changed` (M→R) | `onLibraryChanged(cb)` | broadcast to every window after every mutating `library:*` call, so a picker/dialog open elsewhere re-lists |
| `settings:changed` (M→R) | `onSettingsChanged(cb)` | the library folder moved — every window re-lists |
| `mcp:call` (M→R) + `mcp:result` (send) | `onMcpCall(handler)` | **the one main → renderer request/response**: an MCP document tool call `{id, name, args}` to the document window, its `{id, outcome}` back. See "MCP server" |
| `mcp:ready` (send) | (inside `onMcpCall`) | true on subscribe, false on unsubscribe — main refuses calls at once while false |
| `settings:getTheme` (invoke) | `getTheme()` | the persisted UI theme, or `'dark'` on a fresh install (`themeOf`) |
| `settings:setTheme` (invoke) | `setTheme('dark' \| 'light')` | persist the UI theme. The handler coerces anything that is not exactly `'light'` to `'dark'` (deferred minor: worth a comment saying so) |
| (preload, rest) | `pathForFile(file)` | `webUtils.getPathForFile` — a dropped `File`'s real path, which the sandboxed renderer cannot read itself |

`parts:chooseImageDir` / `partsChooseImageDir` are **DELETED** — there is no direct image-folder
picker any more, only `library:chooseDir` for the whole library (which creates `images/`
alongside `parts/` and `datasheets/`, plus `branding/`, the fourth library subfolder).

## Load path

`open()` → `window.api.openDocument()` → **`loadFromText`** (`parseDocument` →
`reconcileDocument`) → `setDocument(doc, path, load)`. Reconcile runs EXACTLY here: after
deserialization, before the document becomes store state, and nowhere else. Repairs are
surfaced two ways, both non-blocking: the bottom bar's DRC chip (an extra info dot + a `chip--attn` outline; the
notice itself sits in the DRC popover's header, which is closed by default) and one `repaired-on-load` **info finding per repair**, prepended to
the DRC findings in `shell/AppShell.tsx` — they are NOT a DRC rule (they live in the store, not in
`doc`, so they survive edits until the file is saved). `findingKey` therefore includes the
message, so several ref-less findings of one rule dismiss independently.
`File ▸ New` / the initial demo document are not reconciled (both are clean by
construction; `reconcile.test.ts` asserts the demo produces zero repairs).

## DRC rules (22)

Errors: `unconnected-populated-cavity`, `splice-degree`, `branchpoint-degree` (both self-loop-safe
since session 14 — they use `topology.ts`), `self-loop-segment` (session 14: a segment whose two
ends resolve to the same route node), `unresolved-route-node` (session 15 final review: a
segment end naming a body id that is no connector / free terminal / splice / cable, or a
branch id that is no branch point — this is what finally reports the 0.3 → 0.4 migration's
deliberate `missing:<json>` sentinel, which until now made a limb silently lengthless), `invalid-specified-length` (session 14: a negative / NaN /
non-finite `Wire.specifiedLengthMm`, `Wire.addLengthMm` or `Cable.specifiedLengthMm`; 0 is legal),
`unrouted-wire` (**severity depends on the wire**: a wire whose two ends resolve to the SAME body is a
jumper with no limb to draw — `addWire` deliberately creates no segment for it — so it is a WARNING
asking for a `specifiedLengthMm`; two different bodies with no route stay an ERROR),
`shield-without-drain`, `dangling-endpoint`, `dangling-member` (cable cores/drain, twist and
bundle members, all span segment ids — and, since session 13, a wire whose `cableId` names a
missing cable), `dangling-label-ref` (label target + anchor references — added session 11),
`non-contiguous-span` (session 13: a sleeving/twist span that is not one chain; spans holding a
MISSING segment are skipped so `dangling-member` owns that report), `duplicate-designator`
(one finding per designator carried by two or more bodies across connectors, free terminals and
splices; `refs` = every body carrying it).
Warnings: `populated-without-pin`, `empty-cavity-wired`, `orphaned-route`, `segment-length-off-scale`
(session 25: one per segment whose typed length is broken — "Limb typed N mm but drawn M mm — press an
arrow on its label to rescale"; refs the segment; a structural rule, so `harness check` reports it too),
`gauge-mismatch-in-net`, `gauge-mismatch-in-group`, `stale-or-unresolved-partref` (catalog-gated:
`runDrc(doc, catalog?)` only runs this rule when a catalog is passed. Since the parts library,
`shell/AppShell.tsx` passes `library.catalog` — a live `LibraryCatalog` when a folder is set, `undefined`
otherwise — instead of `defaultStubCatalog()`, so the rule is finally checking against real
parts on any machine with a library configured, and stays silently off on a fresh install with
no library, exactly as it did against the stub before).
Info: `colour-mismatch-in-net`, `empty-span` (session 13 — info, not a warning: a treatment with
no segments is a legal authoring intermediate, the twist UI creates one deliberately).

## Test coverage map (820 tests, 46 files — `feature/dark-shell` added
`flow/screenColors.test.ts`, `shell/stats.test.ts` and `shell/drcJump.test.ts` and grew
`store.test.ts` (pane state) and `main/settings.test.ts` (theme), and added the print-path theme guard to
`print/drawingSet.test.ts`; the dot bodies + pictures wave added
`bodyParts`, `picture`, `nearestBody`, `partsImages`, `settings`, `imageSize` and grew
`store`/`serialize`/`board`/`toFormboard`; the final-review wave grew `store`/`drc`/`picture`/
`partsImages`/`fileOps`; session 16 (picture orientation) added cases to `picture`/`board`/
`toFormboard`/`serialize`/`store`; session 17 (parts library) added `librarySchema`, `search`,
`instantiate`, `partsLibrary` and grew `catalog`/`settings`/`store` (`fileOps`/`drc` unchanged —
`LibraryCatalog` coverage lives in `catalog.test.ts`))

Heavy: `store.test.ts` (grew for `addConnectorFromPart`/`applyCavityTemplate`/`refreshPartRefs` —
read before changing history semantics), `routing.test.ts`, `serialize.test.ts`, `bom.test.ts`,
`pdfArgs.test.ts`, `drc.test.ts`, `treatments.test.ts`, `svg.test.ts`, `geometry.test.ts`,
`board.test.ts`, `sheetFindings.test.ts`, `sheetEdit.test.ts`, `reconcile.test.ts`, `toFormboard.test.ts`,
`formboard.test.ts`, `drawingSet.test.ts`, `html` (two files),
`frame`, `toFlow`, `template`, `text.test.ts`, `tableData`,
`librarySchema.test.ts` and `partsLibrary.test.ts` (new — parse/round-trip, listing/write/delete,
atomic-write-leaves-no-`.tmp`, datasheet header/cap/path-guard, symlink-escape rejection; the
final-review fix wave added a stem-collision guard in `writePart` — two different part numbers
that sanitise to the same file stem must not overwrite each other — and an uppercase `.PDF`
case for `datasheetPath`),
`topology.test.ts`, `colors`, `anchors`/`endpoints`/`tables`/`titleBlock`,
`pdfMerge`, `partsImages`/`fileOps`/`picture`,
`instantiate.test.ts`/`search.test.ts` (new),
`imageSize`/`bodyParts`/`nets`/`catalog` (grew for `LibraryCatalog`)/`nearestBody`,
`settings`/`sheet` (grew: `partsLibraryDir` parses, an old file's `partsImageDir` is ignored,
`imageDirOf`).
(Totals last re-measured 2026-10-16 at the end of `feature/dark-shell`: **820 tests, 46 files**.
Re-run `vitest --reporter=json` for a precise per-file breakdown.)

**Known order-dependent test, PRE-EXISTING and out of scope for the dark shell:** `grid view
preference > defaults to a visible 20 mm grid` (`store.test.ts`) fails under shuffled execution
because its `beforeEach` never resets `gridVisible`/`gridMm`. Reproduced at the merge base
`93e7753`, so it predates this branch; it passes in declaration order, which is how `npm test`
runs. Worth fixing on its own.

**The whole dark shell is UI, and the test env has no DOM** (`environment: 'node'`, `.test.ts`
only), so `AppShell.tsx`, `HarnessPane.tsx` and all of `shell/chrome/` are untested by
construction. What IS covered is everything that could be made pure and lifted out: `screenColors`
(the luminance threshold), `stats` (`docStats`, mutation-checked), `drcJump` (all 8 ref-kind ×
view-mode combinations, mutation-checked) and the store's pane state. The selection cycle, the
theme toggle's repaint and the split view were verified by driving the built app over CDP with
real input events. There is
no visual-regression check in the repo.

**Untested:** `src/main/pdf.ts` (the hidden window / `printToPDF` itself — `pdfArgs.ts` was
split out precisely so the validation IS testable), `src/main/partsImagesIpc.ts` (the
`parts-image://` protocol handler and the `parts:*` handlers — everything electron-free was split
into `partsImages.ts` / `settings.ts` / `imageSize.ts`, which ARE tested; the protocol itself was
verified once by hand under the running app: it serves through `contextIsolation`, refuses a
symlink escape and 404s a missing part), **`src/main/partsLibraryIpc.ts`** (same story: the
`library:*` handlers and the folder-picker wiring are untested Electron glue, everything
electron-free is in `partsLibrary.ts`, which IS tested), `src/preload/` + the IPC round trip;
`fileOps.ts`'s `window.api` callbacks (its pure `loadFromText` IS tested); the bottom bar's
repair signal; every `.tsx` component (blocked twice: node env + `.test.ts`-only glob) — which includes
**`PartPicker.tsx`, `LibraryDialog.tsx` and `LibraryPartForm.tsx`** (the search/rank/instantiate
logic they call IS tested via `search.ts`/`instantiate.ts`; the picker's own keyboard nav,
mousedown-before-blur race and the dialog's browse/edit state machine are only verified by
`npm run dev` — see STATUS's open user actions for the parts-library interactive smoke list),
the **`shell/HarnessPane.tsx` wiring between a React Flow block drag and `setBlockPos`/`clearBlockPos`** and the
live sheet resize on a paper change: the store and projection halves ARE covered, the event wiring
between them is not; packaging (`build/`
buildResources dir referenced by electron-builder.yml doesn't exist — no icons/signing).
DRC rules `populated-without-pin`, `empty-cavity-wired`, `orphaned-route`,
`colour-mismatch-in-net` are only indirectly covered; `gauge-mismatch-in-group` has no direct
test. (`branchpoint-degree` gained a direct test in session 14.) The panel's `NumberEdit`
`min` bound is UNTESTED (no DOM env) — the store action is the real gate; the field bound only
keeps the UI from looking as if it accepted the value.

## CLI (`src/cli/`, the headless `harness` tool)

`npm run harness -- <command>` (`--silent` before `harness` when you want clean `--json` on
stdout). Entry `src/cli/bin.ts` → bundled by `scripts/build-cli.mjs` (esbuild, ESM, node20,
`@shared` / `@renderer` aliases) to **`out/cli/harness.mjs`**; `npm run build:cli` builds only.
npm runs it in the repo root, so callers pass absolute paths. `harness --help` (`USAGE` in
`main.ts`) is the command reference.

| Module | Role |
|---|---|
| `bin.ts` | process glue: argv, stdout/stderr, stdin, exit code → `main()`. Ends with `process.exitCode`, never `process.exit()`: on Windows that aborts Node (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`) while fetch's sockets are closing — every `harness mcp` session did |
| `main.ts` | `USAGE`, argument parsing, the commands `new` / `apply` / `check` / `show` / `library put\|show\|search\|dir` / `mcp`; one `refuse()` path (JSON `{ok:false, errors}` on stdout with `--json`, else `harness: …` lines on stderr; exit 1 refused, 2 usage) |
| `io.ts` | the `CliIO` seam (out/err/env/home/platform/readStdin/stdinLines) so commands run in-process under vitest |
| `libraryDir.ts` | library folder: `--library` ▸ `$HARNESS_LIBRARY` ▸ `partsLibraryDir` from the first app settings file that names one (`harness-editor`, then `Harness Editor`, per-OS app-data dir); `resolveLibrary` also returns the source, `libraryDirExists` the existence check |
| `session.ts` | `loadHarness` (parse + reconcile, copied from `fileOps.ts`'s `loadFromText`, not imported), `saveHarness` (refuses a doc that would need repairs on load; atomic tmp + rename), `openLibrary` (`listParts` → `LibraryCatalog` + datasheet stems + the listing's `errors`, i.e. record files that exist but do not parse — kept so they read as "present but unreadable", never as "not in library") |
| `ops.ts` | the batch grammar: `place`, `wire`, `cable`, `cavity` (`empty` / `plugged` / `populated`), `set-wire`, `unwire`, `remove` — shape-checked, unknown fields refused |
| `refs.ts` | end references by designator: `X1:7`, `SP1` / `T1`, `CAN-1:shield:a`; exact, case-sensitive, ambiguity refused |
| `apply.ts` | `applyOps`: load (or `--create`), `setDocument`, `runOps`, `saveHarness` — all or nothing; a refused batch resets the store to an empty doc and writes nothing. Never call it in the app: that reset would wipe the open document |
| `batch.ts` | **`runOps(ops, lib, {placeAt?})`**: the op runner (`Batch`, every rail) through the **store singleton** (`useHarnessStore.getState()` — `add*FromPart`, `addWire`, `addCableFromPart`, `removeWires`, `removeElements`, `applyEdit`, then `commitNodePositions(…, 'schematic')` from `arrangeSchematic`), errors prefixed `op #N (name): `. Leaves a refused batch half-applied: the caller restores (`applyOps` resets, the MCP tools' `batchEdit` restores its snapshot). `placeAt` (default `{0,0}`) is where new bodies land on the formboard; also `parseColor`, `colorRail` |
| `libraryContext.ts` | the `LibraryContext` interface (`session.ts` re-exports it) — apart so the renderer never type-imports an fs module |
| `repairs.ts` | `repairsOnReload(doc)`: the repairs the editor would make on the next open — `saveHarness`'s rail and the MCP edit rail |
| `show.ts` | `showDocument(doc)` → `{bodies, wireCount, cables}` (`harness show --json`, MCP `get_document`) |
| `mcpBridge.ts` | `harness mcp`: stdio ↔ the app's MCP server (see "MCP server"); `resolveMcpPort` (`--port` ▸ `$HARNESS_MCP_PORT` ▸ the app's `mcpPort` ▸ 47100) |
| `rails.ts` | `incompleteReasons(pn, lib, kind?)` — the "complete record" definition (a connector's `defaultPin` is checked as a `pin`, `defaultSeal` as a `seal`); `unreadableRecord` |
| `arrange.ts` | first schematic positions for bodies a batch placed (columns x = 0 / 250 / 500); formboard `pos` untouched |
| `library.ts` | `libraryPut` (refuse up front an unreadable record file or a file-stem collision at the target; download (60 s timeout) / copy the datasheet, write, re-check completeness, roll back on refusal by restoring the previous record's **exact bytes**; a failing rollback is reported as `ROLLBACK FAILED: …`, never thrown), `libraryShow` (`{unreadable}` for a broken record file), `librarySearch` (`{hits, unreadable}`) |
| `check.ts` | `checkDocument`: `runDrc` + `outsideSheetFindings(planBoard(doc, sheetMm(doc.drawing.sheet)).warnings)` (the same `outside-sheet` warnings as the app's DRC panel; no part pictures are loaded, so picture blocks are not planned; a file without `sheetOrigin` — the CLI never writes one — is framed and so reports none), `wiringTable` rows (cores as `<cable>.<coreName>`, drain as `<cable>.drain`), `connectorPinouts`, `incompleteParts` (`null` without a library) |
| `zustandVanilla.ts` | the CLI-only stand-in for bare `zustand` (below) |
| `testLibrary.ts` | test-only tmp-library helper; never imported by the entry |

**Shared with the app.** `ops`, `batch`, `refs`, `rails`, `arrange`, `check`, `show`, `repairs` and
`libraryContext` are also bundled into the RENDERER (the MCP document tools), and `library.ts` into
MAIN (the MCP library tools; `libraryPutText` takes the record JSON instead of a file). The renderer
set must stay fs-free: `src/renderer/src/mcp/bundle.test.ts` builds it for the browser, where any
Node builtin fails the build.

**Rails** (refused with one line per problem, exit 1, nothing written): every part an op names or
touches is a **complete** library record of the expected kind — `manufacturer`, `partNumber`,
`datasheetUrl` and a PDF in `datasheets/`; connector ≥ 1 cavity and every `defaultPin` a
complete `pin` record, every `defaultSeal` a complete `seal` record; cable ≥ 1 core (enforced only here — the library parser is
lenient); wire a `gauge`, which a wire op may not contradict. Every end resolves before any store
call; a wire lands only in a `populated` cavity, and any pin/seal there must be complete;
splice/terminal ends need complete parts, and a cable-shield end (`CAN-1:shield:a`) a complete
`cable` record on that cable; a `cable` op's `drain` needs a core named `drain` in the record (the
store's `addCableFromPart` would otherwise invent a 0.5 mm² BK drain — that app-path default is
unchanged); an **existing** connector an op touches must carry a
complete housing record whose cavity positions equal the record's (sorted lists — a hand-built
mismatch is reported, never re-templated). Batches are all or nothing. Full DRC never blocks a
save; `check` reports it. A **colour-specific** wire record (`wire.color` set) fixes a `wire` /
`set-wire` colour (`colorRail` in `apply.ts`: base must match, or base + stripes exactly when the
record colour has stripes; case-insensitive); a record without `wire.color` is a type record and
the colour is free (spec decision 9). The library folder must exist: `apply` and every `library`
subcommand refuse a missing one (`parts library folder <dir> does not exist`) instead of listing it
as empty; `check` reports `incompleteParts: null` plus a `notes` entry. `library dir` prints the
resolved folder, its source (`resolveLibrary` in `libraryDir.ts`) and whether it exists.

**What it may never import:** `src/renderer/src/fileOps.ts` (imports React), `src/main/partsLibraryIpc.ts`
and `src/main/partsImagesIpc.ts` (Electron), or anything that pulls in `electron` / `react` /
`react-dom` / `@xyflow`. `src/cli/bundle.test.ts` enforces it on the **built bundle** (esbuild
metafile inputs + import/require scans of the output), on both the real entry and a bundle that
demonstrably reaches `store.ts` through `apply.ts`, and runs that bundle under plain `node` from a
tmp dir outside the repo. `electron` / `react` / `react-dom` are marked external so a leak shows
up as an import statement instead of being silently inlined.

**The zustand vanilla shim, and why.** `store.ts` builds its store with `zustand`'s `create`,
whose bare-specifier entry imports React for the hook. The CLI only ever calls `.getState()`, so
`scripts/build-cli.mjs` resolves the exact specifier `zustand` (an `onResolve` plugin, not an
esbuild `alias`, which would also capture `zustand/vanilla` and `zustand/middleware/*`) to
`src/cli/zustandVanilla.ts`: the same store on `zustand/vanilla`'s `createStore`, supporting both
`create(init)` and the curried `create<T>()(init)`, returned as a function that carries the store
API and **throws if called as a hook**. Middleware (`zustand/middleware/immer`) is the real
package. `store.ts` and the app are unchanged; the shim must track `create`'s signature on a
zustand upgrade (pinned by the bundle tests).

**Known gaps:** a cable's drain is not drawn on either canvas; app builds
before library 1.1.0 drop a cable record's core list when they save it from their library dialog
(every machine sharing the folder must update); the wiring table shows a plain wire's base colour
only (no stripes), and pinout rows for cable cores print an empty wire reference (`.White`);
colour codes are not validated (any alphanumeric token); no library kind for wedgelocks / TPAs;
a same-body jumper's `specifiedLengthMm` cannot be set from the CLI (`unrouted-wire` warning).

## MCP server (Agent access: `src/main/mcp/`, `src/renderer/src/mcp/`)

Settings ▸ **Agent access (MCP)** lets an AI agent read and edit the OPEN document, live. Off by
default: `mcpEnabled` / `mcpPort` in settings.json (`settings.ts`; `DEFAULT_MCP_PORT` = 47100). The
submenu shows the state (`mcpStatus()`: off / listening / failed, e.g. the port is taken by another
instance) and copies the Claude Code command or the Claude Desktop config.

A call's path: client → `POST http://127.0.0.1:<port>/mcp` → `server.ts` → `index.ts` `call(name,
args)`. **Library tools run in main** (`tools.ts` `runLibraryTool` → `src/cli/library.ts`; a
successful `library_put` broadcasts `library:changed`). **Document tools** go over `bridge.ts` →
`mcp:call` to the document window → preload `onMcpCall` → the handler `AppShell` registers once →
`renderer/src/mcp/tools.ts` `runTool` → the store → `mcp:result`. Claude Desktop only starts stdio
servers, so it runs `harness mcp` (`src/cli/mcpBridge.ts`), which forwards each stdin line as one
POST and writes each answer as one stdout line.

| Module | Role |
|---|---|
| `src/shared/mcp.ts` | `ToolOutcome` (`{ok, result}` / `{ok: false, errors}`), `McpCall`, `McpReply` — the IPC payloads |
| `src/main/mcp/server.ts` | **Electron-free** HTTP side: one SDK low-level `Server` + `StreamableHTTPServerTransport` per POST (stateless, `enableJsonResponse` — no sessions, so the stdio bridge is one POST per message). `hostAllowed` / `originAllowed` run before the SDK sees anything. `toCallToolResult`: JSON text; a refusal is `isError` + `{errors}` |
| `src/main/mcp/tools.ts` | `TOOLS` (name, description, hand-written JSON Schema, `runsIn`, annotations), `INSTRUCTIONS` (the server's `instructions`), `OP_SCHEMAS` / `LAYOUT_SCHEMAS`, `runLibraryTool` |
| `src/main/mcp/bridge.ts` | **Electron-free** correlation by id. A call always RESOLVES — with a refusal when the renderer is not ready, there is no window, it times out (30 s) or `rejectAll` runs |
| `src/main/mcp/index.ts` | Electron wiring: `registerMcp(onStatus)` (IPC; only the document window's webContents may answer — PDF export windows load the same preload), `attachDocumentWindow(win)` (called in `createWindow`; reload / crash / close → `rejectAll`), `applyMcpSettings()` (start / stop / move port, serialised), `claudeCodeCommand`, `claudeDesktopConfig` (installed: the app's own exe with `ELECTRON_RUN_AS_NODE=1` on `app.asar.unpacked/out/cli/harness.mjs` — `asarUnpack` in electron-builder.yml; dev: `node out/cli/harness.mjs`) |
| `src/renderer/src/mcp/tools.ts` | `runTool(name, args, ctx)`: `get_document`, `get_layout`, `check`, `apply_ops`, `edit_layout`, `set_drawing`, `select`, `save_document`; `DOCUMENT_TOOL_ARGS`, `LAYOUT_SPECS`. No `window`: `ToolContext` brings the library lister, the drop point (`addDropPos`), select (`jumpTarget` + `handleDrcSelect`) and save |
| `src/renderer/src/mcp/library.ts` | `listLibrary()` — a fresh `LibraryContext` per call (`library:getDir` + `library:list`), so a part `library_put` just wrote resolves without waiting for `usePartsLibrary`'s re-list |

Invariants:

- **One tool call = one `batchEdit` = one undo step, all or nothing.** A refusal restores `doc`,
  `past`, `future` and `dirty` exactly — never the CLI's empty-document reset. Before an edit is
  kept, `repairsOnReload` must be empty (`saveHarness`'s rail).
- **The validators are the CLI's.** The JSON Schemas are for the client; the tools re-check with
  `parseOps` / `parseBatch` / `obj`, so the agent reads the CLI's error text. `src/main/mcp/tools.test.ts`
  pins the schemas to `SPECS`, `LAYOUT_SPECS` and `DOCUMENT_TOOL_ARGS`, and the renderer tool list to
  `DOCUMENT_TOOLS`.
- **Local only, no token.** It listens on 127.0.0.1; the Host header must be a loopback name with
  this port (DNS rebinding); an `Origin` must be absent or loopback (a web page may POST cross-site
  without reading the answer — the edit would still land). No CORS headers. Any local process can
  call it while it is on.
- **Saving.** `save_document` writes to `filePath` only (no Save As) and passes the serialised doc to
  `markSaved(path, written)`, as File ▸ Save does — an edit that lands during the write stays dirty.

Known limitations: an agent edit during a canvas drag re-seeds the pane, so the drag snaps back; an
agent edit to a field the user is typing in replaces their draft (`fields.tsx` copies the value on
change); the selection may name an element the agent deleted ("Item not found." until the next
click); user and agent share one undo history; `select` cannot pan or zoom; the `edit_layout` ops
(`move`, `branch`, `merge`, `segment-length`) are MCP-only — the CLI grammar would need ids in `show`.

## Trip hazards (each has bitten or will)

1. **`BranchNode` / `FormboardBodyNode` handle centring is load-bearing layout, not
   transform** — React Flow measures connection points from the layout box, so both nodes use
   `origin: [0.5, 0.5]` and a centred handle; the in-file comments say exactly what not to touch.
   (`FormboardConnectorNode.tsx` is deleted — the formboard has no pin handles at all now.)
2. **Merge-on-drop swallows the drag**: any lone branch point dropped within 10 mm of another
   FUSES instead of moving (`BRANCH_MERGE_MM`).
3. **Formboard segments are not deletable** (Backspace is ignored by design); limbs are removed
   via the branch-point context menu only.
4. **`bundle.segmentIds` is document order, not route order** — contiguity checks must go
   through a member wire's route (`sleevingBundleFromSegments` does this correctly).
5. `docs/harness-schema.ts` is typechecked by nothing; `env.d.ts` is a hand copy of the
   preload API; `serialize.ts`'s `ARRAY_FIELDS` (13 entries) is a hand-maintained parallel of
   `HarnessDocument` — three sync-by-convention files.
6. Shield endpoints resolve to the CABLE as their body (`endpointBodyId`), and nothing in the UI
   ever creates a `Placement` for a cable, so any shield-terminated wire's length is silently
   `unknown` — shield routing is effectively unimplemented. Since 0.4.0 it is no longer
   special-cased anywhere: place a cable and its shields resolve like any other body.
7. `treatments.ts:labelAnchorPos` is exported but has no production caller (`computeFormboard`
   lerps inline); `document.ts:147` is a no-op expression statement. Dead code — safe to remove
   when convenient. (`routeNodeAnchor` was deleted in session 11.)
8. On the canvas 1 model-mm = 1 CSS px at zoom 1, so 10 pt print text looks tiny until ~3.8×
   zoom; the SVG is genuinely to scale.
9. **`win.destroy()` in `pdf.ts` is forbidden** — after a `printToPDF` it wedges the next
   export (`ERR_FAILED`) and takes the process down with SIGTRAP. Use `close()`. Likewise
   there is deliberately **no `data:` URL path**: encoded markup over ~2 MB fails
   `ERR_INVALID_URL`, and even when it fits Chromium stuffs the whole URL into the PDF
   `/Title`. Always render from the temp file.
10. **Every drawing page is 1:1.** The fit-to-sheet renderer (`drawingSheet.ts`) is DELETED —
   there is no not-to-scale output to confuse a drawing page with any more, and `renderDrawingGroup`'s
   `textScale` option is only meaningful at scale 1 now. Do not reintroduce a fit-to-page path
   without re-reading §7.1 of the spec.
11. **Reserved node ids are not entity ids.** The formboard projection emits `__sheet`, `__bom`,
   `tbl:<id>` and **`pic:<id>`** — note that a body dot's node id IS its entity id, so only the
   prefixed ones are furniture. Anything that maps a React Flow node id back to a document entity must
   tolerate them — today they are excluded explicitly in `commitDrag`'s `nodeMoves`, are
   `deletable: false` so no remove change is ever emitted, and fall through entity lookups
   (`PropertiesPanel` shows "Item not found." for a selected block — cosmetic, not a crash).
12. **The sheet node must stay `pointer-events: none`.** React Flow's own node wrapper sets
   `pointer-events: all`, so the CSS rule `.react-flow__node-formboardSheet { pointer-events:
   none }` is load-bearing: without it the full-board sheet swallows every click on the harness
   underneath it. The `⚠ n` badge deliberately re-enables `pointer-events: auto`.
13. **The block-pin id guard exists at TWO boundaries and they must accept the SAME sets**:
   `effectiveBlockMoves` in `store.ts` (drag time) and `validateBlocks` in `serialize.ts` (load
   time). A **pinout** pin accepts connector ids **∪ free-terminal ids**, because
   `connectorPinouts` emits a table for every wire-carrying free terminal; a **picture** pin
   accepts those **∪ splice ids**, because a splice is a placed body with a part but no pinout
   table. When the pinout sets diverged, a dragged ring-lug table silently never pinned. Change
   one, change the other — and note the two kinds have DIFFERENT sets on purpose.
14. **A headless Electron script that closes its last window quits the app.** `renderPartToPdf`
   closes its hidden window between parts, and Electron's DEFAULT `window-all-closed` handler
   then quits — mid-`await`, silently, with **exit code 0 and no output**. The real app installs
   its own handler in `src/main/index.ts`; `scripts/probe/main.ts` had to as well
   (`app.on('window-all-closed', () => {})`). Any new script driving the export path needs it.
15. **Part images are keyed TWO ways and the translation is one function.** `parts:listImages`
   and the `parts-image://` path are keyed by the library **STEM** (`sanitisePartNumber(pn)`,
   because `39-01/3045` cannot be a filename); `PartImages` — what `planBoard` /
   `buildDrawingSet` / `renderPictureBlock` take — is keyed by the **real PART NUMBER** the
   document carries. `usePartImages` owns the re-key (`byStem` → `images`); everything else
   passes a part number and lets main sanitise. Two consequences worth knowing: the lookup is
   an **exact-case stem match** even though macOS/Windows filesystems are case-insensitive (a
   `hsg-a.png` on disk will not answer for part `HSG-A`), and two distinct part numbers can
   sanitise to the SAME stem (`A/B` and `A:B` → `A_B`), which silently shares one photo.
16. **Canvas hrefs carry `?v=<mtimeMs>`; print hrefs are `data:` URIs.** Re-importing a photo
   reuses the stem, so without the cache-buster Chromium repainted the old bitmap — measured:
   the block resized to the new aspect (the plan reads fresh `pxW`/`pxH`) while the pixels
   stayed stale, and the exported PDF disagreed with the canvas. The query is display-only
   (`protocol.handle` reads `pathname`, which excludes `search`). The print window is a
   different `BrowserWindow` and cannot fetch a custom scheme at all, which is why
   `fileOps.exportPdf` swaps every href for a `data:` URI first — an unresolvable href prints a
   blank frame, silently.
17. **The library folder's `parts/*.json` stem must equal `sanitisePartNumber(partNumber)`.**
   `parseLibraryPart(text, expectedStem)` enforces this on every load (`listParts`/`readPart`)
   and every write (`writePart`) — a mismatch is rejected as an error rather than silently
   accepted, because the stem is the ONLY index into `images/<stem>.*` and
   `datasheets/<stem>.pdf`: a part record that parsed with a different stem than its filename
   would have a picture and datasheet nothing could ever find. This is the same class of
   footgun as trip hazard 15's stem-vs-part-number split, now enforced for a third file kind.
18. **Never key a `HarnessPane` — on theme, on mode, on the side, on anything.** A pane's first
   selection report leaves an effect while `nodes` is still `[]`, one commit AHEAD of its first
   re-seed. So a pane that remounts **while focused** reports "nothing selected" against a
   non-empty shell selection; the shell believes the focused pane, pushes the now-empty set down,
   the re-seed answers one commit later, and the two lock into an anti-phase 2-cycle until React
   gives up with "maximum update depth exceeded" (#185) and the ErrorBoundary takes the renderer.
   **That crash shipped once** (commit `6c4c96e`, via Single→Split with the right pane last
   focused). It was closed by resetting `focusedPane` to `'left'` when the split closes — which
   starved the lag of triggers but did not fix it. The lag itself is now closed by rule 4 of the
   store ↔ React Flow boundary (the re-seed drops the report it made stale), but keep the split
   conditional as the only mount/unmount path for a pane: a remount still costs the viewport. This is
   also why the theme is threaded through the projection instead of keying `<ReactFlow>` on it.
19. **A theme change is a DATA change, never a CSS cascade, for anything React draws a colour
   with.** React Flow repaints an edge when its `data` changes, not when `<html data-theme>`
   flips, and `useTheme` writes that attribute in an EFFECT — i.e. after the render that caused
   it. So `currentTheme()` called in a render body returns the OUTGOING theme and nothing
   re-renders that component afterwards. Both halves of this were measured as live bugs: the
   canvas (fixed by `documentToFlow(doc, theme)` putting the theme in each wire edge's `data`) and
   the panel's colour swatches (fixed by making `theme` a required `PropertiesPanel` prop).
   Falsification on record: removing the theme from the projection reproduced the stale colours,
   and a wheel-zoom did not clear them.

## Known issues / next work

The session-10 bugs B1–B5 are **fixed** (session 11; `anchors.ts` is the B1 fix) and so are
the session-10 risks R1–R4 (session 13: cable-core deletion, span contiguity, empty spans,
ghost treatment-only segments). The tiled PDF emitter shipped with the PDF drawing set and was replaced by the single fixed 1:1 sheet (STATUS session 25).
**The "live parts adapter" item is now DONE**: `LibraryCatalog` over a user-chosen folder is the
live `PartCatalog`, wired into `runDrc`; what remains is an importer that WRITES that folder
from ERP/DigiKey/LCSC, which is explicitly out of scope for the parts library feature (the file
format's key — the manufacturer part number — was chosen so such an importer is a later,
additive drop-in).

Still open in this area: a wire whose `cableId` names a cable that exists but does **not** list
it as a core is not checked by anything (the two directions of the link are validated
separately); and `applyRemoveBranchPoint` still leaves span/anchor fractions verbatim across a
merge.

From dot bodies + pictures: a picture block's caption is the body label — there is no
per-picture text.

From the parts library: no re-apply of a changed cavity template to a connector that already has
wires (by design — `applyCavityTemplate` refuses outright rather than attempting a merge; a
smarter "keep wired cavities, add missing positions" merge is a later feature if wanted); no
ERP/DigiKey/LCSC import; no multi-user locking beyond atomic writes (two people editing the same
part at the same second is a Git/shared-drive problem, not the app's); the panel has no field yet
for terminal seal / cable part / sleeving part / branch tie, so those four `PartRef`s stay
free-text-only until a panel row exists for them.
