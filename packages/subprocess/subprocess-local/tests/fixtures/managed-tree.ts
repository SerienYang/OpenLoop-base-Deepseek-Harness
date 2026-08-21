import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const [statePath] = process.argv.slice(2)
if (statePath === undefined) throw new Error('usage: managed-tree.ts <state-path>')

process.on('SIGTERM', () => {})
process.on('SIGHUP', () => {})
const descendant = spawn(process.execPath, [
  '-e',
  'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});setInterval(()=>{},60_000)',
], { stdio: 'ignore' })
if (descendant.pid === undefined) throw new Error('managed descendant did not publish a pid')

const state = JSON.stringify({ root: process.pid, descendant: descendant.pid })
if (process.env.DSH_PROCESS_EXIT_STAGED_TREE_STATE === '1') {
  await writeFile(statePath, state.slice(0, 1))
  await new Promise(resolve => setTimeout(resolve, 250))
}
await writeFile(statePath, state)
setInterval(() => {}, 60_000)
