import { pathToFileURL } from 'node:url'

const maxEvents = 10000
const maxInputBytes = 16 * 1024 * 1024
const maxLineBytes = 4096
const minimumSamples = 20
const counters = ['considered', 'selected', 'sends', 'acks', 'ackTimeouts', 'invalidAcks', 'redeliveries', 'exhausted', 'dropped']
const admissions = new Set(['admitted', 'not-due', 'conflict', 'not-stored', 'unknown', 'failed', 'read-failed', 'invalid-state',
  'clock-unavailable', 'budget-exhausted', 'claimed-too-late', 'invalid-settings', 'pop-unavailable'])
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 253402300799999
const sample = value => value === -1 || time(value)

// Keep only a closed observation shape; raw lines, headers and payloads never escape.
export function normalize(event) {
  if (!event || event.receiver !== 'fastly-tick' || !['manual', 'healthcheck'].includes(event.kind)) return null
  const result = { event: event.event, receiver: 'fastly-tick', kind: event.kind, atMs: event.atMs }
  if (event.event === 'fastly_tick.probe') return event.atMs === null || time(event.atMs) ? result : null
  if (event.event !== 'fastly_tick.outcome' || !sample(event.atMs) || !admissions.has(event.admission) ||
      !['all', 'allowlist', 'single'].includes(event.popMode) || event.receiverPop !== 'unavailable') return null
  Object.assign(result, { admission: event.admission, popMode: event.popMode, receiverPop: 'unavailable' })
  for (const name of counters) {
    const value = event[name]
    if (!Number.isInteger(value) || value < 0 || value > (name === 'considered' ? 8 : 2)) return null
    result[name] = value
  }
  if (result.acks + result.ackTimeouts + result.invalidAcks > result.sends || result.redeliveries > result.sends) return null
  for (const name of ['ackLatencyOneMs', 'ackLatencyTwoMs', 'dispatchLatenessMs', 'responseElapsedMs']) {
    if (!sample(event[name])) return null
    result[name] = event[name]
  }
  if ([result.ackLatencyOneMs, result.ackLatencyTwoMs].filter(time).length !== result.acks) return null
  return result
}

export function parseEvent(line) {
  if (Buffer.byteLength(line) > maxLineBytes) return null
  const start = line.indexOf('{')
  if (start < 0) return null
  try { return normalize(JSON.parse(line.slice(start))) } catch { return null }
}

// Authenticated response metadata remains usable while Native log delivery is deferred.
// Missing admitted metrics are unknown, never guessed as zero.
export function fromHeaders(pairs) {
  const headers = Object.fromEntries(pairs.map(([name, value]) => [name.toLowerCase(), value]))
  const number = name => headers[name] === undefined || !/^-?\d+$/.test(headers[name]) ? NaN : Number(headers[name])
  const admitted = headers['x-tick-admission'] === 'admitted'
  const fields = { considered: 'workers-considered', selected: 'workers-selected', sends: 'sends', acks: 'acks',
    ackTimeouts: 'ack-timeouts', invalidAcks: 'invalid-acks', redeliveries: 'redeliveries', exhausted: 'exhausted', dropped: 'dropped' }
  const event = { event: 'fastly_tick.outcome', receiver: 'fastly-tick', kind: headers['x-tick-probe-kind'],
    atMs: number('x-tick-observed-at-ms'), admission: headers['x-tick-admission'],
    popMode: headers['x-tick-pop-mode'], receiverPop: headers['x-tick-receiver-pop'] }
  for (const [name, field] of Object.entries(fields)) event[name] = admitted ? number('x-tick-' + field) : 0
  for (const [name, field] of Object.entries({ ackLatencyOneMs: 'ack-latency-one-ms', ackLatencyTwoMs: 'ack-latency-two-ms',
    dispatchLatenessMs: 'dispatch-lateness-ms', responseElapsedMs: 'response-elapsed-ms' })) {
    event[name] = !admitted && name !== 'responseElapsedMs' ? -1 : number('x-tick-' + field)
  }
  return normalize(event)
}

function latency(values) {
  const sorted = values.filter(time).sort((a, b) => a - b)
  const enough = sorted.length >= minimumSamples
  const middle = Math.floor(sorted.length / 2)
  return { sampleCount: sorted.length, minimumSampleCount: minimumSamples,
    medianMs: enough ? (sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2) : null,
    p95Ms: enough ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
    maxMs: sorted.at(-1) ?? null }
}

