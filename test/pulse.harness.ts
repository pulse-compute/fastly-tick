// Deliberately public fixture values; never production credentials.
const secrets = { TICK_PROBE_TOKEN: 'fixture-only-not-a-credential' }

export default {
  cases: [
    {
      name: 'duplicate-token-rejected',
      request: { path: '/__tick/probe', headers: [
        ['x-tick-probe-token', secrets.TICK_PROBE_TOKEN],
        ['x-tick-probe-token', secrets.TICK_PROBE_TOKEN],
      ] },
      secrets,
      expect: { status: 401, text: 'unauthorized' },
    },
    {
      name: 'header-scan-limit',
      request: { path: '/__tick/probe', headers: {
        ...Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`x-fixture-${i}`, 'value'])),
        'x-tick-probe-token': secrets.TICK_PROBE_TOKEN,
      } },
      secrets,
      expect: { status: 401, text: 'unauthorized' },
    },
    {
      name: 'authenticated-probe',
      request: { path: '/__tick/probe', headers: { 'x-tick-probe-token': secrets.TICK_PROBE_TOKEN } },
      secrets,
      expect: { status: 200, text: 'healthy', headers: [['cache-control', 'no-store']] },
    },
    {
      name: 'missing-token',
      request: { path: '/__tick/probe' },
      secrets,
      expect: { status: 401, text: 'unauthorized' },
    },
    {
      name: 'wrong-token',
      request: { path: '/__tick/probe', headers: { 'x-tick-probe-token': 'incorrect-fixture-value' } },
      secrets,
      expect: { status: 401, text: 'unauthorized' },
    },
    {
      name: 'empty-token',
      request: { path: '/__tick/probe', headers: { 'x-tick-probe-token': '' } },
      secrets,
      expect: { status: 401, text: 'unauthorized' },
    },
    {
      name: 'empty-configured-secret-fails-closed',
      request: { path: '/__tick/probe', headers: { 'x-tick-probe-token': secrets.TICK_PROBE_TOKEN } },
      secrets: { TICK_PROBE_TOKEN: '' },
      expect: { status: 401, text: 'unauthorized' },
    },
    {
      name: 'unknown-route',
      request: { path: '/not-a-probe' },
      secrets,
      expect: { status: 404 },
    },
    {
      name: 'post-is-not-a-probe',
      request: { method: 'POST', path: '/__tick/probe', headers: { 'x-tick-probe-token': secrets.TICK_PROBE_TOKEN } },
      secrets,
      expect: { status: 404 },
    },
  ],
}
