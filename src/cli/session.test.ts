import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { demoDocument } from '@shared/model/document'
import { loadHarness, saveHarness } from './session'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'harness-session-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('save/load', () => {
  it('round-trips', async () => {
    const doc = demoDocument()
    const p = join(tmp, 'a.harness.json')
    await saveHarness(p, doc)
    const back = await loadHarness(p)
    expect(back.repairs).toEqual([])
    expect(back.doc).toEqual(doc)
    expect(readdirSync(tmp)).toEqual(['a.harness.json'])
  })
  // A wire end naming a missing cavity is NOT a reconcile repair (reconcile only drops dangling
  // routes/labels/spans/cores), so the brief's example would not trip the guard; an orphaned
  // route does, and is what the guard is for.
  it('refuses a document that would need repairs on load and writes nothing', async () => {
    const doc = demoDocument()
    doc.wireRoutes.push({ wireId: 'no-such-wire', path: [] })
    const p = join(tmp, 'b.harness.json')
    await expect(saveHarness(p, doc)).rejects.toThrow(/document would need repairs on load: .*orphaned-route/)
    expect(existsSync(p)).toBe(false)
    expect(readdirSync(tmp)).toEqual([])
  })
})
