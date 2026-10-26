import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { EgressGuard } from '../src/egress-guard.js';
import { AccountManager } from '../src/account-manager.js';
import { ClientUsageTracker } from '../src/client-usage.js';
import { loadConfig } from '../src/config.js';
import { createProxyServer, createProxyRequestListener } from '../src/server.js';
import { authenticateTeam, validateTeamConfig, teamAccessFor } from '../src/team-access.js';

const ADMIN = 'admin-secret';
const ALICE = 'alice-secret';
const BOB = 'bob-secret';
const DISABLED = 'disabled-secret';
const MODEL = 'claude-sonnet-4-6';
const accounts = () => ['alpha', 'beta', 'gamma'].map(name => ({
  id: `account-${name}`, name, type: 'oauth', accessToken: `upstream-${name}`,
  refreshToken: `refresh-${name}`, expiresAt: Date.now() + 3600_000,
}));
const teamProxy = () => ({
  teamMode: true, apiKey: ADMIN,
  clientKeys: [
    { name: 'alice', key: ALICE, accounts: ['account-beta', 'account-gamma'] },
    { name: 'bob', key: BOB, accounts: ['account-alpha'] },
    { name: 'disabled', key: DISABLED, accounts: '*', disabled: true },
  ],
});
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
});
function success(res, usage = { input_tokens: 7, output_tokens: 11 }) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'message', content: [], usage }));
}
async function fixture(t, { handler = (_req, res) => success(res), proxyConfig = teamProxy(), hooks = {} } = {}) {
  const seen = [];
  const events = new EventEmitter();
  const sockets = new Set();
  const servers = [];
  const track = server => {
    servers.push(server);
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    return server;
  };
  const upstream = track(http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const entry = { path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
    seen.push(entry);
    events.emit('upstream', entry);
    handler(req, res, entry);
  }));
  const upstreamPort = await listen(upstream);
  const config = { proxy: proxyConfig, upstream: `http://127.0.0.1:${upstreamPort}` };
  const am = new AccountManager(accounts(), 0.98, { refreshFn: async () => { throw new Error('Unexpected token refresh'); } });
  const clientUsage = new ClientUsageTracker();
  const proxy = track(createProxyServer(am, config, hooks, null, clientUsage));
  const port = await listen(proxy);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); })));
  });
  return { port, proxy, upstream, config, am, clientUsage, seen, events, track };
}
function request(port, { key = ALICE, path = '/v1/messages', method = 'POST', headers = {}, body = { model: MODEL, messages: [] } } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method,
      headers: { 'content-type': 'application/json', ...(key == null ? {} : { 'x-api-key': key }), ...headers },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(method === 'POST' ? JSON.stringify(body) : undefined);
  });
}
function raw(port, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => socket.write(lines.join('\r\n') + '\r\n\r\n'));
    socket.once('error', reject);
    socket.once('data', data => { resolve(data.toString()); socket.destroy(); });
    socket.once('end', () => resolve(''));
  });
}
const me = (port, key = ALICE) => request(port, { key, method: 'GET', path: '/teamclaude/me' });

test('team mode requires a valid enabled key even on loopback and keeps administrator access', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const key of [null, '', 'wrong-key', DISABLED]) {
    const reply = await request(f.port, { key });
    assert.equal(reply.status, 401, `credential ${String(key)}`);
    assert.equal(reply.json().error.type, 'authentication_error');
  }
  assert.equal(f.seen.length, 0);
  assert.equal((await request(f.port, { key: ADMIN, path: '/teamclaude/status', method: 'GET' })).status, 200);
  assert.equal((await request(f.port, { key: ADMIN, path: '/tc-acct/alpha/v1/messages' })).status, 200);
  assert.equal(f.seen[0].headers.authorization, 'Bearer upstream-alpha');
});

