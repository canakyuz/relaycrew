import { USAGE_SLOT_MS, USAGE_WINDOWS } from './client-usage.js';
import { classificationPath } from './classification-path.js';
import { TeamConfigError } from './team-config.js';
import { authenticatedTeamAdmin, teamJson } from './team-api.js';

/** @typedef {{scope:'clients'|'dimension', dimension?:string, window:'5h'|'24h', step:'15m'|'1h', metric:'requests'|'inputTokens'|'outputTokens'}} HistoryQuery */

/** @param {any} query @returns {HistoryQuery} */
function validateQuery(query) {
  if (!query || !['clients', 'dimension'].includes(query.scope)) throw new TeamConfigError('scope must be clients or dimension.');
  if (!Object.hasOwn(USAGE_WINDOWS, query.window)) throw new TeamConfigError('window must be 5h or 24h.');
  if (!['15m', '1h'].includes(query.step)) throw new TeamConfigError('step must be 15m or 1h.');
  if (!['requests', 'inputTokens', 'outputTokens'].includes(query.metric)) throw new TeamConfigError('Unsupported history metric.');
  if (query.scope === 'dimension' && (typeof query.dimension !== 'string' || !query.dimension)) throw new TeamConfigError('A configured dimension is required.');
  if (query.scope === 'clients' && query.dimension !== undefined) throw new TeamConfigError('dimension applies only to dimension scope.');
  return query;
}

/** Project the existing sparse slots; absent samples mean no recorded activity.
 * Buckets align to UTC. Whole edge slots are retained, matching usage windows:
 * the oldest includes up to 15 minutes before `from`, the current is incomplete.
 * @param {Record<string, any>} snapshot The selected client/dimension tracker state.
 * @param {HistoryQuery} query @param {number} [now]
 */
export function buildUsageHistory(snapshot, query, now = Date.now()) {
  validateQuery(query);
  const from = now - USAGE_WINDOWS[query.window];
  const stepMs = query.step === '1h' ? 60 * 60 * 1000 : USAGE_SLOT_MS;
  const firstSlot = Math.floor(from / USAGE_SLOT_MS);
  const lastSlot = Math.floor(now / USAGE_SLOT_MS);
  const firstBucket = Math.floor(from / stepMs) * stepMs;
  const count = Math.floor(now / stepMs) - Math.floor(from / stepMs) + 1;
  const buckets = Array.from({ length: count }, (_, i) => new Date(firstBucket + i * stepMs).toISOString());
  const total = Array(count).fill(0);
  let earliest = Infinity;
  const retainedFirst = Math.floor(now / USAGE_SLOT_MS) - Math.ceil(USAGE_WINDOWS['24h'] / USAGE_SLOT_MS);
  const rows = [];
  for (const [key, record] of Object.entries(snapshot ?? {})) {
    const values = Array(count).fill(0);
    let sum = 0;
    for (const [rawSlot, counters] of Object.entries(record?.slots ?? {})) {
      const slot = Number(rawSlot);
      if (!Number.isSafeInteger(slot) || slot < retainedFirst || slot > lastSlot || !counters || typeof counters !== 'object') continue;
      if (['requests', 'connections', 'inputTokens', 'outputTokens'].some(metric => Number.isFinite(counters[metric]) && counters[metric] > 0)) earliest = Math.min(earliest, slot * USAGE_SLOT_MS);
      if (slot < firstSlot) continue;
      const value = counters[query.metric];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
      const index = Math.floor((slot * USAGE_SLOT_MS - firstBucket) / stepMs);
      values[index] += value;
      total[index] += value;
      sum += value;
    }
    if (sum) rows.push({ key, values, sum });
  }
  rows.sort((a, b) => b.sum - a.sum || a.key.localeCompare(b.key));
  const series = rows.slice(0, 12).map(({ key, values }) => ({ key, values }));
  if (rows.length > 12) {
    const values = Array(count).fill(0);
    for (const row of rows.slice(12)) for (let i = 0; i < count; i++) values[i] += row.values[i];
    series.push({ key: '(remaining)', values });
  }
  return {
    ok: true, from: new Date(from).toISOString(), to: new Date(now).toISOString(),
    slotMs: USAGE_SLOT_MS, stepMs, buckets, series, total,
    coverage: 'recorded-activity', partialFirst: true, partialLast: true,
    earliestRetainedActivityAt: Number.isFinite(earliest) ? new Date(earliest).toISOString() : null,
  };
}

/** Server calls this after its control-plane authorization gates.
 * @param {any} req @param {any} res
 * @param {{config:Record<string, any>, clientUsage?:any, dimensionUsage?:any}} options
 * @returns {Promise<boolean>}
 */
export async function handleUsageHistoryRequest(req, res, { config, clientUsage = null, dimensionUsage = null }) {
  if (classificationPath(req.url) !== '/relaycrew/usage/history') return false;
  if (!authenticatedTeamAdmin(req, config)) {
    teamJson(res, req.tcClient || req.tcTeamIdentity?.kind === 'member' ? 403 : 401, { ok: false, error: 'Administrator authentication required.' });
    return true;
  }
  if (req.method !== 'GET') { teamJson(res, 405, { ok: false, error: 'Method not allowed.' }); return true; }
  try {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const allowed = ['scope', 'dimension', 'window', 'step', 'metric'];
    for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new TeamConfigError('Unknown or repeated history parameter.');
    const query = validateQuery(Object.fromEntries(params));
    let state;
    if (query.scope === 'clients') state = clientUsage?.exportState() ?? {};
    else {
      const dimensions = config.proxy?.usageDimensions ?? [];
      if (!dimensions.some((/** @type {{name?:string}} */ dimension) => dimension?.name === query.dimension)) throw new TeamConfigError('Unknown usage dimension.');
      const snapshot = dimensionUsage?.exportState() ?? {};
      const dimension = query.dimension ?? '';
      state = Object.hasOwn(snapshot, dimension) ? snapshot[dimension] : {};
    }
    teamJson(res, 200, buildUsageHistory(state, query));
  } catch (error) {
    teamJson(res, error instanceof TeamConfigError ? error.status : 500, { ok: false, error: error instanceof TeamConfigError ? error.message : 'Unable to read usage history.' });
  }
  return true;
}
