import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUsageHistory, handleUsageHistoryRequest } from '../src/usage-history.js';
import { ClientUsageTracker, UsageDimensionTracker, USAGE_SLOT_MS } from '../src/client-usage.js';

const NOW = Date.parse('2026-10-26T12:07:00.000Z');
const slot = time => Math.floor(time / USAGE_SLOT_MS);
const query = { scope: 'clients', window: '24h', step: '15m', metric: 'requests' };
const sum = values => values.reduce((a, b) => a + b, 0);

test('history retains UTC boundary slots and excludes older and future observations', () => {
  const from = NOW - 24 * 60 * 60 * 1000;
  const state = { alice: { requests: 9000, slots: {
    [slot(from) - 1]: { requests: 100 },
    [slot(from)]: { requests: 2 },
    [slot(NOW)]: { requests: 3 },
    [slot(NOW) + 1]: { requests: 100 },
  } } };
  const result = buildUsageHistory(state, query, NOW);
  assert.equal(result.buckets.length, 97);
  assert.equal(result.buckets[0], '2026-10-25T12:00:00.000Z');
  assert.equal(result.buckets.at(-1), '2026-10-26T12:00:00.000Z');
  assert.equal(result.from, new Date(from).toISOString());
  assert.equal(result.to, new Date(NOW).toISOString());
  assert.equal(result.partialFirst, true);
  assert.equal(result.partialLast, true);
  assert.equal(result.total[0], 2);
  assert.equal(result.total.at(-1), 3);
  assert.equal(sum(result.total), 5);
  assert.equal(result.coverage, 'recorded-activity');
  assert.equal(result.earliestRetainedActivityAt, '2026-10-25T12:00:00.000Z');
});

test('both windows, resolutions and metrics aggregate the same retained slot counters', () => {
  const tracker = new ClientUsageTracker({ now: () => NOW });
  tracker.record('alice', { requests: 3, inputTokens: 21, outputTokens: 8 });
  for (const window of ['5h', '24h']) for (const step of ['15m', '1h']) {
    for (const [metric, expected] of [['requests', 3], ['inputTokens', 21], ['outputTokens', 8]]) {
      const result = buildUsageHistory(tracker.exportState(), { ...query, window, step, metric }, NOW);
      assert.equal(result.buckets.length, (window === '5h' ? 5 : 24) * (step === '15m' ? 4 : 1) + 1);
      assert.equal(result.stepMs, step === '15m' ? USAGE_SLOT_MS : 3600000);
      assert.equal(sum(result.total), expected);
      assert.deepEqual(result.series[0].values, result.total);
    }
  }
});

test('hour aggregation clips older slots inside the same first hourly bucket', () => {
  const state = { alice: { slots: { [slot(NOW - 5 * 3600000) - 1]: { requests: 9 }, [slot(NOW - 5 * 3600000)]: { requests: 2 } } } };
  assert.equal(sum(buildUsageHistory(state, { ...query, window: '5h', step: '1h' }, NOW).total), 2);
});

test('top twelve and remainder preserve every bucket, including overflow values', () => {
  const state = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`client-${index}`, { slots: { [slot(NOW)]: { requests: index + 1 }, [slot(NOW) - 1]: { requests: 1 } } }]));
  state['(other)'] = { slots: { [slot(NOW)]: { requests: 6 } } };
  const before = JSON.stringify(state);
  const result = buildUsageHistory(state, query, NOW);
  assert.equal(JSON.stringify(state), before, 'projection does not mutate saved counters');
  assert.equal(result.series.length, 13);
  assert.equal(result.series.at(-1).key, '(remaining)');
  assert.equal(result.series[0].key, 'client-29');
  for (let i = 0; i < result.total.length; i++) assert.equal(sum(result.series.map(row => row.values[i])), result.total[i]);
  assert.equal(sum(result.total), 30 * 31 / 2 + 30 + 6);
});

test('normal restart retains history; legacy lifetime counters do not create samples', () => {
  const tracker = new ClientUsageTracker({ now: () => NOW });
  tracker.record('alice', { requests: 2 });
  const restored = new ClientUsageTracker({ now: () => NOW });
  restored.restore(tracker.exportState());
  assert.deepEqual(buildUsageHistory(restored.exportState(), query, NOW), buildUsageHistory(tracker.exportState(), query, NOW));
  restored.restore({ legacy: { requests: 500, inputTokens: 800 } });
  assert.equal(sum(buildUsageHistory(restored.exportState(), query, NOW).total), 2);
  const empty = buildUsageHistory({ legacy: { requests: 500, inputTokens: 800 } }, query, NOW);
  assert.equal(empty.earliestRetainedActivityAt, null);
  assert.equal(sum(empty.total), 0);
  assert.deepEqual(empty.series, []);
});

test('earliest retained activity describes all retained observations, not uptime or the selected metric', () => {
  const state = { alice: { slots: { [slot(NOW) - 70]: { inputTokens: 5 }, [slot(NOW)]: { requests: 2 } } } };
  const result = buildUsageHistory(state, { ...query, window: '5h' }, NOW);
  assert.equal(result.earliestRetainedActivityAt, new Date((slot(NOW) - 70) * USAGE_SLOT_MS).toISOString());
  assert.equal(sum(result.total), 2);
});

async function request(url, { key = 'admin', method = 'GET', config, clientUsage = null, dimensionUsage = null } = {}) {
  let status, headers, body;
  const res = { writeHead: (code, values) => { status = code; headers = values; }, end: raw => { body = JSON.parse(raw); } };
  const handled = await handleUsageHistoryRequest({ url, method, headers: key ? { 'x-api-key': key } : {} }, res, { config: config ?? { proxy: { apiKey: 'admin', usageDimensions: [{ name: 'project', header: 'x-project' }] } }, clientUsage, dimensionUsage });
  return { status, headers, body, handled };
}
const route = '/relaycrew/usage/history?scope=clients&window=24h&step=15m&metric=requests';

test('history serves one configured dimension, never sums dimensions and clients', async () => {
  const clients = new ClientUsageTracker();
  clients.record('alice', { requests: 100 });
  const dimensions = new UsageDimensionTracker();
  dimensions.record('project', 'repo-a', { requests: 3 });
  dimensions.record('branch', 'main', { requests: 15 });
  const response = await request('/relaycrew/usage/history?scope=dimension&dimension=project&window=24h&step=1h&metric=requests', { clientUsage: clients, dimensionUsage: dimensions });
  assert.equal(response.status, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(sum(response.body.total), 3);
  assert.equal(response.body.series[0].key, 'repo-a');
  assert.equal((await request(route, { clientUsage: clients })).body.total.at(-1), 100);
});

test('history rejects invalid, duplicated and unconfigured selectors without reading snapshots', async () => {
  let reads = 0;
  const tracker = { exportState: () => { reads++; return {}; } };
  const invalid = [
    route.replace('24h', '7d'), route.replace('15m', '1m'), route.replace('requests', 'connections'), route.replace('clients', 'all'),
    route + '&window=5h', route + '&foo=bar', route + '&dimension=project',
    route.replace('scope=clients', 'scope=dimension'), route.replace('scope=clients', 'scope=dimension&dimension=unknown'),
  ];
  for (const url of invalid) assert.equal((await request(url, { clientUsage: tracker, dimensionUsage: tracker })).status, 400, url);
  assert.equal(reads, 0);
  assert.equal((await request(route, { key: null })).status, 401);
  assert.equal((await request(route, { method: 'POST' })).status, 405);
  assert.equal((await request('/other')).handled, false);
});
