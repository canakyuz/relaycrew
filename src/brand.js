export const NAME = 'relaycrew';
export const LEGACY_NAMES = ['teamrouter', 'teamclaude'];
export const ENV_PREFIX = 'RELAYCREW_';
export const ROUTE_PREFIX = `/${NAME}`;

/** @param {string} name @param {NodeJS.ProcessEnv} [env] */
export function envVar(name, env = process.env) {
  for (const prefix of [ENV_PREFIX, 'TEAMROUTER_', 'TEAMCLAUDE_']) {
    const value = env[prefix + name];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** @param {string|undefined} url @returns {string|null} */
export function canonicalControlUrl(url) {
  if (!url) return null;
  for (const name of LEGACY_NAMES) {
    const prefix = `/${name}`;
    if (!url.startsWith(prefix)) continue;
    const rest = url.slice(prefix.length);
    if (rest === '' || rest[0] === '/' || rest[0] === '?') return ROUTE_PREFIX + rest;
  }
  return null;
}

/** @param {string} path */
export function isControlPath(path) {
  return [NAME, ...LEGACY_NAMES].some(name => path === `/${name}` || path.startsWith(`/${name}/`));
}
