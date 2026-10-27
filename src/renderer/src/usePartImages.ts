import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PartImage, PartImages } from '@shared/print/picture'
import { sanitisePartNumber } from '@shared/parts/images'

/** Separator for the memo key below — no part number can contain a newline. */
const KEY_SEP = '\n'

/**
 * The parts image library as the renderer sees it. `parts:listImages` keys by
 * FILE STEM (= `sanitisePartNumber(pn)`, since `39-01/3045` cannot be a
 * filename); the planner keys by the REAL part number the document carries.
 * This hook owns that translation: `images` re-keys the listing onto the part
 * numbers passed in, and everything else takes a part number and lets the main
 * process sanitise it.
 *
 * `byStem` is the raw listing, exposed so a caller can ask "does the library
 * hold this stem at all" without re-listing.
 *
 * `logo` rides along: the library's `branding/logo.*` for the title block,
 * reloaded with the listing.
 *
 * The listing is reloaded on mount, whenever the main process reports a
 * settings change (the folder moved), whenever any window mutates the parts
 * LIBRARY (`<lib>/images` is part of it — a picture dropped in from the
 * library dialog or another window must show up here too), on window focus (a
 * colleague may have edited the folder from Finder), and after every mutation
 * this hook itself makes, so two windows converge without a restart.
 */
export function usePartImages(partNumbers: readonly string[]): {
  images: PartImages
  byStem: Record<string, PartImage>
  dir: string | null
  /** The title-block logo (`<library>/branding/logo.*`) as a data URL, or null. */
  logo: string | null
  refresh: () => Promise<void>
  importFor: (partNumber: string, srcPath?: string) => Promise<void>
  remove: (partNumber: string) => Promise<void>
  chooseDir: () => Promise<void>
} {
  const [byStem, setByStem] = useState<Record<string, PartImage>>({})
  const [dir, setDir] = useState<string | null>(null)
  const [logo, setLogo] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setDir(await window.api.partsGetImageDir())
    setLogo(await window.api.libraryLogoDataUrl())
    const next = await window.api.partsListImages()
    // A window-focus re-list commonly finds nothing changed. Keep the old object
    // then: a new one rebuilds `images`, which re-projects and re-seeds every
    // canvas — and that re-seed landing in the same commit as a click's
    // selection is what used to send the panes into error #185 (see
    // HarnessPane's re-seed). Same bail-out as `usePartsLibrary`.
    setByStem((prev) => (JSON.stringify(next) === JSON.stringify(prev) ? prev : next))
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

  // Keyed by the part numbers this document uses. The memo depends on the
  // JOINED list rather than the array: `App.tsx` derives that array from `doc`,
  // so an identity dep would rebuild `images` — and with it re-seed the whole
  // canvas — on every keystroke that touches the document.
  const key = partNumbers.join(KEY_SEP)
  const images = useMemo<PartImages>(() => {
    const out: PartImages = {}
    for (const pn of key ? key.split(KEY_SEP) : []) {
      const v = byStem[sanitisePartNumber(pn)]
      if (v) out[pn] = v
    }
    return out
  }, [byStem, key])

  const importFor = useCallback(
    async (pn: string, srcPath?: string) => {
      // A rejected import (not a regular file / over 5 MB / not PNG or JPEG)
      // comes back as `{ error }` rather than throwing, because every call site
      // is a fire-and-forget `void parts.importFor(...)`. Say so — silently
      // doing nothing is indistinguishable from a broken feature.
      const r = await window.api.partsImportImage(pn, srcPath)
      await refresh()
      if (r && 'error' in r) window.alert(`Picture not imported: ${r.error}`)
    },
    [refresh]
  )
  const remove = useCallback(
    async (pn: string) => {
      await window.api.partsRemoveImage(pn)
      await refresh()
    },
    [refresh]
  )
  const chooseDir = useCallback(async () => {
    await window.api.libraryChooseDir()
    await refresh()
  }, [refresh])

  return { images, byStem, dir, logo, refresh, importFor, remove, chooseDir }
}

/** The hook's result, as the panel and the canvas take it. */
export type PartImageLibrary = ReturnType<typeof usePartImages>
