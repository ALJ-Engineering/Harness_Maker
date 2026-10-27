import { existsSync } from 'fs'
import type { HarnessDocument } from '@shared/model/schema'
import { emptyDocument } from '@shared/model/document'
import { useHarnessStore } from '../renderer/src/store'
import { loadHarness, saveHarness } from './session'
import type { LibraryContext } from './libraryContext'
import { runOps } from './batch'
import type { Op } from './ops'

export { parseColor, colorRail } from './batch'

/**
 * Apply an ops batch to a harness file, all or nothing: load (or start empty
 * with `create`), run every op through the store in order (`runOps`, which
 * holds the rails), stop at the first refusal, and save only when every op
 * succeeded. A refusal leaves the file on disk untouched (byte-identical; with
 * `create`, no file at all).
 */
export async function applyOps(
  path: string,
  ops: Op[],
  lib: LibraryContext,
  opts: { create: boolean }
): Promise<{ ok: true; summary: string[] } | { ok: false; errors: string[] }> {
  const summary: string[] = []
  let doc: HarnessDocument
  if (opts.create) {
    if (existsSync(path)) return { ok: false, errors: [`${path} already exists; --create only starts a new file (it would overwrite the existing work) — edit it without --create`] }
    doc = emptyDocument()
  } else {
    try {
      const loaded = await loadHarness(path)
      doc = loaded.doc
      for (const r of loaded.repairs) summary.push(`note: repaired on load: ${r.message}`)
      for (const m of loaded.migrated) summary.push(`note: migrated on load: ${m}`)
    } catch (e) {
      return { ok: false, errors: [`cannot read ${path}: ${(e as Error).message}`] }
    }
  }
  // The CLI never writes drawing.sheetOrigin (spec §1) — the app pins it on first open.
  useHarnessStore.getState().setDocument(doc, path, undefined, { pinSheetOrigin: false })

  const run = runOps(ops, lib)
  if (!run.ok) return refuse(run.errors)
  try {
    await saveHarness(path, S().doc)
  } catch (e) {
    return refuse([`save refused: ${(e as Error).message}`])
  }
  return { ok: true, summary: [...summary, ...run.summary] }
}

const S = () => useHarnessStore.getState()

/** A refused batch must not leave its half-applied document (or its history) in the store singleton. */
function refuse(errors: string[]): { ok: false; errors: string[] } {
  S().setDocument(emptyDocument(), null, undefined, { pinSheetOrigin: false })
  return { ok: false, errors }
}
