import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { createConnectHandler } from '../src/mitm.js';
import { generateCertChain } from '../src/x509.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function tunnel(port, target, key, ca) {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Bearer ${key}\r\n\r\n`);
  const [headers] = await once(socket, 'data');
  assert.match(headers.toString(), /^HTTP\/1.1 200 /);
  const secure = tls.connect({ socket, ca, servername: 'localhost', ALPNProtocols: ['h2'] });
  await once(secure, 'secureConnect');
  return http2.connect('https://localhost', { createConnection: () => secure });
}

async function inference(session) {
  const request = session.request({ ':method': 'POST', ':path': '/v1/messages' });
  const response = once(request, 'response');
  request.end(JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }));
  request.resume();
  const [headers] = await response;
  await once(request, 'end');
  return headers[':status'];
}

test('an open HTTP/2 MITM tunnel loses access when its member key rotates', { timeout: 10000 }, async t => {
  const { leafCertPem, leafKeyPem, caCertPem } = generateCertChain('localhost');
  let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    calls += 1;
    assert.equal(req.headers['x-api-key'], 'provider-fixture');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upstreamPort = await listen(upstream);
  const config = {
    upstream: `http://127.0.0.1:${upstreamPort}`,
    proxy: { teamMode: true, apiKey: 'admin-fixture', clientKeys: [{ name: 'alice', key: 'member-fixture', accounts: ['provider-a'] }] },
  };
  const manager = new AccountManager([{ id: 'provider-a', name: 'provider', type: 'apikey', apiKey: 'provider-fixture' }]);
  const proxy = http.createServer();
  const sockets = new Set();
  proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  proxy.on('connect', createConnectHandler({
    config, accountManager: manager,
    ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }),
    log: () => {},
  }));
  const port = await listen(proxy);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    proxy.close();
    upstream.closeAllConnections();
    upstream.close();
  });
  const first = await tunnel(port, `127.0.0.1:${upstreamPort}`, 'member-fixture', caCertPem);
  t.after(() => first.destroy());
  assert.equal(await inference(first), 200);
  config.proxy.clientKeys[0].key = 'rotated-fixture';
  assert.equal(await inference(first), 401);
  const replacement = await tunnel(port, `127.0.0.1:${upstreamPort}`, 'rotated-fixture', caCertPem);
  t.after(() => replacement.destroy());
  assert.equal(await inference(replacement), 200);
  assert.equal(calls, 2);
});
