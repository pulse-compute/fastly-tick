import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { workerFiles } from './worker.mjs'

const directory = new URL('../fixtures/worker/src/tick/', import.meta.url)
mkdirSync(directory, { recursive: true })
for (const [name, content] of Object.entries(workerFiles({ worker: 'uptime', secret: 'UPTIME_TICK_TOKEN', accept: '../accept.js' }))) {
  const file = new URL(name, directory)
  if (!existsSync(file) || readFileSync(file, 'utf8') !== content) writeFileSync(file, content)
}
