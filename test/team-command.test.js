import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
const ADMIN_KEY = 'tc-fixture-admin-secret-0123456789abcdef';
const MEMBER_KEY = 'tc-fixture-member-secret-0123456789abcdef';

function baseConfig() {
  return {
    proxy: { port: 0, apiKey: ADMIN_KEY },
    upstream: 'https://upstream.invalid',
    upstreamProxy: false,
    autoUpdate: true,
    accounts: [
      { id: 'account-a', name: 'Alpha', type: 'apikey', apiKey: 'upstream-secret-a' },
      { id: 'account-b', name: 'Beta', provider: 'codex', type: 'oauth', accessToken: 'upstream-secret-b', refreshToken: 'refresh-secret-b' },
    ],
  };
}

function teamConfig() {
  const config = baseConfig();
  config.proxy.teamMode = true;
  config.proxy.clientKeys = [{ name: 'alice', key: MEMBER_KEY, accounts: ['account-a'], maxConcurrent: 2 }];
  return config;
}

async function fixture(t, config = baseConfig()) {
  const dir = await mkdtemp(join(tmpdir(), 'relaycrew-team-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(config));
  return { path, read: async () => JSON.parse(await readFile(path, 'utf8')) };
}

function runCli(configPath, args) {
  const child = spawn(process.execPath, [cliPath, 'team', ...args], {
    env: { ...process.env, RELAYCREW_CONFIG: configPath, RELAYCREW_DISABLE_AUTOUPDATE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Team CLI did not exit')); }, 10_000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function refusedWithoutSaving(path, args) {
  const before = await readFile(path, 'utf8');
  const result = await runCli(path, args);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.equal(await readFile(path, 'utf8'), before, 'a refused command must not save');
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${ADMIN_KEY}|${MEMBER_KEY}|upstream-secret|refresh-secret`));
  return result;
}

function issuedKey(result) {
  const match = result.stdout.match(/^Member key \(shown once\): (tc-[A-Za-z0-9_-]+)$/m);
  assert.ok(match, result.stdout);
  assert.equal(result.stdout.split(match[1]).length - 1, 1, 'the key must appear once');
  assert.ok(match[1].length >= 35);
  assert.ok(!result.stderr.includes(match[1]));
  return match[1];
}

test('team init preserves accounts and a strong admin key, disables trust and updates', async t => {
  const original = baseConfig();
  original.proxy.trustLoopback = true;
  const file = await fixture(t, original);
  const result = await runCli(file.path, ['init']);
  assert.equal(result.code, 0, result.stderr);
  const saved = await file.read();
  assert.equal(saved.proxy.teamMode, true);
  assert.equal(saved.proxy.trustLoopback, false);
  assert.equal(saved.autoUpdate, false);
  assert.equal(saved.proxy.apiKey, ADMIN_KEY);
  assert.deepEqual(saved.accounts, original.accounts);
  assert.match(result.stdout, /protected config file/);
  assert.ok(result.stdout.includes(file.path));
  assert.ok(!(result.stdout + result.stderr).includes(ADMIN_KEY));
  assert.match(result.stderr, /Changes saved/);
  assert.equal((await stat(file.path)).mode & 0o777, 0o600);
});

test('team init generates a strong admin key when absent or weak without printing it', async t => {
  for (const oldKey of [undefined, 'weak']) {
    const config = baseConfig();
    config.proxy.apiKey = oldKey;
    const file = await fixture(t, config);
    const result = await runCli(file.path, ['init']);
    assert.equal(result.code, 0, result.stderr);
    const saved = await file.read();
    assert.match(saved.proxy.apiKey, /^tc-[A-Za-z0-9_-]{43}$/);
    assert.ok(!(result.stdout + result.stderr).includes(saved.proxy.apiKey));
  }
});

test('team init refuses ambiguous keys, names and implicit or invalid grants without saving', async t => {
  const member = { name: 'alice', key: MEMBER_KEY, accounts: ['account-a'], maxConcurrent: 2 };
  const invalidEntries = [
    [{ name: 'alice', key: MEMBER_KEY }],
    [{ ...member, accounts: ['missing-id'] }],
    [{ ...member, accounts: ['account-a', 'account-a'] }],
    [{ ...member, accounts: ['*'] }],
    [{ ...member, maxConcurrent: 0 }],
    [{ ...member, disabled: 'yes' }],
    [member, { ...member, key: 'different-member-key' }],
    [member, { ...member, name: 'bob' }],
    [{ ...member, key: ADMIN_KEY }],
    [{ ...member, name: 'unsafe name' }],
  ];
  for (const entries of invalidEntries) {
    const config = baseConfig();
    config.proxy.clientKeys = entries;
    const file = await fixture(t, config);
    await refusedWithoutSaving(file.path, ['init']);
  }
});

test('team init accepts explicit grants and supplies the default concurrency', async t => {
  const config = baseConfig();
  config.proxy.clientKeys = [{ name: 'alice', key: MEMBER_KEY, accounts: '*' }];
  const file = await fixture(t, config);
  const result = await runCli(file.path, ['init']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await file.read()).proxy.clientKeys, [{ name: 'alice', key: MEMBER_KEY, accounts: '*', maxConcurrent: 4 }]);
});

test('team list prints grants, limits and states without credentials or writes', async t => {
  const config = teamConfig();
  config.proxy.clientKeys.push({ name: 'bob', key: 'tc-bob-secret', accounts: '*', maxConcurrent: 4, disabled: true });
  const file = await fixture(t, config);
  const before = await readFile(file.path, 'utf8');
  const result = await runCli(file.path, ['list']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /alice\t.*account-a.*\t2\tactive/);
  assert.match(result.stdout, /bob\t\*\t4\tdisabled/);
  for (const secret of [ADMIN_KEY, MEMBER_KEY, 'tc-bob-secret', 'upstream-secret-a', 'upstream-secret-b', 'refresh-secret-b']) assert.ok(!(result.stdout + result.stderr).includes(secret));
  assert.equal(await readFile(file.path, 'utf8'), before);
});

test('team accounts persists stable IDs and lists providers without credentials', async t => {
  const config = baseConfig();
  delete config.accounts[0].id;
  delete config.accounts[1].id;
  const file = await fixture(t, config);
  const first = await runCli(file.path, ['accounts']);
  assert.equal(first.code, 0, first.stderr);
  const saved = await file.read();
  assert.equal(new Set(saved.accounts.map(account => account.id)).size, 2);
  for (const account of saved.accounts) {
    assert.equal(typeof account.id, 'string');
    assert.ok(account.id.length);
    assert.ok(first.stdout.includes(account.id));
  }
  assert.match(first.stdout, /Alpha.*anthropic/);
  assert.match(first.stdout, /Beta.*codex/);
  for (const secret of [ADMIN_KEY, 'upstream-secret-a', 'upstream-secret-b', 'refresh-secret-b']) assert.ok(!(first.stdout + first.stderr).includes(secret));
  const after = await readFile(file.path, 'utf8');
  const second = await runCli(file.path, ['accounts']);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);
  assert.equal(await readFile(file.path, 'utf8'), after);
});

test('team add stores only explicit stable IDs and prints a random key once', async t => {
  const file = await fixture(t, teamConfig());
  const result = await runCli(file.path, ['add', 'bob', '--accounts', 'account-b,account-a', '--max-concurrent', '3']);
  assert.equal(result.code, 0, result.stderr);
  const key = issuedKey(result);
  const saved = await file.read();
  assert.deepEqual(saved.proxy.clientKeys[1], { name: 'bob', key, accounts: ['account-b', 'account-a'], maxConcurrent: 3 });
  assert.notEqual(key, MEMBER_KEY);
  assert.notEqual(key, ADMIN_KEY);
  assert.equal(saved.proxy.apiKey, ADMIN_KEY);
  assert.match(result.stderr, /Changes saved/);
  assert.equal((await stat(file.path)).mode & 0o777, 0o600);
});

test('team add accepts an explicit wildcard and defaults concurrency to four', async t => {
  const file = await fixture(t, teamConfig());
  const result = await runCli(file.path, ['add', 'all-accounts', '--accounts', '*']);
  assert.equal(result.code, 0, result.stderr);
  const key = issuedKey(result);
  assert.deepEqual((await file.read()).proxy.clientKeys[1], { name: 'all-accounts', key, accounts: '*', maxConcurrent: 4 });
});

test('team add refuses duplicate names, account names and unknown IDs without saving', async t => {
  const file = await fixture(t, teamConfig());
  for (const args of [
    ['add', 'alice', '--accounts', 'account-a'],
    ['add', 'bob', '--accounts', 'Alpha'],
    ['add', 'bob', '--accounts', 'missing-id'],
  ]) await refusedWithoutSaving(file.path, args);
});

test('malformed team commands fail before saving, including malformed flags and limits', async t => {
  const file = await fixture(t, teamConfig());
  const malformed = [
    [], ['unknown'], ['--help', 'extra'], ['init', '--unknown'], ['list', 'extra'], ['accounts', '--unknown'],
    ['revoke'], ['rotate'], ['revoke', 'alice', '--unknown'], ['rotate', 'alice', 'extra'],
    ['add'], ['add', 'bob'], ['add', 'bob', '--accounts'], ['add', 'bob', '--accounts', '--max-concurrent', '2'],
    ['add', 'bob', '--unknown', 'x'], ['add', 'bob', '--accounts', 'account-a', 'extra'],
    ['add', 'bob', '--accounts', 'account-a', '--accounts', 'account-b'],
    ['add', 'bob', '--accounts', 'account-a', '--max-concurrent', '2', '--max-concurrent', '3'],
    ['add', 'bob', '--accounts', ''], ['add', 'bob', '--accounts', 'account-a,'],
    ['add', 'bob', '--accounts', 'account-a,account-a'], ['add', 'bob', '--accounts', '*,account-a'],
    ['add', 'bad name', '--accounts', 'account-a'], ['add', '-bob', '--accounts', 'account-a'],
    ['add', 'a'.repeat(65), '--accounts', 'account-a'],
  ];
  for (const value of ['0', '-1', '1.5', '1e3', 'NaN', 'Infinity', '9007199254740992', '']) {
    malformed.push(['add', 'bob', '--accounts', 'account-a', '--max-concurrent', value]);
  }
  for (const args of malformed) await refusedWithoutSaving(file.path, args);
});

test('invalid adds do not persist account IDs as a side effect', async t => {
  const config = teamConfig();
  delete config.accounts[1].id;
  const file = await fixture(t, config);
  await refusedWithoutSaving(file.path, ['add', 'bob', '--accounts', 'Beta']);
});

test('member changes require explicit team initialization', async t => {
  const file = await fixture(t);
  for (const args of [ ['add', 'bob', '--accounts', 'account-a'], ['revoke', 'alice'], ['rotate', 'alice'] ]) {
    const result = await refusedWithoutSaving(file.path, args);
    assert.match(result.stderr, /team init/);
  }
});

test('team revoke disables the key and rotation preserves grants, limits and revocation', async t => {
  const file = await fixture(t, teamConfig());
  const revoked = await runCli(file.path, ['revoke', 'alice']);
  assert.equal(revoked.code, 0, revoked.stderr);
  assert.deepEqual((await file.read()).proxy.clientKeys[0], { name: 'alice', key: MEMBER_KEY, accounts: ['account-a'], maxConcurrent: 2, disabled: true });
  assert.ok(!(revoked.stdout + revoked.stderr).includes(MEMBER_KEY));
  const rotated = await runCli(file.path, ['rotate', 'alice']);
  assert.equal(rotated.code, 0, rotated.stderr);
  const key = issuedKey(rotated);
  assert.notEqual(key, MEMBER_KEY);
  assert.deepEqual((await file.read()).proxy.clientKeys[0], { name: 'alice', key, accounts: ['account-a'], maxConcurrent: 2, disabled: true });
  await refusedWithoutSaving(file.path, ['rotate', 'missing']);
  await refusedWithoutSaving(file.path, ['revoke', 'missing']);
});

test('revoking a member remains possible after a granted account is removed', async t => {
  const config = teamConfig();
  config.accounts.shift();
  const file = await fixture(t, config);
  const result = await runCli(file.path, ['revoke', 'alice']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await file.read()).proxy.clientKeys[0].disabled, true);
});

test('team changes notify only the local reload endpoint with the admin key and no credentials in the body', async t => {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, path: req.url, key: req.headers['x-api-key'], body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const config = teamConfig();
  config.proxy.port = server.address().port;
  const file = await fixture(t, config);
  const result = await runCli(file.path, ['add', 'bob', '--accounts', 'account-b']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Reloaded running server/);
  assert.deepEqual(requests, [{ method: 'POST', path: '/relaycrew/reload', key: ADMIN_KEY, body: '' }]);
  assert.ok(!(result.stdout + result.stderr).includes(ADMIN_KEY));
});

test('a refused reload reports that changes were saved and does not repeat the operation', async t => {
  let requests = 0;
  const server = createServer((req, res) => { requests++; req.resume(); res.writeHead(403); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const config = teamConfig();
  config.proxy.port = server.address().port;
  const file = await fixture(t, config);
  const result = await runCli(file.path, ['revoke', 'alice']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests, 1);
  assert.match(result.stderr, /Changes saved, but.*reload failed/);
  assert.equal((await file.read()).proxy.clientKeys[0].disabled, true);
});

test('reload does not follow a redirect carrying the admin key', async t => {
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    req.resume();
    res.writeHead(302, { Location: '/credential-collector' });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const config = teamConfig();
  config.proxy.port = server.address().port;
  const file = await fixture(t, config);
  const result = await runCli(file.path, ['revoke', 'alice']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(paths, ['/relaycrew/reload']);
  assert.match(result.stderr, /Changes saved, but.*reload failed/);
  assert.equal((await file.read()).proxy.clientKeys[0].disabled, true);
});

test('a stalled reload times out and leaves the saved member change intact', async t => {
  const server = createServer(req => { req.resume(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const config = teamConfig();
  config.proxy.port = server.address().port;
  const file = await fixture(t, config);
  const result = await runCli(file.path, ['revoke', 'alice']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Changes saved, but.*reload failed/);
  assert.equal((await file.read()).proxy.clientKeys[0].disabled, true);
});


test('fresh team init supports subsequent member administration', async t => {
  const file = await fixture(t);
  assert.equal((await runCli(file.path, ['init'])).code, 0);
  const empty = await runCli(file.path, ['list']);
  assert.equal(empty.code, 0, empty.stderr);
  assert.match(empty.stdout, /No team members configured/);
  const add = await runCli(file.path, ['add', 'new-member', '--accounts', 'account-a']);
  assert.equal(add.code, 0, add.stderr);
  assert.ok(issuedKey(add));
  assert.equal((await runCli(file.path, ['accounts'])).code, 0);
  const list = await runCli(file.path, ['list']);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /new-member/);
});


test('deny-all members remain listable, rotatable, and revocable', async t => {
  const config = teamConfig();
  config.proxy.clientKeys[0].accounts = [];
  const file = await fixture(t, config);
  const list = await runCli(file.path, ['list']);
  assert.equal(list.code, 0, list.stderr);
  const rotate = await runCli(file.path, ['rotate', 'alice']);
  assert.equal(rotate.code, 0, rotate.stderr);
  assert.ok(issuedKey(rotate));
  const revoke = await runCli(file.path, ['revoke', 'alice']);
  assert.equal(revoke.code, 0, revoke.stderr);
  assert.deepEqual((await file.read()).proxy.clientKeys[0].accounts, []);
});
