import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CliIO } from './io'
import { main } from './main'
import { resolveMcpPort } from './mcpBridge'

let tmp: string
let out: string[]
let err: string[]
let http: Server
let port: number
let posts: { body: string; headers: Record<string, unknown> }[]

const io = (lines: string[], env: Record<string, string | undefined> = {}): CliIO => ({
  out: (s) => out.push(s),
  err: (s) => err.push(s),
  env,
  home: tmp,
  platform: 'darwin',
  readStdin: async () => '',
  stdinLines: async function* () {
    yield* lines
  }
})

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'harness-mcp-bridge-'))
  out = []
  err = []
  posts = []
  // A stand-in for the app's server: requests get a JSON answer (pretty-printed, to check the
  // bridge re-lines it), notifications a bare 202, and `boom` a plain-text 403.
  http = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      posts.push({ body, headers: req.headers })
      const msg = JSON.parse(body)
      if (msg.method === 'boom') return void res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden')
      if (msg.id === undefined) return void res.writeHead(202).end()
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echo: msg.method } }, null, 2))
    })
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  port = (http.address() as AddressInfo).port
})
afterEach(async () => {
  await new Promise((r) => http.close(r))
  rmSync(tmp, { recursive: true, force: true })
})

const rpc = (o: object) => JSON.stringify({ jsonrpc: '2.0', ...o })

describe('harness mcp (stdio bridge)', () => {
  it('forwards each line as one POST and writes each answer as one line', async () => {
    const lines = [rpc({ id: 1, method: 'initialize' }), rpc({ method: 'notifications/initialized' }), '', rpc({ id: 2, method: 'tools/list' })]
    expect(await main(['mcp', '--port', String(port)], io(lines))).toBe(0)
    expect(posts.map((p) => JSON.parse(p.body).method)).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    expect(posts[0].headers.accept).toBe('application/json, text/event-stream')
    expect(out.map((l) => JSON.parse(l)).sort((a, b) => a.id - b.id)).toEqual([
      { jsonrpc: '2.0', id: 1, result: { echo: 'initialize' } },
      { jsonrpc: '2.0', id: 2, result: { echo: 'tools/list' } }
    ])
    expect(out.every((l) => !l.includes('\n'))).toBe(true)
    expect(err).toEqual([])
  })

  it('answers a request with a JSON-RPC error when the app is not there, and drops a notification', async () => {
    await new Promise((r) => http.close(r))
    const code = await main(['mcp', '--port', String(port)], io([rpc({ id: 7, method: 'tools/list' }), rpc({ method: 'notifications/initialized' })]))
    expect(code).toBe(0)
    expect(out).toHaveLength(1)
    const e = JSON.parse(out[0])
    expect(e).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32000 } })
    expect(e.error.message).toMatch(/not running, or its Agent access is off/)
    http = createServer() // afterEach closes it
  })

  it('turns a non-JSON refusal into a JSON-RPC error, and junk input into a parse error', async () => {
    await main(['mcp', '--port', String(port)], io([rpc({ id: 3, method: 'boom' }), '{not json']))
    const msgs = out.map((l) => JSON.parse(l))
    expect(msgs).toContainEqual({ jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'Harness Editor answered HTTP 403: forbidden' } })
    expect(msgs).toContainEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
  })

  it('refuses a bad port as a usage error, with nothing on stdout', async () => {
    expect(await main(['mcp', '--port', 'x'], io([]))).toBe(2)
    expect(out).toEqual([])
    expect(err[0]).toMatch(/port 'x' is not a number from 1 to 65535/)
  })
})

describe('resolveMcpPort', () => {
  it('flag, then HARNESS_MCP_PORT, then the app setting, then 47100', async () => {
    expect(await resolveMcpPort(undefined, io([]))).toBe(47100)
    const dir = join(tmp, 'Library', 'Application Support', 'Harness Editor')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ mcpPort: 47300 }))
    expect(await resolveMcpPort(undefined, io([]))).toBe(47300)
    expect(await resolveMcpPort(undefined, io([], { HARNESS_MCP_PORT: '47400' }))).toBe(47400)
    expect(await resolveMcpPort('47500', io([], { HARNESS_MCP_PORT: '47400' }))).toBe(47500)
  })
})
