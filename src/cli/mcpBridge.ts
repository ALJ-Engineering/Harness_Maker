import { readFile } from 'fs/promises'
import { DEFAULT_MCP_PORT, parseSettings } from '../main/settings'
import type { CliIO } from './io'
import { settingsPaths } from './libraryDir'

/**
 * `harness mcp` — a stdio MCP server for clients that only start local servers
 * as a subprocess (Claude Desktop), bridged to the running app's Agent access
 * (`src/main/mcp/`, Streamable HTTP on 127.0.0.1). The app's server is
 * stateless and answers in plain JSON, so each newline-delimited JSON-RPC
 * message from stdin is one POST, and its answer one line on stdout.
 *
 * stdout carries JSON-RPC only. When the app cannot be reached, a request gets
 * a JSON-RPC error the client shows ("not running"), a notification is dropped.
 * Messages are forwarded as they arrive and answered as they complete (JSON-RPC
 * matches answers by id), so a slow call — a datasheet download — does not hold
 * up the rest.
 */

/** The app's MCP port: `--port`, then `HARNESS_MCP_PORT`, then the app's settings (`mcpPort`), then the default. */
export async function resolveMcpPort(flag: string | undefined, io: CliIO): Promise<number | { error: string }> {
  const given = flag ?? io.env.HARNESS_MCP_PORT
  if (given !== undefined) {
    const n = Number(given)
    if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: `port '${given}' is not a number from 1 to 65535` }
    return n
  }
  for (const p of settingsPaths(io)) {
    let text: string
    try {
      text = await readFile(p, 'utf8')
    } catch {
      continue
    }
    const port = parseSettings(text).mcpPort
    if (port) return port
  }
  return DEFAULT_MCP_PORT
}

type Id = string | number | null

const rpcError = (id: Id, message: string) => JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })

/** The JSON-RPC messages in an answer: a JSON body, or the `data:` lines of an event stream. */
function messages(contentType: string, body: string): string[] {
  if (!contentType.includes('text/event-stream')) return body.trim() ? [body] : []
  return body
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter(Boolean)
}

export async function runMcpBridge(port: number, io: CliIO): Promise<number> {
  const url = `http://127.0.0.1:${port}/mcp`
  const notRunning = `Harness Editor is not running, or its Agent access is off (Settings ▸ Agent access (MCP) in the app); nothing answers at ${url}`

  async function forward(line: string): Promise<void> {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      io.out(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
      return
    }
    // A request carries an id and expects an answer; a notification does not.
    const id: Id | undefined =
      typeof msg === 'object' && msg !== null && !Array.isArray(msg) && 'id' in msg ? ((msg as { id: Id }).id ?? null) : undefined
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: line
      })
    } catch {
      if (id !== undefined) io.out(rpcError(id, notRunning))
      return
    }
    const body = await res.text()
    const type = res.headers.get('content-type') ?? ''
    if (!type.includes('json') && !type.includes('event-stream')) {
      if (id !== undefined && res.status !== 202) io.out(rpcError(id, `Harness Editor answered HTTP ${res.status}: ${body.trim()}`))
      return
    }
    for (const m of messages(type, body)) {
      try {
        io.out(JSON.stringify(JSON.parse(m))) // one message per line, whatever the server's layout
      } catch {
        if (id !== undefined) io.out(rpcError(id, `Harness Editor sent an unreadable answer: ${m.slice(0, 200)}`))
      }
    }
  }

  const pending = new Set<Promise<void>>()
  for await (const line of io.stdinLines()) {
    if (!line.trim()) continue
    const p = forward(line).finally(() => pending.delete(p))
    pending.add(p)
  }
  await Promise.all(pending)
  return 0
}
