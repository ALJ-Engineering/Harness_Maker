import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import type { HarnessDocument } from '@shared/model/schema'
import { emptyDocument } from '@shared/model/document'
import type { CliIO } from './io'
import { resolveLibrary, libraryDirExists, type LibrarySource } from './libraryDir'
import { loadHarness, saveHarness, openLibrary, type LibraryContext } from './session'
import { parseOps } from './ops'
import { applyOps } from './apply'
import { checkDocument, formatCheck } from './check'
import { showDocument } from './show'
import { libraryPut, libraryShow, librarySearch, formatHit } from './library'
import { resolveMcpPort, runMcpBridge } from './mcpBridge'

export const USAGE = `harness - create and edit wire-harness files headlessly

Usage:
  harness <command> [options]

Commands:
  new <file>                         start an empty harness file (refuses an existing one)
  apply <file> <ops.json | -> [--create]
                                     apply an all-or-nothing batch of operations ('-' reads stdin)
  check <file>                       DRC findings, wiring table, connector pinouts, incomplete parts
  show <file>                        bodies by designator with part numbers, wire count, cables
  library put <record.json> [--datasheet <pdf path | https url>] [--picture <png/jpg path | https url>]
                                     add or replace a part record (refused unless complete)
  library show <partNumber>          one record, its datasheet and picture, and what it lacks
  library search <text>              find records by part number, manufacturer or description
  library dir                        the parts library folder in use, where it came from, whether it exists
  mcp [--port <n>]                   stdio MCP server bridged to the running app's Agent access (for Claude Desktop)

Options:
  --help, -h      show this help
  --library <dir> parts library folder (else $HARNESS_LIBRARY, else the app's setting)
  --json          print one JSON object instead of text
  --create        (apply) start a new file instead of editing one
  --datasheet <x> (library put) datasheet PDF path or URL
  --picture <x>   (library put) the part's picture: a PNG or JPEG (at most 5 MB) path or URL
  --port <n>      (mcp) the app's MCP port (else $HARNESS_MCP_PORT, else the app's setting, else 47100)

Exit codes: 0 ok, 1 refused or failed, 2 usage error.
With --json every refusal (exit 1) prints { "ok": false, "errors": [...] } on stdout; usage errors (exit 2) always go to stderr.
'harness <command> --help' prints this text.
`

const NO_LIBRARY = 'harness: no parts library folder — pass --library or set HARNESS_LIBRARY'

interface Parsed {
  positional: string[]
  flags: Map<string, string | true>
}

/** `--name value` flags (value flags listed in `valued`), `--name` booleans, and positionals. A lone `-` is positional. */
function parseArgs(args: string[], valued: string[]): Parsed | { error: string } {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const name = a.slice(2)
      if (valued.includes(name)) {
        const v = args[++i]
        if (v === undefined) return { error: `--${name} needs a value` }
        flags.set(name, v)
      } else if (['json', 'create'].includes(name)) flags.set(name, true)
      else return { error: `unknown option '${a}'` }
    } else positional.push(a)
  }
  return { positional, flags }
}

/** One refusal path: JSON mode puts `{ ok: false, errors }` on stdout, text mode one line per error on stderr. Returns 1. */
function refuse(json: boolean, io: CliIO, errors: string[]): number {
  const clean = errors.map((e) => e.replace(/^harness: /, ''))
  if (json) io.out(JSON.stringify({ ok: false, errors: clean }))
  else for (const e of clean) io.err(`harness: ${e}`)
  return 1
}

const usageError = (io: CliIO, msg: string): number => {
  io.err(`harness: ${msg}\n\n${USAGE}`)
  return 2
}

type Command = (args: string[], io: CliIO) => Promise<number>

/** The library when one resolves; `null` otherwise (check/show/new treat it as optional). */
async function libraryFor(p: Parsed, io: CliIO): Promise<{ dir: string; source: LibrarySource; exists: boolean } | null> {
  const r = await resolveLibrary(p.flags.get('library') as string | undefined, io)
  return r ? { ...r, exists: await libraryDirExists(r.dir) } : null
}

/** A configured folder that is not there would list as an EMPTY library (every part "not in library"). */
const missingLibrary = (dir: string): string => `parts library folder ${dir} does not exist`

const asJson = (p: Parsed) => p.flags.get('json') === true

