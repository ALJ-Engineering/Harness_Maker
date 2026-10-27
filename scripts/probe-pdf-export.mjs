#!/usr/bin/env node
/**
 * Prove the exported drawing-set PDF is 1:1 — empirically, on the real merged
 * file. Bundles `scripts/probe/main.ts` with esbuild, runs it under Electron
 * (which is what makes `printToPDF` available at all), then reports every
 * page's MediaBox with `pdfinfo` and measures the 100 mm scale bar on page 1
 * with `scripts/check-pdf-scale.sh`.
 *
 * It also gates the PART PICTURES: the probe pins a fixture 2x2 PNG to the
 * demo's first connector, this script counts the `<image>` tags in part 0's
 * markup (dumped next to the PDF as `*-part0.html`) and `pdfimages -list`
 * confirms the bytes are embedded on a drawing page.
 *
 * Needs poppler on PATH (`pdfinfo`, `pdftoppm`, `pdfimages`) + python3.
 *
 * Usage:  node scripts/probe-pdf-export.mjs [outDir] [paper] [orientation]
 *   outDir       where the bundle and the PDF go (default: `<repo>/out/probe`;
 *                `out/` is gitignored, so nothing a run writes is committed)
 *   paper        drawing-sheet paper: A4 (default) | A3 | A2 | A1 | A0 |
 *                Plotter:<lengthMm> (914 mm roll). The BOM /
 *                Wiring Table / Cutlist pages stay A4 landscape whatever this
 *                is, which is the mixed-size merge the probe exists to check.
 *   orientation  landscape (default) | portrait
 *
 * On this machine: export PATH="/opt/homebrew/bin:$PATH"
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Repo-relative and gitignored (`out/`), so a probe run leaves the working tree
// clean without depending on any machine-specific scratch directory.
const DEFAULT_OUT = join(repo, 'out', 'probe')

const out = resolve(process.argv[2] ?? DEFAULT_OUT)
const paper = process.argv[3] ?? 'A4'
const orientation = process.argv[4] ?? 'landscape'
const pdf = join(out, `demo-${paper.toLowerCase().replace(':', '-')}-${orientation}.pdf`)

mkdirSync(out, { recursive: true })

const run = (cmd, args) => execFileSync(cmd, args, { cwd: repo, stdio: 'inherit' })

// `--external:electron` keeps the runtime's own module; `--alias:@shared` is
// the tsconfig path mapping, which esbuild does not read.
run('npx', [
  'esbuild',
  'scripts/probe/main.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--external:electron',
  '--alias:@shared=./src/shared',
  `--outfile=${join(out, 'probe.cjs')}`
])

run('npx', ['electron', join(out, 'probe.cjs'), pdf, paper, orientation])

// The picture gate, cheap half: the probe gives its first connector a housing
// part number the fixture library has a photo for, so part 0's markup must
// carry an `<image>` — exactly one, on the one drawing page. Zero is the
// regression this catches:
// the picture never reached the print path at all, which neither the page-size
// nor the scale check can see.
const part0 = readFileSync(pdf.replace(/\.pdf$/, '-part0.html'), 'utf8')
console.log(`image tags: ${part0.split('<image ').length - 1}`)

console.log(`\n--- pdfinfo (per-page MediaBox) ---`)
run('pdfinfo', ['-f', '1', '-l', '99', pdf])

// The picture gate, expensive half: an `<image>` tag Chromium could not decode
// embeds nothing, so this is what proves the bytes made it into the PDF.
console.log(`\n--- pdfimages -list (embedded images) ---`)
run('pdfimages', ['-list', pdf])

console.log(`\n--- 1:1 scale check, page 1 ---`)
run('scripts/check-pdf-scale.sh', [pdf, '1'])
