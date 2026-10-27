# Wire Harness Editor — Architecture & Design Spec

**Status:** Draft v0.1 — design locked, ready for implementation
**Canonical types:** see `harness-schema.ts` (TypeScript interfaces). This document explains *intent, rules, and rationale*; the `.ts` file is authoritative for exact field shapes. If the two disagree, fix one and note it here.

---

## 1. Purpose & scope

Build a wire-harness drawing/editing tool from scratch. It produces readable, manufacturing-grade harness drawings (formboard style) and a correct bill of materials / cut list.

The tool is for harnesses like battery and charger interconnects, CAN looms, and EV-conversion wiring — i.e. real harnesses with connectors, splices, ring terminals on battery studs, shielded CAN cables, bundles, sleeving and branch breakouts.

**WireViz is explicitly out.** It was evaluated and rejected as a base because its layout is owned by GraphViz (no real manual layout control) and it has no first-class model for bundles, branch breakouts, cables, or free terminals. We own the full stack. We do **not** need WireViz YAML round-trip.

**Manual layout is a hard requirement for every large harness.** Auto-layout, if implemented at all, is only a *seed* that the user then edits freely (see §10).

---

## 2. Core architecture: the two-layer model

The single most important rule, from which everything else follows:

> **Electrical truth and drawing geometry are completely separate, linked only by stable ids.**

- The **electrical model** stores connectivity and parts. It never stores a position.
- The **layout overlay** stores geometry in millimetres. It never stores connectivity — it references electrical entities by id.
- A thin **annotations** layer (sleeving, twist, labels) bridges the two: it references electrical entities *and* carries geometry.

Why this matters: it gives correct re-layout (move anything without touching electrical truth), a trustworthy BOM (connectivity is independent of drawing), validation/DRC, and the "drag a node, everything updates" behaviour. **Never infer connectivity from geometry, and never leak positions into the electrical model.** Violating this rebuilds the exact problem WireViz had.

---

## 3. Document structure

One serializable `HarnessDocument` (see `harness-schema.ts`) with three groups of arrays:

```
HarnessDocument
├── ELECTRICAL MODEL   (truth, no geometry)
│   ├── connectors[]      housings, each with cavities[]
│   ├── freeTerminals[]   ring lugs, ferrules, bare ends …
│   ├── splices[]         conductor junctions
│   ├── wires[]           THE conductor primitive (one cut length each)
│   └── cables[]          purchased multi-core assemblies
│
├── LAYOUT OVERLAY     (geometry in mm, references electrical by id)
│   ├── drawing          drawing paper (A4–A0 or plotter roll), 1:1 print scale, title block,
│   │                    pinned block positions (`blocks`)
│   ├── placements[]     dot centre (+ schematic pos) for connectors, splices, free terminals
│   ├── branchPoints[]   routing vertices (bend or Y-split)
│   ├── segments[]       loom edges between routing nodes ("branches"/limbs)
│   ├── wireRoutes[]     each wire's ordered path of segment ids
│   └── bundles[]        loose wires loomed together over a set of segments
│
└── ANNOTATIONS        (bridge: reference electrical + carry geometry)
    ├── sleeving[]       covering over a span
    ├── twists[]         twisted grouping of loose wires over a span
    └── labels[]         draggable callouts on wires/bundles/branches/branch points
```

Persist the whole document as version-controllable JSON (one file per harness, lives in Git). YAML is acceptable if preferred; JSON is the default. IDs are opaque and stable (uuid/nanoid), never reused, never derived from content.

---

## 4. Entity reference

Exact field types are in `harness-schema.ts`. Below is each entity's role plus the rules that types alone don't capture.

### Electrical model

**Connector** — a housing with a reference designator (`X1`, `J3`), optional housing part, optional gender, and any number of cavities. May reference the connector it `mates` with.

**Cavity** — a position inside a connector.
- `position` is a **string** (alphanumeric: `"1"`, `"A"`, `"A1"`). Never an integer — do not assume numeric sort order; sort naturally (numeric-aware) for display.
- `status` is `populated | plugged | empty`. `pin` is required only when populated; `plug` is used when plugged.
- `pin` and `seal` are `PartRef`s, not free text.
- A populated cavity is a valid wire endpoint.

