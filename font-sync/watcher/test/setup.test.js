// setup.sh is the path most people will actually take, so it gets the same
// treatment as the rest: run the real script against a fake Supabase and check
// it leaves the machine in a working state.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFakeSupabase } from './fake-supabase.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(HERE, '..', '..', 'setup.sh');

let supabase;
let home;

before(async () => {
  supabase = await startFakeSupabase();
  home = await mkdtemp(join(tmpdir(), 'fontsync-setup-'));
});

after(async () => {
  await supabase?.close();
  await rm(home, { recursive: true, force: true });
});

const env = (overrides = {}) => ({
  ...process.env,
  FONTSYNC_HOME: home,
  FONTSYNC_URL: supabase.url,
  FONTSYNC_KEY: supabase.anonKey,
  FONTSYNC_EMAIL: 'designer@agency.test',
  FONTSYNC_PASSWORD: 'hunter2',
  ...overrides,
});

test('setup.sh configures the machine and leaves the watcher signed in', async () => {
  const { stdout } = await run('bash', [SETUP, '--no-start', '--skip-schema'], { env: env() });

  assert.match(stdout, /10\/10 checks passed/, 'the backend self-test should run as part of setup');
  assert.match(stdout, /Signed in as designer@agency\.test/);
  assert.match(stdout, /manifest\.json/, 'should point at the Figma plugin manifest');

  const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
  assert.equal(config.supabaseUrl, supabase.url);
  assert.equal(config.supabaseAnonKey, supabase.anonKey);
  assert.equal(config.session.user.email, 'designer@agency.test');
  assert.ok(config.session.access_token, 'a usable session should be stored');

  // Defaults that matter: standing licence consent must not be switched on by
  // a setup script.
  assert.equal(config.autoConfirmLicense, false);
});

test('setup.sh stops at the backend test rather than half-configuring', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'fontsync-setup-bad-'));
  try {
    await assert.rejects(
      () => run('bash', [SETUP, '--no-start', '--skip-schema'], {
        env: env({ FONTSYNC_HOME: scratch, FONTSYNC_PASSWORD: 'wrong-password' }),
      }),
      (err) => {
        assert.match(err.stdout + err.stderr, /Backend test failed/);
        return true;
      },
    );

    // No session written for a login that never succeeded.
    const config = JSON.parse(await readFile(join(scratch, 'config.json'), 'utf8').catch(() => '{}'));
    assert.ok(!config.session, 'a failed setup must not leave a session behind');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
