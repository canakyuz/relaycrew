import { timingSafeEqual } from 'node:crypto';
import { atomicConfigUpdate, getConfigPath, loadConfigPersistingIds } from './config.js';
import { classificationPath } from './classification-path.js';
import { teamAccessFor } from './team-access.js';
import { TeamConfigError, applyTeamAction, configuredMembers, redactMember, teamAccounts, teamRevision } from './team-config.js';

/** These APIs always require the administrator key, including on loopback.
 * @param {any} req @param {Record<string, any>} config
 */
export function authenticatedTeamAdmin(req, config) {
  const key = req.headers?.['x-api-key'];
  const admin = config.proxy?.apiKey;
  if (typeof key !== 'string' || !key || typeof admin !== 'string' || !admin || req.tcClient) return false;
  if ((config.proxy?.clientKeys ?? []).some((/** @type {{key?:string}} */ member) => member?.key === key)) return false;
  const actual = Buffer.from(key);
  const expected = Buffer.from(admin);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** @param {any} res @param {number} status @param {any} body */
export function teamJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Keep persistence AND reload in order. The config lock cannot enclose reload:
// reload itself reads/persists account IDs through that same lock.
const mutations = new Map();
/** @template T @param {()=>Promise<T>} run @returns {Promise<T>} */
function serializeMutation(run) {
  const path = getConfigPath();
  const previous = mutations.get(path) ?? Promise.resolve();
  const result = previous.then(run, run);
  const settled = result.then(() => {}, () => {});
  mutations.set(path, settled);
  settled.then(() => { if (mutations.get(path) === settled) mutations.delete(path); });
  return result;
}

/** @param {Record<string, any>} disk @param {Record<string, any>} live @param {any} clientUsage */
function listTeam(disk, live, clientUsage) {
  const usage = clientUsage?.export() ?? {};
  const active = teamAccessFor(live).active;
  return {
    ok: true,
    enabled: disk.proxy?.teamMode === true,
    revision: teamRevision(disk),
    accounts: teamAccounts(disk),
    members: disk.proxy?.teamMode === true ? configuredMembers(disk).map(member => ({
      ...redactMember(member),
      active: active.get(member.name) ?? 0,
      usage: Object.hasOwn(usage, member.name) ? usage[member.name] : { requests: 0, inputTokens: 0, outputTokens: 0, lastUsed: null },
    })) : [],
  };
}

/** HTTP authorization, CSRF and member control gates in server.js run first.
 * This handler also verifies the administrator credential, so loopback cannot
 * inherit the older control plane's key exemption.
 * @param {any} req @param {any} res
 * @param {{config:Record<string, any>, hooks?:{reload?:()=>Promise<any>}, clientUsage?:any, readBody:(req:any)=>Promise<string|Buffer>}} options
 * @returns {Promise<boolean>}
 */
export async function handleTeamRequest(req, res, { config, hooks = {}, clientUsage = null, readBody }) {
  const path = classificationPath(req.url);
  const match = /^\/relaycrew\/team\/(add|update|rotate|revoke)$/.exec(path);
  if (path !== '/relaycrew/team' && !match) return false;
  if (!authenticatedTeamAdmin(req, config)) {
    teamJson(res, req.tcClient || req.tcTeamIdentity?.kind === 'member' ? 403 : 401, { ok: false, error: 'Administrator authentication required.' });
    return true;
  }
  try {
    if (req.method === 'GET' && !match) {
      const disk = await loadConfigPersistingIds() ?? config;
      teamJson(res, 200, listTeam(disk, config, clientUsage));
      return true;
    }
    if (req.method !== 'POST' || !match) {
      teamJson(res, 405, { ok: false, error: 'Method not allowed.' });
      return true;
    }
    let body;
    try {
      const raw = await readBody(req);
      if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('oversized');
      body = JSON.parse(String(raw));
    } catch {
      throw new TeamConfigError('A valid JSON body no larger than 64 KiB is required.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TeamConfigError('Expected a JSON object.');
    const action = /** @type {'add'|'update'|'rotate'|'revoke'} */ (match[1]);
    const allowed = action === 'add' || action === 'update'
      ? ['revision', 'name', 'accounts', 'maxConcurrent', ...(action === 'update' ? ['disabled'] : [])]
      : ['revision', 'name'];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw new TeamConfigError('Unknown member field. Names cannot be changed.');
    if (typeof body.revision !== 'string' || !body.revision) throw new TeamConfigError('A current revision is required.');
    const result = await serializeMutation(async () => {
      /** @type {ReturnType<typeof applyTeamAction>} */
      let change = {};
      const saved = await atomicConfigUpdate((/** @type {Record<string, any>} */ disk) => {
        if (body.revision !== teamRevision(disk)) throw new TeamConfigError('Team configuration changed. Refresh before saving.', 409);
        change = applyTeamAction(disk, { ...body, action });
      });
      let applied = false;
      try {
        if (typeof hooks.reload === 'function') {
          await hooks.reload();
          teamAccessFor(config).refresh();
          applied = true;
        }
      } catch { /* The durable result and one-time key must survive reload failure. */ }
      return {
        ok: true, saved: true, applied, revision: teamRevision(saved), ...change,
        ...(applied ? {} : { warning: 'Changes saved. Runtime reload failed or is unavailable; reload the server to apply them.' }),
      };
    });
    teamJson(res, action === 'add' ? 201 : 200, result);
  } catch (error) {
    const status = error instanceof TeamConfigError ? error.status : /** @type {{code?:string}} */ (error).code === 'CONFIG_LOCK_BUSY' ? 503 : 500;
    teamJson(res, status, { ok: false, error: error instanceof TeamConfigError ? error.message : status === 503 ? 'Config is busy. Try again shortly.' : 'Unable to read or save team configuration.' });
  }
  return true;
}
