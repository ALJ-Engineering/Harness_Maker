import type { LibraryCatalog } from '@shared/parts/catalog'

/**
 * An opened parts library: what the rails, `check` and the op runner read. Kept
 * apart from `session.ts` (which builds one from disk) so the app's renderer can
 * build one from its own listing without type-importing an fs module.
 */
export interface LibraryContext {
  dir: string
  catalog: LibraryCatalog
  /** File stems (sanitisePartNumber) that have a datasheets/<stem>.pdf. */
  datasheets: Set<string>
  /** Record files under `parts/` that exist but did not load (file name, error) — never dropped. */
  errors: { file: string; error: string }[]
}
