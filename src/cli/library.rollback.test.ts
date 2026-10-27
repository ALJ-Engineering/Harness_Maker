/**
 * A rollback that itself fails must come back as a structured refusal naming the failure
 * ("ROLLBACK FAILED: …"), never as a rejected promise. `removeDatasheet` is made to throw —
 * the first thing the rollback of a put with a new datasheet does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { newLibraryPart, serializeLibraryPart } from '@shared/parts/librarySchema'

vi.mock('../main/partsLibrary', async (importOriginal) => {
  const real = await importOriginal<typeof import('../main/partsLibrary')>()
  return {
    ...real,
    removeDatasheet: async () => {
      throw new Error('EPERM: simulated')
    }
  }
})

const { ensureLibraryDirs } = await import('../main/partsLibrary')
const { libraryPut } = await import('./library')

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'harness-rb-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('libraryPut rollback failure', () => {
  it('is reported as a problem in a structured result', async () => {
    const lib = join(tmp, 'lib')
    await ensureLibraryDirs(lib)
    const p = { ...newLibraryPart('pin', 'PIN-1'), datasheetUrl: 'https://x/p.pdf' } // no manufacturer → incomplete
    const rec = join(tmp, 'rec.json')
    writeFileSync(rec, serializeLibraryPart(p))
    const pdf = join(tmp, 'ds.pdf')
    writeFileSync(pdf, '%PDF-1.4\n')
    const r = await libraryPut(lib, rec, { datasheet: pdf })
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toBe('PIN-1: missing manufacturer')
    expect(r.problems[1]).toMatch(/^ROLLBACK FAILED: EPERM: simulated — check .*PIN-1\.json and its datasheet by hand$/)
  })
})
