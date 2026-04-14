# @overeng/pty-effect — `withSerializedEnv` global Promise chain starvation

One hanging pty operation (e.g. connecting to a stale socket) blocks ALL subsequent pty client operations indefinitely, because they share a single module-level Promise chain (`serializedEnvQueue`).

## Reproduction

```bash
bun install
bun run repro.ts
```

## Expected

Each `listSessions` poll should execute independently. A hanging `spawnDaemon` should not block unrelated `listSessions` calls.

## Actual

After a single hanging operation enters `withSerializedEnv`, all subsequent calls (including `listSessions` polling) are `.then()`-chained behind it and never execute:

```
[poll-1] queued
  [poll-1] executed      ← before the hang
[poll-1] completed

[poll-2] queued          ← after the hang
[poll-3] queued          ← queued but NEVER executed
[poll-4] queued
[poll-5] queued
```

In Electron's main process, this starves the HTTP server event loop — the server stops responding to external connections after the initial page load.

## Root Cause

`withSerializedEnv` in `client.ts` uses a module-level Promise chain to serialize `process.env` mutations:

```ts
let serializedEnvQueue = Promise.resolve()

const withSerializedEnv = <A>(env, thunk) => {
  const previous = serializedEnvQueue
  serializedEnvQueue = new Promise(resolve => { release = resolve })
  return previous.then(async () => {
    // mutate process.env, run thunk, restore process.env, release
  })
}
```

Every pty client operation (`spawnDaemon`, `listSessions`, `attach`, `kill`) goes through this queue. When any single thunk hangs (stale socket, slow spawn), the `release()` in the `finally` block never runs, and ALL subsequent operations are blocked.

## Suggested Fix

Replace the global mutex with per-call env isolation. Options:

1. **Use `child_process` env option** — pass env directly to `spawn()` / `execFile()` instead of mutating `process.env`. This eliminates the need for serialization entirely.

2. **Per-operation env via `AsyncLocalStorage`** — use Node's `AsyncLocalStorage` to scope env changes to the current async context without a global mutex.

3. **Timeout the queue** — add a timeout to the Promise chain so a stuck operation doesn't block indefinitely. (Workaround, not a fix.)

Option 1 is the most principled — `process.env` mutation is inherently unsafe for concurrent operations.

## Versions

- `@overeng/pty-effect`: 0.1.0
- `effect`: 3.21.0
- `@myobie/pty`: schickling/pty#ad76c42
- Runtime: Bun 1.3.11 / Node 24.14.0 (Electron 38.4.0)
- OS: macOS 15 (Darwin 25.2.0)

## Related Issue

*TBD — will be linked after filing*
