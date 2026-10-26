import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleTeamRequest } from '../src/team-api.js';
import { handleUsageHistoryRequest } from '../src/usage-history.js';
import { teamRevision } from '../src/team-config.js';
import { authenticateTeam, teamAccessFor } from '../src/team-access.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { ClientUsageTracker } from '../src/client-usage.js';

const ADMIN = 'tc-admin-fixture-key-0123456789abcdef';
const MEMBER = 'tc-member-fixture-key-0123456789abcdef';
function baseConfig() {
  return {
    upstreamProxy: false,
    proxy: { apiKey: ADMIN, teamMode: true, trustLoopback: false, clientKeys: [{ name: 'alice', key: MEMBER, accounts: ['a'], maxConcurrent: 2 }], usageDimensions: [{ name: 'project', header: 'x-project' }] },
    accounts: [{ id: 'a', name: 'Primary', apiKey: 'upstream-account-secret', type: 'apikey' }, { id: 'b', name: 'Second', refreshToken: 'refresh-account-secret', provider: 'codex' }],
  };
}
async function fixture(t, { reload, config = baseConfig() } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'relaycrew-dashboard-api-'));
  const path = join(dir, 'config.json');
  const previous = process.env.RELAYCREW_CONFIG;
  const previousWait = process.env.RELAYCREW_CONFIG_LOCK_WAIT_MS;
  process.env.RELAYCREW_CONFIG = path;
  process.env.RELAYCREW_CONFIG_LOCK_WAIT_MS = '50';
  await writeFile(path, JSON.stringify(config));
  const clientUsage = new ClientUsageTracker();
  clientUsage.record('alice', { requests: 3, inputTokens: 18 });
  let reads = 0;
  let reloads = 0;
  const server = createServer(async (req, res) => {
    req.tcClient = config.proxy.clientKeys?.find(member => member.key === req.headers['x-api-key'])?.name ?? null;
    const hooks = { reload: async () => {
      reloads++;
      if (reload) await reload({ config, path });
      else config.proxy = (await loadConfig()).proxy;
    } };
    const handled = await handleTeamRequest(req, res, { config, hooks, clientUsage, readBody: async request => {
      reads++;
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return Buffer.concat(chunks).toString('utf8');
    } }) || await handleUsageHistoryRequest(req, res, { config, clientUsage });
    if (!handled) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.RELAYCREW_CONFIG; else process.env.RELAYCREW_CONFIG = previous;
    if (previousWait === undefined) delete process.env.RELAYCREW_CONFIG_LOCK_WAIT_MS; else process.env.RELAYCREW_CONFIG_LOCK_WAIT_MS = previousWait;
  });
  const call = async (route = '/relaycrew/team', body, key = ADMIN) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: key === null ? {} : { 'x-api-key': key }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { config, path, call, read: async () => JSON.parse(await readFile(path, 'utf8')), reads: () => reads, reloads: () => reloads };
}

