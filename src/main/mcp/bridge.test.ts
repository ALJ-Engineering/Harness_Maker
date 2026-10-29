import { describe, it, expect, vi, afterEach } from 'vitest'
import type { McpCall } from '../../shared/mcp'
import { createBridge } from './bridge'

afterEach(() => vi.useRealTimers())

describe('MCP bridge (main → renderer request/response)', () => {
  it('refuses at once while the renderer has no handler', async () => {
    const send = vi.fn(() => true)
    const b = createBridge(send)
    expect(await b.call('get_document', {})).toEqual({ ok: false, errors: [expect.stringMatching(/not ready/)] })
    expect(send).not.toHaveBeenCalled()
  })

  it('correlates answers by id, whatever order they come back in', async () => {
    const sent: McpCall[] = []
    const b = createBridge((c) => (sent.push(c), true))
    b.setReady(true)
    const one = b.call('get_document', {})
    const two = b.call('check', { x: 1 })
    expect(sent.map((c) => [c.name, c.args])).toEqual([['get_document', {}], ['check', { x: 1 }]])
    b.settle(sent[1].id, { ok: true, result: 'second' })
    b.settle(sent[0].id, { ok: true, result: 'first' })
    expect(await one).toEqual({ ok: true, result: 'first' })
    expect(await two).toEqual({ ok: true, result: 'second' })
    b.settle(sent[0].id, { ok: true, result: 'late' }) // an already-settled id is ignored
  })

  it('times out a call the renderer never answers', async () => {
    vi.useFakeTimers()
    const b = createBridge(() => true, { timeoutMs: 1000 })
    b.setReady(true)
    const p = b.call('get_document', {})
    vi.advanceTimersByTime(1000)
    expect(await p).toEqual({ ok: false, errors: ['the editor did not answer within 1 s'] })
  })

  it('refuses when there is no window to send to', async () => {
    const b = createBridge(() => false)
    b.setReady(true)
    expect(await b.call('get_document', {})).toEqual({ ok: false, errors: ['no document window is open'] })
  })

  it('rejectAll answers every pending call with the reason', async () => {
    const b = createBridge(() => true)
    b.setReady(true)
    const calls = [b.call('a', {}), b.call('b', {})]
    b.rejectAll('the editor window reloaded')
    expect(await Promise.all(calls)).toEqual([
      { ok: false, errors: ['the editor window reloaded'] },
      { ok: false, errors: ['the editor window reloaded'] }
    ])
  })
})