**FreeTerminal** — a wire end that is *not* in a connector: ring, ferrule, eyelet, blade, fork, bare, tinned. Optional part and seal; `landsOn` is a note for the stud/post it attaches to (`"B+ stud"`, `"M6 GND"`). Essential for battery/busbar harnesses. Carries a required `designator` (`T1`, `T2`, … — prefix `T`, lowest free number across all bodies; schema 0.5.0 loader backfills missing/blank ones on older files).

**Splice** — a conductor junction (butt, solder sleeve, clip, weld, ultrasonic). First-class endpoint with its own part. Its degree (how many wires meet) is **derived** from the wires that reference it, not stored. Carries a required `designator` (`SP1`, `SP2`, … — prefix `SP`, lowest free number across all bodies; the 0.5.0 loader backfills missing/blank ones on older files).

**Endpoint** — the four-way discriminated union that is the backbone of the whole model:
`{cavity} | {splice} | {freeTerminal} | {shield}`. This is what lets a connector pin, a splice, a ring lug, and a cable shield drain all be valid ends of the same wire. Adding a fifth endpoint kind later must not require changes elsewhere.

**Wire** — **the conductor primitive: one cut length of one conductor between exactly two endpoints.**
- Connectivity is a **multigraph** — a cavity may appear in any number of wires. **Never cap endpoint degree.**
- "A wire with a splice in it" is stored as **two wires sharing one splice** endpoint. This keeps every wire equal to exactly one cut piece.
- Electrical nets / continuity are **derived by graph traversal**, never stored.
- `gauge` is value + unit (`mm2` or `AWG`); `color` is IEC base + optional stripes.
- `specifiedLengthMm` optionally overrides the 1:1 length computed from the route (for service loops / slack). When absent, length is computed from geometry.

