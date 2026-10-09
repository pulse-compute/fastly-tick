import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const cli = resolve(dirname(require.resolve('@pulse-compute/cli')), '../bin/pulse.js')
const wasm = readFileSync('dist/bin/main.wasm')
const sha256 = createHash('sha256').update(wasm).digest('hex')
const build = JSON.parse(readFileSync('dist/pulse-build.json', 'utf8'))
assert.equal(build.configuredTarget, 'native')
assert.equal(build.targetDescriptor.automaticFallback, false)
assert.equal(build.providerTarget.target, 'fastly-compute-native')
assert.equal(build.providerTarget.javascriptRuntime, false)
assert.equal(build.providerTarget.wasm.sha256, sha256)
assert.equal(build.providerTarget.wasm.bytes, wasm.length)
const imports = WebAssembly.Module.imports(new WebAssembly.Module(wasm))
assert.ok(imports.length > 0)
assert.ok(imports.every(({ module }) => module.startsWith('fastly_')), 'FT-00 must contain only Fastly host imports')

const json = execFileSync(process.execPath, [cli, 'report', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const report = JSON.parse(json)
const artifact = report.artifacts.find((entry) => entry.stage === 'final' && entry.sha256 === sha256)
assert.ok(artifact, 'Pulse report must identify the actual packaged Wasm')
assert.equal(artifact.bytes, wasm.length)
writeFileSync('dist/report.json', json)
execFileSync(process.execPath, [cli, 'report', '--html', '--out', 'dist/report.html'], { stdio: 'inherit' })
writeFileSync('dist/bin/main.wasm.sha256', `${sha256}  main.wasm\n`)
console.log(JSON.stringify({ target: artifact.target, bytes: wasm.length, sha256, routes: report.routes.length, schemas: report.schemas.length }, null, 2))
