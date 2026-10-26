import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';

const configPath = process.env.TEAMCLAUDE_CONFIG;
assert.equal(configPath, '/data/teamclaude.json', 'Run this script in the gateway container with an empty /data volume');
assert.equal(existsSync(configPath), false, 'The smoke check requires an empty /data volume');

function cli(args) {
  const result = spawnSync('teamclaude', ['team', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

cli(['init']);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
config.quotaProbeSeconds = 0;
config.accounts = [{ id: 'smoke-provider', name: 'smoke-provider', type: 'apikey', apiKey: 'synthetic-smoke-provider-key' }];
writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
cli(['add', 'smoke-member', '--accounts', 'smoke-provider']);
const oldKey = JSON.parse(readFileSync(configPath, 'utf8')).proxy.clientKeys[0].key;
const server = spawn('teamclaude', ['server', '--headless'], { stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
server.stderr.on('data', chunk => { stderr += chunk; });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Gateway startup timed out')), 10000);
    server.once('exit', () => { clearTimeout(timer); reject(new Error('Gateway exited before ready')); });
    let output = '';
    server.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('  Bind:')) { clearTimeout(timer); resolve(); }
    });
  });
  const url = `http://127.0.0.1:${config.proxy.port}`;
  const get = (path, key) => fetch(url + path, { headers: key ? { 'x-api-key': key } : {}, signal: AbortSignal.timeout(2000) });
  assert.equal((await get('/teamclaude/status')).status, 401);
  assert.equal((await get('/teamclaude/status', oldKey)).status, 403);
  assert.equal((await get('/teamclaude/status', config.proxy.apiKey)).status, 200);
  assert.equal((await get('/teamclaude/me', oldKey)).status, 200);
  assert.match(cli(['rotate', 'smoke-member']), /Reloaded running server/);
  const newKey = JSON.parse(readFileSync(configPath, 'utf8')).proxy.clientKeys[0].key;
  assert.equal((await get('/teamclaude/me', oldKey)).status, 401);
  assert.equal((await get('/teamclaude/me', newKey)).status, 200);
  assert.match(cli(['revoke', 'smoke-member']), /Reloaded running server/);
  assert.equal((await get('/teamclaude/me', newKey)).status, 401);
  console.log('Container smoke passed: startup, administrator isolation, live rotation, live revocation.');
} catch (error) {
  throw new Error(`${error.message}\n${stderr}`);
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await exited;
  }
}