**Cable** — a purchased multi-core assembly: one part, one jacket, cut as one piece.
- `coreWireIds` point to the `Wire` records that are its cores (a core is still a Wire, with `cableId` set back to the cable; `Wire.coreName` / `Wire.corePair` (schema 0.5.1) carry the library record's core name and pair label so same-colour cores and twisted pairs stay distinguishable).
- `twistedPair: true` for pre-twisted cable (distinct from a loose `Twist` treatment).
- `shield.drainWireId` points to a Wire whose endpoint `type` is `"shield"` — that's how the shield terminates to a ground pin.

### Layout overlay (all coordinates in mm)

**DrawingConfig** — `units` fixed to `"mm"`; `printScale` fixed to `1`; `sheet` is the paper/orientation of the ONE fixed **1:1 drawing sheet** (A4–A0, or `Plotter` = a 914 mm roll whose length is the typed `sheet.lengthMm`, 914–5000 mm, default 2000; the export prints it as-is, the export dialog has no paper picker). `sheetOrigin?` (0.6.0) is the model-mm top-left of the sheet's printable area; absent, the planner frames the harness, and the app pins it on open/new so the sheet never moves (the CLI never writes it). The BOM / Wiring Table / Cutlist pages are **always A4 landscape** (`DOCUMENT_PAGE_SHEET`, print code — not user data). Optional typed `titleBlock` (title / part number / description / revision, four `Approval` name+date pairs, confidentiality text) and optional `blocks`.

**DrawingBlocks** (`drawing.blocks`) — the top-left positions, in **model mm**, of drawing blocks the user has **dragged**: `pinout[id]` per pinout table — keyed by **connector *or* free-terminal** id, because a ring lug on a stud gets a pinout table exactly like a housing does — and `bom` for the BOM summary block. An absent entry means *auto-placed*: `planBoard` positions it, and a pinned one is taken verbatim and becomes an obstacle every auto-placed block dodges. Layout-layer data throughout: geometry keyed by an electrical id, never connectivity. A pin whose id no longer exists (only reachable by hand-editing the file) is dropped on load with a `invalid drawing-block position dropped` migration note. `picture[id]` is the third kind, keyed by connector, free-terminal **or splice** id — a splice has a part and therefore a photo, but no pinout table.

**Part pictures** — a body's dot may carry a **product photo** of its primary part (connector housing, terminal part, splice part), drawn as its own draggable block beside the dot exactly like a pinout table. The image is **not in the document**: it is looked up by `PartRef.partNumber` in the `images/` folder of the parts library the user points the app at (`Settings ▸ Parts library folder…`), so a photo added once is shared by every harness and every engineer with that folder. Adding one is picking or dropping a file on the dot; the app copies it into the folder as `<sanitised part number>.<png|jpg>`. The document stores only the pinned block position. A body whose part has no photo simply gets no block, and the export dialog says how many are missing.

**Placement** — position for any node-like electrical entity (connector, splice, free terminal, and a cable once one is placed). On the formboard `pos` is the **dot centre** — the point every wire on that body lands on and the datum every length is measured from. `schematicPos` + `schematicExitSide` + `schematicPinOrderReversed` (schema 0.5.2 — mirror the symbol top↔bottom) are the schematic's separate, view-only geometry. There is no formboard exit side: a dot has no sides (`cavityExitSide` was removed with schema 0.4.0).

**BranchPoint** — a routing vertex. **Degree 2 = direction change (bend); degree ≥3 = Y-split / breakout.** Same entity, role determined by degree — this unifies "add a bend" and "split a bundle" into one thing. Optional `tie` part to BOM the tape/tie at a breakout.

**RouteNode** — `{branch} | {body}`. A routing position is either a branch point or a **placed body** (`{type:'body', refId}`, a `Placement.refId`). Keys are `b:<branchId>` and `n:<refId>`.

*Why body, not cavity (schema 0.4.0, reversing the earlier per-endpoint keying).* On a formboard a connector is one dot, so four wires running from C2 to branch point B are ONE limb. Keyed per cavity they would have been four coincident segments: four length labels drawn on one line, and every routing op — split, merge, sleeving span, bundle membership, label anchor — forced to treat the coincident set as a unit. One physical limb must be one `Segment`. Nothing is lost: which cavity a wire lands in is already electrical truth in `Wire.ends`, and `wireRoutes[].path` already says which wires run through a limb. The layout layer now says only *which body* a limb reaches — the two-layer rule applied more strictly, not less. The consequence to know: a **jumper between two cavities of the same body has no limb at all**, so it gets no segment and no route, and its length has to be stated with `specifiedLengthMm` (DRC asks for it).

**Segment** — an edge of the loom between two route nodes; a straight "branch"/limb. **Its geometry and true length are derived from the two nodes' mm positions** — segments store no coordinates of their own. A segment may additionally carry a typed manufacturing length, `specifiedLengthMm` (schema 0.6.1), which overrides its geometry for the cut list, sleeving and tape; the drawing keeps its geometry, and a typed length that differs from the drawn one by 0.5 mm or more reads as "broken".

**WireRoute** — a wire's physical path as an ordered list of segment ids (from `ends[0]` to `ends[1]`).

**Bundle** — loose wires loomed together over a set of segments. A **build grouping, not electrical** (contrast Cable). Its segments form a tree; it Y-splits at branch points. Optional **`part`** = the loom tape / spiral wrap consumed over the run — it yields one length-based BOM line (category `loom tape`, unit `m`), quantity 1 per bundle and length = Σ of the member segments' lengths, grouped by part number exactly like sleeving. A bundle without a `part` produces no BOM line. Bundles are derived by `syncBundles` on every topology change, which inherits `id`, `name` **and `part`** from the best-overlapping prior bundle so an authored tape survives a re-route.

### Annotations

**Span** — a contiguous run of segments with optional fractional start/end (0..1 into the first/last segment). The shared shape for treatments that cover *part* of a run.

**Sleeving** — a covering over a `Span`, targeting a wire, bundle, or cable. Span-based because real sleeving leaves ends exposed for breakouts. Carries type/size/color/part.

**Twist** — a twisted grouping of 2+ **loose** wires over a `Span` (cable twisting is `Cable.twistedPair`). Optional `layLengthMm` pitch.

**Label** — a typed annotation targeting a wire, bundle, branch (segment), or branch point. Kinds: `callout | wireMarker | flag | heatshrinkPrint`. Has its own draggable `pos` and optional leader line.

---

## 5. Design decisions (with rationale)

These are settled. Don't re-open without a reason; if you do, record it here.

### Load-bearing
1. **`Endpoint` is a four-way union** (cavity / splice / free terminal / cable shield). One type unifies all wire ends; extensible without ripple effects.
2. **`Wire` = one cut length between two endpoints.** Splices are separate nodes wires share. Keeps the cut list correct, makes connectivity a true multigraph, and lets nets be derived rather than stored.
3. **Cable ≠ Bundle, split by layer.** Cable is an electrical part (one BOM line, one cut length); Bundle is a layout build-grouping (loom tape over N separate wires). They may share routing segments but BOM completely differently.
4. **Routing is a referenced graph.** Nodes are branch points (bend at degree 2, Y-split at ≥3) **and placed bodies** (one dot each, keyed `n:<refId>` — see RouteNode above), segments are edges, wires are ordered segment paths, and bundles/treatments/labels reference the same segments. Everything resolves to mm node positions, so (a) dragging a node updates every wire/bundle/sleeve/label on it for free, and (b) 1:1 print is "render mm as mm" then one fixed sheet.
5. **Sleeving and twist are span treatments**, not whole-length booleans — contiguous run with fractional ends, so they cover a portion and leave breakouts exposed.
6. **One PDF output, and its drawing pages are 1:1.** The first cut shipped two exports — a fit-to-sheet drawing set and a 1:1 tiled formboard template — *because a drawing that is not to scale invited the wrong sheet onto the bench*. One export removes the choice: the drawing page is always 1:1, the tables that used to justify shrinking the drawing are placed **on the board** at true scale (and are draggable when they get in the way), and the documentation pages that never needed scale are fixed at A4 landscape. What the formboard view shows is what prints.

### Smaller calls
- **Cavity `pin` optional, required only when `status === "populated"`** — supports plugged/empty cavities. (If every cavity in practice is always populated, simplify: drop `status`, make `pin` required. Confirm with the owner.)
- **`specifiedLengthMm` override exists** on wires for slack/service loops; otherwise length is computed from the route.
- **Branch points carry an optional `tie` part** for BOM-ing tape/ties at breakouts. Remove if not tracked.
- **Bundles carry an optional `part`** for BOM-ing the loom tape/wrap over the whole run (`BranchPoint.tie` covers the discrete tie at a breakout; the two are complementary).

---

## 6. Invariants & critical behaviors

Implement and test these explicitly:

- **Multigraph connectivity.** No code path may limit a cavity/terminal/splice to a single wire.
- **Nets are derived.** Provide a traversal that computes connected conductor sets (through splices and cable shields) on demand for highlighting and DRC. Do not persist nets.
- **Wire ↔ cut length is 1:1.** Each `Wire` is exactly one cut piece. Inserting a splice into an existing run replaces one wire with two wires sharing the new splice.
- **Insert branch point splits a segment.** Adding a branch point on an existing segment must: create the branch point node, replace the original segment with two segments meeting at it, and rewrite the `path` of **every wire** (and the `segmentIds` of every bundle, and any span treatments/labels) that used the original segment. This is the operation most likely to have bugs — cover it well.
- **Drag-by-reference.** Moving a `Placement` or `BranchPoint` changes only its `pos`; all dependent geometry (segments, wire polylines, bundle paths, sleeving spans, label leaders) recomputes from references. No geometry is duplicated onto wires.
- **Length is geometry-derived** (unless `specifiedLengthMm` is set). Segment length = distance between its two resolved node positions in mm. Wire length = sum of its segment lengths.

---

## 7. 1:1 print (one fixed sheet)

- The drawing is authored in **real millimetres**. The on-screen canvas may zoom freely, but **build-template print scale is locked at 1:1 — never "fit to page."**
- Output target is **one sheet, A4 through A0 or a 914 mm plotter roll** (length typed, 914–5000 mm). The sheet is fixed in model space; anything that does not fit is **flagged `outside-sheet`, never accommodated** — the user picks a bigger sheet.
- **Reversal (user decision 2026-10-27):** earlier versions tiled the drawing across A4–A1 sheets with registration/overlap marks, sizing the grid from the content. Reason for reversing: a sheet that moves and grows with the content makes layout planning impossible. Tiling, `TILE_OVERLAP`, registration marks, `MAX_TILES` and `block-outside-tiles:` are gone.
- A printed segment's length must equal its true modelled length, so the printout works as a build template.

### 7.1 One PDF output: the drawing set (there is no standalone SVG export)

`File ▸ Export` offers exactly two items: **`Drawing set (PDF)…`** and
**`BOM & Cut List (CSV)…`**. The drawing set is one file with two kinds of page, and the
drawing pages are **always 1:1** — there is no fit-to-sheet output any more, so no
not-to-scale sheet can reach the bench by mistake.

1. **Drawing page — one 1:1 sheet** at `drawing.sheet` (A4–A0 or plotter, default **A3
   landscape**, chosen in Document Properties; the plotter length field appears there too).
   The board — harness at true mm, per-connector/free-terminal **pinout tables**, part
   pictures, the **BOM summary block** and the **title block** (150 × 30 mm) — is drawn
   on that one sheet, clipped to its printable area; there are no tiles, overlap bands or
   registration marks. The info strip carries `Drawing` on the left and
   `1:1 — verify scale bar = 100 mm · Page N of M` on the right, above a **page-space 100 mm
   scale-check bar**. The title block sits in the bottom-right corner of the sheet.
2. **Document pages — always A4 landscape**, never configurable: full-width **BOM**,
   **Wiring Table** and **Cutlist**, each with the header block, logo and
   `<Section> i of k` / `Page N of M` footers. `Page N of M` runs continuously across both
   kinds.

**Board layout is planned once and shared.** `src/shared/print/board.ts` `planBoard(doc,
sheet, layout?)` places the blocks inside the one fixed sheet and positions the title block, all
in model mm; `template.ts` renders that plan onto the page and the **formboard canvas draws
the same plan** — what you see is what prints. Blocks are auto-placed (dodging bodies, wire
runs, run labels, each other and the title block) until the user drags one, which pins it in
`drawing.blocks`; a pinned block is placed verbatim and never moved, only warned about.
Right-click a pinned block → *Reset position (auto-place)*.

**Plan warnings are never printed.** `table-overlap:<id>`, `table-over-wire:<id>` and
`title-block-over-content` and the **`outside-sheet:<kind>:<id>`** codes come out on `DrawingSetOutput.warnings` and surface where they can
be acted on: a line in the export dialog, a `⚠ n` badge on the canvas sheet node, and — for `outside-sheet` — DRC findings (`ruleId: 'outside-sheet'`, warning; also reported by `harness check`), tested against each item's drawn extent (dot + designator, run + its length label, label text), not an anchor point. The page's
info strip has no room for a warning band, and a warning on paper is a warning found too late.
`title-block-over-content` is re-derived from the **final** geometry and reports anything
under the title block, pinned or not.

Rendering goes through Electron `webContents.printToPDF` on a hidden `BrowserWindow`
(bundled Chromium = identical mm→pt mapping on every OS, which is why Electron was chosen).
Chromium prints one page size per call, so an export is a **list of parts** (`ExportPdfArgs
{ parts: PdfPart[] }`): the main process renders each part in turn and merges them with
`pdf-lib` (`src/main/pdfMerge.ts`), which copies every page box verbatim — the 1:1 claim
survives the merge (measured, §7.2 below). `documentToSvg` survives only as an
internal/test renderer; there is no `Drawing (SVG)…` menu item.

### 7.2 Accuracy floor of the toolchain (measured, not assumed)

Chromium quantises the PDF page box to 1/300 in (0.24 pt), so an A4-landscape drawing page
reports `841.92 × 594.96 pts`, not the nominal `841.89 × 595.28`. The residual *content*
scale error is −0.011 % (≈0.1 mm per metre) — below paper dimensional stability and inside
build tolerance. `scripts/check-pdf-scale.sh <drawing-set.pdf> [page]` measures the 100 mm
bar off a rasterised page and asserts `1181 px ± 3` at 300 dpi; point it at the drawing page,
since the A4 document pages carry no bar. `node scripts/probe-pdf-export.mjs [outDir]
[paper] [orientation]` (paper also `A0` and `Plotter:<lengthMm>`) drives the **real** export path headlessly under Electron and runs
both checks. Measured on the merged demo export: **1181.000 px = 99.9913 mm (−0.0087 %)**,
PASS on an A4 run (9 pages, all `841.92 × 594.96 pts`) and on an A3 run (drawing pages
`1191.12 × 841.92 pts`, document pages `841.92 × 594.96 pts`). After the fixed-sheet change (2026-10-27) the same bar measured **1181.000 px** on A3, A0, `Plotter:5000` (page `14173 × 2591.04 pts`) and `Plotter:2600`, all landscape.

---

## 8. Mandatory features (acceptance checklist)

Every item below is required and covered by the schema:

- [x] Any number of connectors, each with any number of cavities
- [x] Cavity ID is a number **or** a letter (string, alphanumeric)
- [x] Cavity has a pin; cavity can have a seal
- [x] Connections are pin-to-pin, any pin to any pin (no topology restriction)
- [x] More than one connection per pin (multigraph)
- [x] Connections are realized by wires
- [x] Splices within wires
- [x] Print at 1:1 scale (A4–A0 or plotter, one fixed sheet) — the **drawing pages of the drawing-set PDF** (§7.1)
- [x] Bundle wires together
- [x] Apply sleeving to wires or bundles (and cables)
- [x] Labels on wires, bundles, and branches
- [x] Ring terminals, ferrules, and other free terminals
- [x] Cables (multi-core, shield + drain)
- [x] Twisted wire pairs (loose, and pre-twisted cable)
- [x] Branch points along a wire/bundle (direction change) and Y-splits in bundles

---

## 9. Tech stack & implementation guidance

- **Own the domain model and the bundle-routing logic. Do not hand-roll the canvas.** Use **React Flow (xyflow)**: connectors = custom nodes, cavities/pins = handles, wires = edges, splices and free terminals = additional node types, branch points = lightweight nodes. React Flow gives drag, selection, pan/zoom, and viewport for free. The part React Flow does **not** do — harness-aware bundle/segment routing — is the custom engine we build on top.
- **Render with SVG, not Canvas/WebGL.** Output goes to manufacturing: it must be clean, inspectable, exportable vector (for crisp PDF and 1:1 print). Large harnesses are at most low-thousands of elements — SVG with light virtualization is fine, and the export story is far better.
- **Coordinates are millimetres** throughout the layout layer. Keep a single mm→screen transform; never bake screen pixels into the model.
- **State / undo-redo:** normalized document store (entities by id) with an immutable history stack or command pattern. `Immer` + `Zustand` is a pragmatic combo. Keep state centralized — the "insert branch point" and "drag node" operations must be single atomic, undoable commands.
- **Persistence:** serialize `HarnessDocument` to JSON; treat it as a Git-tracked source file. Keep the three layers as distinct sections so diffs are readable.
- **Parts library integration — built.** A user-chosen folder (`Settings ▸ Parts library folder…`, `partsLibraryDir` in `userData/settings.json`) holds `parts/ images/ datasheets/`: one hand-editable JSON record per part under `parts/<stem>.json` (`src/shared/parts/librarySchema.ts`, `LibraryPart` — versioned independently as `LIBRARY_VERSION`), its picture under `images/<stem>.*` and its datasheet under `datasheets/<stem>.pdf`, all keyed by the same `stem = sanitisePartNumber(partNumber)` the parts-image folder already used. The key is the **manufacturer part number** — there is no separate vendor-PN field; an ERP/DigiKey/LCSC importer is a later, additive drop-in against the same key. `HarnessDocument` is unchanged and unaffected: it still references parts through `PartRef {partNumber, manufacturer?, description?}` only, and **must open with no library present** — the library is a third, external store, linked to the document by part number alone, exactly as pictures always were. From the library the editor can: **pick** any `PartRef` field from a searching combobox (`PartPicker`, `src/shared/parts/search.ts`'s `searchParts`) while a free-text part number the library doesn't know stays enterable; **instantiate** a connector / free terminal / splice onto the board with its cavities, default pins/seals, gender and description filled in (`src/shared/parts/instantiate.ts`, `store.ts`'s `add*FromPart`); **check against** it — the `stale-or-unresolved-partref` DRC rule is now live, fed by `LibraryCatalog` (`src/shared/parts/catalog.ts`) instead of the 6-entry stub, and off by design when no library folder is configured; and **save to** it — a placed body's `Save to library…` builds a `LibraryPart` template from what's on the board.
- **Auto-layout is a seed, not a requirement.** If implemented, it produces an initial placement that is then fully manually editable. Manual override is mandatory; manual origination is a convenience.

---

## 10. Open questions / deferred to v2

Flagged, not blocking. Resolve with the owner when relevant:

- **Explicit logical "Connection" object.** Currently a "connection" = a wire (or a chain of wires through splices), derived by traversal. We deliberately did not add a separate connection entity above wires. Revisit only if a use case needs named pin-to-pin connections independent of the physical wire.
- **Cable cut length vs core length.** A cable's jacket runs along its shared path, but cores often extend *past* the breakout points to reach their connectors, so jacket length ≠ core length. Tail-beyond-breakout is **not yet modelled**. Add for accurate cable cut lengths if battery/CAN harnesses need it.
- **Stored nets.** Nets are derived for now. Persist only if traversal cost becomes a problem (unlikely at these sizes).
- **DRC ruleset.** Duplicate pin assignment, unconnected populated cavities, gauge/seal/color mismatches, shield-without-drain, etc. Cheap to add incrementally once the electrical model is clean; not in the schema yet.
- **Multi-user editing.** Single-user assumed for v1. If collaboration (e.g. a second engineer) becomes near-term, plan the normalized store now so a later move to CRDTs (Yjs) is not a rewrite.
- **Cavity "always populated" simplification** — see §5.

---

## 11. Suggested build phasing

1. **MVP — electrical model + manual placement + export.** Connectors/cavities/pins/seals, free terminals, splices, wires, cables. React Flow canvas with draggable connectors (custom nodes), pins as handles, wires as edges. Point-to-point wires (no bundle routing yet). JSON load/save. SVG export + BOM. This alone beats WireViz for large harnesses.
2. **Routing graph.** Branch points (bend + Y-split), segments, wire routes, bundles. Segment lengths → cut list. 1:1 print + one fixed A4–A0 sheet (tiling since removed, §7).
3. **Treatments, labels, parts, DRC.** Sleeving and twist (span treatments), labels on wires/bundles/branches/branch points, parts-library integration (ERP / DigiKey / LCSC), DRC, title block, multi-sheet PDF export.
4. **(Optional) Collaboration & auto-layout.** CRDT-backed multi-user; auto-layout seed.

---

## 12. Glossary

- **Connector** — a housing containing cavities.
- **Cavity** — a numbered/lettered position in a connector; holds a pin and optional seal.
- **Pin / terminal** — the crimped contact in a cavity (a part).
- **Seal** — a wire seal in a cavity (a part).
- **Free terminal** — a wire end not in a connector: ring lug, ferrule, eyelet, blade, bare, tinned.
- **Splice** — a conductor junction where two or more wires join (a part).
- **Wire** — one cut length of one conductor between exactly two endpoints. The conductor primitive.
- **Cable** — a purchased multi-core assembly (jacket, cores, optional shield/drain); one part, one cut length.
- **Bundle** — loose wires loomed together over a shared path; a build grouping, not a part.
- **Branch point** — a routing vertex; a bend (degree 2) or a Y-split (degree ≥3).
- **Segment / branch / limb** — a straight edge of the loom between two routing nodes.
- **Route** — a wire's ordered path of segments.
- **Sleeving** — a covering (braid, convoluted, heat-shrink, PVC, tape) over a span.
- **Twist** — a twisted grouping of loose wires over a span.
- **Label** — a draggable annotation on a wire, bundle, branch, or branch point.
- **Net** — a derived set of conductors at the same potential (via traversal; not stored).
