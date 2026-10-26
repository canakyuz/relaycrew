import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The server (token refresh), the CLI (login/import/priority/...) and a GUI
// client all rewrite the config with a temp+rename. Two of them racing keep only
// the later write, and the edit that is lost is as likely as not a freshly
// rotated refresh token — which costs a re-login. Writers therefore hold an
// advisory lock file, `<config>.lock`, across the read-modify-write. These pin
// the protocol other clients interoperate with: exclusive create, a JSON body
// of {pid, at}, staleness by dead pid or malformed age, a bounded wait, and
// fail-closed writes when another live holder owns the lock.

// `lockWaitMs` is the wait budget for the run, when a test's assertions depend
// on it: a test that must observe a release before the budget runs out gets a
// budget no scheduler stall can exhaust; a test of the budget itself gets a
// short one, so it is fast and its lower bound is the only timing it asserts.
async function withConfigDir(fn, { lockWaitMs = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-lock-'));
  const prev = process.env.RELAYCREW_CONFIG;
  const prevWait = process.env.RELAYCREW_CONFIG_LOCK_WAIT_MS;
  const path = join(dir, 'relaycrew.json');
  process.env.RELAYCREW_CONFIG = path;
  if (lockWaitMs != null) process.env.RELAYCREW_CONFIG_LOCK_WAIT_MS = String(lockWaitMs);
  else delete process.env.RELAYCREW_CONFIG_LOCK_WAIT_MS;
  try {
    const cfg = await import('../src/config.js');
    await writeFile(path, JSON.stringify({ proxy: { port: 1, apiKey: 'tc-test' }, upstreamProxy: false, accounts: [] }));
    await fn({ dir, cfg, path, lockPath: `${path}.lock` });
  } finally {
    if (prev === undefined) delete process.env.RELAYCREW_CONFIG;
    else process.env.RELAYCREW_CONFIG = prev;
    if (prevWait === undefined) delete process.env.RELAYCREW_CONFIG_LOCK_WAIT_MS;
    else process.env.RELAYCREW_CONFIG_LOCK_WAIT_MS = prevWait;
  }
}

// The bypass warning is the one observable difference between a write that
// waited for the holder and one that gave up on it.
function captureBypassWarnings() {
  const warnings = [];
  const origError = console.error;
  console.error = (...args) => {
    const line = args.join(' ');
    if (/is still held by another process/.test(line)) warnings.push(line);
    else origError(...args);
  };
  return { warnings, restore: () => { console.error = origError; } };
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf-8'));

// A pid that no process has: a child that has already exited.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => child.on('exit', resolve));
  return child.pid;
}

test('two concurrent atomicConfigUpdate calls both land', async () => {
  await withConfigDir(async ({ dir, cfg, path }) => {
    await Promise.all([
      cfg.atomicConfigUpdate(config => { config.first = 1; }),
      cfg.atomicConfigUpdate(config => { config.second = 2; }),
    ]);
    const on = await readJson(path);
    assert.equal(on.first, 1);
    assert.equal(on.second, 2);
    assert.deepEqual(await readdir(dir), ['relaycrew.json'], 'no lock or temp file remains');
  });
});

test('an old timestamp never steals a live holder lock', async () => {
  await withConfigDir(async ({ cfg, path, lockPath }) => {
    const before = await readFile(path, 'utf8');
    const body = { pid: process.pid, at: Date.now() - 60_000 };
    await writeFile(lockPath, JSON.stringify(body));
    await assert.rejects(cfg.saveConfig({ fresh: true }), { code: 'CONFIG_LOCK_BUSY' });
    assert.equal(await readFile(path, 'utf8'), before);
    assert.deepEqual(await readJson(lockPath), body);
  }, { lockWaitMs: 50 });
});

test('a fresh lock whose pid is dead is broken', async () => {
  await withConfigDir(async ({ dir, cfg, path, lockPath }) => {
    await writeFile(lockPath, JSON.stringify({ pid: await deadPid(), at: Date.now() }));
    const { warnings, restore } = captureBypassWarnings();
    try { await cfg.saveConfig({ fresh: true }); } finally { restore(); }
    assert.deepEqual(warnings, [], 'a dead holder\'s lock is broken, not waited out and bypassed');
    assert.deepEqual(await readJson(path), { fresh: true });
    assert.deepEqual(await readdir(dir), ['relaycrew.json']);
  });
});

test('a live lock held by another process delays the write until it is released', async () => {
  // A budget no stall of this process can run out: the write below must be
  // seen to wait for the release, never to give up on it.
  await withConfigDir(async ({ dir, cfg, path, lockPath }) => {
    // The other writer: takes the lock exactly as we do, holds it until told
    // to let go (a byte on stdin), and releases. Event-driven rather than
    // timed, so what the test observes is ordering, not the scheduler.
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const fd = fs.openSync(process.argv[1], 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      process.stdout.write('locked\\n');
      process.stdin.once('data', () => { fs.unlinkSync(process.argv[1]); process.exit(0); });
    `, lockPath], { stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = new Promise(resolve => holder.on('exit', resolve));
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', resolve);
      holder.once('error', reject);
    });

    const { warnings, restore } = captureBypassWarnings();
    try {
      const write = cfg.saveConfig({ fresh: true });
      // While the holder has the lock, the write has not happened: the file
      // still carries what withConfigDir put there.
      await new Promise(r => setTimeout(r, 100));
      assert.deepEqual(await readJson(path), { proxy: { port: 1, apiKey: 'tc-test' }, upstreamProxy: false, accounts: [] }, 'the write waited for the holder');
      holder.stdin.write('go\n');
      await write;
    } finally {
      restore();
    }
    assert.deepEqual(warnings, [], 'the write went through on the release, not by giving up on the lock');
    assert.deepEqual(await readJson(path), { fresh: true });
    assert.equal(await exited, 0, 'the holder unlinked its own lock; nobody removed it from under it');
    assert.deepEqual(await readdir(dir), ['relaycrew.json']);
  }, { lockWaitMs: 600_000 });
});

test('the lock is released after a success and after a throwing mutator', async () => {
  await withConfigDir(async ({ dir, cfg, path }) => {
    await cfg.atomicConfigUpdate(config => { config.ok = true; });
    assert.deepEqual(await readdir(dir), ['relaycrew.json'], 'released after success');

    await assert.rejects(cfg.atomicConfigUpdate(() => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(await readdir(dir), ['relaycrew.json'], 'released after a throw');
    assert.equal((await readJson(path)).ok, true, 'the failed update wrote nothing');

    // And the next writer is not held up by anything the failure left behind.
    const { warnings, restore } = captureBypassWarnings();
    try { await cfg.saveConfig({ after: true }); } finally { restore(); }
    assert.deepEqual(warnings, [], 'nothing left behind was waited out');
    assert.deepEqual(await readJson(path), { after: true });
  });
});

test('a lock held past the wait budget refuses writes and leaves the holder intact', async () => {
  await withConfigDir(async ({ cfg, path, lockPath }) => {
    const before = await readFile(path, 'utf8');
    const body = { pid: process.pid, at: Date.now() };
    await writeFile(lockPath, JSON.stringify(body));
    const started = Date.now();
    await assert.rejects(cfg.saveConfig({ fresh: true }), { code: 'CONFIG_LOCK_BUSY' });
    assert.ok(Date.now() - started >= 200);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.deepEqual(await readJson(lockPath), body);
  }, { lockWaitMs: 200 });
});


test('malformed lock metadata recovers only after the file is old', async () => {
  await withConfigDir(async ({ cfg, path, lockPath }) => {
    await writeFile(lockPath, JSON.stringify({ at: 'invalid', pid: null }));
    const before = await readFile(path, 'utf8');
    await assert.rejects(cfg.saveConfig({ fresh: true }), { code: 'CONFIG_LOCK_BUSY' });
    assert.equal(await readFile(path, 'utf8'), before);
    const old = new Date(Date.now() - 60000);
    await utimes(lockPath, old, old);
    await cfg.saveConfig({ fresh: true });
    assert.deepEqual(await readJson(path), { fresh: true });
  }, { lockWaitMs: 50 });
});
