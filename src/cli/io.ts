/** Everything the CLI touches in the outside world, injected so tests run `main()` in-process. */
export interface CliIO {
  out: (s: string) => void
  err: (s: string) => void
  env: Record<string, string | undefined>
  home: string
  platform: NodeJS.Platform
  /** All of stdin as text (for `apply <file> -`). */
  readStdin: () => Promise<string>
}
