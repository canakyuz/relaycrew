import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultConfig, writeJsonAtomic } from '../src/config.js';
import { ClientUsageTracker, UsageDimensionTracker, USAGE_SLOT_MS } from '../src/client-usage.js';

const port = Number(process.env.RELAYCREW_PREVIEW_PORT || 43190);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('RELAYCREW_PREVIEW_PORT must be an integer from 1024 to 65535.');
const directory = await mkdtemp(join(tmpdir(), 'relaycrew-preview-'));
const configPath = join(directory, 'relaycrew.json');
const upstream = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Local demonstration response.' }], usage: { input_tokens: 120, output_tokens: 40 } }));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const config = createDefaultConfig();
config.dashboardPreview = true;
config.proxy = { ...config.proxy, host: '127.0.0.1', port, teamMode: true, trustLoopback: false, sessionDetail: true,
  clientKeys: ['ana-demo', 'bruno-demo', 'ci-demo'].map((name, i) => ({ name, key: 'demo-' + randomBytes(32).toString('base64url'), accounts: i === 2 ? ['local-claude'] : '*', maxConcurrent: i === 2 ? 2 : 4 })),
  usageDimensions: [{ name: 'project', header: 'x-preview-project' }],
};
config.accounts = [
  { id: 'local-claude', name: 'Claude · demonstração local', type: 'apikey', apiKey: 'synthetic-local-provider' },
  { id: 'local-codex', name: 'Codex · demonstração local', type: 'apikey', provider: 'codex', apiKey: 'synthetic-local-provider' },
];
config.upstream = `http://127.0.0.1:${upstream.address().port}`;
for (const account of config.accounts) account.upstream = config.upstream;
config.upstreamProxy = false;
config.autoUpdate = false;
config.quotaProbeSeconds = 0;
await writeJsonAtomic(configPath, config);
let clock = Date.now();
const clients = new ClientUsageTracker({ now: () => clock });
const dimensions = new UsageDimensionTracker({ now: () => clock });
const current = Math.floor(clock / USAGE_SLOT_MS) * USAGE_SLOT_MS;
for (let slot = 0; slot < 96; slot++) {
  clock = current - (95 - slot) * USAGE_SLOT_MS;
  for (let member = 0; member < 3; member++) {
    const requests = Math.max(0, Math.round(9 + 7 * Math.sin(slot / 7 + member) - member * 2));
    if (!requests) continue;
    const usage = { requests, inputTokens: requests * (420 + member * 80), outputTokens: requests * (180 + member * 50) };
    clients.record(config.proxy.clientKeys[member].name, usage);
    dimensions.record('project', ['relay-demo', 'sdk-demo', 'ci-demo'][member], usage);
  }
}
clock = Date.now();
await writeJsonAtomic(join(directory, 'relaycrew.state.json'), { clients: clients.exportState(), usageDimensions: dimensions.exportState() });
const child = spawn(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url)), 'server', '--headless'], {
  env: { ...process.env, RELAYCREW_CONFIG: configPath, RELAYCREW_HOST: '127.0.0.1', RELAYCREW_DISABLE_AUTOUPDATE: '1' },
  stdio: 'inherit',
});
console.log(`Local demonstration with synthetic accounts, members and history. No provider credentials are used.\nDashboard: http://localhost:${port}/relaycrew/dashboard\nProtected demo configuration: ${configPath}`);
let stopping = false;
function stop() { if (!stopping) { stopping = true; child.kill('SIGTERM'); } }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.once('error', async error => { console.error(error.message); upstream.close(); await rm(directory, { recursive: true, force: true }); process.exitCode = 1; });
child.once('exit', async code => { upstream.close(); await rm(directory, { recursive: true, force: true }); process.exitCode = stopping ? 0 : (code ?? 1); });
