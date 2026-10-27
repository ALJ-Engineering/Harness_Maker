/**
 * The main ↔ renderer leg of the in-app MCP server (`src/main/mcp/`): main
 * forwards a document tool call to the window that holds the document and
 * awaits its outcome. Plain data — it crosses IPC as structured clone.
 */

/** What a tool returns: its JSON result, or the reasons it refused (nothing changed). */
export type ToolOutcome = { ok: true; result: unknown } | { ok: false; errors: string[] }

/** main → renderer on `mcp:call`. */
export interface McpCall {
  id: number
  name: string
  args: unknown
}

/** renderer → main on `mcp:result`. */
export interface McpReply {
  id: number
  outcome: ToolOutcome
}
