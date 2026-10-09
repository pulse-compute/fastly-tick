import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const mode = process.argv[2]
assert.ok(['check', 'pack'].includes(mode), 'Use package.mjs check or pack')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const lockPath = existsSync('package-lock.json') ? 'package-lock.json' : 'npm-shrinkwrap.json'
const lockBytes = readFileSync(lockPath)
const lock = JSON.parse(lockBytes)
assert.equal(pkg.name, '@pulse-compute/fastly-tick')
assert.equal(pkg.private, false, 'The npm application kit must be publishable')
assert.equal(pkg.repository.url, 'git+https://github.com/pulse-compute/fastly-tick.git')
assert.equal(pkg.publishConfig.registry, 'https://registry.npmjs.org/')
assert.equal(lock.name, pkg.name)
assert.equal(lock.version, pkg.version)
assert.equal(lock.packages[''].name, pkg.name)
assert.equal(lock.packages[''].version, pkg.version)
assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies)
assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies)
assert.deepEqual(lock.packages[''].bin, pkg.bin)
assert.equal(pkg.bin['fastly-tick'], 'scripts/worker.mjs')
if (process.env.EXPECTED_VERSION !== undefined) assert.equal(pkg.version, process.env.EXPECTED_VERSION, 'Publish the committed package version; bump it in a PR')
assert.ok(Array.isArray(pkg.files) && !pkg.files.includes('*'), 'Declare the package file allowlist')

if (mode === 'check') {
  console.log(`${pkg.name}@${pkg.version}: package metadata and lockfile agree`)
} else {
  const wasm = readFileSync('dist/bin/main.wasm')
  const digest = createHash('sha256').update(wasm).digest('hex')
  const build = JSON.parse(readFileSync('dist/pulse-build.json'))
  assert.equal(build.configuredTarget, 'native')
  assert.equal(build.providerTarget.javascriptRuntime, false)
  assert.equal(build.providerTarget.wasm.sha256, digest)
  assert.equal(readFileSync('dist/bin/main.wasm.sha256', 'utf8'), `${digest}  main.wasm\n`)
  // npm omits package-lock.json. Ship its exact bytes as a publishable shrinkwrap
  // so an extracted kit can use npm ci with the reviewed dependency graph.
  const hadShrinkwrap = existsSync('npm-shrinkwrap.json')
  if (hadShrinkwrap) assert.deepEqual(readFileSync('npm-shrinkwrap.json'), lockBytes, 'Existing shrinkwrap must match the reviewed lockfile')
  mkdirSync('dist', { recursive: true })
  if (!hadShrinkwrap) writeFileSync('npm-shrinkwrap.json', lockBytes)
  try {
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', 'dist'], { encoding: 'utf8' }))
    assert.equal(packed.name, pkg.name)
    assert.equal(packed.version, pkg.version)
    const files = new Set(packed.files.map(file => file.path))
    for (const path of ['package.json', 'npm-shrinkwrap.json', 'README.md', '.pulse/config.ts', 'src/index.ts', 'src/schemas.ts',
      'tsconfig.json', 'fastly.toml', 'scripts/report.mjs', 'test/pulse.harness.ts',
      'fixtures/worker/package.json', 'fixtures/worker/.pulse/config.ts', 'fixtures/worker/src/index.ts',
      'fixtures/worker/src/accept.ts', 'fixtures/worker/src/tick/handler.ts',
      'fixtures/worker/src/tick/index.ts', 'fixtures/worker/src/tick/schemas.ts',
      'scripts/worker.mjs', 'templates/worker/handler.ts', 'templates/worker/accept.ts',
      'templates/worker/index.ts', 'templates/worker/schemas.ts', 'docs/worker.md',
      'deploy/trigger.example.json', 'deploy/registry.example.json', 'dist/bin/main.wasm',
      'dist/bin/main.wasm.sha256', 'dist/fastly.toml', 'dist/pulse-build.json', 'dist/report.json', 'dist/report.html']) {
      assert.ok(files.has(path), `Missing kit file: ${path}`)
    }
    for (const path of files) {
      assert.ok(!/(^|\/)(node_modules|\.github|\.git|\.env[^/]*|\.pulse-report-locks)(\/|$)|\.local\.json$|\.tgz$/.test(path), `Unexpected private/generated file: ${path}`)
      assert.ok(!path.startsWith('fixtures/worker/dist/'), 'Worker test builds are not published')
      assert.ok(!path.startsWith('.pulse/') || path === '.pulse/config.ts', 'Pulse caches/reports are not published')
      assert.ok(!path.startsWith('dist/') || ['dist/bin/main.wasm', 'dist/bin/main.wasm.sha256',
        'dist/fastly.toml', 'dist/pulse-build.json', 'dist/report.json', 'dist/report.html'].includes(path), `Unexpected build product: ${path}`)
    }
    const archive = join('dist', packed.filename)
    const unpack = path => execFileSync('tar', ['-xOf', archive, `package/${path}`], { maxBuffer: 16 * 1024 * 1024 })
    assert.ok(unpack(pkg.bin['fastly-tick']).toString('utf8').startsWith('#!/usr/bin/env node\n'), 'Installer must have a Node entry point')
    assert.deepEqual(unpack('dist/bin/main.wasm'), wasm, 'Publish the tested Wasm bytes')
    assert.deepEqual(unpack('npm-shrinkwrap.json'), lockBytes)
    const report = JSON.parse(unpack('dist/report.json'))
    assert.ok(report.artifacts.some(artifact => artifact.stage === 'final' && artifact.sha256 === digest && artifact.bytes === wasm.length))
    console.log(JSON.stringify({ archive, files: files.size, bytes: packed.size, wasmSha256: digest }, null, 2))
  } finally {
    if (!hadShrinkwrap) rmSync('npm-shrinkwrap.json', { force: true })
  }
}