test('members cannot read or mutate control routes through aliases or encoded paths', { timeout: 10000 }, async t => {
  let mutations = 0;
  const f = await fixture(t, { hooks: { reload: () => { mutations++; }, getStatusExtra: () => ({ secretFleetData: true }) } });
  const routes = [
    ['GET', '/teamclaude/status'], ['GET', '/teamclaude/quota'],
    ['POST', '/teamclaude/reload'], ['POST', '/teamclaude/switch'],
    ['POST', '/teamclaude/priority'], ['POST', '/teamclaude/disable'],
    ['POST', '/teamclaude/threshold'], ['POST', '/teamclaude/probe'],
    ['POST', '/teamclaude/mcp'], ['GET', '/teamclaude/mcp/'],
    ['GET', '/teamrouter/status'], ['POST', '/teamrouter/reload'],
    ['GET', '/%74eamclaude/status'], ['GET', '/%74eamrouter/status'],
    ['GET', '/teamclaude%2fstatus'], ['GET', '/teamclaude\\status'],
    ['GET', '/tc-acct/beta/teamclaude/status'],
    ['GET', '/api/oauth/profile'], ['POST', '/v1/oauth/token'],
    ['GET', '/v1/code/sessions'], ['POST', '/anything-else'],
  ];
  for (const [method, path] of routes) {
    const reply = await request(f.port, { method, path });
    assert.equal(reply.status, 403, `${method} ${path}`);
  }
  assert.equal(mutations, 0);
  assert.equal(f.seen.length, 0);
});

test('member status exposes only its own usage and grant', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  assert.equal((await request(f.port)).status, 200);
  assert.equal((await request(f.port, { key: BOB })).status, 200);
  assert.equal((await request(f.port, { key: BOB })).status, 200);
  const reply = await me(f.port);
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['cache-control'], 'no-store');
  const own = reply.json();
  assert.equal(own.member, 'alice');
  assert.deepEqual(own.accounts, ['account-beta', 'account-gamma']);
  assert.equal(own.usage.requests, 1);
  assert.equal(own.usage.inputTokens, 7);
  assert.equal(own.usage.outputTokens, 11);
  assert.deepEqual(own.concurrency, { active: 0, limit: 4 });
  for (const secret of ['bob', BOB, ADMIN, ALICE, 'upstream-', 'account-alpha', 'refresh-']) assert.ok(!reply.text.includes(secret), secret);
  assert.equal((await me(f.port, BOB)).json().usage.requests, 2);
});

test('selection and URL pins enforce stable account grants', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  assert.equal((await request(f.port)).status, 200);
  assert.equal(f.seen[0].headers.authorization, 'Bearer upstream-beta');
  assert.equal((await request(f.port, { path: '/tc-acct/gamma/v1/messages' })).status, 200);
  assert.equal(f.seen[1].headers.authorization, 'Bearer upstream-gamma');
  assert.equal(f.seen[1].path, '/v1/messages');
  assert.equal((await request(f.port, { path: '/tc-acct/alpha/v1/messages' })).status, 403);
  assert.equal(f.seen.length, 2);
  f.am.accounts[0].name = 'beta';
  f.am.accounts[1].name = 'renamed-permitted';
  assert.equal((await request(f.port, { path: '/tc-acct/beta/v1/messages' })).status, 403);
  assert.equal((await request(f.port, { path: '/tc-acct/renamed-permitted/v1/messages' })).status, 200);
  assert.equal(f.seen[2].headers.authorization, 'Bearer upstream-beta');
});

