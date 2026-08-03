import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { saveConfig } from './config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_FILE = join(HERE, 'ui.html');

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// The server holds a live Supabase session, so treat it like any other local
// privileged endpoint: loopback only, and reject cross-origin browsers.
function isLocalRequest(req) {
  const host = (req.headers.host || '').split(':')[0];
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return false;

  const origin = req.headers.origin;
  if (origin) {
    try {
      const originHost = new URL(origin).hostname;
      if (!['localhost', '127.0.0.1', '::1'].includes(originHost)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function createSettingsServer({ engine, api, config, state, logs }) {
  const routes = {
    'GET /api/state': async () => ({
      signedIn: api.signedIn,
      email: api.user?.email ?? null,
      supabaseUrl: config.supabaseUrl,
      configured: Boolean(config.supabaseUrl && config.supabaseAnonKey),
      projectTag: config.projectTag,
      autoConfirmLicense: config.autoConfirmLicense,
      watchDirs: config.watchDirs,
      status: engine.status,
      pending: state.pending,
      uploaded: state.uploaded.slice(0, 25),
      skipped: state.skipped.slice(0, 10),
      logs: logs.slice(0, 40),
    }),

    'POST /api/signin': async (body) => {
      if (!config.supabaseUrl || !config.supabaseAnonKey) {
        throw new Error('Supabase URL and anon key are not configured yet');
      }
      const session = await api.signIn(body.email, body.password);
      config.session = session;
      saveConfig(config);
      // Anything queued before sign-in can go now if standing consent is on.
      if (config.autoConfirmLicense && state.pending.length) {
        engine.approve(state.pending.map((p) => p.id), { projectTag: config.projectTag });
      }
      return { email: session.user.email };
    },

    'POST /api/signout': async () => {
      api.signOut();
      config.session = null;
      saveConfig(config);
      return { ok: true };
    },

    'POST /api/settings': async (body) => {
      const patch = {};
      if ('projectTag' in body) patch.projectTag = String(body.projectTag || '').trim();
      if ('autoConfirmLicense' in body) patch.autoConfirmLicense = Boolean(body.autoConfirmLicense);
      if ('supabaseUrl' in body) patch.supabaseUrl = String(body.supabaseUrl || '').trim().replace(/\/+$/, '');
      if ('supabaseAnonKey' in body) patch.supabaseAnonKey = String(body.supabaseAnonKey || '').trim();

      engine.updateSettings(patch);
      if (patch.supabaseUrl) api.url = patch.supabaseUrl;
      if (patch.supabaseAnonKey) api.anonKey = patch.supabaseAnonKey;
      return { ok: true };
    },

    'POST /api/approve': async (body) => {
      if (!body.licenseConfirmed) throw new Error('You must confirm you have the rights to share these fonts');
      const results = await engine.approve(body.ids ?? [], { projectTag: body.projectTag ?? config.projectTag });
      return { results };
    },

    'POST /api/dismiss': async (body) => {
      engine.dismiss(body.ids ?? []);
      return { ok: true };
    },

    'POST /api/retag': async (body) => {
      const updated = await engine.retag(body.rowIds ?? [], body.projectTag ?? '');
      return { updated: updated.length };
    },

    'POST /api/rescan': async () => {
      await engine.scan({ reason: 'manual rescan' });
      return { ok: true };
    },
  };

  const server = createServer(async (req, res) => {
    if (!isLocalRequest(req)) {
      json(res, 403, { error: 'Font Watcher only accepts local requests' });
      return;
    }

    const path = new URL(req.url, 'http://localhost').pathname;

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      try {
        const html = await readFile(UI_FILE);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
      } catch (err) {
        json(res, 500, { error: err.message });
      }
      return;
    }

    const handler = routes[`${req.method} ${path}`];
    if (!handler) {
      json(res, 404, { error: 'Not found' });
      return;
    }

    try {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      json(res, 200, await handler(body));
    } catch (err) {
      json(res, err.status === 400 || err.status === 401 ? err.status : 500, { error: err.message });
    }
  });

  return server;
}
