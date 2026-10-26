import { createHash, timingSafeEqual } from 'node:crypto';
import { classificationPath } from './classification-path.js';

/** @typedef {{ kind: 'admin', fingerprint: string } | { kind: 'member', name: string, fingerprint: string }} TeamIdentity */
/** @typedef {{ name: string, key: string, accounts: string[] | '*', maxConcurrent?: number, disabled?: boolean }} TeamMember */

/** @typedef {{teamMode?: boolean, apiKey?: string, clientKeys?: TeamMember[]}} TeamProxy */
/** @typedef {Record<string, any>} TeamAccount */
/** @typedef {{identity: TeamIdentity, abort: AbortController, signal: AbortSignal, account: TeamAccount|null, allows: (account: TeamAccount) => boolean, valid: () => boolean, session: (raw: string|null) => string|null}} TeamRequest */

const MEMBER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** @type {WeakMap<object, TeamAccess>} */
const controllers = new WeakMap();

/** @param {string} key */
function fingerprint(key) {
  return createHash('sha256').update(key).digest('hex');
}

/** @param {unknown} key @param {unknown} digest */
function matches(key, digest) {
  if (typeof key !== 'string' || typeof digest !== 'string') return false;
  const expected = Buffer.from(fingerprint(key));
  const actual = Buffer.from(digest);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** @param {TeamProxy|undefined} proxy */
export function validateTeamConfig(proxy) {
  if (proxy?.teamMode != null && typeof proxy.teamMode !== 'boolean') throw new Error('proxy.teamMode must be a boolean');
  if (proxy?.teamMode !== true) return;
  if (typeof proxy.apiKey !== 'string' || !proxy.apiKey.trim()) throw new Error('Team mode requires an administrator proxy.apiKey');
  if (!Array.isArray(proxy.clientKeys)) throw new Error('Team mode requires proxy.clientKeys');
  const names = new Set();
  const keys = new Set([proxy.apiKey]);
  for (const member of proxy.clientKeys) {
    if (!member || typeof member.name !== 'string' || !MEMBER_NAME.test(member.name) || names.has(member.name)) throw new Error('Team member names must be unique identifiers');
    if (typeof member.key !== 'string' || !member.key.trim() || keys.has(member.key)) throw new Error('Team member keys must be nonempty and unique');
    if (member.accounts !== '*' && (!Array.isArray(member.accounts) || !member.accounts.every(id => typeof id === 'string' && id.length > 0))) throw new Error('Team members require explicit account IDs or "*"');
    if (member.maxConcurrent != null && (!Number.isSafeInteger(member.maxConcurrent) || member.maxConcurrent < 1 || member.maxConcurrent > 1024)) throw new Error('Team maxConcurrent must be an integer from 1 to 1024');
    if (member.disabled != null && typeof member.disabled !== 'boolean') throw new Error('Team member disabled must be a boolean');
    names.add(member.name);
    keys.add(member.key);
  }
}

/** @param {TeamProxy} proxy @param {unknown} key @returns {{ ok: boolean, client: string|null, identity: TeamIdentity|null }} */
export function authenticateTeam(proxy, key) {
  validateTeamConfig(proxy);
  if (typeof key !== 'string' || !key) return { ok: false, client: null, identity: null };
  const digest = fingerprint(key);
  if (matches(proxy.apiKey, digest)) return { ok: true, client: null, identity: { kind: 'admin', fingerprint: digest } };
  const member = (proxy.clientKeys ?? []).find(entry => !entry.disabled && matches(entry.key, digest));
  return member
    ? { ok: true, client: member.name, identity: { kind: 'member', name: member.name, fingerprint: digest } }
    : { ok: false, client: null, identity: null };
}

/** @param {TeamProxy|undefined} proxy @param {TeamIdentity|null|undefined} identity @returns {TeamMember|null} */
export function currentTeamMember(proxy, identity) {
  validateTeamConfig(proxy);
  if (identity?.kind !== 'member') return null;
  return (proxy?.clientKeys ?? []).find(member => member.name === identity.name && !member.disabled && matches(member.key, identity.fingerprint)) || null;
}

/** @param {TeamProxy|undefined} proxy @param {TeamIdentity|null|undefined} identity */
export function teamIdentityValid(proxy, identity) {
  if (proxy?.teamMode !== true) return identity == null;
  if (identity?.kind === 'admin') return matches(proxy.apiKey, identity.fingerprint);
  return currentTeamMember(proxy, identity) !== null;
}

/** @param {TeamProxy|undefined} proxy @param {TeamIdentity|null|undefined} identity @param {TeamAccount} account */
export function teamAllowsAccount(proxy, identity, account) {
  if (proxy?.teamMode !== true) return identity == null;
  if (!teamIdentityValid(proxy, identity)) return false;
  if (!identity) return false;
  if (identity.kind === 'admin') return true;
  const member = currentTeamMember(proxy, identity);
  return member !== null && (member.accounts === '*' || member.accounts.includes(account?.id));
}

/** @param {TeamRequest|null|undefined} access @param {TeamAccount[]} accounts @param {Set<number>} [excluded] */
export function teamExclusions(access, accounts, excluded = new Set()) {
  if (!access) return excluded;
  return new Set([...excluded, ...accounts.filter(account => !access.allows(account)).map(account => account.index)]);
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {string} message */
export function teamError(res, status, message) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(status === 429 ? { 'retry-after': '1' } : {}) });
  res.end(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : 'permission_error', message } }));
}