for (const status of [429, 503]) {
  for (const siblingAllowed of [false, true]) {
    test(`${status} failover ${siblingAllowed ? 'uses a permitted sibling' : 'never uses an account outside the grant'}`, { timeout: 10000 }, async t => {
      const proxyConfig = teamProxy();
      proxyConfig.clientKeys[0].accounts = siblingAllowed ? ['account-beta', 'account-gamma'] : ['account-beta'];
      const f = await fixture(t, { proxyConfig, handler(req, res) {
        if (req.headers.authorization === 'Bearer upstream-beta') {
          res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '300' });
          res.end(JSON.stringify({ type: 'error', error: { type: status === 429 ? 'rate_limit_error' : 'overloaded_error' } }));
        } else success(res);
      } });
      const reply = await request(f.port);
      if (siblingAllowed) assert.equal(reply.status, 200);
      else assert.ok([429, 503].includes(reply.status), `unexpected status ${reply.status}`);
      assert.deepEqual(f.seen.map(entry => entry.headers.authorization), siblingAllowed ? ['Bearer upstream-beta', 'Bearer upstream-gamma'] : ['Bearer upstream-beta']);
    });
  }
}

test('proxy credentials never reach the inference upstream', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const reply = await request(f.port, { headers: { authorization: `Bearer ${ALICE}`, 'proxy-authorization': `Bearer ${ALICE}` } });
  assert.equal(reply.status, 200);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].headers.authorization, 'Bearer upstream-beta');
  assert.equal(f.seen[0].headers['x-api-key'], undefined);
  assert.equal(f.seen[0].headers['proxy-authorization'], undefined);
  assert.ok(!JSON.stringify(f.seen).includes(ALICE));
});

function openStream(port, id, key = ALICE) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages',
      headers: { 'x-api-key': key, 'content-type': 'application/json', 'x-test-stream': id },
    }, res => {
      const done = new Promise(doneResolve => { res.once('end', doneResolve); res.once('close', doneResolve); });
      res.once('data', () => resolve({ res, done, abort: () => res.destroy() }));
      res.on('error', () => {});
      res.resume();
    });
    req.once('error', reject);
    req.end(JSON.stringify({ model: MODEL, stream: true, messages: [] }));
  });
}
function nextMatching(events, name, predicate) {
  return new Promise(resolve => {
    const listener = value => {
      if (!predicate(value)) return;
      events.off(name, listener);
      resolve(value);
    };
    events.on(name, listener);
  });
}

test('parallel streaming requests keep their permits until completion or disconnect', { timeout: 10000 }, async t => {
  const held = new Map();
  const f = await fixture(t, { handler(req, res, entry) {
    if (!JSON.parse(entry.body).stream) { success(res); return; }
    held.set(req.headers['x-test-stream'], res);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
  } });
  f.proxy.on('request', (req, res) => res.once('close', () => f.events.emit('closed', req.headers['x-test-stream'])));
  const streams = [];
  for (let i = 0; i < 4; i++) streams.push(await openStream(f.port, String(i)));
  assert.equal((await me(f.port)).json().concurrency.active, 4);
  const blocked = await request(f.port);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['retry-after'], '1');
  assert.equal(f.seen.length, 4);
  assert.equal((await request(f.port, { key: BOB })).status, 200);
  assert.equal((await me(f.port, BOB)).json().concurrency.active, 0);
  held.get('0').end('data: {"type":"message_stop"}\n\n');
  await streams[0].done;
  assert.equal((await me(f.port)).json().concurrency.active, 3);
  streams.push(await openStream(f.port, 'replacement'));
  assert.equal((await me(f.port)).json().concurrency.active, 4);
  const closed = nextMatching(f.events, 'closed', id => id === '1');
  streams[1].abort();
  await closed;
  assert.equal((await me(f.port)).json().concurrency.active, 3);
  for (const id of ['2', '3', 'replacement']) held.get(id).end('data: {"type":"message_stop"}\n\n');
  await Promise.all([streams[2].done, streams[3].done, streams[4].done]);
  assert.deepEqual((await me(f.port)).json().concurrency, { active: 0, limit: 4 });
  assert.equal((await request(f.port)).status, 200);
});

