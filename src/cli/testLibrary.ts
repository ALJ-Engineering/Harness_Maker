/**
 * Test-only helper (imported by `*.test.ts` only, never by the CLI entry): a
 * throwaway parts library folder under `tmp` with `parts` written and a stub
 * PDF imported as the datasheet of every part number in `withDatasheets`.
 */
import { writeFileSync } from 'fs'
import { join } from 'path'
import { writePart, importDatasheet, ensureLibraryDirs } from '../main/partsLibrary'
import type { LibraryPart } from '@shared/parts/librarySchema'
import { openLibrary, type LibraryContext } from './session'

/** `p` with the fields every complete record needs (manufacturer, datasheet URL). */
export const full = (p: LibraryPart): LibraryPart => ({ ...p, manufacturer: 'TE', datasheetUrl: 'https://x/ds.pdf' })

export async function makeLibrary(tmp: string, parts: LibraryPart[], withDatasheets: string[]): Promise<LibraryContext> {
  const dir = join(tmp, 'lib')
  await ensureLibraryDirs(dir)
  for (const p of parts) await writePart(dir, p)
  const pdf = join(tmp, 'stub-datasheet.pdf')
  writeFileSync(pdf, '%PDF-1.4\n%%EOF\n')
  for (const pn of withDatasheets) await importDatasheet(dir, pn, pdf)
  return openLibrary(dir)
}
