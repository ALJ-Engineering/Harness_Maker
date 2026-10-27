import { homedir } from 'os'
import { createInterface } from 'readline'
import { main } from './main'

main(process.argv.slice(2), {
  out: (s) => void process.stdout.write(s.endsWith('\n') ? s : s + '\n'),
  err: (s) => void process.stderr.write(s.endsWith('\n') ? s : s + '\n'),
  env: process.env,
  home: homedir(),
  platform: process.platform,
  readStdin: async () => {
    const chunks: Buffer[] = []
    for await (const c of process.stdin) chunks.push(c as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  },
  stdinLines: () => createInterface({ input: process.stdin, crlfDelay: Infinity })
}).then(
  // exitCode, not exit(): Node on Windows aborts ("Assertion failed: !(handle->flags &
  // UV_HANDLE_CLOSING)") when exit() runs while fetch's sockets are still closing — after
  // every `harness mcp` session. Nothing else is left running by then, so Node exits at once.
  (code) => {
    process.exitCode = code
  },
  (e) => {
    process.stderr.write(`harness: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  }
)