const newCmd: Command = async (args, io) => {
  const p = parseArgs(args, ['library'])
  if ('error' in p) return usageError(io, p.error)
  if (p.positional.length !== 1) return usageError(io, 'new needs exactly one <file>')
  const [file] = p.positional
  if (existsSync(file)) {
    return refuse(asJson(p), io, [`${file} already exists; new will not overwrite it`])
  }
  try {
    await saveHarness(file, emptyDocument())
  } catch (e) {
    return refuse(asJson(p), io, [`cannot write ${file}: ${(e as Error).message}`])
  }
  if (asJson(p)) io.out(JSON.stringify({ ok: true, file }))
  else io.out(`created ${file}`)
  return 0
}

const applyCmd: Command = async (args, io) => {
  const p = parseArgs(args, ['library'])
  if ('error' in p) return usageError(io, p.error)
  if (p.positional.length !== 2) return usageError(io, 'apply needs <file> and <ops.json | ->')
  const [file, opsSrc] = p.positional
  const json = asJson(p)
  const fail = (errors: string[]): number => refuse(json, io, errors)
  const libRef = await libraryFor(p, io)
  if (!libRef) return fail([NO_LIBRARY.replace('harness: ', '')])
  if (!libRef.exists) return fail([missingLibrary(libRef.dir)])
  let text: string
  try {
    text = opsSrc === '-' ? await io.readStdin() : await readFile(opsSrc, 'utf8')
  } catch (e) {
    return fail([`cannot read ops ${opsSrc}: ${(e as Error).message}`])
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return fail([`ops are not valid JSON: ${(e as Error).message}`])
  }
  const ops = parseOps(raw)
  if ('error' in ops) return fail([ops.error])
  let lib: LibraryContext
  try {
    lib = await openLibrary(libRef.dir)
  } catch (e) {
    return fail([`cannot open parts library ${libRef.dir}: ${(e as Error).message}`])
  }
  const r = await applyOps(file, ops, lib, { create: p.flags.get('create') === true })
  if (!r.ok) return fail(r.errors)
  if (json) io.out(JSON.stringify({ ok: true, summary: r.summary }))
  else io.out(r.summary.length ? r.summary.join('\n') : 'no operations')
  return 0
}

type Loaded = { doc: HarnessDocument; repairs: string[]; migrated: string[] }

async function open(file: string, io: CliIO, json: boolean): Promise<Loaded | null> {
  try {
    const l = await loadHarness(file)
    return { doc: l.doc, repairs: l.repairs.map((r) => r.message), migrated: l.migrated }
  } catch (e) {
    refuse(json, io, [`cannot open ${file}: ${(e as Error).message}`])
    return null
  }
}

const checkCmd: Command = async (args, io) => {
  const p = parseArgs(args, ['library'])
  if ('error' in p) return usageError(io, p.error)
  if (p.positional.length !== 1) return usageError(io, 'check needs exactly one <file>')
  const loaded = await open(p.positional[0], io, asJson(p))
  if (!loaded) return 1
  const { doc } = loaded
  const libRef = await libraryFor(p, io)
  let lib: LibraryContext | null = null
  const notes: string[] = []
  if (libRef && !libRef.exists) notes.push(`${missingLibrary(libRef.dir)}; incomplete parts were not computed`)
  else if (libRef) {
    try {
      lib = await openLibrary(libRef.dir)
    } catch (e) {
      return refuse(asJson(p), io, [`cannot open parts library ${libRef.dir}: ${(e as Error).message}`])
    }
  }
  const result = { ...checkDocument(doc, lib), repairs: loaded.repairs, migrated: loaded.migrated, notes }
  io.out(asJson(p) ? JSON.stringify(result) : formatCheck(result))
  return 0
}

const showCmd: Command = async (args, io) => {
  const p = parseArgs(args, ['library'])
  if ('error' in p) return usageError(io, p.error)
  if (p.positional.length !== 1) return usageError(io, 'show needs exactly one <file>')
  const loaded = await open(p.positional[0], io, asJson(p))
  if (!loaded) return 1
  const { bodies, wireCount, cables } = showDocument(loaded.doc)
  if (asJson(p)) {
    io.out(JSON.stringify({ bodies, wireCount, cables }))
    return 0
  }
  const lines = bodies.map((b) => `${b.designator.padEnd(6)} ${b.kind.padEnd(10)} ${b.partNumber || '(no part)'}`)
  if (!lines.length) lines.push('(no bodies)')
  lines.push(`wires: ${wireCount}`)
  lines.push(
    cables.length
      ? `cables: ${cables.map((c) => `${c.name} (${c.partNumber || 'no part'}, ${c.cores} cores)`).join(', ')}`
      : 'cables: none'
  )
  io.out(lines.join('\n'))
  return 0
}