export function summarize(events, source, coverage = {}) {
  if (!['local', 'deployed'].includes(source)) throw new Error('Source must be local or deployed')
  const valid = events.slice(0, maxEvents).map(normalize).filter(Boolean)
  const probes = valid.filter(e => e.event === 'fastly_tick.probe')
  const tagged = probes.filter(e => e.kind === 'healthcheck')
  const outcomes = valid.filter(e => e.event === 'fastly_tick.outcome')
  const times = tagged.map(e => e.atMs).filter(time).sort((a, b) => a - b)
  const allTimes = valid.map(e => e.atMs).filter(time).sort((a, b) => a - b)
  const totals = Object.fromEntries(counters.map(name => [name, outcomes.reduce((n, e) => n + e[name], 0)]))
  const admissionCounts = Object.fromEntries([...admissions].map(name => [name, outcomes.filter(e => e.admission === name).length]))
  let maxGap = null
  for (let i = 1; i < times.length; i++) maxGap = Math.max(maxGap ?? 0, times[i] - times[i - 1])
  return {
    source, evidence: source === 'local' ? 'synthetic-local' : 'deployed-observations-unqualified',
    liveGate: 'requires-operator-verification', configuredIntervalMs: 15000,
    timeRange: { firstAtMs: allTimes[0] ?? null, lastAtMs: allTimes.at(-1) ?? null },
    authenticatedProbes: probes.length, healthcheckTagged: tagged.length,
    otherProbes: probes.length - tagged.length, missingTimestamps: tagged.length - times.length,
    firstAtMs: times[0] ?? null, lastAtMs: times.at(-1) ?? null, maxObservedGapMs: maxGap,
    outcomesObserved: outcomes.length, arrivalOutcomeCountDifference: probes.length - outcomes.length,
    admissionCounts, popSelected: outcomes.filter(e => e.popMode === 'all').length,
    popNonselected: admissionCounts['pop-unavailable'],
    popSelectionUnknown: outcomes.filter(e => e.popMode !== 'all' && e.admission !== 'pop-unavailable').length,
    receiverPopCoverage: 'unavailable', totals,
    unclassifiedSends: totals.sends - totals.acks - totals.ackTimeouts - totals.invalidAcks,
    ackLatency: latency(outcomes.flatMap(e => [e.ackLatencyOneMs, e.ackLatencyTwoMs])),
    dispatchLatenessPerProbe: latency(outcomes.map(e => e.dispatchLatenessMs)),
    responseWork: latency(outcomes.map(e => e.responseElapsedMs)),
    coverage: { incomplete: true, acceptedEvents: valid.length,
      limitReached: events.length >= maxEvents || coverage.limitReached === true,
      oversizedLines: coverage.oversizedLines ?? 0, malformedOrUnrelatedLines: coverage.ignoredLines ?? 0 },
    scope: 'Bounded merged receiver observations, not per-site cadence or complete counters. Kind is caller-supplied; log loss, crashes and clock skew can hide arrivals/outcomes. ACK latency samples are individual valid ACKs; lateness samples are per-probe maxima. Response work runs from before probe secret lookup to the pre-response clock sample; excludes header scan, final log/response construction and transmission.',
  }
}

// Bound input bytes, line retention and event count, even on an unterminated line.
export async function collect(input) {
  const events = []
  const coverage = { limitReached: false, oversizedLines: 0, ignoredLines: 0 }
  let bytes = 0
  let line = Buffer.alloc(0)
  let oversized = false
  const finish = () => {
    if (oversized) coverage.oversizedLines++
    else {
      const event = parseEvent(line.toString('utf8').replace(/\r$/, ''))
      if (event) events.push(event)
      else coverage.ignoredLines++
    }
    line = Buffer.alloc(0)
    oversized = false
  }
  outer: for await (const chunk of input) {
    const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const remaining = maxInputBytes - bytes
    const bounded = raw.subarray(0, remaining)
    bytes += bounded.length
    let start = 0
    for (let i = 0; i <= bounded.length; i++) {
      if (i !== bounded.length && bounded[i] !== 10) continue
      const part = bounded.subarray(start, i)
      if (!oversized && line.length + part.length <= maxLineBytes) line = Buffer.concat([line, part])
      else { oversized = true; line = Buffer.alloc(0) }
      if (i < bounded.length) {
        finish()
        if (events.length >= maxEvents) { coverage.limitReached = true; break outer }
      }
      start = i + 1
    }
    if (raw.length >= remaining) { coverage.limitReached = true; break }
  }
  if (!coverage.limitReached && (line.length || oversized)) finish()
  return { events, coverage }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = process.argv[2]
  if (!['local', 'deployed'].includes(source)) {
    console.error('Usage: <bounded stdout log stream> | node scripts/observe.mjs local|deployed')
    process.exitCode = 1
  } else {
    const { events, coverage } = await collect(process.stdin)
    console.log(JSON.stringify(summarize(events, source, coverage), null, 2))
  }
}
