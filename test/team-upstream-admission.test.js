import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

test('authorization is checked after the upstream admission queue', async t => {
  const previous = process.env.TEAMCLAUDE_UPSTREAM_MAX_SOCKETS;
  process.env.TEAMCLAUDE_UPSTREAM_MAX_SOCKETS = '1';
  let pool;
  try {
    pool = await import('../src/upstream-fetch.js?team-admission');
  } finally {
    if (previous === undefined) delete process.env.TEAMCLAUDE_UPSTREAM_MAX_SOCKETS;
    else process.env.TEAMCLAUDE_UPSTREAM_MAX_SOCKETS = previous;
  }
  let activeResponse;
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    activeResponse = res;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('open');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const first = await pool.upstreamFetch(url);
  let allowed = true;
  const second = pool.upstreamFetch(url, { authorize: () => allowed });
  const rejected = assert.rejects(second, /Team access changed before dispatch/);
  assert.equal(pool.upstreamPoolStatus().queued, 1);
  allowed = false;
  activeResponse.end();
  await first.text();
  await rejected;
  assert.equal(requests, 1);
  assert.equal(pool.upstreamPoolStatus().active, 0);
});
