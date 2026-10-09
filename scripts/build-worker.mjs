import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import './generate-worker-fixture.mjs'

const require = createRequire(import.meta.url)
const cli = resolve(dirname(require.resolve('@pulse-compute/cli')), '../bin/pulse.js')
const worker = fileURLToPath(new URL('../fixtures/worker', import.meta.url))
execFileSync(process.execPath, [cli, 'build'], { cwd: worker, stdio: 'inherit', timeout: 60000 })
