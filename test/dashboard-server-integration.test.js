import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { ClientUsageTracker, UsageDimensionTracker } from '../src/client-usage.js';
import { createProxyServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { teamAccessFor } from '../src/team-access.js';

const ADMIN = 'administrator-test-key-01234567890123456789';
const MEMBER = 'member-test-key-0123456789012345678901234';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
async function fixture(t, teamMode = true) {
  const dir = await mkdtemp(join(tmpdir(), 'relaycrew-dashboard-api-'));
  const previous = process.env.RELAYCREW_CONFIG;
  process.env.RELAYCREW_CONFIG = join(dir, 'config.json');
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => { upstreamHits++; res.writeHead(503); res.end('{}'); });
  const upstreamPort = await listen(upstream);
  const config = { proxy: { apiKey: ADMIN, teamMode, clientKeys: [{ name: 'alice', key: MEMBER, accounts: ['a'], maxConcurrent: 2 }], usageDimensions: [{name: 'project', header: 'x-project'}] }, accounts: [{id: 'a', name: 'Primary', type: 'apikey', apiKey: 'provider-secret'}], upstream: `http://127.0.0.1:${upstreamPort}` };
  await writeFile(process.env.RELAYCREW_CONFIG, JSON.stringify(config), {mode: 0o600});
  const usage = new ClientUsageTracker();
  usage.record('alice', { requests: 3, inputTokens: 10, outputTokens: 4 });
  const dimensions = new UsageDimensionTracker();
  dimensions.record('project', 'fixture', { requests: 3, inputTokens: 10 });
  const manager = new AccountManager(config.accounts);
  const proxy = createProxyServer(manager, config, {reload: async () => {
    const disk = await loadConfig();
    config.proxy = disk.proxy;
    teamAccessFor(config).refresh();
  }}, null, usage, dimensions);
  const port = await listen(proxy);
  t.after(async () => {
    proxy.closeAllConnections?.(); upstream.closeAllConnections?.();
    await Promise.all([new Promise(resolve => proxy.close(resolve)),new Promise(resolve => upstream.close(resolve))]);
    if (previous === undefined) delete process.env.RELAYCREW_CONFIG; else process.env.RELAYCREW_CONFIG = previous;
    await rm(dir, {recursive:true,force:true});
  });
  async function request(path, key = ADMIN, body, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {...(key ? {'x-api-key':key}:{}), 'content-type':'application/json', ...headers}, ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal:AbortSignal.timeout(3000) });
    return {status:response.status, headers:response.headers, body:await response.json()};
  }
  return {request, config, path:process.env.RELAYCREW_CONFIG, upstreamHits:()=>upstreamHits};
}

test('dashboard team/history endpoints require admin credentials in team and individual modes', async t => {
  for (const mode of [true,false]) await t.test(String(mode), async t => {
    const f=await fixture(t,mode);
    for (const path of ['/relaycrew/team','/relaycrew/usage/history?scope=clients&window=24h&step=15m&metric=requests']) {
      for (const [key,status] of [[null,401],[MEMBER,403]]) {
        const response=await f.request(path,key);
        assert.equal(response.status,status);
        assert.equal(response.headers.get('cache-control'),'no-store');
      }
      assert.equal((await f.request(path)).status,200);
    }
    const team=await f.request('/teamclaude/team');
    assert.equal(team.status,200);
    const serialized=JSON.stringify(team.body);
    for (const secret of [ADMIN,MEMBER,'provider-secret']) assert(!serialized.includes(secret));
    assert.equal(f.upstreamHits(),0);
  });
});

test('browser mutations reject canonical, encoded and legacy cross-origin paths before saving', async t => {
  const f=await fixture(t);
  const before=await readFile(f.path,'utf8');
  const {revision}= (await f.request('/relaycrew/team')).body;
  for (const path of ['/relaycrew/team/add','/%72elaycrew/team/add','/relaycrew/%74eam/add','/teamclaude/team/add','/%74eamclaude/team/add','/teamrouter/team/add']) {
    const response=await f.request(path,ADMIN,{revision,name:'bob',accounts:['a'],maxConcurrent:2},{origin:'https://attacker.invalid'});
    assert.equal(response.status,403,path);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(await readFile(f.path,'utf8'),before);
  }
  assert.equal(f.upstreamHits(),0);
});

test('dashboard add, rotate, revoke and revision conflicts affect live authentication', async t => {
  const f=await fixture(t);
  let revision=(await f.request('/relaycrew/team')).body.revision;
  const added=await f.request('/relaycrew/team/add',ADMIN,{revision,name:'bob',accounts:['a'],maxConcurrent:2});
  assert.equal(added.status,201);
  assert.equal(added.body.applied,true);
  const oldKey=added.body.issuedKey;
  assert.equal((await f.request('/relaycrew/me',oldKey)).status,200);
  assert.equal((await f.request('/relaycrew/team/add',ADMIN,{revision,name:'stale',accounts:['a'],maxConcurrent:2})).status,409);
  const listing=await f.request('/relaycrew/team');
  assert(!JSON.stringify(listing.body).includes(oldKey));
  revision=listing.body.revision;
  const rotated=await f.request('/teamrouter/team/rotate',ADMIN,{revision,name:'bob'});
  assert.equal(rotated.status,200);
  assert.equal((await f.request('/relaycrew/me',oldKey)).status,401);
  assert.equal((await f.request('/relaycrew/me',rotated.body.issuedKey)).status,200);
  const revoked=await f.request('/relaycrew/team/revoke',ADMIN,{revision:rotated.body.revision,name:'bob'});
  assert.equal(revoked.status,200);
  assert.equal((await f.request('/relaycrew/me',rotated.body.issuedKey)).status,401);
  const history=await f.request('/relaycrew/usage/history?scope=clients&window=24h&step=15m&metric=requests');
  assert.equal(history.body.total.reduce((a,b)=>a+b,0),3);
  assert.equal(history.body.coverage,'recorded-activity');
});