test('an explicit concurrency limit applies to the member only', { timeout: 10000 }, async t => {
  const proxyConfig = teamProxy();
  proxyConfig.clientKeys[0].maxConcurrent = 1;
  let held;
  const f = await fixture(t, { proxyConfig, handler(req, res, entry) {
    if (!JSON.parse(entry.body).stream) { success(res); return; }
    held = res;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n');
  } });
  const stream = await openStream(f.port, 'limited');
  assert.deepEqual((await me(f.port)).json().concurrency, { active: 1, limit: 1 });
  assert.equal((await request(f.port)).status, 429);
  assert.equal((await request(f.port, { key: ADMIN })).status, 200);
  held.end('data: {"type":"message_stop"}\n\n');
  await stream.done;
  assert.equal((await request(f.port)).status, 200);
});

test('identical caller session IDs stay isolated across member trackers', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const headers = { 'x-claude-code-session-id': 'shared-session' };
  assert.equal((await request(f.port, { headers })).status, 200);
  assert.equal((await request(f.port, { headers, key: BOB })).status, 200);
  assert.equal((await request(f.port, { headers })).status, 200);
  const sessions = f.am.getStatus({ sessionDetail: true }).sessions.items;
  assert.equal(sessions.length, 2);
  const alice = sessions.find(session => session.client === 'alice');
  const bob = sessions.find(session => session.client === 'bob');
  assert.ok(alice);
  assert.ok(bob);
  assert.notEqual(alice.id, bob.id);
  assert.equal(alice.requests, 2);
  assert.equal(bob.requests, 1);
  assert.equal(Object.values(alice.tokens).reduce((sum, token) => sum + token.output, 0), 22);
  assert.equal(Object.values(bob.tokens).reduce((sum, token) => sum + token.output, 0), 11);
  assert.ok(Object.values(alice.pins).every(index => index === 1));
  assert.ok(Object.values(bob.pins).every(index => index === 0));
});

test('a tunnel-bound request listener revalidates its credential after rotation or revocation', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const old = authenticateTeam(f.config.proxy, ALICE).identity;
  const listener = identity => createProxyRequestListener({ accountManager: f.am, upstream: f.config.upstream,
    config: f.config, clientUsage: f.clientUsage, forcedClient: 'alice', forcedIdentity: identity,
  });
  const stalePort = await listen(f.track(http.createServer(listener(old))));
  assert.equal((await request(stalePort, { key: null })).status, 200);
  f.config.proxy.clientKeys[0].key = 'rotated-alice-secret';
  assert.equal((await request(stalePort, { key: 'rotated-alice-secret' })).status, 401);
  const fresh = authenticateTeam(f.config.proxy, 'rotated-alice-secret').identity;
  const freshPort = await listen(f.track(http.createServer(listener(fresh))));
  assert.equal((await request(freshPort, { key: null })).status, 200);
  f.config.proxy.clientKeys.splice(0, 1);
  assert.equal((await request(freshPort, { key: null })).status, 401);
  assert.equal(f.seen.length, 2);
});

test('a tunnel-bound account pin cannot escape its member grant', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const identity = authenticateTeam(f.config.proxy, ALICE).identity;
  for (const [forcedPin, status] of [['gamma', 200], ['alpha', 403]]) {
    const listener = createProxyRequestListener({ accountManager: f.am, upstream: f.config.upstream,
      config: f.config, forcedClient: 'alice', forcedIdentity: identity, forcedPin,
    });
    const port = await listen(f.track(http.createServer(listener)));
    assert.equal((await request(port, { key: null })).status, status);
  }
  assert.deepEqual(f.seen.map(entry => entry.headers.authorization), ['Bearer upstream-gamma']);
});

