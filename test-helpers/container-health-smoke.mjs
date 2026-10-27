import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2];
assert.ok(image, 'Usage: node test-helpers/container-health-smoke.mjs <image>');
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 20000 });
const setup = `relaycrew team init && node -e 'const fs=require("node:fs");const p=process.env.RELAYCREW_CONFIG;const c=JSON.parse(fs.readFileSync(p,"utf8"));c.quotaProbeSeconds=0;c.autoUpdate=false;c.accounts=[{id:"health-provider",name:"health-provider",type:"apikey",apiKey:"synthetic-health-key",upstream:"http://127.0.0.1:9"}];fs.writeFileSync(p,JSON.stringify(c));' && exec relaycrew server --headless`;
const started = docker('run', '--detach', '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges:true', '--tmpfs', '/data:rw,mode=0700', '--entrypoint', 'docker-entrypoint.sh', image, 'sh', '-c', setup);
assert.equal(started.status, 0, started.stderr);
const container = started.stdout.trim();
try {
  const probe = 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync("/data/relaycrew.json","utf8"));fetch("http://127.0.0.1:3456/relaycrew/status",{headers:{"x-api-key":c.proxy.apiKey}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))';
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (docker('exec', '--user', '1000:1000', container, 'node', '-e', probe).status === 0) { ready = true; break; }
    await delay(100);
  }
  assert.ok(ready, 'Gateway did not become ready as its unprivileged user');
  const inspected = docker('inspect', '--format', '{{json .Config.Healthcheck.Test}}', container);
  assert.equal(inspected.status, 0, inspected.stderr);
  const health = JSON.parse(inspected.stdout);
  assert.ok(Array.isArray(health) && (health[0] === 'CMD' || health[0] === 'CMD-SHELL'), 'Image must define an executable health check');
  const command = health[0] === 'CMD-SHELL' ? ['sh', '-c', health[1]] : health.slice(1);
  const checked = docker('exec', container, ...command);
  assert.equal(checked.status, 0, 'Image health check failed with Compose capabilities and private configuration:\n' + checked.stderr);
  const owner = docker('exec', '--user', '1000:1000', container, 'stat', '-c', '%u:%g:%a', '/data/relaycrew.json');
  assert.equal(owner.status, 0, owner.stderr);
  assert.equal(owner.stdout.trim(), '1000:1000:600');
  console.log('Container health smoke passed with restricted capabilities and a private unprivileged configuration.');
} finally {
  const removed = docker('rm', '--force', container);
  assert.equal(removed.status, 0, removed.stderr);
}
