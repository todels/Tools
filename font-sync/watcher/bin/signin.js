#!/usr/bin/env node
// Signs in and stores the session in ~/.fontsync/config.json, so the watcher
// starts already authenticated instead of asking again in the settings UI.
//
//   node bin/signin.js you@agency.com yourpassword
//   node bin/signin.js you@agency.com            (prompts for the password)

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { loadConfig, saveConfig } from '../src/config.js';
import { FontSyncApi } from '../src/api.js';

const config = loadConfig();

if (!config.supabaseUrl || !config.supabaseAnonKey) {
  console.error('No Supabase URL/key configured yet. Run setup.sh, or start the watcher and enter them in the settings UI.');
  process.exit(1);
}

let [email, password] = process.argv.slice(2);

if (!email || !password) {
  const rl = createInterface({ input: stdin, output: stdout });
  if (!email) email = await rl.question('Email: ');
  if (!password) password = await rl.question('Password: ');
  rl.close();
}

const api = new FontSyncApi({ url: config.supabaseUrl, anonKey: config.supabaseAnonKey });

try {
  const session = await api.signIn(email.trim(), password);
  config.session = session;
  saveConfig(config);
  console.log(`Signed in as ${session.user.email}`);
} catch (err) {
  console.error(`Sign-in failed: ${err.message}`);
  process.exit(1);
}
