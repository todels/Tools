#!/usr/bin/env node
// Font Watcher — background font detector + uploader.
// Zero dependencies: run it with `node bin/fontsync.js`.

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

import { loadConfig, saveConfig, loadState } from '../src/config.js';
import { FontSyncApi } from '../src/api.js';
import { SyncEngine } from '../src/engine.js';
import { startWatching } from '../src/watch.js';
import { createSettingsServer } from '../src/server.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(name);

const config = loadConfig();
const state = loadState();

if (flag('--port')) config.port = Number(flag('--port'));

const logs = [];
const log = (message) => {
  const line = `${new Date().toLocaleTimeString()}  ${message}`;
  logs.unshift(line);
  logs.length = Math.min(logs.length, 200);
  console.log(line);
};

const api = new FontSyncApi({ url: config.supabaseUrl, anonKey: config.supabaseAnonKey });
if (config.session) api.setSession(config.session);

const engine = new SyncEngine({ config, state, api, log });

async function restoreSession() {
  if (!api.session) return;
  try {
    const session = await api.ensureFreshSession();
    config.session = session;
    saveConfig(config);
    log(`signed in as ${api.user.email}`);
  } catch (err) {
    log(`saved session expired (${err.message}) — sign in again`);
    api.signOut();
    config.session = null;
    saveConfig(config);
  }
}

function openBrowser(url) {
  const opener = { darwin: 'open', win32: 'start', linux: 'xdg-open' }[platform()];
  if (!opener) return;
  try {
    spawn(opener, [url], { stdio: 'ignore', detached: true, shell: platform() === 'win32' }).unref();
  } catch {
    /* headless or no browser — the URL is printed anyway */
  }
}

async function main() {
  await restoreSession();

  if (!config.watchDirs.length) {
    log(`no font folders found for platform "${platform()}" — set watchDirs in ~/.fontsync/config.json`);
  }

  const firstRun = !state.baselineTaken;
  await engine.scan({ reason: 'startup' });
  if (firstRun) log('first run: existing fonts recorded as baseline, only new installs will sync');

  const stopWatching = startWatching({
    dirs: config.watchDirs,
    onChange: (reason) => engine.scan({ reason }),
    log,
  });

  const server = createSettingsServer({ engine, api, config, state, logs });
  server.listen(config.port, '127.0.0.1', () => {
    const url = `http://localhost:${config.port}`;
    log(`settings UI at ${url}`);
    if (!has('--no-open')) openBrowser(url);
  });
  server.on('error', (err) => {
    log(`could not start settings server: ${err.message}`);
    process.exit(1);
  });

  const shutdown = () => {
    log('shutting down');
    stopWatching();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
