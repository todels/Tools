// The upload half of the watcher, end to end: sign in -> detect -> confirm ->
// upload -> row + object land correctly. Runs the real process against a fake
// Supabase, so no credentials are needed and the assertions are on real HTTP
// traffic rather than mocked functions.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFakeFont } from '../../tools/fake-font.mjs';
import { hashBuffer } from '../src/fontmeta.js';
import { startFakeSupabase } from './fake-supabase.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, '..', 'bin', 'fontsync.js');
const PORT = 7901 + (process.pid % 80);

let supabase;
let home;
let fontDir;
let child;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async () => (await fetch(`http://localhost:${PORT}/api/state`)).json();

async function post(path, body) {
  const res = await fetch(`http://localhost:${PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function waitFor(check, { timeout = 20000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await get();
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
  supabase = await startFakeSupabase();
  home = await mkdtemp(join(tmpdir(), 'fontsync-up-home-'));
  fontDir = await mkdtemp(join(tmpdir(), 'fontsync-up-fonts-'));

  await writeFile(join(home, 'config.json'), JSON.stringify({
    supabaseUrl: supabase.url,
    supabaseAnonKey: supabase.anonKey,
    watchDirs: [fontDir],
    port: PORT,
  }));

  child = spawn(process.execPath, [ENTRY, '--no-open'], {
    env: { ...process.env, FONTSYNC_HOME: home, SUPABASE_URL: '', SUPABASE_ANON_KEY: '' },
    stdio: 'ignore',
  });

  await waitFor(() => true);
});

after(async () => {
  child?.kill('SIGTERM');
  await sleep(300);
  child?.kill('SIGKILL');
  await supabase?.close();
  await rm(home, { recursive: true, force: true });
  await rm(fontDir, { recursive: true, force: true });
});

test('bad credentials are reported and leave the app signed out', async () => {
  const res = await post('/api/signin', { email: 'designer@agency.test', password: 'wrong' });
  assert.equal(res.status, 400, 'auth failures should surface as a client error, not a 500');
  assert.match(res.body.error, /Invalid login credentials/);
  assert.equal((await get()).signedIn, false);
});

test('signing in stores the session and shows the account', async () => {
  const res = await post('/api/signin', { email: 'designer@agency.test', password: 'hunter2' });
  assert.equal(res.status, 200);

  const state = await get();
  assert.equal(state.signedIn, true);
  assert.equal(state.email, 'designer@agency.test');
});

test('confirming a queued font uploads the file and its metadata', async () => {
  const bytes = makeFakeFont('Acme Grotesk', 'SemiBold');
  await writeFile(join(fontDir, 'AcmeGrotesk-SemiBold.ttf'), bytes);

  const queued = await waitFor((s) => s.pending.length === 1);
  const res = await post('/api/approve', {
    ids: [queued.pending[0].id],
    licenseConfirmed: true,
    projectTag: 'Acme rebrand',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results, [{ id: queued.pending[0].id, ok: true }]);

  // One row, with the fields the plugin depends on.
  assert.equal(supabase.db.fonts.length, 1);
  const row = supabase.db.fonts[0];
  assert.equal(row.family, 'Acme Grotesk');
  assert.equal(row.style, 'SemiBold');
  assert.equal(row.family_key, 'acme grotesk');
  assert.equal(row.style_key, 'semibold');
  assert.equal(row.postscript_name, 'AcmeGrotesk-SemiBold');
  assert.equal(row.uploader, 'designer@agency.test');
  assert.equal(row.uploader_id, supabase.users[0].id);
  assert.equal(row.project_tag, 'Acme rebrand');
  assert.equal(row.license_confirmed, true);
  assert.equal(row.format, 'ttf');
  assert.equal(row.file_size, bytes.length);
  assert.equal(row.file_hash, hashBuffer(bytes));

  // The stored object is the actual font, byte for byte.
  assert.equal(supabase.hashOf(row.storage_path), hashBuffer(bytes));

  const state = await waitFor((s) => s.uploaded.length === 1);
  assert.equal(state.pending.length, 0);
  assert.equal(state.uploaded[0].projectTag, 'Acme rebrand');
});

test('the same font arriving under another name does not duplicate the row', async () => {
  const bytes = makeFakeFont('Acme Grotesk', 'SemiBold'); // identical content
  await writeFile(join(fontDir, 'AcmeGrotesk-SemiBold-copy.ttf'), bytes);

  const queued = await waitFor((s) => s.pending.length === 1);
  await post('/api/approve', { ids: [queued.pending[0].id], licenseConfirmed: true, projectTag: 'Acme rebrand' });
  await waitFor((s) => s.pending.length === 0);

  // merge-duplicates on (family_key, style_key, file_hash)
  assert.equal(supabase.db.fonts.length, 1, `rows: ${JSON.stringify(supabase.db.fonts.map((f) => [f.family, f.style, f.storage_path]))}`);
  assert.equal(supabase.db.objects.size, 1, `objects: ${JSON.stringify([...supabase.db.objects.keys()])}`);
});

test('a .ttc collection becomes one stored file and one row per face', async () => {
  const { buildNameTable, buildTtc } = await import('../../tools/fake-font.mjs');
  await writeFile(join(fontDir, 'AcmeDisplay.ttc'), buildTtc([
    buildNameTable([[1, 'Acme Display'], [2, 'Regular']]),
    buildNameTable([[1, 'Acme Display'], [2, 'Black']]),
  ]));

  const queued = await waitFor((s) => s.pending.some((p) => p.fileName === 'AcmeDisplay.ttc'));
  const entry = queued.pending.find((p) => p.fileName === 'AcmeDisplay.ttc');
  await post('/api/approve', { ids: [entry.id], licenseConfirmed: true, projectTag: '' });
  await waitFor((s) => !s.pending.some((p) => p.id === entry.id));

  const rows = supabase.db.fonts.filter((f) => f.family === 'Acme Display');
  assert.deepEqual(rows.map((r) => r.style).sort(), ['Black', 'Regular']);
  // Two faces, one file: same hash and same object.
  assert.equal(new Set(rows.map((r) => r.storage_path)).size, 1);
  assert.equal(supabase.db.objects.size, 2);
});

test('retagging a recent upload updates the stored row', async () => {
  const state = await get();
  const upload = state.uploaded.find((u) => u.fileName === 'AcmeGrotesk-SemiBold.ttf');

  const res = await post('/api/retag', { rowIds: upload.rowIds, projectTag: 'Beta launch' });
  assert.equal(res.status, 200);
  assert.equal(res.body.updated, 1);

  const row = supabase.db.fonts.find((f) => f.id === upload.rowIds[0]);
  assert.equal(row.project_tag, 'Beta launch');
});

test('the font is discoverable the way the plugin queries for it', async () => {
  const { FontSyncApi } = await import('../src/api.js');
  const api = new FontSyncApi({ url: supabase.url, anonKey: supabase.anonKey });
  await api.signIn('teammate@agency.test', 'hunter2');

  // A teammate who uploaded nothing can still read the library.
  const rows = await api.findByFamilies(['acme grotesk']);
  const match = rows.find((r) => r.style_key === 'semibold');
  assert.ok(match, 'font not found by normalised family key');
  assert.equal(match.uploader, 'designer@agency.test');

  // ...and download it through a signed URL.
  const signedUrl = await api.createSignedUrl(match.storage_path, 60);
  const download = await fetch(signedUrl);
  assert.equal(download.status, 200);
  assert.equal(
    hashBuffer(Buffer.from(await download.arrayBuffer())),
    match.file_hash,
    'downloaded bytes differ from what was uploaded',
  );

  // An unsigned public URL must not work — the bucket is private.
  const unsigned = await fetch(`${supabase.url}/storage/v1/object/public/fonts/${encodeURI(match.storage_path)}`);
  assert.equal(unsigned.ok, false);
});

test('the licensing gate is enforced server-side, not just in the UI', async () => {
  const { FontSyncApi } = await import('../src/api.js');
  const api = new FontSyncApi({ url: supabase.url, anonKey: supabase.anonKey });
  await api.signIn('designer@agency.test', 'hunter2');

  await assert.rejects(
    () => api.insertFonts([{
      family: 'Sneaky Sans',
      style: 'Regular',
      family_key: 'sneaky sans',
      style_key: 'regular',
      file_name: 'sneaky.ttf',
      file_hash: 'deadbeef',
      file_size: 10,
      format: 'ttf',
      storage_path: 'deadbeef-sneaky.ttf',
      uploader: 'designer@agency.test',
      uploader_id: supabase.users[0].id,
      license_confirmed: false,
    }]),
    /row-level security/,
  );

  // And you cannot attribute an upload to someone else.
  await assert.rejects(
    () => api.insertFonts([{
      family: 'Sneaky Sans',
      style: 'Bold',
      family_key: 'sneaky sans',
      style_key: 'bold',
      file_name: 'sneaky.ttf',
      file_hash: 'deadbeef2',
      file_size: 10,
      format: 'ttf',
      storage_path: 'deadbeef2-sneaky.ttf',
      uploader: 'teammate@agency.test',
      uploader_id: supabase.users[1].id,
      license_confirmed: true,
    }]),
    /row-level security/,
  );
});

test('an expired access token is refreshed instead of failing the upload', async () => {
  const { FontSyncApi } = await import('../src/api.js');
  const api = new FontSyncApi({ url: supabase.url, anonKey: supabase.anonKey });
  const session = await api.signIn('designer@agency.test', 'hunter2');

  const staleToken = session.access_token;
  api.session.expires_at = Math.floor(Date.now() / 1000) - 10; // already expired

  await api.findByFamilies(['acme grotesk']);
  assert.notEqual(api.session.access_token, staleToken, 'session should have been refreshed');
});
