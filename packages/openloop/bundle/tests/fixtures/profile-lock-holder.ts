import {
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const home = process.argv[2]
if (home === undefined || process.send === undefined) {
  throw new Error('profile lock holder requires a home argument and an IPC channel')
}

const lockPath = join(home, 'profiles', '.openloop.init.lock')
const owner = {
  pid: process.pid,
  createdAt: Date.now(),
  token: `child-${process.pid}`,
}

mkdirSync(lockPath, { recursive: true })
writeFileSync(
  join(lockPath, 'owner.json'),
  `${JSON.stringify(owner)}\n`,
  { encoding: 'utf8', flag: 'wx', mode: 0o600 },
)
process.send({ type: 'ready', lockPath })

process.on('message', (message: unknown) => {
  if (typeof message !== 'object' || message === null
    || (message as Record<string, unknown>)['type'] !== 'release') return
  rmSync(lockPath, { recursive: true })
  process.send?.({ type: 'released' }, () => process.exit(0))
})
