import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ToolOutcome } from '../../shared/mcp'
import type { ToolDef } from './tools'

/**
 * The in-app MCP server's HTTP side: Streamable HTTP on 127.0.0.1, stateless
 * (a fresh SDK `Server` + transport per POST, plain JSON responses), so there
 * are no sessions to keep and the `harness mcp` stdio bridge can forward each
 * message as one POST. Electron-free; `mcp/index.ts` supplies `call`.
 *
 * Local only, by three rules checked before the SDK sees a request: it listens
 * on the loopback interface; the Host header must name it (a DNS-rebinding page
 * reaches 127.0.0.1 under its own host name); and a browser `Origin` other
 * than localhost is refused (a web page may POST cross-site without reading
 * the answer — the edit would still happen). No CORS headers are ever sent.
 */
export interface McpServerOpts {
  port: number
  tools: ToolDef[]
  instructions: string
  version: string
  call: (name: string, args: unknown) => Promise<ToolOutcome>
}

export interface RunningMcpServer {
  port: number
  close(): Promise<void>
}

const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])$/

/** `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` — the names this server may be reached by. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false
  const m = /^(.*):(\d+)$/.exec(host)
  return !!m && LOCAL.test(m[1]) && Number(m[2]) === port
}

/** No Origin (any non-browser client), or a page served from this machine. */
export function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true
  try {
    const u = new URL(origin)
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL.test(u.hostname)
  } catch {
    return false // includes the literal "null" of sandboxed and file:// pages
  }
}

export function toCallToolResult(o: ToolOutcome): CallToolResult {
  return o.ok
    ? { content: [{ type: 'text', text: JSON.stringify(o.result, null, 2) }] }
    : { content: [{ type: 'text', text: JSON.stringify({ errors: o.errors }, null, 2) }], isError: true }
}

function mcpServer(opts: McpServerOpts): Server {
  const server = new Server(
    { name: 'harness-editor', version: opts.version },
    { capabilities: { tools: {} }, instructions: opts.instructions }
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: opts.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }))
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    toCallToolResult(await opts.call(req.params.name, req.params.arguments ?? {}))
  )
  return server
}

function deny(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message)
}

/** Listen on 127.0.0.1:`port` (0 picks a free one). Rejects with the listen error, e.g. EADDRINUSE. */
export function startMcpServer(opts: McpServerOpts): Promise<RunningMcpServer> {
  let port = opts.port
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!hostAllowed(req.headers.host, port)) return deny(res, 403, 'forbidden: unexpected Host header')
    if (!originAllowed(req.headers.origin)) return deny(res, 403, 'forbidden: requests from web pages are not accepted')
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path !== '/mcp') return deny(res, 404, 'not found — the MCP endpoint is /mcp')
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    const server = mcpServer(opts)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((e: Error) => {
        if (!res.headersSent) deny(res, 500, `internal error: ${e.message}`)
      })
  })
  return new Promise((resolve, reject) => {
    http.once('error', reject)
    http.listen(opts.port, '127.0.0.1', () => {
      http.off('error', reject)
      port = (http.address() as AddressInfo).port
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            http.closeAllConnections()
            http.close(() => done())
          })
      })
    })
  })
}
