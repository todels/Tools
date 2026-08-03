// Minimal OpenType/TrueType `name` table reader.
//
// We only need family + style + PostScript name, which live in the `name`
// table of every sfnt font. Parsing those few hundred bytes ourselves avoids
// pulling in fontkit/opentype.js and keeps the watcher install-free.
//
// Supported containers: .ttf, .otf (sfnt) and .ttc, .otc (collections).
// Not supported: .dfont (Mac resource fork), .woff/.woff2 (compressed) —
// callers get null and should surface a "skipped, unsupported format" note.

import { createHash } from 'node:crypto';
import { extname, basename } from 'node:path';

export const SUPPORTED_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc']);
export const KNOWN_FONT_EXTENSIONS = new Set([
  '.ttf', '.otf', '.ttc', '.otc', '.dfont', '.woff', '.woff2', '.pfb', '.suit',
]);

const NAME_FAMILY = 1;
const NAME_SUBFAMILY = 2;
const NAME_POSTSCRIPT = 6;
const NAME_TYPO_FAMILY = 16;
const NAME_TYPO_SUBFAMILY = 17;

const u16 = (b, o) => b.readUInt16BE(o);
const u32 = (b, o) => b.readUInt32BE(o);

// Figma reports the typographic family/style pair when a font declares one
// (e.g. "Inter" + "SemiBold" rather than "Inter SemiBold" + "Regular"), so we
// prefer name IDs 16/17 and fall back to 1/2.
function decodeName(buf, start, len, platformID) {
  if (start + len > buf.length) return null;
  const slice = buf.subarray(start, start + len);
  // Platform 3 (Windows) and 0 (Unicode) store UTF-16BE.
  if (platformID === 3 || platformID === 0) {
    if (len % 2 !== 0) return null;
    const copy = Buffer.from(slice);
    copy.swap16();
    return copy.toString('utf16le');
  }
  // Platform 1 (Macintosh) — MacRoman. Latin1 is close enough for the ASCII
  // range that font names live in.
  return slice.toString('latin1');
}

// Higher is better. English-Windows records win, then any Unicode record.
function recordScore(platformID, languageID) {
  if (platformID === 3 && languageID === 0x409) return 100;
  if (platformID === 3) return 80;
  if (platformID === 0) return 60;
  if (platformID === 1 && languageID === 0) return 40;
  return 10;
}

function parseNameTable(buf, tableOffset) {
  if (tableOffset + 6 > buf.length) return null;
  const count = u16(buf, tableOffset + 2);
  const stringOffset = u16(buf, tableOffset + 4);
  const stringBase = tableOffset + stringOffset;

  const best = new Map(); // nameID -> { score, value }
  for (let i = 0; i < count; i++) {
    const rec = tableOffset + 6 + i * 12;
    if (rec + 12 > buf.length) break;

    const platformID = u16(buf, rec);
    const languageID = u16(buf, rec + 4);
    const nameID = u16(buf, rec + 6);
    const length = u16(buf, rec + 8);
    const offset = u16(buf, rec + 10);

    if (![NAME_FAMILY, NAME_SUBFAMILY, NAME_POSTSCRIPT, NAME_TYPO_FAMILY, NAME_TYPO_SUBFAMILY].includes(nameID)) {
      continue;
    }

    const score = recordScore(platformID, languageID);
    const existing = best.get(nameID);
    if (existing && existing.score >= score) continue;

    const value = decodeName(buf, stringBase + offset, length, platformID);
    if (value) best.set(nameID, { score, value: value.replace(/\0/g, '').trim() });
  }

  const pick = (id) => best.get(id)?.value || null;
  const family = pick(NAME_TYPO_FAMILY) || pick(NAME_FAMILY);
  if (!family) return null;

  return {
    family,
    style: pick(NAME_TYPO_SUBFAMILY) || pick(NAME_SUBFAMILY) || 'Regular',
    postscriptName: pick(NAME_POSTSCRIPT),
  };
}

function parseSfnt(buf, base) {
  if (base + 12 > buf.length) return null;
  const numTables = u16(buf, base + 4);
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (rec + 16 > buf.length) return null;
    if (buf.toString('latin1', rec, rec + 4) === 'name') {
      return parseNameTable(buf, u32(buf, rec + 8));
    }
  }
  return null;
}

/**
 * @returns {{format: string, faces: Array<{family,style,postscriptName}>}|null}
 */
export function parseFont(buf) {
  if (!buf || buf.length < 12) return null;

  const tag = u32(buf, 0);

  if (tag === 0x74746366) {
    // 'ttcf' — a collection holds several faces in one file. Each becomes its
    // own row so a 4-style .ttc satisfies four different missing-font lookups.
    const numFonts = u32(buf, 8);
    const faces = [];
    for (let i = 0; i < numFonts && i < 64; i++) {
      const recOffset = 12 + i * 4;
      if (recOffset + 4 > buf.length) break;
      const face = parseSfnt(buf, u32(buf, recOffset));
      if (face) faces.push(face);
    }
    return faces.length ? { format: 'ttc', faces } : null;
  }

  // 0x00010000 = TrueType outlines, 'OTTO' = CFF outlines, 'true' = legacy Mac.
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null;

  const face = parseSfnt(buf, 0);
  if (!face) return null;
  return { format: tag === 0x4f54544f ? 'otf' : 'ttf', faces: [face] };
}

/** Normalised key used for all font matching. */
export function normalizeKey(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function hashBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** `fonts/<hash-prefix>-<safe-name>` — identical bytes always land on one path. */
export function storagePathFor(filePath, hash) {
  const safe = basename(filePath).replace(/[^A-Za-z0-9._-]/g, '_');
  return `${hash.slice(0, 12)}-${safe}`;
}

export function isFontFile(filePath) {
  return KNOWN_FONT_EXTENSIONS.has(extname(filePath).toLowerCase());
}

export function isSupportedFontFile(filePath) {
  return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}
