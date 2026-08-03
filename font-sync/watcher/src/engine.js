import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { saveConfig, saveState } from './config.js';
import {
  parseFont,
  normalizeKey,
  hashBuffer,
  storagePathFor,
  isFontFile,
  isSupportedFontFile,
} from './fontmeta.js';

const CONTENT_TYPES = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  ttc: 'font/collection',
  otc: 'font/collection',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A font file appears on disk the instant the installer opens it, well before
 * the bytes are all there. Wait until the size stops moving before hashing.
 */
async function waitForStableFile(path, { tries = 10, interval = 300 } = {}) {
  let previous = -1;
  for (let i = 0; i < tries; i++) {
    let size;
    try {
      size = (await stat(path)).size;
    } catch {
      return false; // vanished again (temp file during install)
    }
    if (size > 0 && size === previous) return true;
    previous = size;
    await sleep(interval);
  }
  return previous > 0;
}

export class SyncEngine {
  constructor({ config, state, api, log }) {
    this.config = config;
    this.state = state;
    this.api = api;
    this.log = log ?? (() => {});
    this.status = { scanning: false, uploading: 0, lastScan: null, lastError: null };
    this.queue = Promise.resolve(); // serialises scans so watch bursts collapse
  }

  // --- discovery ----------------------------------------------------------

  async listFontFiles() {
    const found = [];
    for (const dir of this.config.watchDirs) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true, recursive: true });
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'EACCES') this.log(`scan error in ${dir}: ${err.message}`);
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (basename(entry.name).startsWith('.')) continue;
        if (!isFontFile(entry.name)) continue;
        found.push(join(entry.parentPath ?? entry.path ?? dir, entry.name));
      }
    }
    return found;
  }

  /** Serialised entry point — safe to call from several watchers at once. */
  scan(options) {
    this.queue = this.queue.then(() => this.#scan(options)).catch((err) => {
      this.status.lastError = err.message;
      this.log(`scan failed: ${err.message}`);
    });
    return this.queue;
  }

  async #scan({ reason = 'manual' } = {}) {
    this.status.scanning = true;
    try {
      const files = await this.listFontFiles();

      // First ever run: everything already installed is the baseline. Only
      // fonts that show up *after* this point count as newly installed.
      if (!this.state.baselineTaken) {
        for (const file of files) this.state.known[file] = 'baseline';
        this.state.baselineTaken = true;
        saveState(this.state);
        this.log(`baseline captured: ${files.length} existing fonts ignored`);
        return;
      }

      const fresh = files.filter((file) => !this.state.known[file]);
      if (fresh.length) this.log(`${fresh.length} new font file(s) detected (${reason})`);

      for (const file of fresh) await this.#ingest(file);

      this.status.lastScan = new Date().toISOString();
      saveState(this.state);
    } finally {
      this.status.scanning = false;
    }
  }

  async #ingest(path) {
    if (!(await waitForStableFile(path))) return;

    if (!isSupportedFontFile(path)) {
      this.state.known[path] = 'unsupported';
      this.state.skipped.unshift({
        id: randomUUID(),
        path,
        fileName: basename(path),
        reason: `${extname(path) || 'unknown'} files can't be read by the MVP parser (only .ttf, .otf, .ttc, .otc)`,
        at: new Date().toISOString(),
      });
      return;
    }

    let buf;
    try {
      buf = await readFile(path);
    } catch (err) {
      this.log(`could not read ${path}: ${err.message}`);
      return;
    }

    const parsed = parseFont(buf);
    if (!parsed) {
      this.state.known[path] = 'unparseable';
      this.state.skipped.unshift({
        id: randomUUID(),
        path,
        fileName: basename(path),
        reason: 'no readable name table — file may be corrupt or an unsupported variant',
        at: new Date().toISOString(),
      });
      return;
    }

    const hash = hashBuffer(buf);
    const entry = {
      id: randomUUID(),
      path,
      fileName: basename(path),
      hash,
      size: buf.length,
      format: parsed.format,
      faces: parsed.faces,
      detectedAt: new Date().toISOString(),
    };

    this.state.known[path] = hash;

    if (this.config.autoConfirmLicense && this.api.signedIn) {
      // The designer accepted the standing rights confirmation in settings.
      await this.upload(entry, { licenseConfirmed: true, projectTag: this.config.projectTag });
    } else {
      this.state.pending.unshift(entry);
      this.log(`queued "${entry.faces[0].family}" — waiting for rights confirmation`);
    }
  }

  // --- upload -------------------------------------------------------------

  async upload(entry, { licenseConfirmed, projectTag }) {
    if (!licenseConfirmed) throw new Error('Rights confirmation is required before upload');
    if (!this.api.signedIn) throw new Error('Sign in before uploading');

    this.status.uploading += 1;
    try {
      const buf = await readFile(entry.path);
      const hash = hashBuffer(buf);
      const path = storagePathFor(entry.path, hash);

      await this.api.uploadFile(path, buf, CONTENT_TYPES[entry.format] ?? 'application/octet-stream');

      const rows = entry.faces.map((face) => ({
        family: face.family,
        style: face.style,
        family_key: normalizeKey(face.family),
        style_key: normalizeKey(face.style),
        postscript_name: face.postscriptName,
        file_name: entry.fileName,
        file_hash: hash,
        file_size: buf.length,
        format: entry.format,
        storage_path: path,
        uploader: this.api.user.email,
        uploader_id: this.api.user.id,
        project_tag: projectTag || null,
        license_confirmed: true,
      }));

      const inserted = await this.api.insertFonts(rows);

      this.state.known[entry.path] = hash;
      this.state.pending = this.state.pending.filter((p) => p.id !== entry.id);
      this.state.uploaded.unshift({
        id: entry.id,
        fileName: entry.fileName,
        faces: entry.faces,
        projectTag: projectTag || null,
        rowIds: (inserted ?? []).map((r) => r.id),
        at: new Date().toISOString(),
      });
      saveState(this.state);

      this.log(`uploaded ${entry.fileName} (${entry.faces.map((f) => `${f.family} ${f.style}`).join(', ')})`);
      return inserted;
    } catch (err) {
      this.status.lastError = err.message;
      // Leave it pending so the UI can offer a retry instead of losing it.
      if (!this.state.pending.some((p) => p.id === entry.id)) this.state.pending.unshift(entry);
      saveState(this.state);
      this.log(`upload failed for ${entry.fileName}: ${err.message}`);
      throw err;
    } finally {
      this.status.uploading -= 1;
    }
  }

  async approve(ids, { projectTag }) {
    const targets = this.state.pending.filter((p) => ids.includes(p.id));
    const results = [];
    for (const entry of targets) {
      try {
        await this.upload(entry, { licenseConfirmed: true, projectTag });
        results.push({ id: entry.id, ok: true });
      } catch (err) {
        results.push({ id: entry.id, ok: false, error: err.message });
      }
    }
    return results;
  }

  dismiss(ids) {
    // Dropped on purpose (e.g. a font the designer can't share). Keep it in
    // `known` so it is not re-queued on the next scan.
    this.state.pending = this.state.pending.filter((p) => !ids.includes(p.id));
    saveState(this.state);
  }

  async retag(rowIds, projectTag) {
    const updated = await this.api.setProjectTag(rowIds, projectTag);
    const set = new Set(rowIds);
    for (const item of this.state.uploaded) {
      if (item.rowIds?.some((id) => set.has(id))) item.projectTag = projectTag || null;
    }
    saveState(this.state);
    return updated;
  }

  updateSettings(patch) {
    Object.assign(this.config, patch);
    saveConfig(this.config);
    return this.config;
  }
}
