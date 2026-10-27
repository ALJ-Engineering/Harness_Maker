import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, copyFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import { newLibraryPart } from '@shared/parts/librarySchema'
// @ts-expect-error plain .mjs build script
import { build } from '../../scripts/build-cli.mjs'
import { full, makeLibrary } from './testLibrary'

type Built = { outfile: string; metafile: { inputs: Record<string, unknown> } }

/** The no-electron / no-react / no-Electron-bound-module rules, on one built bundle. */
function expectHeadless({ outfile, metafile }: Built): void {
  expect(existsSync(outfile)).toBe(true)
  const inputs = Object.keys(metafile.inputs)
  expect(inputs.filter((i) => /node_modules\/(electron|react|react-dom|@xyflow)\//.test(i))).toEqual([])
  expect(inputs.filter((i) => /(fileOps|partsLibraryIpc|partsImagesIpc)\.ts$/.test(i))).toEqual([])
  const text = readFileSync(outfile, 'utf8')
  for (const m of ['electron', 'react', 'react-dom']) {
    expect(text).not.toMatch(new RegExp(`from\\s*["']${m}["']`))
    expect(text).not.toMatch(new RegExp(`import\\s*["']${m}["']`))
    expect(text).not.toMatch(new RegExp(`require\\(["']${m}["']\\)`))
  }
}

/** A bundle that really reaches the store: applyOps + openLibrary, same build options as the CLI. */
const buildApply = (): Promise<Built> =>
  build({
    stdin: {
      contents: "export { applyOps } from './apply'\nexport { openLibrary } from './session'\n",
      resolveDir: __dirname,
      sourcefile: 'apply-entry.ts',
      loader: 'ts'
    },
    outfile: resolve(__dirname, '../../out/cli-test/apply.mjs')
  })

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'harness-bundle-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('CLI bundle', () => {
  it('builds out/cli/harness.mjs without electron, react or the Electron-bound modules', async () => {
    const b = (await build()) as Built
    expect(b.outfile).toBe(resolve(__dirname, '../../out/cli/harness.mjs'))
    expectHeadless(b)
  }, 60000)

  it('a bundle reaching the store (apply.ts) stays headless: zustand is the vanilla shim, middleware is real', async () => {
    const b = await buildApply()
    expectHeadless(b)
    const inputs = Object.keys(b.metafile.inputs)
    expect(inputs.some((i) => i.endsWith('src/renderer/src/store.ts'))).toBe(true)
    expect(inputs.some((i) => i.endsWith('src/cli/zustandVanilla.ts'))).toBe(true)
    expect(inputs.some((i) => /node_modules\/zustand\/esm\/vanilla\.mjs$/.test(i))).toBe(true)
    expect(inputs.some((i) => /node_modules\/zustand\/esm\/middleware\/immer\.mjs$/.test(i))).toBe(true)
    expect(inputs.some((i) => /node_modules\/zustand\/esm\/(index|react)\.mjs$/.test(i))).toBe(false)
  }, 60000)

  it('the built bundle runs applyOps through the store under plain node, outside the repo', async () => {
    const b = await buildApply()
    // Copied out of the repo so a stray external import (react) could not resolve from node_modules.
    const bundle = join(tmp, 'apply.mjs')
    copyFileSync(b.outfile, bundle)
    const hsg = full(newLibraryPart('connector', 'HSG-2'))
    hsg.connector = { cavities: [{ position: '1' }, { position: '2' }] }
    await makeLibrary(tmp, [hsg], ['HSG-2'])
    const file = join(tmp, 'smoke.harness.json')
    const script = `
      const m = await import(${JSON.stringify(pathToFileURL(bundle).href)})
      const lib = await m.openLibrary(${JSON.stringify(join(tmp, 'lib'))})
      const r = await m.applyOps(${JSON.stringify(file)}, [{ op: 'place', kind: 'connector', partNumber: 'HSG-2' }], lib, { create: true })
      console.log(JSON.stringify(r))`
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: tmp, encoding: 'utf8' })
    expect(JSON.parse(out.trim())).toEqual({ ok: true, summary: ['placed connector X1 (HSG-2)'] })
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    expect(doc.connectors).toHaveLength(1)
    expect(doc.connectors[0]).toMatchObject({ designator: 'X1', housing: { partNumber: 'HSG-2' } })
    expect(doc.placements[0].schematicPos).toEqual({ x: 0, y: 0 })
  }, 60000)
})