test('CONNECT authenticates loopback keys before destination handling', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const key of [null, 'wrong-key', DISABLED]) {
    const reply = await raw(f.port, ['CONNECT invalid:authority:443 HTTP/1.1', 'Host: localhost',
      ...(key == null ? [] : [`Proxy-Authorization: Bearer ${key}`])]);
    assert.match(reply, /^HTTP\/1\.1 407 /);
  }
  for (const key of [ALICE, ADMIN]) {
    const reply = await raw(f.port, ['CONNECT invalid:authority:443 HTTP/1.1', 'Host: localhost', `Proxy-Authorization: Bearer ${key}`]);
    assert.match(reply, /^HTTP\/1\.1 400 /);
  }
  const deniedRelay = await raw(f.port, ['CONNECT localhost:443 HTTP/1.1', 'Host: localhost', `Proxy-Authorization: Bearer ${ALICE}`]);
  assert.match(deniedRelay, /^HTTP\/1\.1 403 /);
  assert.equal(f.seen.length, 0);
});

test('WebSocket upgrades require a valid key and permit only administrators to relay', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  let upgrades = 0;
  let headers;
  f.upstream.on('upgrade', (req, socket) => {
    upgrades++;
    headers = req.headers;
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  const handshake = key => raw(f.port, ['GET /v1/messages HTTP/1.1', 'Host: localhost', 'Connection: Upgrade', 'Upgrade: websocket',
    'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', ...(key == null ? [] : [`x-api-key: ${key}`])]);
  for (const key of [null, 'wrong-key', DISABLED]) assert.match(await handshake(key), /^HTTP\/1\.1 401 /);
  assert.match(await handshake(ALICE), /^HTTP\/1\.1 403 /);
  assert.equal(upgrades, 0);
  assert.match(await handshake(ADMIN), /^HTTP\/1\.1 101 /);
  assert.equal(upgrades, 1);
  assert.ok(!JSON.stringify(headers).includes(ADMIN));
});

test('malformed team policy cannot start an open or partially restricted proxy', () => {
  const malformed = [
    { ...teamProxy(), teamMode: 'true' },
    { ...teamProxy(), apiKey: '' },
    { ...teamProxy(), apiKey: null },
    { ...teamProxy(), clientKeys: undefined },
    ...[
      { name: 'alice', key: ALICE },
      { key: ALICE, accounts: '*' },
      { name: 123, key: ALICE, accounts: '*' },
      { name: 'alice', key: ALICE, accounts: [1] },
      { name: 'alice', key: ALICE, accounts: '*' , maxConcurrent: 0 },
      { name: 'alice', key: ALICE, accounts: '*' , maxConcurrent: 1.5 },
      { name: 'alice', key: ALICE, accounts: '*' , disabled: 'false' },
      { name: 'alice', key: ADMIN, accounts: '*' },
    ].map(member => ({ ...teamProxy(), clientKeys: [member] })),
    { ...teamProxy(), clientKeys: [{ name: 'a', key: 'a', accounts: '*' }, { name: 'a', key: 'b', accounts: '*' }] },
    { ...teamProxy(), clientKeys: [{ name: 'a', key: 'a', accounts: '*' }, { name: 'b', key: 'a', accounts: '*' }] },
  ];
  for (const proxy of malformed) {
    assert.throws(() => validateTeamConfig(proxy), undefined, JSON.stringify(proxy));
    assert.throws(() => createProxyServer(new AccountManager(accounts()), { proxy }), undefined, JSON.stringify(proxy));
  }
});

test('team mode stays opt-in for an existing loopback proxy', { timeout: 10000 }, async t => {
  const f = await fixture(t, { proxyConfig: { apiKey: ADMIN, clientKeys: [{ name: 'legacy', key: ALICE }] } });
  assert.equal((await request(f.port, { key: null })).status, 200);
  assert.equal((await request(f.port, { key: ALICE, method: 'GET', path: '/teamclaude/status' })).status, 200);
  assert.equal(f.seen[0].headers.authorization, 'Bearer upstream-alpha');
});

test('wildcard grants allow every account while an empty grant never forwards', { timeout: 10000 }, async t => {
  const proxyConfig = teamProxy();
  proxyConfig.clientKeys[0].accounts = '*';
  const f = await fixture(t, { proxyConfig });
  for (const name of ['alpha', 'beta', 'gamma']) {
    assert.equal((await request(f.port, { path: `/tc-acct/${name}/v1/messages` })).status, 200);
  }
  assert.deepEqual(f.seen.map(entry => entry.headers.authorization), ['Bearer upstream-alpha', 'Bearer upstream-beta', 'Bearer upstream-gamma']);
  f.config.proxy.clientKeys[0].accounts = [];
  assert.equal((await request(f.port)).status, 429);
  assert.equal((await request(f.port, { path: '/tc-acct/beta/v1/messages' })).status, 403);
  assert.equal(f.seen.length, 3);
});

test('rotated and disabled member keys stop authenticating on a running proxy', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  assert.equal((await request(f.port)).status, 200);
  f.config.proxy.clientKeys[0].key = 'new-alice-key';
  assert.equal((await request(f.port)).status, 401);
  assert.equal((await request(f.port, { key: 'new-alice-key' })).status, 200);
  f.config.proxy.clientKeys[0].disabled = true;
  assert.equal((await request(f.port, { key: 'new-alice-key' })).status, 401);
  assert.equal(f.seen.length, 2);
});