const libraryCmd: Command = async (args, io) => {
  const [sub, ...rest] = args
  if (sub !== 'put' && sub !== 'show' && sub !== 'search' && sub !== 'dir')
    return usageError(io, `library needs a subcommand: put, show, search or dir`)
  const p = parseArgs(rest, ['library', 'datasheet', 'picture'])
  if ('error' in p) return usageError(io, p.error)
  if (sub === 'dir') {
    if (p.positional.length !== 0) return usageError(io, 'library dir takes no arguments')
    const r = await libraryFor(p, io)
    if (!r) return refuse(asJson(p), io, [NO_LIBRARY])
    if (asJson(p)) io.out(JSON.stringify({ dir: r.dir, source: r.source, exists: r.exists }))
    else io.out(`${r.dir}\nfrom: ${r.source}\n${r.exists ? 'exists' : 'does NOT exist'}`)
    return 0
  }
  if (p.positional.length !== 1)
    return usageError(io, `library ${sub} needs exactly one ${sub === 'put' ? '<record.json>' : sub === 'show' ? '<partNumber>' : '<text>'}`)
  const json = asJson(p)
  const libRef = await libraryFor(p, io)
  if (!libRef) return refuse(json, io, [NO_LIBRARY])
  if (!libRef.exists) return refuse(json, io, [missingLibrary(libRef.dir)])
  const [arg] = p.positional
  if (sub === 'put') {
    const r = await libraryPut(libRef.dir, arg, {
      datasheet: p.flags.get('datasheet') as string | undefined,
      picture: p.flags.get('picture') as string | undefined
    })
    if (!r.ok) return refuse(json, io, r.problems)
    io.out(json ? JSON.stringify(r) : `${r.created ? 'added' : 'replaced'} ${r.partNumber}`)
    return 0
  }
  if (sub === 'show') {
    const r = await libraryShow(libRef.dir, arg)
    if (!r) return refuse(json, io, [`${arg}: not in library`])
    if ('unreadable' in r) return refuse(json, io, [`${arg}: present but unreadable: ${r.unreadable}`])
    if (json) io.out(JSON.stringify(r))
    else {
      io.out(
        [
          JSON.stringify(r.part, null, 2),
          `datasheet file: ${r.hasDatasheet ? 'yes' : 'no'}`,
          `picture: ${r.hasPicture ? 'yes' : 'no'}`,
          r.incomplete.length ? `incomplete:\n${r.incomplete.map((x) => `  ${x}`).join('\n')}` : 'complete'
        ].join('\n')
      )
    }
    return 0
  }
  const { hits, unreadable } = await librarySearch(libRef.dir, arg)
  if (json) io.out(JSON.stringify({ hits, unreadable }))
  else {
    io.out(hits.length ? hits.map(formatHit).join('\n') : 'no matches')
    if (unreadable.length)
      io.out(`unreadable record files (not searched):\n${unreadable.map((u) => `  ${u.file}: ${u.error}`).join('\n')}`)
  }
  return 0
}

/** Runs until stdin closes; stdout is JSON-RPC only, so every problem before that is a usage error on stderr. */
const mcpCmd: Command = async (args, io) => {
  const p = parseArgs(args, ['port'])
  if ('error' in p) return usageError(io, p.error)
  if (p.positional.length !== 0) return usageError(io, 'mcp takes no arguments')
  const port = await resolveMcpPort(p.flags.get('port') as string | undefined, io)
  if (typeof port !== 'number') return usageError(io, port.error)
  return runMcpBridge(port, io)
}

const COMMANDS: Record<string, Command> = {
  new: newCmd,
  apply: applyCmd,
  check: checkCmd,
  show: showCmd,
  library: libraryCmd,
  mcp: mcpCmd
}

export async function main(argv: string[], io: CliIO): Promise<number> {
  const [cmd, ...rest] = argv
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    io.out(USAGE)
    return 0
  }
  const run = COMMANDS[cmd]
  if (!run) {
    io.err(`harness: unknown command '${cmd}'\n\n${USAGE}`)
    return 2
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    io.out(USAGE)
    return 0
  }
  return run(rest, io)
}
