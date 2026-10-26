import { atomicConfigUpdate, getConfigPath, loadConfig, loadConfigPersistingIds } from './config.js';
import { providerOf } from './provider.js';
import { applyTeamAction, configuredMembers, validateName } from './team-config.js';

/**
 * @typedef {{ name: string, key: string, accounts: string[]|'*', maxConcurrent: number, disabled?: boolean }} TeamMember
 * @typedef {{ action: 'init' } | { action: 'list' } | { action: 'accounts' } | { action: 'help' } |
 *   { action: 'revoke', name: string } | { action: 'rotate', name: string } |
 *   { action: 'add', name: string, accounts: string[]|'*', maxConcurrent: number }} TeamAction
 */

const USAGE = [
  'Usage: relaycrew team init',
  '       relaycrew team accounts',
  '       relaycrew team add <name> --accounts <id,id|*> [--max-concurrent N]',
  '       relaycrew team list',
  '       relaycrew team revoke <name>',
  '       relaycrew team rotate <name>',
  '',
  'Use stable IDs from team accounts. Quote "*" to explicitly grant every account.',
].join('\n');

/** @param {string[]} args @returns {TeamAction} */
function parseCommand(args) {
  const [action, name, ...flags] = args;
  if ((action === '--help' || action === '-h') && args.length === 1) return { action: 'help' };
  if (action === 'init' || action === 'list' || action === 'accounts') {
    if (args.length !== 1) throw new Error(USAGE);
    return { action };
  }
  if (action !== 'add' && action !== 'revoke' && action !== 'rotate') throw new Error(USAGE);
  if (!name) throw new Error(USAGE);
  validateName(name);
  if (action !== 'add') {
    if (flags.length) throw new Error(USAGE);
    return { action, name };
  }

  const options = new Map();
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i];
    if (flag !== '--accounts' && flag !== '--max-concurrent') throw new Error(USAGE);
    if (options.has(flag)) throw new Error(`Duplicate option ${flag}.\n${USAGE}`);
    const value = flags[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.\n${USAGE}`);
    options.set(flag, value);
  }
  if (!options.has('--accounts')) throw new Error(`--accounts is required.\n${USAGE}`);
  const rawAccounts = String(options.get('--accounts'));
  const accounts = rawAccounts === '*' ? '*' : rawAccounts.split(',').map(id => id.trim());
  if (accounts !== '*' && (!accounts.length || accounts.some(id => !id || id === '*') || new Set(accounts).size !== accounts.length)) {
    throw new Error('--accounts must contain distinct account IDs, or a single quoted "*".');
  }
  const rawLimit = options.get('--max-concurrent') ?? '4';
  const maxConcurrent = Number(rawLimit);
  if (!/^[1-9][0-9]*$/.test(rawLimit) || !Number.isSafeInteger(maxConcurrent) || maxConcurrent > 1024) {
    throw new Error('--max-concurrent must be an integer from 1 to 1024.');
  }
  return { action, name, accounts, maxConcurrent };
}

/** @param {Record<string, any>} config */
async function notifyRunningServer(config) {
  const port = config.proxy?.port;
  if (port === 0 || port === undefined) {
    console.error('Changes saved. No local server port is configured; restart the server to apply them.');
    return;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('Changes saved, but the local reload port is invalid. Restart the server to apply them.');
    return;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/relaycrew/reload`, {
      method: 'POST',
      headers: { 'x-api-key': config.proxy.apiKey },
      signal: AbortSignal.timeout(1500),
      redirect: 'error',
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error('Reload refused');
    console.log('Reloaded running server.');
  } catch {
    console.error('Changes saved, but the local server reload failed. Restart the server to apply them.');
  }
}

/**
 * Manage team gateway members. Pass only the arguments following `team`.
 * @param {string[]} args
 */
export async function teamCommand(args) {
  try {
    const command = parseCommand(args);
    if (command.action === 'help') {
      console.log(USAGE);
      return;
    }
    if (command.action === 'accounts' || command.action === 'list') {
      const config = command.action === 'accounts' ? await loadConfigPersistingIds() : await loadConfig();
      if (!config) throw new Error('No config found. Run team init first.');
      if (command.action === 'accounts') {
        console.log('Account ID\tName\tProvider');
        for (const account of config.accounts) console.log(`${JSON.stringify(account.id)}\t${JSON.stringify(account.name ?? '')}\t${providerOf(account)}`);
      } else {
        const members = configuredMembers(config);
        console.log('Member\tAccounts\tMax concurrent\tState');
        for (const member of members) {
          console.log(`${member.name}\t${member.accounts === '*' ? '*' : JSON.stringify(member.accounts)}\t${member.maxConcurrent ?? 4}\t${member.disabled ? 'disabled' : 'active'}`);
        }
        if (!members.length) console.log('No team members configured.');
      }
      return;
    }

    let issuedKey;
    const config = await atomicConfigUpdate((/** @type {Record<string, any>} */ disk) => {
      ({ issuedKey } = applyTeamAction(disk, command));
    });

    if (command.action === 'init') {
      console.log(`Team mode enabled. Read the admin key from the protected config file at ${getConfigPath()}.`);
    } else if (command.action === 'revoke') {
      console.log(`Revoked member "${command.name}".`);
    } else {
      console.log(`${command.action === 'add' ? 'Added' : 'Rotated key for'} member "${command.name}".`);
      console.log(`Member key (shown once): ${issuedKey}`);
    }
    await notifyRunningServer(config);
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'Team command failed.');
    process.exitCode = 1;
  }
}
