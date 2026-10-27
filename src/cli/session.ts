import { readFile, writeFile, rm } from 'fs/promises'
import type { HarnessDocument } from '@shared/model/schema'
import { parseDocument, parseDocumentWithNotes, serializeDocument } from '@shared/model/serialize'
import { reconcileDocument, type Repair } from '@shared/model/reconcile'
import { LibraryCatalog } from '@shared/parts/catalog'
import { listParts } from '../main/partsLibrary'
import { renameWithRetry } from '../main/renameRetry'

/** Parse + reconcile, exactly as the editor's `loadFromText` does (copied, not imported). */
export async function loadHarness(
  path: string
): Promise<{ doc: HarnessDocument; repairs: Repair[]; migrated: string[] }> {
  const text = await readFile(path, 'utf8')
  const { doc: onDisk, migrated } = parseDocumentWithNotes(text)
  const { doc, repairs } = reconcileDocument(onDisk)
  return { doc, repairs, migrated }
}

/** Refuses a document the editor would have to repair on open; writes atomically. */
export async function saveHarness(path: string, doc: HarnessDocument): Promise<void> {
  const text = serializeDocument(doc)
  const { repairs } = reconcileDocument(parseDocument(text))
  if (repairs.length > 0) {
    throw new Error(`document would need repairs on load: ${repairs.map((r) => JSON.stringify(r)).join('; ')}`)
  }
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(tmp, text, 'utf8')
    await renameWithRetry(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}

export interface LibraryContext {
  dir: string
  catalog: LibraryCatalog
  /** File stems (sanitisePartNumber) that have a datasheets/<stem>.pdf. */
  datasheets: Set<string>
  /** Record files under `parts/` that exist but did not load (file name, error) — never dropped. */
  errors: { file: string; error: string }[]
}

export async function openLibrary(dir: string): Promise<LibraryContext> {
  const listing = await listParts(dir)
  return { dir, catalog: new LibraryCatalog(listing.parts), datasheets: listing.datasheets, errors: listing.errors }
}
