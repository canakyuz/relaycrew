import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envVar, canonicalControlUrl } from '../src/brand.js';
import { getConfigPath, getStatePath } from '../src/config.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { generateCertChain } from '../src/x509.js';
import { ensureCerts, caCertPath } from '../src/mitm.js';

const listen = s => new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve(s.address().port)));
function request(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('RelayCrew environment takes precedence while both legacy spellings remain accepted', () => {
  assert.equal(envVar('CONFIG', {}), undefined);
  assert.equal(envVar('CONFIG', { TEAMCLAUDE_CONFIG: '/old' }), '/old');
  assert.equal(envVar('CONFIG', { TEAMROUTER_CONFIG: '/router', TEAMCLAUDE_CONFIG: '/old' }), '/router');
  assert.equal(envVar('CONFIG', { RELAYCREW_CONFIG: '/new', TEAMROUTER_CONFIG: '/router', TEAMCLAUDE_CONFIG: '/old' }), '/new');
  assert.equal(envVar('HOST', { RELAYCREW_HOST: '', TEAMCLAUDE_HOST: '0.0.0.0' }), '');
});

test('control URL normalization accepts complete legacy segments only', () => {
  for (const name of ['teamrouter', 'teamclaude']) {
    assert.equal(canonicalControlUrl(`/${name}/status`), '/relaycrew/status');
    assert.equal(canonicalControlUrl(`/${name}/mcp/?x=1`), '/relaycrew/mcp/?x=1');
    assert.equal(canonicalControlUrl(`/${name}`), '/relaycrew');
    assert.equal(canonicalControlUrl(`/${name}?x`), '/relaycrew?x');
    assert.equal(canonicalControlUrl(`/${name}x/status`), null);
  }
  assert.equal(canonicalControlUrl('/relaycrew/status'), null);
  assert.equal(canonicalControlUrl('/v1/messages'), null);
  assert.equal(canonicalControlUrl(undefined), null);
});

test('new installs use RelayCrew configuration while existing configs and state are reused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'relaycrew-brand-'));
  const keys = ['RELAYCREW_CONFIG', 'TEAMROUTER_CONFIG', 'TEAMCLAUDE_CONFIG', 'XDG_CONFIG_HOME'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(async () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    await rm(dir, { recursive: true, force: true });
  });
  for (const key of keys) delete process.env[key];
  process.env.XDG_CONFIG_HOME = dir;
  assert.equal(getConfigPath(), join(dir, 'relaycrew.json'));
  for (const name of ['teamclaude', 'teamrouter', 'relaycrew']) {
    await writeFile(join(dir, `${name}.json`), '{}');
    assert.equal(getConfigPath(), join(dir, `${name}.json`));
    assert.equal(getStatePath(), join(dir, `${name}.state.json`));
  }
  process.env.TEAMCLAUDE_CONFIG = '/explicit/old.json';
  assert.equal(getConfigPath(), '/explicit/old.json');
  process.env.RELAYCREW_CONFIG = '/explicit/new.json';
  assert.equal(getConfigPath(), '/explicit/new.json');
});

test('canonical and legacy control routes share authorization and never leak unknown paths upstream', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => { upstreamHits++; res.writeHead(404); res.end('{}'); });
  const upstreamPort = await listen(upstream);
  const manager = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k' }]);
  const proxy = createProxyServer(manager, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    for (const name of ['relaycrew', 'teamrouter', 'teamclaude']) {
      assert.equal((await request(port, `/${name}/status`)).status, 200);
      const page = await request(port, `/${name}/dashboard`);
      assert.equal(page.status, 200);
      assert.match(page.body, /<title>RelayCrew<\/title>/);
      assert.equal((await request(port, `/${name}/quota`)).status, 200);
      const csrf = await request(port, `/${name}/reload`, { method: 'POST', headers: { origin: 'https://evil.example' } });
      assert.equal(csrf.status, 403);
      for (const path of [`/${name}/reload`, `/${name}/statuss`, `/${name}`, `/${name}/`, `/%${name.charCodeAt(0).toString(16)}${name.slice(1)}/reload`]) {
        assert.equal((await request(port, path)).status, 404, path);
      }
    }
    assert.equal(upstreamHits, 0);
    await request(port, '/relaycrewx/status');
    assert.equal(upstreamHits, 1);
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    upstream.closeAllConnections?.(); upstream.close();
  }
});


test('existing MITM certificates retain their trusted CA after the rename', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'relaycrew-cert-migration-'));
  const previous = process.env.RELAYCREW_CONFIG;
  process.env.RELAYCREW_CONFIG = join(dir, 'relaycrew.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.RELAYCREW_CONFIG; else process.env.RELAYCREW_CONFIG = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const chain = generateCertChain(['api.anthropic.com', 'www.example.org']);
  for (const [suffix, value] of [['-ca.pem', chain.caCertPem], ['-leaf.pem', chain.leafCertPem], ['-leaf.key', chain.leafKeyPem]]) {
    await writeFile(join(dir, 'teamclaude' + suffix), value);
  }
  const result = await ensureCerts('api.anthropic.com');
  assert.equal(result.caCertPem, chain.caCertPem);
  assert.equal(caCertPath(), join(dir, 'teamclaude-ca.pem'));
});
