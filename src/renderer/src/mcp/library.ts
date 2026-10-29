import { LibraryCatalog } from '@shared/parts/catalog'
import type { LibraryContext } from '../../../cli/libraryContext'

/**
 * The parts library as the MCP tools read it: listed from disk on every call,
 * the way the CLI opens it per run, so a record written a moment ago (by
 * `library_put`, the library dialog or a colleague) is already there. Null when
 * no folder is set.
 */
export async function listLibrary(): Promise<LibraryContext | null> {
  const dir = await window.api.libraryGetDir()
  if (!dir) return null
  const l = await window.api.libraryList()
  return { dir, catalog: new LibraryCatalog(l.parts), datasheets: new Set(l.datasheets), errors: l.errors }
}
