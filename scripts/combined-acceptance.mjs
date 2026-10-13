import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Separate application acceptance, deliberately absent from Pulse publication
// from the default injected-ABI suite. Never mutate installed package bytes.
const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
assert.equal(args.length, 4, 'Use --packages /absolute/path/pulse-release-manifest.json --out /fresh/report-directory')
assert.equal(args[0], '--packages')
assert.equal(args[2], '--out')
const manifestPath = resolve(args[1])
const out = resolve(args[3])
assert.ok(!existsSync(out), 'Use a fresh output directory to preserve previous attempts')
mkdirSync(out, { recursive: true })
const consumer = mkdtempSync(join(tmpdir(), 'fastly-tick-combined-'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { schemaVersion: 'fastly-tick.combined-acceptance.v1', status: 'running',
  qualification: 'development-only', startedAt: new Date().toISOString(), node: process.version,
  manifestSha256: sha(readFileSync(manifestPath)), inputs: [], packages: [], steps: [] }
const save = () => writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
const env = { ...process.env }
delete env.FASTLY_TICK_TEST_RECEIVER
delete env.FASTLY_TICK_TEST_RECEIVER_SHA256
function run(name, command, argv) {
  const started = performance.now()
  const result = spawnSync(command, argv, { cwd: consumer, env, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 })
  writeFileSync(join(out, `${name}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
  report.steps.push({ name, status: result.status === 0 ? 'passed' : 'failed', exitCode: result.status,
    elapsedMs: Math.round(performance.now() - started), log: `${name}.log` })
  save()
  assert.equal(result.status, 0, `${name} failed; see ${join(out, `${name}.log`)}`)
  console.log(`ok - ${name}`)
}
function files(directory, prefix = '') {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name)
    const relative = prefix ? `${prefix}/${name}` : name
    assert.ok(!lstatSync(path).isSymbolicLink(), `Unexpected symlink: ${relative}`)
    return lstatSync(path).isDirectory() ? files(path, relative) : [relative]
  })
}
let enabled
try {
  assert.ok(env.PULSE_VICEROY_BIN, 'Set PULSE_VICEROY_BIN to an explicit Viceroy binary')
  env.PULSE_VICEROY_BIN = resolve(env.PULSE_VICEROY_BIN)
  report.viceroy = { sha256: sha(readFileSync(env.PULSE_VICEROY_BIN)),
    version: execFileSync(env.PULSE_VICEROY_BIN, ['--version'], { encoding: 'utf8' }).trim() }
  for (const source of ['src', 'test', 'scripts', '.pulse/config.ts', 'fixtures/worker/src',
    'fixtures/worker/.pulse/config.ts', 'fixtures/worker/package.json', 'package.json', 'package-lock.json', 'tsconfig.json']) {
    const input = join(root, source)
    const names = lstatSync(input).isDirectory() ? files(input).map(path => `${source}/${path}`) : [source]
    for (const path of names) {
      const bytes = readFileSync(join(root, path))
      report.inputs.push({ path, sha256: sha(bytes) })
      mkdirSync(dirname(join(consumer, path)), { recursive: true })
      writeFileSync(join(consumer, path), bytes)
    }
  }
  report.inputDigest = sha(JSON.stringify(report.inputs))
  const manifest = JSON.parse(readFileSync(manifestPath))
  assert.equal(manifest.schemaVersion, 'pulse.release-packages.v3')
  assert.equal(manifest.packages.length, manifest.packageCount)
  assert.equal(new Set(manifest.packages.map(pkg => pkg.name)).size, manifest.packageCount)
  const archives = manifest.packages.map(pkg => {
    assert.match(pkg.name, /^@pulse-compute\/[a-z0-9-]+$/)
    assert.equal(basename(pkg.tarball), pkg.tarball)
    const path = join(dirname(manifestPath), pkg.tarball)
    assert.equal(sha(readFileSync(path)), pkg.sha256, `Tarball digest: ${pkg.name}`)
    report.packages.push({ name: pkg.name, version: pkg.version, sha256: pkg.sha256 })
    return path
  })
  // The published-package lockfile must not silently substitute registry Pulse
  // packages for these explicit local candidates. Keep the source lock untouched.
  rmSync(join(consumer, 'package-lock.json'))
  run('install', 'npm', ['install', '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund', ...archives])
  const expected = join(consumer, 'expected-packages')
  mkdirSync(expected)
  for (let i = 0; i < archives.length; i++) {
    const directory = join(expected, String(i))
    mkdirSync(directory)
    const entries = execFileSync('tar', ['-tzf', archives[i]], { encoding: 'utf8' }).trim().split('\n')
    assert.ok(entries.every(path => path.startsWith('package/') && !path.split('/').includes('..')))
    execFileSync('tar', ['-xzf', archives[i], '-C', directory])
  }
  function verifyInstalled() {
    for (let i = 0; i < report.packages.length; i++) {
      const pkg = report.packages[i]
      const installed = join(consumer, 'node_modules', pkg.name)
      assert.ok(!lstatSync(installed).isSymbolicLink(), `Workspace package link: ${pkg.name}`)
      const packed = join(expected, String(i), 'package')
      const paths = files(packed)
      // npm renames packed .gitignore files to .npmignore on extraction.
      // Account for the path change only; their bytes must still match exactly.
      const installedPath = path => path.endsWith('/.gitignore') || path === '.gitignore'
        ? (paths.includes(path.replace(/\.gitignore$/, '.npmignore')) ? path : path.replace(/\.gitignore$/, '.npmignore')) : path
      assert.deepEqual(files(installed).sort(), paths.map(installedPath).sort(), `Installed file set: ${pkg.name}`)
      for (const path of paths) assert.equal(sha(readFileSync(join(installed, installedPath(path)))), sha(readFileSync(join(packed, path))), `${pkg.name}/${path}`)
      assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'))).version, pkg.version)
    }
  }
  verifyInstalled()
  run('build', 'npm', ['run', 'build'])
  run('build-worker', 'npm', ['run', 'build:worker'])
  const fixture = await import(pathToFileURL(join(consumer, 'test/dispatch-fixture.mjs')))
  enabled = fixture.enabledReceiver({ shared: null })
  env.FASTLY_TICK_TEST_RECEIVER = enabled.wasmPath
  env.FASTLY_TICK_TEST_RECEIVER_SHA256 = sha(enabled.binary)
  report.artifacts = {
    receiver: sha(readFileSync(join(consumer, 'dist/bin/main.wasm'))),
    worker: sha(readFileSync(join(consumer, 'fixtures/worker/dist/bin/main.wasm'))),
    enabledReceiver: sha(enabled.binary),
  }
  env.FASTLY_TICK_COMBINED_ABI_REPORT = join(out, 'abi.json')
  env.FASTLY_TICK_NATIVE_DISPATCH_REPORT = join(out, 'dispatch.json')
  run('abi', process.execPath, ['test/combined-acceptance.mjs'])
  run('auth-http', process.execPath, ['test/native.mjs'])
  run('dispatch-http', process.execPath, ['test/native-dispatch.mjs', '--qualify'])
  verifyInstalled()
  report.installedBytesVerifiedBeforeAndAfter = true
  report.npmExtractionPathRule = '.gitignore -> .npmignore when no packed .npmignore exists'
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.message
  process.exitCode = 1
  console.error(error.message)
} finally {
  enabled?.cleanup()
  rmSync(consumer, { recursive: true, force: true })
  report.completedAt = new Date().toISOString()
  save()
  console.log(`Combined acceptance ${report.status}: ${join(out, 'report.json')}`)
}