test('loading a malformed team policy rejects it before startup', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teamclaude-team-policy-'));
  const path = join(directory, 'config.json');
  const previous = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = path;
  try {
    for (const proxy of [{ ...teamProxy(), apiKey: null }, { ...teamProxy(), clientKeys: [{ name: 'alice', key: ALICE }] }]) {
      await writeFile(path, JSON.stringify({ proxy, accounts: [] }));
      await assert.rejects(loadConfig());
    }
  } finally {
    if (previous === undefined) delete process.env.TEAMCLAUDE_CONFIG;
    else process.env.TEAMCLAUDE_CONFIG = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('member named admin cannot collide with administrator session', async t => {
 const proxyConfig = teamProxy();
 proxyConfig.clientKeys[0].name = 'admin';
 const f = await fixture(t, {proxyConfig});
 const headers = {'x-claude-code-session-id':'same'};
 await request(f.port, {headers});
 await request(f.port, {headers, key:ADMIN});
 assert.equal(f.am.getStatus({sessionDetail:true}).sessions.items.length, 2);
});

test('hard pin survives account removal during body upload', async t => {
 let started;
 const start = new Promise(resolve => started = resolve);
 const f = await fixture(t, {hooks:{onRequestStart: started}});
 const result = new Promise((resolve, reject) => {
  const req=http.request({host:'127.0.0.1',port:f.port,method:'POST',path:'/tc-acct/beta/v1/messages',headers:{'x-api-key':ALICE,'content-type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
  req.on('error',reject);
  req.write('{');
  start.then(()=>{f.am.removeAccount(0);req.end('"model":"claude-sonnet-4-6","messages":[]}');});
 });
 assert.equal(await result,200);
 assert.equal(f.seen[0].headers.authorization,'Bearer upstream-beta');
});

test('rotation cancels a body upload and frees its member slot', async t => {
 let started;
 const start=new Promise(resolve=>started=resolve);
 const proxyConfig=teamProxy();proxyConfig.clientKeys[0].maxConcurrent=1;
 const f=await fixture(t,{proxyConfig,hooks:{onRequestStart:started}});
 const req=http.request({host:'127.0.0.1',port:f.port,method:'POST',path:'/v1/messages',headers:{'x-api-key':ALICE,'content-type':'application/json'}});
 const closed = new Promise(resolve => req.once('close', resolve));
 req.on('response',res=>res.resume());req.on('error',()=>{});t.after(()=>req.destroy());
 req.write('{');await start;
 f.config.proxy.clientKeys[0].key='rotated';teamAccessFor(f.config).refresh();await closed;
 assert.equal((await me(f.port,'rotated')).json().concurrency.active,0);
 assert.equal((await request(f.port,{key:'rotated'})).status,200);
});

test('rotation cancels an account admission wait and frees its member slot', async t => {
 const proxyConfig=teamProxy();proxyConfig.clientKeys[0].maxConcurrent=1;
 const f=await fixture(t,{proxyConfig});
 f.am.accounts[1].pausedUntil=Date.now()+60000;
 let entered; const admission = new Promise(resolve => entered = resolve);
 const admit = f.am.admit.bind(f.am);
 f.am.admit = (...args) => { entered(); return admit(...args); };
 const req=http.request({host:'127.0.0.1',port:f.port,method:'POST',path:'/tc-acct/beta/v1/messages',headers:{'x-api-key':ALICE,'content-type':'application/json'}});
 const closed = new Promise(resolve => req.once('close', resolve));
 req.on('response',res=>res.resume());req.on('error',()=>{});t.after(()=>{req.destroy();f.am.accounts[1].pausedUntil=0;});
 req.end(JSON.stringify({model:MODEL,messages:[]}));await admission;
 f.config.proxy.clientKeys[0].key='rotated';teamAccessFor(f.config).refresh();await closed;
 assert.equal((await me(f.port,'rotated')).json().concurrency.active,0);
});

test('empty grants cannot bypass selection via cross-provider Host', async t => {
 const proxyConfig=teamProxy();proxyConfig.clientKeys[0].accounts=[];
 const f=await fixture(t,{proxyConfig});
 f.config.accounts=[{provider:'codex',type:'oauth'}];
 f.am.addAccount({id:'codex-account',name:'codex',provider:'codex',type:'oauth',accessToken:'codex-secret',expiresAt:Date.now()+3600000,upstream:f.config.upstream});
 const response=await request(f.port,{headers:{host:'chatgpt.com',authorization:'Bearer client-own-token'}});
 assert.equal(response.status,403);
 assert.equal(f.seen.length,0);
});


test('rotation cancels an egress hold and frees its member slot', async t => {
 const f=await fixture(t);
 const old=authenticateTeam(f.config.proxy,ALICE).identity;
 let checked; const probe = new Promise(resolve => checked = resolve);
 const guard=new EgressGuard({pin:'192.0.2.1',holdMs:2000,pollMs:25,fetchImpl:async()=>{ checked(); return new globalThis.Response('192.0.2.2'); }});
 const listener=createProxyRequestListener({accountManager:f.am,upstream:f.config.upstream,config:f.config,forcedIdentity:old,forcedClient:'alice',egress:guard});
 const port=await listen(f.track(http.createServer(listener)));
 const req=http.request({host:'127.0.0.1',port,method:'POST',path:'/v1/messages'});
 const closed = new Promise(resolve => req.once('close', resolve));
 req.on('response',res=>res.resume());req.on('error',()=>{});t.after(()=>req.destroy());
 req.end('{}');await probe;
 f.config.proxy.clientKeys[0].key='rotated';teamAccessFor(f.config).refresh();await closed;
 assert.equal((await me(f.port,'rotated')).json().concurrency.active,0);
});



test('members with prototype property names receive zero usage counters', async t => {
  const config = teamProxy();
  config.clientKeys[0].name = 'constructor';
  const f = await fixture(t, { proxyConfig: config });
  const own = (await me(f.port)).json();
  assert.equal(own.member, 'constructor');
  assert.deepEqual(own.usage, { requests: 0, connections: 0, inputTokens: 0, outputTokens: 0, lastUsed: null });
});


test('Codex WebSocket inference reports HTTP fallback for members', async t => {
  const f = await fixture(t);
  const reply = await raw(f.port, [
    'GET /backend-api/codex/responses HTTP/1.1',
    'Host: localhost', 'Connection: Upgrade', 'Upgrade: websocket', `x-api-key: ${ALICE}`,
  ]);
  assert.match(reply, /^HTTP\/1.1 501 Not Implemented/);
  assert.equal(f.seen.length, 0);
});
