import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

export function summarize(events, source) {
  const probes = events.filter((e) => e.kind === 'healthcheck')
  const times = probes.map((e) => e.atMs).filter((t) => Number.isSafeInteger(t) && t >= 0).sort((a, b) => a - b)
  return {
    source, liveGate: 'requires-operator-verification', configuredIntervalMs: 15000,
    authenticatedProbes: events.length, healthcheckTagged: probes.length,
    otherProbes: events.length - probes.length, missingTimestamps: probes.length - times.length,
    firstAtMs: times[0] ?? null, lastAtMs: times.at(-1) ?? null,
    maxObservedGapMs: times.length > 1 ? Math.max(...times.slice(1).map((t, i) => t - times[i])) : null,
    receiverPopCoverage: 'unavailable-until-FT-02',
    scope: 'Merged receiver arrivals, not per-site cadence. Log loss and caller-supplied kind can affect this observation.',
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = process.argv[2]
  if (!['local', 'deployed'].includes(source)) {
    console.error('Usage: <bounded stdout log stream> | node scripts/observe.mjs local|deployed')
    process.exitCode = 1
  } else {
    const events = []
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      if (line.length > 4096) continue
      const start = line.indexOf('{"event":"fastly_tick.probe"')
      if (start < 0) continue
      try {
        const event = JSON.parse(line.slice(start))
        if (event.event === 'fastly_tick.probe' && event.receiver === 'fastly-tick') events.push(event)
      } catch { /* Ignore unrelated/incomplete tail output, never echo it. */ }
      if (events.length >= 10000) break
    }
    console.log(JSON.stringify(summarize(events, source), null, 2))
  }
}
