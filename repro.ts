/**
 * Reproduces: withSerializedEnv global Promise chain starvation in @overeng/pty-effect
 *
 * The `withSerializedEnv` function in client.ts serializes ALL pty client operations
 * (spawnDaemon, listSessions, attach, etc.) via a single module-level Promise chain.
 * When any operation's thunk hangs (e.g. connecting to a stale socket, slow spawn),
 * ALL subsequent operations are blocked indefinitely — including unrelated ones like
 * listSessions used for polling.
 *
 * This is the extracted pattern from client.ts (no pty dependency needed to demonstrate).
 */

// ─── Extracted withSerializedEnv pattern from client.ts ───

let serializedEnvQueue = Promise.resolve()

const withSerializedEnv = <A>(
  env: Readonly<Record<string, string | undefined>>,
  thunk: () => Promise<A> | A,
): Promise<A> => {
  const previous = serializedEnvQueue
  let release!: () => void
  serializedEnvQueue = new Promise<void>((resolve) => {
    release = resolve
  })

  return previous.then(async () => {
    const saved = Object.entries(env).map(([key]) => [key, process.env[key]] as const)

    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }

    try {
      return await thunk()
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      release()
    }
  })
}

// ─── Reproduction ───

/** Simulates spawnDaemon — hangs when the daemon socket is stale */
const hangingOperation = () =>
  withSerializedEnv({ PTY_SESSION_DIR: '/tmp/pty' }, () =>
    new Promise<void>(() => {
      // Never resolves — simulates a stale socket connect or slow daemon spawn
    }),
  )

/** Simulates listSessions — fast operation that reads the session dir */
const fastOperation = (label: string) =>
  withSerializedEnv({ PTY_SESSION_DIR: '/tmp/pty' }, () => {
    console.log(`  [${label}] executed`)
    return 'ok'
  })

/** Simulates SessionSource.refresh polling — calls listSessions every 2s */
const startPolling = () => {
  let poll = 0
  const interval = setInterval(() => {
    poll++
    const id = `poll-${poll}`
    console.log(`[${id}] queued`)
    fastOperation(id).then(
      () => console.log(`[${id}] completed`),
      (e) => console.log(`[${id}] failed: ${e}`),
    )
  }, 2000)
  return () => clearInterval(interval)
}

/** Simulates an HTTP server health check */
const simulateHttpServer = () => {
  let request = 0
  const interval = setInterval(() => {
    request++
    console.log(`[http-${request}] health check — event loop is alive`)
  }, 1000)
  return () => clearInterval(interval)
}

async function main() {
  console.log('=== withSerializedEnv starvation reproduction ===\n')

  console.log('1. Starting HTTP server simulation (1s interval)...')
  const stopHttp = simulateHttpServer()

  console.log('2. Starting session polling (2s interval)...')
  const stopPolling = startPolling()

  console.log('3. Waiting 3s to show normal operation...\n')
  await new Promise((r) => setTimeout(r, 3000))

  console.log('\n4. Triggering a hanging operation (simulates stale socket connect)...')
  console.log('   This will block ALL subsequent withSerializedEnv calls.\n')
  hangingOperation() // fire-and-forget — hangs forever

  console.log('5. Waiting 10s to observe starvation...\n')
  await new Promise((r) => setTimeout(r, 10000))

  console.log('\n=== Result ===')
  console.log('After the hanging operation, no poll-N "executed" messages appear.')
  console.log('The polls are QUEUED but never EXECUTED because they are chained')
  console.log('behind the hanging Promise in the global serializedEnvQueue.')
  console.log('')
  console.log('Note: the HTTP server simulation (event loop) keeps running because')
  console.log('setTimeout is not blocked. But in Electron, the Effect fiber scheduler')
  console.log('holds fibers waiting on the Promise, which starves the event loop.')

  stopPolling()
  stopHttp()
  process.exit(0)
}

main()