test('team and history require admin credentials even on loopback, before reading bodies', async t => {
  const f = await fixture(t);
  for (const route of ['/relaycrew/team', '/relaycrew/%74eam?poll=1', '/relaycrew/usage/history?scope=clients&window=24h&step=15m&metric=requests']) {
    for (const key of [null, 'wrong', MEMBER]) {
      const response = await f.call(route, undefined, key);
      assert.equal(response.status, key === MEMBER ? 403 : 401);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal((await f.call('/relaycrew/team/add', '{broken', MEMBER)).status, 403);
  assert.equal(f.reads(), 0);
  f.config.proxy.teamMode = false;
  assert.equal((await f.call('/relaycrew/team', undefined, MEMBER)).status, 403, 'legacy client keys are refused too');
  assert.equal((await f.call('/relaycrew/team', undefined, null)).status, 401);
});

test('listing redacts every credential and reports runtime usage and activity', async t => {
  const f = await fixture(t);
  const response = await f.call('/relaycrew/team?poll=1');
  assert.equal(response.status, 200);
  assert.equal(response.body.members[0].usage.requests, 3);
  assert.equal(response.body.members[0].active, 0);
  assert.equal(response.body.accounts[0].disabled, false);
  assert.equal(typeof response.body.revision, 'string');
  assert.doesNotMatch(JSON.stringify(response.body), /tc-admin|tc-member|upstream-account-secret|refresh-account-secret|fingerprint|"key"/);
});

test('add/update/rotate/revoke use revisions and preserve grants plus one-time keys', async t => {
  const f = await fixture(t);
  let revision = (await f.call()).body.revision;
  const add = await f.call('/relaycrew/team/add?x=1', { revision, name: 'bob', accounts: '*', maxConcurrent: 4 });
  assert.equal(add.status, 201);
  assert.equal(add.body.saved, true);
  assert.equal(add.body.applied, true);
  assert.match(add.body.issuedKey, /^tc-[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.read()).proxy.clientKeys[1].key, add.body.issuedKey);
  revision = add.body.revision;
  const update = await f.call('/relaycrew/team/update', { revision, name: 'bob', accounts: ['b'], maxConcurrent: 1, disabled: false });
  assert.equal(update.status, 200);
  assert.equal(update.body.issuedKey, undefined);
  const rotate = await f.call('/relaycrew/team/rotate', { revision: update.body.revision, name: 'bob' });
  assert.equal(rotate.status, 200);
  assert.notEqual(rotate.body.issuedKey, add.body.issuedKey);
  assert.deepEqual(rotate.body.member.accounts, ['b']);
  const revoke = await f.call('/relaycrew/team/revoke', { revision: rotate.body.revision, name: 'bob' });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.member.disabled, true);
  const listed = await f.call();
  assert.ok(!JSON.stringify(listed.body).includes(rotate.body.issuedKey));
  assert.equal((await f.read()).proxy.clientKeys[1].disabled, true);
  assert.equal(f.reloads(), 4);
});

test('invalid bodies and stale edits do not save or reload', async t => {
  const f = await fixture(t);
  const revision = (await f.call()).body.revision;
  const before = await readFile(f.path, 'utf8');
  for (const body of ['{invalid', 'x'.repeat(65537), '[]', 'null', {}, { revision, name: 'unsafe name', accounts: '*', maxConcurrent: 1 }, { revision, name: 'bob', accounts: ['missing'], maxConcurrent: 1 }, { revision, name: 'bob', accounts: ['a', 'a'], maxConcurrent: 1 }, { revision, name: 'bob', accounts: '*', maxConcurrent: 0 }, { revision, name: 'bob', accounts: '*', maxConcurrent: 2, key: 'injected' }]) {
    assert.equal((await f.call('/relaycrew/team/add', body)).status, 400);
    assert.equal(await readFile(f.path, 'utf8'), before);
  }
  assert.equal((await f.call('/relaycrew/team/revoke', { revision, name: 'missing' })).status, 404);
  assert.equal((await f.call('/relaycrew/team/revoke', { revision: 'stale', name: 'alice' })).status, 409);
  assert.equal(f.reloads(), 0);
});

test('simultaneous editors cannot both apply the same revision', async t => {
  const f = await fixture(t);
  const revision = (await f.call()).body.revision;
  const results = await Promise.all(['bob', 'carol'].map(name => f.call('/relaycrew/team/add', { revision, name, accounts: '*', maxConcurrent: 4 })));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  assert.equal((await f.read()).proxy.clientKeys.length, 2);
  assert.equal(f.reloads(), 1);
});

test('runtime reload failure retains the durable result and issued key', async t => {
  const f = await fixture(t, { reload: () => { throw new Error('SECRET INTERNAL MESSAGE'); } });
  const response = await f.call('/relaycrew/team/rotate', { revision: (await f.call()).body.revision, name: 'alice' });
  assert.equal(response.status, 200);
  assert.equal(response.body.saved, true);
  assert.equal(response.body.applied, false);
  assert.equal((await f.read()).proxy.clientKeys[0].key, response.body.issuedKey);
  assert.ok(response.body.warning);
  assert.ok(!JSON.stringify(response.body).includes('SECRET INTERNAL'));
  assert.equal((await f.call()).body.revision, response.body.revision);
});

test('persistence and reload remain serialized, including failures', async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let runs = 0;
  const f = await fixture(t, { reload: async ({ config }) => {
    if (++runs === 1) { entered(); await blocked; }
    config.proxy = (await loadConfig()).proxy;
  } });
  const first = f.call('/relaycrew/team/rotate', { revision: (await f.call()).body.revision, name: 'alice' });
  await started;
  const disk = await f.read();
  const second = f.call('/relaycrew/team/revoke', { revision: teamRevision(disk), name: 'alice' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await f.read()).proxy.clientKeys[0].disabled, undefined, 'next mutation waits until reload completes');
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal((await f.read()).proxy.clientKeys[0].disabled, true);
});

