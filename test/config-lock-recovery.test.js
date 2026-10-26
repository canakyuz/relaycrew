import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicConfigUpdate } from '../src/config.js';

const configModule = new URL('../src/config.js', import.meta.url).href;
const childCode = `
 const fs = require('node:fs');
 const { syncBuiltinESMExports } = require('node:module');
 const original = fs.readFileSync;
 const path = process.env.RELAYCREW_CONFIG;
 let paused = false;
 fs.readFileSync = function(file, ...args) {
  const result = original.call(this, file, ...args);
  if (file === path + '.lock') {
   if (!paused) {
    paused = true;
    process.send({ event: 'observed' });
    while (!fs.existsSync(path + '.go-' + process.env.WRITER)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
   } else if (process.env.WRITER === 'unrelated') {
    process.send({ event: 'rechecked', pid: JSON.parse(result).pid });
   }
  }
  return result;
 };
 syncBuiltinESMExports();
 import(process.env.CONFIG_MODULE).then(async ({ atomicConfigUpdate }) => {
  await atomicConfigUpdate(async config => {
   if (process.env.WRITER === 'rotation') config.proxy.clientKeys[0].key = 'rotated';
   else config.unrelatedSetting = true;
   config.updateCount = (config.updateCount ?? 0) + 1;
   process.send({ event: 'entered' });
   while (!fs.existsSync(path + '.finish-' + process.env.WRITER)) await new Promise(resolve => setTimeout(resolve, 5));
  });
  process.send({ event: 'done' });
  process.exit(0);
 }).catch(error => { process.send({ event: 'error', message: error.stack }); process.exit(1); });
`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'relaycrew-lock-regression-'));
  const path = join(dir, 'config.json');
  const config = { upstreamProxy: false, accounts: [], proxy: { apiKey: 'admin', teamMode: true, clientKeys: [{ name: 'alice', key: 'old', accounts: '*' }] } };
  await writeFile(path, JSON.stringify(config));
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => dead.once('exit', resolve));
  await writeFile(path + '.lock', JSON.stringify({ pid: dead.pid, at: Date.now() }));
  return { dir, path, config, deadPid: dead.pid };
}

function writer(path, name) {
  const child = spawn(process.execPath, ['-e', childCode], { env: { ...process.env, RELAYCREW_CONFIG: path, WRITER: name, CONFIG_MODULE: configModule }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const history = [];
  const listeners = new Set();
  child.on('message', message => { history.push(message); for (const listener of listeners) listener(message); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  function wait(...events) {
    const previous = history.find(message => events.includes(message.event) || message.event === 'error');
    if (previous) return previous.event === 'error' ? Promise.reject(new Error(previous.message)) : Promise.resolve(previous);
    return new Promise((resolve, reject) => {
      const listener = message => {
        if (events.includes(message.event) || message.event === 'error') {
          listeners.delete(listener);
          if (message.event === 'error') reject(new Error(message.message)); else resolve(message);
        }
      };
      listeners.add(listener);
      exited.then(code => { if (listeners.delete(listener)) reject(new Error('Child exited before ' + events.join('/') + ': ' + code)); });
    });
  }
  return { child, history, wait, exited };
}

test('two processes recovering one dead lock cannot overwrite a completed credential rotation', { timeout: 5000 }, async () => {
  const f = await fixture();
  const a = writer(f.path, 'rotation'), b = writer(f.path, 'unrelated');
  try {
    await Promise.all([a.wait('observed'), b.wait('observed')]);
    await writeFile(f.path + '.go-rotation', '');
    await a.wait('entered');
    await writeFile(f.path + '.go-unrelated', '');
    const result = await b.wait('rechecked', 'entered');
    assert.equal(result.event, 'rechecked', 'the delayed reaper must recheck the replacement before entering');
    assert.equal(result.pid, a.child.pid, 'the replacement still belongs to the first live writer');
    assert(!b.history.some(message => message.event === 'entered'), 'the second mutation remains outside the critical section');
    assert.equal(JSON.parse(await readFile(f.path + '.lock', 'utf8')).pid, a.child.pid);
    await writeFile(f.path + '.finish-rotation', '');
    await a.wait('done');
    await b.wait('entered');
    await writeFile(f.path + '.finish-unrelated', '');
    await b.wait('done');
    const saved = JSON.parse(await readFile(f.path, 'utf8'));
    assert.equal(saved.proxy.clientKeys[0].key, 'rotated');
    assert.equal(saved.unrelatedSetting, true);
    assert.equal(saved.updateCount, 2);
    assert.deepEqual(await Promise.all([a.exited, b.exited]), [0, 0]);
  } finally {
    for (const process of [a, b]) if (process.child.exitCode === null) process.child.kill('SIGKILL');
    await Promise.all([a.exited, b.exited]);
    await rm(f.dir, { recursive: true, force: true });
  }
});

test('an orphaned recovery guard refuses stale-lock recovery until explicit cleanup', { timeout: 10000 }, async () => {
  const f = await fixture();
  const previousPath = process.env.RELAYCREW_CONFIG;
  const previousWait = process.env.RELAYCREW_CONFIG_LOCK_WAIT_MS;
  process.env.RELAYCREW_CONFIG = f.path;
  process.env.RELAYCREW_CONFIG_LOCK_WAIT_MS = '50';
  try {
    const orphan = JSON.stringify({ pid: f.deadPid, at: Date.now() - 60000 });
    await writeFile(f.path + '.lock.recovery', orphan);
    await assert.rejects(atomicConfigUpdate(config => { config.updated = true; }), { code: 'CONFIG_LOCK_BUSY' });
    assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), f.config);
    assert.equal(await readFile(f.path + '.lock.recovery', 'utf8'), orphan);
    await rm(f.path + '.lock.recovery');
    await atomicConfigUpdate(config => { config.updated = true; });
    assert.equal(JSON.parse(await readFile(f.path, 'utf8')).updated, true);
  } finally {
    if (previousPath === undefined) delete process.env.RELAYCREW_CONFIG; else process.env.RELAYCREW_CONFIG = previousPath;
    if (previousWait === undefined) delete process.env.RELAYCREW_CONFIG_LOCK_WAIT_MS; else process.env.RELAYCREW_CONFIG_LOCK_WAIT_MS = previousWait;
    await rm(f.dir, { recursive: true, force: true });
  }
});
