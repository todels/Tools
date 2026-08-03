import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

export const CONFIG_DIR = process.env.FONTSYNC_HOME || join(homedir(), '.fontsync');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const STATE_FILE = join(CONFIG_DIR, 'state.json');

// Where each OS puts fonts. System directories (/System/Library/Fonts,
// /usr/share/fonts) are intentionally absent: those ship with the OS, everyone
// already has them, and several are not redistributable.
const FONT_DIRS = {
  darwin: () => [join(homedir(), 'Library', 'Fonts'), '/Library/Fonts'],
  win32: () => [
    join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts'),
    join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
  ],
  linux: () => [
    join(homedir(), '.local', 'share', 'fonts'),
    join(homedir(), '.fonts'),
    '/usr/local/share/fonts',
  ],
};

export function defaultFontDirs() {
  const resolver = FONT_DIRS[platform()];
  if (!resolver) return [];
  return resolver().filter((dir) => existsSync(dir));
}

const DEFAULT_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  session: null,
  projectTag: '',
  // Off by default: uploading someone else's font without confirming rights is
  // exactly the failure mode the licensing constraint is about.
  autoConfirmLicense: false,
  watchDirs: null, // null => use platform defaults
  port: 7331,
};

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return structuredClone(fallback);
    return { ...structuredClone(fallback), ...JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return structuredClone(fallback);
  }
}

// Write to a temp file then rename, so a crash mid-write can't leave a
// truncated config behind.
function writeJson(file, data) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function loadConfig() {
  const config = readJson(CONFIG_FILE, DEFAULT_CONFIG);

  // Env vars win, so a test run can point at a different project without
  // touching the saved config.
  if (process.env.SUPABASE_URL) config.supabaseUrl = process.env.SUPABASE_URL;
  if (process.env.SUPABASE_ANON_KEY) config.supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!config.watchDirs?.length) config.watchDirs = defaultFontDirs();

  return config;
}

export function saveConfig(config) {
  writeJson(CONFIG_FILE, config);
  return config;
}

const DEFAULT_STATE = {
  // Set once on first run: every font already installed at that moment is
  // baseline, not "newly installed". Without this the first launch would try
  // to upload the designer's entire existing library.
  baselineTaken: false,
  known: {},    // absolute path -> file hash
  pending: [],  // detected, awaiting the rights confirmation
  uploaded: [], // recent successful uploads (capped)
  skipped: [],  // unsupported/unparseable, kept so the UI can explain itself
};

export function loadState() {
  return readJson(STATE_FILE, DEFAULT_STATE);
}

export function saveState(state) {
  state.uploaded = state.uploaded.slice(0, 100);
  state.skipped = state.skipped.slice(0, 50);
  writeJson(STATE_FILE, state);
  return state;
}