test('live external lock and an occupied lock path refuse writes with 503', async t => {
  const f = await fixture(t);
  const revision = (await f.call()).body.revision;
  const before = await readFile(f.path, 'utf8');
  await writeFile(`${f.path}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() - 60000 }));
  assert.equal((await f.call('/relaycrew/team/revoke', { revision, name: 'alice' })).status, 503);
  assert.equal(await readFile(f.path, 'utf8'), before);
  await rm(`${f.path}.lock`);
  await mkdir(`${f.path}.lock`);
  assert.equal((await f.call('/relaycrew/team/revoke', { revision, name: 'alice' })).status, 503);
  assert.equal(await readFile(f.path, 'utf8'), before);
});

test('stale whole-config settings saves preserve authoritative team credentials and policy', async t => {
  const f = await fixture(t);
  const stale = await f.read();
  const rotate = await f.call('/relaycrew/team/rotate', { revision: (await f.call()).body.revision, name: 'alice' });
  const revoked = await f.call('/relaycrew/team/revoke', { revision: rotate.body.revision, name: 'alice' });
  assert.equal(revoked.status, 200);
  stale.proxy.teamMode = false;
  stale.proxy.apiKey = 'stale-admin-key';
  stale.proxy.trustLoopback = true;
  stale.switchThreshold = 0.75;
  await saveConfig(stale);
  const saved = await f.read();
  assert.equal(saved.proxy.clientKeys[0].key, rotate.body.issuedKey);
  assert.equal(saved.proxy.clientKeys[0].disabled, true);
  assert.equal(saved.proxy.apiKey, ADMIN);
  assert.equal(saved.proxy.teamMode, true);
  assert.equal(saved.proxy.trustLoopback, false);
  assert.equal(saved.switchThreshold, 0.75);
  assert.equal(stale.proxy.apiKey, 'stale-admin-key', 'save must not overwrite the caller object');
});

test('rotation, revocation and removed grants abort live traffic and release concurrency once', async t => {
  for (const action of ['rotate', 'revoke', 'update']) {
    const f = await fixture(t);
    const res = new EventEmitter();
    res.destroy = () => { res.emit('close'); };
    const controller = teamAccessFor(f.config);
    const access = controller.enter(authenticateTeam(f.config.proxy, MEMBER).identity, res);
    access.account = { id: 'a' };
    const result = await f.call(`/relaycrew/team/${action}`, { revision: (await f.call()).body.revision, name: 'alice', ...(action === 'update' ? { accounts: ['b'], maxConcurrent: 2, disabled: false } : {}) });
    assert.equal(result.status, 200);
    assert.equal(access.signal.aborted, true);
    res.emit('finish');
    res.emit('close');
    assert.equal(controller.active.get('alice'), 0);
  }
});
