// Bundles the headless CLI (`src/cli/bin.ts`) to out/cli/harness.mjs: one ESM file for Node, with the
// `@shared` / `@renderer` aliases resolved so the CLI can reuse the store. Never pulls in electron.
import { build as esbuild } from 'esbuild'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The bare `zustand` specifier only: its `create` imports React for the hook. An esbuild
// `alias` would also capture `zustand/vanilla` and `zustand/middleware/*` (it matches
// subpaths), so an exact-match resolve plugin is used instead.
const zustandVanilla = {
  name: 'zustand-vanilla',
  setup(b) {
    b.onResolve({ filter: /^zustand$/ }, () => ({ path: join(root, 'src/cli/zustandVanilla.ts') }))
  }
}

/** `overrides` (entryPoints / stdin / outfile) lets tests bundle another entry with the same options. */
export async function build(overrides = {}) {
  const outfile = overrides.outfile ?? join(root, 'out/cli/harness.mjs')
  const entry = overrides.stdin ? { stdin: overrides.stdin } : { entryPoints: overrides.entryPoints ?? [join(root, 'src/cli/bin.ts')] }
  const result = await esbuild({
    ...entry,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile,
    alias: { '@shared': join(root, 'src/shared'), '@renderer': join(root, 'src/renderer/src') },
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module';const require = __cr(import.meta.url);"
    },
    external: ['electron', 'react', 'react-dom'],
    plugins: [zustandVanilla],
    metafile: true,
    logLevel: 'warning'
  })
  return { outfile, metafile: result.metafile }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build()
}
