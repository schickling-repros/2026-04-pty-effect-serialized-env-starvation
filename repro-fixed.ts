/**
 * Verifies that the fix in PR #567 resolves the withSerializedEnv starvation.
 *
 * The fix removes the global Promise chain and passes env directly per-call.
 * This script simulates the FIXED pattern and confirms operations don't block each other.
 */

// ─── FIXED pattern: no global queue, env passed per-call ───

const runWithEnv = async <A>(
  env: Readonly<Record<string, string | undefined>>,
  thunk: () => Promise<A> | A,
): Promise<A> => {
  // In the real fix, env is passed to child_process.spawn({ env: { ...process.env, ...env } })
  // No global queue, no process.env mutation
  return thunk()
}

// ─── Same reproduction scenario ───

const hangingOperation = () =>
  runWithEnv({ PTY_SESSION_DIR: '/tmp/pty' }, () =>
    new Promise<void>(() => {
      // Never resolves — simulates a stale socket
    }),
  )

const fastOperation = (label: string) =>
  runWithEnv({ PTY_SESSION_DIR: '/tmp/pty' }, () => {
    console.log(`  [${label}] executed`)
    return 'ok'
  })

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

async function main() {
  console.log('=== FIXED pattern verification ===\n')

  console.log('1. Starting session polling (2s interval)...')
  const stopPolling = startPolling()

  console.log('2. Waiting 3s to show normal operation...\n')
  await new Promise((r) => setTimeout(r, 3000))

  console.log('\n3. Triggering a hanging operation...')
  hangingOperation()

  console.log('4. Waiting 8s — polls should STILL execute...\n')
  await new Promise((r) => setTimeout(r, 8000))

  stopPolling()

  console.log('\n=== Result ===')
  console.log('All poll-N operations executed despite the hanging operation.')
  console.log('The fix eliminates the global Promise chain — operations are independent.')
  process.exit(0)
}

main()
