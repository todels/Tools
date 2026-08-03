// Boots the real watcher process against a throwaway font directory and
// checks the detect -> baseline -> queue pipeline over its own HTTP API.
// No Supabase account needed: without a session, new fonts stop at the
// "waiting for confirmation" queue, which is exactly what we assert.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFakeFont } from '../../tools/fake-font.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, '..', 'bin', 'fontsync.js');
const PORT = 7801 + (process.pid % 100); // avoid collisions with a running instance

let home;
let fontDir;
let child;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (path) => (await fetch(`http://localhost:${PORT}${path}`)).json();

async function post(path, body) {
  const res = await fetch(`http://localhost:${PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Polls until `check` passes, so the test never depends on a fixed sleep.
 * Connection errors are retried too — the server needs a moment to bind.
 */
async function waitFor(check, { timeout = 15000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await get('/api/state');
      lastError = null;
      if (check(last)) return last;
    } catch (err) {
      lastError = err;
    }
    await sleep(interval);
  }
  throw new Error(
    `condition not met within ${timeout}ms. ${lastError ? `Last error: ${lastError.message}` : `Last state: ${JSON.stringify(last)}`}`,
  );
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'fontsync-home-'));
  fontDir = await mkdtemp(join(tmpdir(), 'fontsync-fonts-'));

  // A font already present before first launch: this must be treated as
  // baseline and never queued for upload.
  await writeFile(join(fontDir, 'Preinstalled-Regular.ttf'), makeFakeFont('Preinstalled Sans', 'Regular'));

  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'config.json'), JSON.stringify({
    supabaseUrl: 'https://example.invalid',
    supabaseAnonKey: 'test-key',
    watchDirs: [fontDir],
    port: PORT,
  }));

  child = spawn(process.execPath, [ENTRY, '--no-open'], {
    env: { ...process.env, FONTSYNC_HOME: home, SUPABASE_URL: '', SUPABASE_ANON_KEY: '' },
    stdio: 'ignore',
  });

  await waitFor(() => true, { timeout: 10000 });
});

after(async () => {
  child?.kill('SIGTERM');
  await sleep(300);
  child?.kill('SIGKILL');
  await rm(home, { recursive: true, force: true });
  await rm(fontDir, { recursive: true, force: true });
});

test('fonts installed before first launch are baseline, not upload candidates', async () => {
  const state = await get('/api/state');
  assert.equal(state.pending.length, 0, 'preinstalled font should not be queued');
  assert.deepEqual(state.watchDirs, [fontDir]);
  assert.equal(state.signedIn, false);
});

test('a newly installed font is detected and queued for rights confirmation', async () => {
  await writeFile(join(fontDir, 'AcmeGrotesk-Bold.ttf'), makeFakeFont('Acme Grotesk', 'Bold'));

  const state = await waitFor((s) => s.pending.length === 1);
  const [entry] = state.pending;

  assert.equal(entry.fileName, 'AcmeGrotesk-Bold.ttf');
  assert.equal(entry.format, 'ttf');
  assert.deepEqual(
    entry.faces.map((f) => [f.family, f.style]),
    [['Acme Grotesk', 'Bold']],
  );
});

test('nothing uploads without an explicit rights confirmation', async () => {
  const state = await get('/api/state');
  const ids = state.pending.map((p) => p.id);

  const res = await post('/api/approve', { ids, licenseConfirmed: false });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /rights/i);

  // Still queued, nothing lost.
  assert.equal((await get('/api/state')).pending.length, ids.length);
});

test('unsupported font formats are skipped with a reason rather than silently dropped', async () => {
  await writeFile(join(fontDir, 'Legacy-Regular.woff2'), Buffer.from('wOF2 not really a woff2'));

  const state = await waitFor((s) => s.skipped.some((k) => k.fileName === 'Legacy-Regular.woff2'));
  const skipped = state.skipped.find((k) => k.fileName === 'Legacy-Regular.woff2');

  assert.match(skipped.reason, /\.woff2/);
  assert.ok(!state.pending.some((p) => p.fileName === 'Legacy-Regular.woff2'));
});

test('a .ttc collection is queued as one file carrying several faces', async () => {
  const { buildNameTable, buildTtc } = await import('../../tools/fake-font.mjs');
  const ttc = buildTtc([
    buildNameTable([[1, 'Acme Display'], [2, 'Regular']]),
    buildNameTable([[1, 'Acme Display'], [2, 'Black']]),
  ]);
  await writeFile(join(fontDir, 'AcmeDisplay.ttc'), ttc);

  const state = await waitFor((s) => s.pending.some((p) => p.fileName === 'AcmeDisplay.ttc'));
  const entry = state.pending.find((p) => p.fileName === 'AcmeDisplay.ttc');

  assert.equal(entry.format, 'ttc');
  assert.deepEqual(entry.faces.map((f) => f.style), ['Regular', 'Black']);
});

test('dismissing a queued font removes it without re-queueing on the next scan', async () => {
  const before = await get('/api/state');
  const target = before.pending.find((p) => p.fileName === 'AcmeDisplay.ttc');

  await post('/api/dismiss', { ids: [target.id] });
  await post('/api/rescan', {});

  const after = await get('/api/state');
  assert.ok(!after.pending.some((p) => p.id === target.id));
  assert.ok(!after.pending.some((p) => p.fileName === 'AcmeDisplay.ttc'));
});

test('the settings API rejects non-local requests', async () => {
  const res = await fetch(`http://localhost:${PORT}/api/state`, {
    headers: { Origin: 'https://evil.example.com' },
  });
  assert.equal(res.status, 403);
});
