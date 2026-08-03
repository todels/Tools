#!/usr/bin/env node
// End-to-end check of the backend: sign in -> upload -> insert -> query ->
// signed URL -> download -> clean up. Run this before touching the watcher or
// the plugin, so a later failure is never ambiguous about which layer broke.
//
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_ANON_KEY=eyJ... \
//   FONTSYNC_EMAIL=you@agency.com \
//   FONTSYNC_PASSWORD=... \
//   node backend/test-backend.mjs

import { FontSyncApi } from '../watcher/src/api.js';
import { parseFont, normalizeKey, hashBuffer, storagePathFor } from '../watcher/src/fontmeta.js';
import { makeFakeFont } from '../tools/fake-font.mjs';

const { SUPABASE_URL, SUPABASE_ANON_KEY, FONTSYNC_EMAIL, FONTSYNC_PASSWORD } = process.env;

const missing = Object.entries({ SUPABASE_URL, SUPABASE_ANON_KEY, FONTSYNC_EMAIL, FONTSYNC_PASSWORD })
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length) {
  console.error(`Missing env var(s): ${missing.join(', ')}`);
  process.exit(1);
}

const steps = [];
const step = async (label, fn) => {
  process.stdout.write(`• ${label} ... `);
  try {
    const result = await fn();
    console.log('ok');
    steps.push({ label, ok: true });
    return result;
  } catch (err) {
    console.log('FAILED');
    console.error(`  ${err.message}`);
    if (err.body) console.error(`  ${JSON.stringify(err.body)}`);
    steps.push({ label, ok: false });
    throw err;
  }
};

const api = new FontSyncApi({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });

// A family name unique to this run, so repeated runs never collide.
const family = `FontSync Test ${Date.now()}`;
const fileBuf = makeFakeFont(family, 'Bold');
const fileName = `${family.replace(/\s+/g, '')}-Bold.ttf`;
const hash = hashBuffer(fileBuf);
const path = storagePathFor(fileName, hash);

let inserted;

try {
  await step('sign in', () => api.signIn(FONTSYNC_EMAIL, FONTSYNC_PASSWORD));
  console.log(`  signed in as ${api.user.email}`);

  const parsed = await step('parse the generated font', async () => {
    const result = parseFont(fileBuf);
    if (!result) throw new Error('parser returned null');
    if (result.faces[0].family !== family) throw new Error('family mismatch');
    return result;
  });

  await step('upload the file to the fonts bucket', () => api.uploadFile(path, fileBuf, 'font/ttf'));

  inserted = await step('insert the metadata row', async () => {
    const rows = await api.insertFonts([{
      family: parsed.faces[0].family,
      style: parsed.faces[0].style,
      family_key: normalizeKey(parsed.faces[0].family),
      style_key: normalizeKey(parsed.faces[0].style),
      postscript_name: parsed.faces[0].postscriptName,
      file_name: fileName,
      file_hash: hash,
      file_size: fileBuf.length,
      format: parsed.format,
      storage_path: path,
      uploader: api.user.email,
      uploader_id: api.user.id,
      project_tag: 'backend-selftest',
      license_confirmed: true,
    }]);
    if (!rows?.length) throw new Error('no row returned');
    return rows[0];
  });

  await step('licensing gate rejects an unconfirmed row', async () => {
    try {
      await api.insertFonts([{
        family: `${family} Unconfirmed`,
        style: 'Regular',
        family_key: normalizeKey(`${family} Unconfirmed`),
        style_key: 'regular',
        file_name: fileName,
        file_hash: `${hash}x`,
        file_size: fileBuf.length,
        format: 'ttf',
        storage_path: path,
        uploader: api.user.email,
        uploader_id: api.user.id,
        license_confirmed: false,
      }]);
    } catch (err) {
      if (err.status === 403 || /row-level security/i.test(err.message)) return; // expected
      throw err;
    }
    throw new Error('an unconfirmed row was accepted — check the RLS insert policy');
  });

  await step('look the font up the way the plugin will', async () => {
    const found = await api.findByFamilies([normalizeKey(family)]);
    const match = found.find((f) => f.style_key === 'bold');
    if (!match) throw new Error('font not found by family_key');
    if (match.uploader !== api.user.email) throw new Error('uploader not recorded');
  });

  const signedUrl = await step('mint a signed download URL', () => api.createSignedUrl(path, 60));

  await step('download through the signed URL', async () => {
    const res = await fetch(signedUrl);
    if (!res.ok) throw new Error(`download returned ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (hashBuffer(bytes) !== hash) throw new Error('downloaded bytes do not match what was uploaded');
  });

  await step('bucket is private (unsigned URL is refused)', async () => {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/public/fonts/${encodeURI(path)}`);
    if (res.ok) throw new Error('the fonts bucket is public — font files are exposed to anyone with the URL');
  });
} finally {
  if (inserted) {
    await step('clean up test row and file', async () => {
      await api.request(`/rest/v1/fonts?id=eq.${inserted.id}`, { method: 'DELETE' });
      await api.removeFile(path).catch(() => {});
    }).catch(() => {});
  }

  const failed = steps.filter((s) => !s.ok).length;
  console.log(`\n${steps.length - failed}/${steps.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
