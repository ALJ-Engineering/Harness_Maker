# Harness Maker

A desktop editor for wire harnesses. You draw the harness once and get two things out of it: a
**1:1 formboard drawing** you can lay on the build board as a full-size template, and a **correct
BOM and cut list**.

It is built for real looms — battery and charger interconnects, CAN looms, EV-conversion wiring —
with connectors, splices, ring terminals on battery studs, shielded multi-core cables, bundles,
sleeving and branch breakouts.

## What it does

- **Two views of one harness.** The *Schematic* view is where you wire: connectors, free terminals
  (ring lugs, ferrules, bare ends) and splices, with wires drawn cavity to cavity. The *Formboard*
  view is the physical layout: each body is a dot, wires run along limbs between branch points,
  and every limb shows its length. Show either view, or both side by side.
- **Lengths from the drawing.** A wire's cut length is the sum of the limbs it runs along. A limb
  can also carry a typed manufacturing length, which wins for the cut list; if it disagrees with
  the drawn length the label turns red and offers to rescale.
- **Cables and bundles kept apart.** A cable is a purchased part (one BOM line, one jacket, cores
  and an optional shield drain). A bundle is loose wires taped together on the board. They can
  share limbs but are counted differently in the BOM.
- **Sleeving, twists and labels** over any run of limbs, with exposed ends where wires break out.
- **Design-rule checks** — over 20 rules covering unconnected cavities, wires into empty
  cavities, splice and branch-point degree, unrouted wires, dangling references, gauge and colour
  mismatches across a net, limbs drawn off scale, bodies outside the sheet and stale part numbers.
- **One PDF drawing set.** One fixed drawing sheet printed at exactly 1:1 (A4–A0 or a 914 mm
  plotter roll up to 5 m long), with pinout tables, part pictures, BOM block and title block, followed
  by A4 BOM, wiring-table and cut-list pages. Never scaled to fit. BOM and cut list are also
  available as CSV.
- **Parts library.** Parts live in a folder you choose: one JSON record per manufacturer part
  number, plus its picture, datasheet and your company logo for the title block.
- **Headless CLI** for creating and editing harness files from scripts.

Harness files are plain JSON (`*.harness.json`), one file per harness, written to diff cleanly
under version control.

## Getting started

You need [Node.js](https://nodejs.org/) 20 or newer.

```bash
git clone https://github.com/ALJ-Engineering/Harness_Maker.git
cd Harness_Maker
npm install
npm run dev        # start the app
```

To build an installer for your platform (written to `release/`):

```bash
npm run pack:mac     # .dmg
npm run pack:win     # NSIS installer
npm run pack:linux   # AppImage and .deb
```

## Using the app

1. **Set up a parts library (optional).** *Settings ▸ Parts library folder…* and pick or create a
   folder. The app creates four subfolders in it:

   | Folder        | Holds                                                                 |
   |---------------|-----------------------------------------------------------------------|
   | `parts/`      | one `<part number>.json` record per part                              |
   | `images/`     | the part's picture, named after its part number                       |
   | `datasheets/` | the part's datasheet PDF, named after its part number                 |
   | `branding/`   | `logo.svg` (or `.png` / `.jpg`) for the title block and page headers |

   Browse and edit records with *Settings ▸ Parts library…* (⌘L / Ctrl+L). Without a library,
   harnesses still open and edit normally; part checks and pictures are simply off, and the logo
   cell stays empty.
2. **Add bodies.** Use **Add** in the bottom bar to place a connector, free terminal or splice in
   the focused view.
3. **Wire.** In the Schematic view, drag from one cavity to another to add a wire. Select a wire or
   body to edit its part, colour, gauge and other properties in the side panel.
4. **Lay it out.** In the Formboard view, drag the dots into the shape of the real harness.
   Right-click a limb and choose **Add branch point** to split it, then drag the branch point to
   make a breakout. Lengths update as you drag.
5. **Check it.** Problems found by the design-rule checks are listed in the app; clicking one jumps
   to the item at fault.
6. **Export.** *File ▸ Export ▸ Drawing set (PDF)…* or *BOM & Cut List (CSV)…*.

Undo and redo (⌘Z / ⌘⇧Z, Ctrl on Windows and Linux) cover every edit.

### Printing at 1:1

The drawing page must be printed at **100 % / actual size**, never "fit to page". Every drawing
carries a 100 mm scale bar; measure it on the print before using it as a template.

## Command-line tool

`harness` creates and edits harness files without the app, and validates part records before
adding them to the library:

```bash
npm run harness -- --help
npm run harness -- new /abs/path/loom.harness.json
npm run harness -- apply /abs/path/loom.harness.json ops.json
npm run harness -- check /abs/path/loom.harness.json
```

| Command                                   | Does                                                         |
|-------------------------------------------|--------------------------------------------------------------|
| `new <file>`                              | start an empty harness file                                  |
| `apply <file> <ops.json \| -> [--create]` | apply a batch of operations, all or nothing                  |
| `check <file>`                            | design-rule findings, wiring table, pinouts, incomplete parts |
| `show <file>`                             | bodies by designator, part numbers, wires, cables            |
| `library put <record.json>`               | add or replace a part record (refused unless complete)       |
| `library show \| search \| dir`             | look up records and the library folder in use                |

An operations file is a JSON array. Wire ends are written `X1:3` (designator and cavity) or a
splice/terminal designator:

```json
[
  { "op": "place", "kind": "connector", "partNumber": "HSG-4", "designator": "X1" },
  { "op": "place", "kind": "connector", "partNumber": "HSG-4", "designator": "X2" },
  { "op": "place", "kind": "splice", "partNumber": "SPL-1" },
  { "op": "wire", "from": "X1:1", "to": "SP1", "partNumber": "W-05", "color": "BK" },
  { "op": "wire", "from": "X2:1", "to": "SP1", "partNumber": "W-05", "color": "BK" }
]
```

Every part number used must exist as a complete record in the parts library. The library folder
comes from `--library <dir>`, else `$HARNESS_LIBRARY`, else the app's setting. Add `--json` (and
use `npm run --silent harness`) for machine-readable output. Pass absolute paths, because npm runs
the tool from the repository root.

## Development

```bash
npm test             # unit tests (Vitest)
npm run typecheck    # TypeScript, main/preload and renderer
npm run build        # typecheck and bundle to out/
```

Stack: Electron, React 19, TypeScript, React Flow for the canvas, Zustand and Immer for the
document store. PDFs are rendered with Chromium's print engine so the 1:1 output is identical on
every platform. `scripts/check-pdf-scale.sh <drawing-set.pdf> 1` measures the scale bar on an
exported PDF (needs poppler and Python 3).

Further reading:

- [`docs/harness-editor-spec.md`](docs/harness-editor-spec.md) — the design: data model, rules and
  why they are that way.
- [`docs/harness-schema.ts`](docs/harness-schema.ts) — the harness file format as TypeScript types.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the code is organised.

## Licence

Copyright © 2026 ALJ Engineering.

Harness Maker is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, version 3 of the
License, or (at your option) any later version. It is distributed in the hope that it will be
useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See [`LICENSE`](LICENSE) for the full text.
