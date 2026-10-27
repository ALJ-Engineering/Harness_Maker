import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { renameWithRetry } from './renameRetry'

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

/** A rename that throws `codes` in turn, then succeeds; `calls` counts every attempt. */
function flaky(codes: string[]): { rename: (a: string, b: string) => Promise<void>; calls: () => number } {
  let n = 0
  return {
    rename: async () => {
      const code = codes[n++]
      if (code) throw errno(code)
    },
    calls: () => n
  }
}

describe('renameWithRetry', () => {
  it('renames over an existing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rr-'))
    try {
      await writeFile(join(dir, 'a.tmp'), 'new')
      await writeFile(join(dir, 'a'), 'old')
      await renameWithRetry(join(dir, 'a.tmp'), join(dir, 'a'))
      expect(await readFile(join(dir, 'a'), 'utf8')).toBe('new')
      expect(await readdir(dir)).toEqual(['a'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('on Windows, retries a held target until it is released', async () => {
    const f = flaky(['EPERM', 'EBUSY', 'EACCES'])
    await renameWithRetry('a', 'b', { platform: 'win32', rename: f.rename })
    expect(f.calls()).toBe(4)
  })

  it('on Windows, gives up after the last retry and throws that error', async () => {
    const f = flaky(new Array(20).fill('EPERM'))
    await expect(renameWithRetry('a', 'b', { platform: 'win32', rename: f.rename })).rejects.toThrow('EPERM')
    expect(f.calls()).toBe(8)
  })

  it('never retries an error a held file does not cause', async () => {
    const f = flaky(['ENOENT'])
    await expect(renameWithRetry('a', 'b', { platform: 'win32', rename: f.rename })).rejects.toThrow('ENOENT')
    expect(f.calls()).toBe(1)
  })

  it('off Windows, is a plain rename', async () => {
    const f = flaky(['EPERM'])
    await expect(renameWithRetry('a', 'b', { platform: 'darwin', rename: f.rename })).rejects.toThrow('EPERM')
    expect(f.calls()).toBe(1)
  })
})
