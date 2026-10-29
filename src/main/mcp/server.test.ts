import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { request } from 'http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolOutcome } from '../../shared/mcp'
import { hostAllowed, originAllowed, startMcpServer, type RunningMcpServer } from './server'
import { TOOLS } from './tools'

let server: RunningMcpServer
let calls: { name: string; args: unknown }[]
let answer: ToolOutcome

beforeEach(async () => {
  calls = []
  answer = { ok: true, result: { hello: 'world' } }
  server = await startMcpServer({
    port: 0,
    tools: TOOLS,
    instructions: 'test instructions',
    version: '0.0.0-test',
    call: async (name, args) => (calls.push({ name, args }), answer)
  })
})
afterEach(() => server.close())

async function connect(): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)))
  return client
}

/** A raw POST to the server with chosen headers; resolves to the status code. */
function post(headers: Record<string, string>, path = '/mcp', method = 'POST'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  })
}

describe('in-app MCP server over HTTP', () => {
  it('lists the tools with their schemas and the instructions', async () => {
    const client = await connect()
    expect(client.getInstructions()).toBe('test instructions')
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name))
    expect(tools.find((t) => t.name === 'apply_ops')!.inputSchema.required).toEqual(['ops'])
    await client.close()
  })

  it('routes a call and returns its result as JSON text', async () => {
    const client = await connect()
    const r = await client.callTool({ name: 'get_document', arguments: {} })
    expect(calls).toEqual([{ name: 'get_document', args: {} }])
    expect(r.isError).toBeFalsy()
    expect(JSON.parse((r.content as { text: string }[])[0].text)).toEqual({ hello: 'world' })
    await client.close()
  })

  it('a refusal is an error result carrying the errors', async () => {
    answer = { ok: false, errors: ["op #1 (wire): no connector 'X9'"] }
    const client = await connect()
    const r = await client.callTool({ name: 'apply_ops', arguments: { ops: [] } })
    expect(r.isError).toBe(true)
    expect(JSON.parse((r.content as { text: string }[])[0].text)).toEqual({ errors: ["op #1 (wire): no connector 'X9'"] })
    await client.close()
  })

  it('refuses a foreign Host (DNS rebinding) and a web page Origin', async () => {
    const accept = { Accept: 'application/json, text/event-stream' }
    expect(await post({ ...accept, Host: 'evil.example:' + server.port })).toBe(403)
    expect(await post({ ...accept, Origin: 'https://evil.example' })).toBe(403)
    expect(await post({ ...accept, Origin: 'null' })).toBe(403)
    expect(await post(accept)).toBe(200)
    expect(await post({ ...accept, Origin: `http://localhost:6274` })).toBe(200)
  })

  it('serves only POST /mcp', async () => {
    expect(await post({}, '/')).toBe(404)
    expect(await post({}, '/mcp', 'GET')).toBe(405)
  })

  it('a second server on the same port fails with EADDRINUSE', async () => {
    await expect(
      startMcpServer({ port: server.port, tools: [], instructions: '', version: '0', call: async () => answer })
    ).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })
})

describe('local-only rules', () => {
  it('hostAllowed: the loopback names on this port only', () => {
    expect(hostAllowed('127.0.0.1:47100', 47100)).toBe(true)
    expect(hostAllowed('localhost:47100', 47100)).toBe(true)
    expect(hostAllowed('[::1]:47100', 47100)).toBe(true)
    expect(hostAllowed('localhost:47101', 47100)).toBe(false)
    expect(hostAllowed('127.0.0.1', 47100)).toBe(false)
    expect(hostAllowed('attacker.example:47100', 47100)).toBe(false)
    expect(hostAllowed(undefined, 47100)).toBe(false)
  })

  it('originAllowed: none, or a page on this machine', () => {
    expect(originAllowed(undefined)).toBe(true)
    expect(originAllowed('http://localhost:5173')).toBe(true)
    expect(originAllowed('http://127.0.0.1')).toBe(true)
    expect(originAllowed('https://localhost.evil.example')).toBe(false)
    expect(originAllowed('null')).toBe(false)
    expect(originAllowed('file://')).toBe(false)
  })
})
