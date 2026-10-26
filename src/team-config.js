import { createHmac, randomBytes } from 'node:crypto';
import { providerOf } from './provider.js';

/** @typedef {{name:string, key:string, accounts:string[]|'*', maxConcurrent?:number, disabled?:boolean}} TeamMember */
/** @typedef {{action:'init'} |
 * {action:'add', name:string, accounts:string[]|'*', maxConcurrent:number} |
 * {action:'update', name:string, accounts:string[]|'*', maxConcurrent:number, disabled:boolean} |
 * {action:'rotate'|'revoke', name:string}} TeamAction */

/** An error safe to return to an administrator without including credentials. */
export class TeamConfigError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** @param {unknown} name */
export function validateName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
    throw new TeamConfigError('Member names must be 1-64 letters, digits, underscores, dots or hyphens, starting with a letter or digit.');
  }
}

/** @param {unknown} grants @param {Set<string>} [accountIds] */
export function validateGrants(grants, accountIds) {
  if (grants === '*') return;
  if (!Array.isArray(grants) || grants.some(id => typeof id !== 'string' || !id || id === '*') || new Set(grants).size !== grants.length) {
    throw new TeamConfigError('Each member needs distinct explicit account IDs or accounts: "*".');
  }
  if (accountIds && grants.some(id => !accountIds.has(id))) {
    throw new TeamConfigError('An account grant does not match a configured stable ID. Run team accounts to list IDs.');
  }
}

/** @param {unknown} limit */
function validateLimit(limit) {
  if (!Number.isSafeInteger(limit) || typeof limit !== 'number' || limit < 1 || limit > 1024) throw new TeamConfigError('Member maxConcurrent must be an integer from 1 to 1024.');
}

/** @param {Record<string, any>} config @returns {TeamMember[]} */
export function configuredMembers(config) {
  const entries = config.proxy?.clientKeys ?? [];
  if (!Array.isArray(entries)) throw new TeamConfigError('proxy.clientKeys must be an array. Review the protected config file.');
  const names = new Set();
  const keys = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new TeamConfigError('Invalid member entry. Review the protected config file.');
    validateName(entry.name);
    if (names.has(entry.name)) throw new TeamConfigError('Duplicate member name. Review the protected config file.');
    if (typeof entry.key !== 'string' || !entry.key.trim() || /\s|[\x00-\x1f\x7f]/.test(entry.key)) throw new TeamConfigError('Each member needs a non-empty key without whitespace or control characters.');
    if (keys.has(entry.key) || entry.key === config.proxy?.apiKey) throw new TeamConfigError('Duplicate member key or member/admin key collision. Review the protected config file.');
    validateGrants(entry.accounts);
    validateLimit(entry.maxConcurrent ?? 4);
    if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') throw new TeamConfigError('Member disabled must be true or false.');
    names.add(entry.name);
    keys.add(entry.key);
  }
  return entries;
}

function newKey() { return 'tc-' + randomBytes(32).toString('base64url'); }

/** @param {TeamMember} member */
export function redactMember(member) {
  return { name: member.name, accounts: member.accounts === '*' ? '*' : [...member.accounts], maxConcurrent: member.maxConcurrent ?? 4, disabled: member.disabled === true };
}

/** @param {Record<string, any>} config */
export function teamAccounts(config) {
  return (config.accounts ?? []).map((/** @type {Record<string, any>} */ account) => ({ id: account.id, name: account.name ?? '', provider: providerOf(account), disabled: account.disabled === true }));
}

// HMAC makes the optimistic concurrency token opaque, including when only a
// credential changed. It is not a reusable key fingerprint. Restart expires it.
const revisionSecret = randomBytes(32);
/** @param {Record<string, any>} config */
export function teamRevision(config) {
  return createHmac('sha256', revisionSecret).update(JSON.stringify({ enabled: config.proxy?.teamMode === true, admin: config.proxy?.apiKey, members: config.proxy?.clientKeys ?? [], accounts: teamAccounts(config) })).digest('base64url');
}

/** Pure domain mutation; persistence and runtime refresh belong to the caller.
 * @param {Record<string, any>} config @param {TeamAction} action
 * @returns {{member?: ReturnType<typeof redactMember>, issuedKey?: string}}
 */
export function applyTeamAction(config, action) {
  const members = configuredMembers(config);
  if (action.action === 'init') {
    const ids = new Set((config.accounts ?? []).map((/** @type {Record<string, any>} */ account) => account.id));
    for (const member of members) validateGrants(member.accounts, ids);
    config.proxy ??= {};
    config.proxy.clientKeys ??= [];
    const admin = config.proxy.apiKey;
    if (typeof admin !== 'string' || admin.length < 32 || /\s|[\x00-\x1f\x7f]/.test(admin)) config.proxy.apiKey = newKey();
    config.proxy.teamMode = true;
    config.proxy.trustLoopback = false;
    config.autoUpdate = false;
    for (const member of members) member.maxConcurrent ??= 4;
    return {};
  }
  if (config.proxy?.teamMode !== true) throw new TeamConfigError('Team mode is not enabled. Run team init first.', 409);
  validateName(action.name);
  if (action.action === 'add' || action.action === 'update') {
    validateGrants(action.accounts, new Set((config.accounts ?? []).map((/** @type {Record<string, any>} */ account) => account.id)));
    validateLimit(action.maxConcurrent ?? (action.action === 'add' ? 4 : undefined));
    if (action.action === 'update' && typeof action.disabled !== 'boolean') throw new TeamConfigError('Member disabled must be true or false.');
  }
  if (action.action === 'add') {
    if (members.some(member => member.name === action.name)) throw new TeamConfigError('Member already exists.', 409);
    const issuedKey = newKey();
    /** @type {TeamMember} */
    const member = { name: action.name, key: issuedKey, accounts: action.accounts === '*' ? '*' : [...action.accounts], maxConcurrent: action.maxConcurrent ?? 4 };
    config.proxy.clientKeys = [...members, member];
    return { member: redactMember(member), issuedKey };
  }
  const member = members.find(entry => entry.name === action.name);
  if (!member) throw new TeamConfigError('Member not found.', 404);
  if (action.action === 'revoke') member.disabled = true;
  else if (action.action === 'update') {
    member.accounts = action.accounts === '*' ? '*' : [...action.accounts];
    member.maxConcurrent = action.maxConcurrent;
    member.disabled = action.disabled;
  } else if (action.action === 'rotate') {
    const issuedKey = newKey();
    member.key = issuedKey;
    return { member: redactMember(member), issuedKey };
  } else throw new TeamConfigError('Unknown team action.');
  return { member: redactMember(member) };
}
