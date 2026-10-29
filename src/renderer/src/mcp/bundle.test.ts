import { describe, it, expect } from 'vitest'
import { join, resolve } from 'path'
import { build } from 'esbuild'

const root = resolve(__dirname, '../../../..')

describe('MCP document tools bundle', () => {
  // The tools reuse the CLI's grammar, rails, check and op runner from src/cli/. Those modules
  // must stay fs-free: the renderer has no Node. A browser build fails on any Node builtin.
  it('bundles for the browser with nothing from Node or the fs-bound CLI modules', async () => {
    const r = await build({
      entryPoints: [join(root, 'src/renderer/src/mcp/tools.ts')],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      alias: { '@shared': join(root, 'src/shared'), '@renderer': join(root, 'src/renderer/src') },
      metafile: true,
      logLevel: 'silent'
    })
    const inputs = Object.keys(r.metafile.inputs)
    expect(inputs.some((i) => i.endsWith('src/cli/batch.ts'))).toBe(true)
    expect(inputs.filter((i) => /src\/main\/|src\/cli\/(session|library|libraryDir|apply|io|main|bin)\.ts$/.test(i))).toEqual([])
  }, 60000)
})
