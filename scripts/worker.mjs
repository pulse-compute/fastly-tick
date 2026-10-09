#!/usr/bin/env node
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function workerFiles({ worker, secret = 'TICK_TOKEN', accept } = {}) {
  if (!/^[a-z0-9_-]{1,32}$/.test(worker ?? '')) throw new Error('Worker ID must be 1–32 lowercase ASCII letters, digits, underscores or hyphens')
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(secret)) throw new Error('Secret must be an uppercase ASCII name')
  if (accept !== undefined && !/^\.\.?\/[a-zA-Z0-9_./-]+\.js$/.test(accept)) throw new Error('--accept must be a relative .js source import exporting acceptTick')
  const files = {}
  for (const name of ['handler.ts', 'index.ts', 'schemas.ts', ...(accept ? [] : ['accept.ts'])]) {
    files[name] = readFileSync(new URL(`../templates/worker/${name}`, import.meta.url), 'utf8')
      .replaceAll('__TOKEN__', JSON.stringify(secret))
      .replaceAll('__WORKER__', JSON.stringify(worker))
      .replaceAll('__RUN_PREFIX__', JSON.stringify(`${worker}:slot:`))
      .replaceAll('__ACCEPT__', JSON.stringify(accept ?? './accept.js'))
  }
  return files
}

function main(args) {
  if (args.length === 0 || args[0] === '--help') {
    console.log('Usage: fastly-tick worker <worker-id> [--dir src/tick] [--secret TICK_TOKEN] [--accept ../accept.js]')
    return
  }
  if (args.shift() !== 'worker') throw new Error('Expected worker command; use --help')
  const worker = args.shift()
  const options = { worker }
  let directory = 'src/tick'
  const seen = new Set()
  while (args.length) {
    const flag = args.shift()
    if (!['--dir', '--secret', '--accept'].includes(flag) || seen.has(flag)) throw new Error(`Unknown or repeated option: ${flag}`)
    seen.add(flag)
    const value = args.shift()
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`)
    if (flag === '--dir') directory = value
    else options[flag.slice(2)] = value
  }
  const files = workerFiles(options)
  const target = resolve(directory)
  // Creating the final directory exclusively also protects every existing file.
  mkdirSync(resolve(target, '..'), { recursive: true })
  mkdirSync(target)
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(resolve(target, name), content, { flag: 'wx' })
  } catch (error) {
    rmSync(target, { recursive: true, force: true })
    throw error
  }
  console.log(`Created ${directory}: POST /__tick, worker ${worker}, secret ${options.secret ?? 'TICK_TOKEN'}.`)
  console.log('Mount the generated Router or register tickHandler and tickError. Add tick.Invocation to your schema registry and bind the secret store.')
  console.log('Implement acceptTick before use; the default stub returns 503 without an ACK. See docs/worker.md in the package.')
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
