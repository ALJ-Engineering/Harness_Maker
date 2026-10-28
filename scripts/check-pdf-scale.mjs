#!/usr/bin/env node
/**
 * Usage: node scripts/check-pdf-scale.mjs <drawing-set.pdf> [page]
 *
 * End-to-end 1:1 check on an exported drawing set's 1:1 drawing page:
 *   1. reports the page count and MediaBox from pdfinfo;
 *   2. rasterises the page(s) at 300 dpi and MEASURES the 100 mm scale-check bar
 *      end-tick centre to end-tick centre, in pixels (`measure_scale_bar.py`).
 *
 * 100 mm at 300 dpi = 1181.10 px, so expect 1181 px +/- 3.
 * The bar is drawn in PAGE space in the info strip along the bottom of the 1:1
 * drawing page (page 1 of the set); pass [page] to pin it. With no [page]
 * argument every page is scanned until the bar is found, which also skips the
 * A4 document pages (BOM / Wiring Table / Cutlist), that carry no bar.
 *
 * NOTE on the page size: Chromium quantises the PDF page box to 1/300 in
 * (0.24 pt), so an A4-landscape template reports 841.92 x 594.96 pts, not the
 * nominal 841.89 x 595.28.
 *
 * Needs poppler on PATH (`pdfinfo`, `pdftoppm`) and Python 3. macOS:
 * `brew install poppler`. Windows: MSYS2 `pacman -S mingw-w64-x86_64-poppler`
 * (then put `C:\msys64\mingw64\bin` on PATH) or `scoop install poppler`.
 *
 * Node rather than bash so it runs the same on Windows, where a bare `bash` is
 * often WSL's and `python3` the Microsoft Store stub. `PYTHON` overrides the
 * interpreter. Exit 0 = PASS, 1 = no bar found, 2 = bar out of tolerance.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** `[command, ...args]` of the first Python 3 that answers `--version`. */
function findPython() {
  const candidates = process.env.PYTHON
    ? [[process.env.PYTHON]]
    : process.platform === 'win32'
      ? [['py', '-3'], ['python'], ['python3']]
      : [['python3'], ['python']]
  for (const c of candidates) {
    const r = spawnSync(c[0], [...c.slice(1), '--version'], { encoding: 'utf8' })
    if (r.status === 0 && /Python 3/.test(`${r.stdout}${r.stderr}`)) return c
  }
  throw new Error('no Python 3 found — install one or set PYTHON')
}

const [pdf, pageArg] = process.argv.slice(2)
if (!pdf) {
  console.error('usage: node scripts/check-pdf-scale.mjs <drawing-set.pdf> [page]')
  process.exit(1)
}

const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' })
for (const line of info.split(/\r?\n/)) if (/^(Pages|Page size)/.test(line)) console.log(line)
const npages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0)
const pages = pageArg ? [pageArg] : Array.from({ length: npages }, (_, i) => String(i + 1))

const out = join(tmpdir(), 'harness-scale-check')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const python = findPython()

/** pdftoppm zero-pads the page number to the document's page count, so find the file by prefix. */
const raster = (p, ext) => join(out, readdirSync(out).find((f) => f.startsWith(`p${p}-`) && f.endsWith(ext)))

let status = 1
for (const p of pages) {
  // PGM (P5) is trivially parseable from the Python stdlib; the PNG is for eyeballing.
  execFileSync('pdftoppm', ['-r', '300', '-gray', '-f', p, '-l', p, pdf, join(out, `p${p}`)])
  execFileSync('pdftoppm', ['-r', '300', '-f', p, '-l', p, '-png', pdf, join(out, `p${p}`)])
  const r = spawnSync(python[0], [...python.slice(1), join(here, 'measure_scale_bar.py'), raster(p, '.pgm'), p], {
    stdio: 'inherit'
  })
  if (r.status === 0) {
    status = 0
    console.log(`PNG for visual inspection: ${raster(p, '.png')}`)
    break
  }
  // Found but out of tolerance: the measurer has already printed the FAIL, and
  // scanning on would only end in a misleading "no bar found".
  if (r.status === 2) {
    status = 2
    break
  }
}

if (status === 1) console.log(`FAIL — no 100 mm scale bar found in ${pdf}`)
process.exit(status)
