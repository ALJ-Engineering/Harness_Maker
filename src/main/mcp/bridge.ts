import type { McpCall, ToolOutcome } from '../../shared/mcp'

/**
 * Main's half of the one main → renderer request/response in the app: the MCP
 * server asks the document window to run a tool and awaits the outcome. Main
 * sends `mcp:call` with an id; the renderer answers on `mcp:result` with the same
 * id (`settle`). Electron-free so vitest can drive it — `mcp/index.ts` wires the
 * IPC.
 *
 * A call always RESOLVES, with a refusal when the renderer cannot answer: an MCP
 * client is better served by "the editor reloaded" than by a transport error.
 */
export interface Bridge {
  call(name: string, args: unknown): Promise<ToolOutcome>
  /** The renderer's answer to call `id`. An unknown or settled id is ignored. */
  settle(id: number, outcome: ToolOutcome): void
  /** The renderer registered (true) or dropped (false) its handler — `mcp:ready`. */
  setReady(ready: boolean): void
  /** Answer every pending call with a refusal (window closed, reloaded, crashed). */
  rejectAll(reason: string): void
}

/** How long a tool may take in the renderer. Edits are synchronous; this guards a hung window. */
export const CALL_TIMEOUT_MS = 30_000

/** `send` delivers a call to the document window; false when there is none. */
export function createBridge(send: (call: McpCall) => boolean, opts: { timeoutMs?: number } = {}): Bridge {
  const timeoutMs = opts.timeoutMs ?? CALL_TIMEOUT_MS
  const pending = new Map<number, { resolve: (o: ToolOutcome) => void; timer: ReturnType<typeof setTimeout> }>()
  let ready = false
  let nextId = 1
  const refuse = (error: string): ToolOutcome => ({ ok: false, errors: [error] })

  function finish(id: number, outcome: ToolOutcome): void {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    clearTimeout(p.timer)
    p.resolve(outcome)
  }

  return {
    call(name, args) {
      if (!ready) return Promise.resolve(refuse('the editor window is not ready (no document window is open, or it is still loading)'))
      const id = nextId++
      return new Promise<ToolOutcome>((resolve) => {
        const timer = setTimeout(() => finish(id, refuse(`the editor did not answer within ${timeoutMs / 1000} s`)), timeoutMs)
        pending.set(id, { resolve, timer })
        if (!send({ id, name, args })) finish(id, refuse('no document window is open'))
      })
    },
    settle: finish,
    setReady(r) {
      ready = r
    },
    rejectAll(reason) {
      for (const id of [...pending.keys()]) finish(id, refuse(reason))
    }
  }
}
