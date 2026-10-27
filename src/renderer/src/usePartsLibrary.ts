import { useCallback, useEffect, useMemo, useState } from 'react'
import { LibraryCatalog } from '@shared/parts/catalog'
import { sanitisePartNumber } from '@shared/parts/images'
import type { LibraryPart } from '@shared/parts/librarySchema'

/**
 * `LibraryListingDto` is declared in `env.d.ts`, which ends in `export {}` and
 * so is a module — the interface is not visible by name outside that file.
 * Deriving it from the bridge method's own return type sidesteps that without
 * duplicating the shape here.
 */
type Listing = Awaited<ReturnType<typeof window.api.libraryList>>

/** The parts library as the renderer sees it, as `runDrc` and the (future) library dialog take it. */
export interface PartsLibrary {
  dir: string | null
  parts: LibraryPart[]
  byPn: Map<string, LibraryPart>
  datasheets: Set<string> // stems
  errors: { file: string; error: string }[]
  catalog: LibraryCatalog | undefined // undefined when no dir
  resolve: (pn: string) => LibraryPart | undefined
  hasDatasheet: (pn: string) => boolean
  refresh: () => Promise<void>
  chooseDir: () => Promise<void>
  write: (p: LibraryPart) => Promise<string | null> // error message or null
  remove: (pn: string, withFiles: boolean) => Promise<void>
  importDatasheet: (pn: string, srcPath?: string) => Promise<void>
  openDatasheet: (pn: string) => Promise<void>
  removeDatasheet: (pn: string) => Promise<void>
}

/**
 * The parts library as the renderer sees it: the whole folder listed into
 * memory (hundreds of parts, not millions), re-listed on mount, on
 * `settings:changed` / `library:changed` from main, on window focus (a
 * colleague may have pushed to the shared folder) and after every mutation.
 * `catalog` is what `runDrc` takes; it is undefined without a folder so a
 * fresh install is not flooded with "unresolved part" warnings.
 */
export function usePartsLibrary(): PartsLibrary {
  const [dir, setDir] = useState<string | null>(null)
  const [listing, setListing] = useState<Listing>({ parts: [], datasheets: [], errors: [] })

  const refresh = useCallback(async () => {
    setDir(await window.api.libraryGetDir())
    const next = await window.api.libraryList()
    // A window-focus re-list commonly finds nothing changed. Bail out of the
    // state update (rather than always calling `setListing(next)`) so an
    // unchanged listing does not re-render the app or rebuild `catalog` —
    // which would otherwise re-run `runDrc` on every alt-tab back to the app.
    setListing((prev) => (JSON.stringify(next) === JSON.stringify(prev) ? prev : next))
  }, [])

  useEffect(() => {
    void refresh()
    const offSettings = window.api.onSettingsChanged(() => void refresh())
    const offLib = window.api.onLibraryChanged(() => void refresh())
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      offSettings()
      offLib()
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  const byPn = useMemo(() => new Map(listing.parts.map((p) => [p.partNumber, p])), [listing.parts])
  const datasheets = useMemo(() => new Set(listing.datasheets), [listing.datasheets])
  const catalog = useMemo(() => (dir ? new LibraryCatalog(listing.parts) : undefined), [dir, listing.parts])

  const after = useCallback(
    async <T,>(p: Promise<T>): Promise<T> => {
      const r = await p
      await refresh()
      return r
    },
    [refresh]
  )

  return {
    dir,
    parts: listing.parts,
    byPn,
    datasheets,
    errors: listing.errors,
    catalog,
    resolve: useCallback((pn: string) => byPn.get(pn), [byPn]),
    hasDatasheet: useCallback(
      (pn: string) => datasheets.has(sanitisePartNumber(pn)) || !!byPn.get(pn)?.datasheetUrl,
      [datasheets, byPn]
    ),
    refresh,
    chooseDir: useCallback(async () => {
      await after(window.api.libraryChooseDir())
    }, [after]),
    write: useCallback(
      async (p: LibraryPart) => {
        const r = await after(window.api.libraryWritePart(p))
        return 'error' in r ? r.error : null
      },
      [after]
    ),
    remove: useCallback(
      async (pn: string, withFiles: boolean) => {
        await after(window.api.libraryDeletePart(pn, withFiles))
      },
      [after]
    ),
    importDatasheet: useCallback(
      async (pn: string, srcPath?: string) => {
        const r = await after(window.api.libraryImportDatasheet(pn, srcPath))
        if (r && 'error' in r) window.alert(`Datasheet not imported: ${r.error}`)
      },
      [after]
    ),
    openDatasheet: useCallback(async (pn: string) => {
      const r = await window.api.libraryOpenDatasheet(pn)
      if ('error' in r) window.alert(`Cannot open datasheet: ${r.error}`)
    }, []),
    removeDatasheet: useCallback(
      async (pn: string) => {
        await after(window.api.libraryRemoveDatasheet(pn))
      },
      [after]
    )
  }
}