/** @param {string|undefined} method @param {string|undefined} url */
export function teamInferencePath(method, url) {
  let path = classificationPath(url);
  if (path.startsWith('/tc-acct/')) path = path.slice(path.indexOf('/', '/tc-acct/'.length));
  if (method === 'POST') return ['/v1/messages', '/v1/messages/count_tokens', '/v1/responses', '/responses', '/responses/compact', '/v1/responses/compact', '/backend-api/codex/responses', '/backend-api/codex/responses/compact'].includes(path);
  return method === 'GET' && ['/v1/models', '/models', '/backend-api/codex/models'].includes(path);
}

/** @param {{proxy?: TeamProxy}} config */
export function teamAccessFor(config) {
  let controller = controllers.get(config);
  if (!controller) {
    controller = new TeamAccess(config);
    controllers.set(config, controller);
  }
  return controller;
}

class TeamAccess {
  /** @param {{proxy?: TeamProxy}} config */
  constructor(config) {
    this.config = config;
    this.active = new Map();
    /** @type {Set<TeamRequest>} */
    this.requests = new Set();
  }

  refresh() {
    for (const request of this.requests) {
      if (!request.valid() || (request.account && !request.allows(request.account))) request.abort.abort(new Error('Team access changed'));
    }
  }

  /** @param {TeamIdentity|null} identity @param {import('node:http').ServerResponse} res @returns {TeamRequest|null} */
  enter(identity, res) {
    const proxy = this.config.proxy;
    if (!teamIdentityValid(proxy, identity)) {
      teamError(res, 401, 'Team credential has been revoked or rotated');
      return null;
    }
    const member = currentTeamMember(proxy, identity);
    if (member) {
      const active = this.active.get(member.name) || 0;
      if (active >= (member.maxConcurrent ?? 4)) {
        teamError(res, 429, 'Member concurrency limit reached');
        return null;
      }
      this.active.set(member.name, active + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.active.set(member.name, Math.max(0, (this.active.get(member.name) || 0) - 1));
      };
      res.once('finish', release);
      res.once('close', release);
    }
    if (!identity) return null;
    const abort = new AbortController();
    abort.signal.addEventListener('abort', () => res.destroy(), { once: true });
    /** @type {TeamRequest} */
    const access = {
      identity,
      abort,
      signal: abort.signal,
      account: null,
      allows: account => teamAllowsAccount(this.config.proxy, identity, account),
      valid: () => teamIdentityValid(this.config.proxy, identity),
      session: raw => raw == null ? null : `team-${fingerprint(JSON.stringify([identity.kind, identity.kind === 'member' ? identity.name : null, raw]))}`,
    };
    this.requests.add(access);
    const cleanup = () => this.requests.delete(access);
    res.once('finish', cleanup);
    res.once('close', cleanup);
    return access;
  }

  /** @param {TeamIdentity} identity @param {import('./client-usage.js').ClientUsageTracker|null} clientUsage */
  status(identity, clientUsage) {
    const member = currentTeamMember(this.config.proxy, identity);
    if (!member) throw new Error('Member is no longer active');
    const usage = clientUsage?.export() ?? {};
    return {
      member: member.name,
      accounts: member.accounts,
      concurrency: { active: this.active.get(member.name) || 0, limit: member.maxConcurrent ?? 4 },
      usage: Object.hasOwn(usage, member.name) ? usage[member.name] : { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0, lastUsed: null },
    };
  }
}
