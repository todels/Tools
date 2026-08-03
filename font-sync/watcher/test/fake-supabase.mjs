// A stand-in for the Supabase endpoints this project uses: auth, PostgREST and
// storage. It exists so the upload path can be tested end to end without a
// real project or credentials.
//
// It is deliberately strict about the rules that matter, so a test passing here
// means something:
//   - inserts require a valid access token
//   - uploader_id must match the token's user (the RLS self-attribution rule)
//   - license_confirmed must be true (the licensing gate)
//   - (family_key, style_key, file_hash) is unique, like the real index
//   - the bucket is private: unsigned object URLs are refused

import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';

const ANON_KEY = 'test-anon-key';
const USERS = [
  { id: '11111111-1111-4111-8111-111111111111', email: 'designer@agency.test', password: 'hunter2' },
  { id: '22222222-2222-4222-8222-222222222222', email: 'teammate@agency.test', password: 'hunter2' },
];

export async function startFakeSupabase({ port = 0 } = {}) {
  const db = { fonts: [], objects: new Map(), tokens: new Map(), signed: new Map() };

  const json = (res, status, body) => {
    const payload = body === null ? '' : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  };

  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
  };

  const userFor = (req) => {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token || token === ANON_KEY) return null;
    return db.tokens.get(token) ?? null;
  };

  const issueSession = (user) => {
    const access = `access-${randomUUID()}`;
    const refresh = `refresh-${randomUUID()}`;
    db.tokens.set(access, user);
    db.tokens.set(refresh, user);
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: 3600,
      user: { id: user.id, email: user.email },
    };
  };

  // `family_key=in.("a","b")` -> ['a','b'];  `id=eq.x` -> 'x'
  const parseFilter = (raw) => {
    if (raw.startsWith('eq.')) return { op: 'eq', values: [raw.slice(3)] };
    if (raw.startsWith('in.')) {
      const inner = raw.slice(3).replace(/^\(|\)$/g, '');
      return { op: 'in', values: inner.split(',').map((v) => v.trim().replace(/^"|"$/g, '')) };
    }
    return { op: 'eq', values: [raw] };
  };

  const applyFilters = (rows, params) => {
    let out = rows;
    for (const [key, raw] of params) {
      if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
      const { values } = parseFilter(raw);
      out = out.filter((row) => values.includes(String(row[key])));
    }
    return out;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // --- auth --------------------------------------------------------------
    if (path === '/auth/v1/token') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const grant = url.searchParams.get('grant_type');

      if (grant === 'password') {
        const user = USERS.find((u) => u.email === body.email && u.password === body.password);
        if (!user) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        return json(res, 200, issueSession(user));
      }
      if (grant === 'refresh_token') {
        const user = db.tokens.get(body.refresh_token);
        if (!user) return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid refresh token' });
        return json(res, 200, issueSession(user));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    // --- PostgREST ---------------------------------------------------------
    if (path === '/rest/v1/fonts') {
      const user = userFor(req);

      if (req.method === 'GET') {
        if (!user) return json(res, 401, { message: 'JWT required' });
        let rows = applyFilters(db.fonts, url.searchParams);
        if ((url.searchParams.get('order') || '').startsWith('created_at.desc')) {
          rows = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
        }
        const limit = Number(url.searchParams.get('limit') || 0);
        return json(res, 200, limit ? rows.slice(0, limit) : rows);
      }

      if (req.method === 'POST') {
        if (!user) return json(res, 401, { message: 'JWT required' });
        const rows = JSON.parse((await readBody(req)).toString() || '[]');
        const inserted = [];

        for (const row of rows) {
          // Mirrors the RLS insert policy: self-attributed and rights-confirmed.
          if (row.uploader_id !== user.id) {
            return json(res, 403, { message: 'new row violates row-level security policy for table "fonts"' });
          }
          if (row.license_confirmed !== true) {
            return json(res, 403, { message: 'new row violates row-level security policy for table "fonts"' });
          }

          const existing = db.fonts.find(
            (f) => f.family_key === row.family_key && f.style_key === row.style_key && f.file_hash === row.file_hash,
          );
          if (existing) {
            // Prefer: resolution=merge-duplicates
            Object.assign(existing, row);
            inserted.push(existing);
            continue;
          }

          const created = { id: randomUUID(), created_at: new Date().toISOString(), ...row };
          db.fonts.push(created);
          inserted.push(created);
        }
        return json(res, 201, inserted);
      }

      if (req.method === 'PATCH') {
        if (!user) return json(res, 401, { message: 'JWT required' });
        const patch = JSON.parse((await readBody(req)).toString() || '{}');
        const targets = applyFilters(db.fonts, url.searchParams)
          .filter((row) => row.uploader_id === user.id); // update-own policy
        for (const row of targets) Object.assign(row, patch);
        return json(res, 200, targets);
      }

      if (req.method === 'DELETE') {
        if (!user) return json(res, 401, { message: 'JWT required' });
        const targets = new Set(applyFilters(db.fonts, url.searchParams).filter((r) => r.uploader_id === user.id));
        db.fonts = db.fonts.filter((row) => !targets.has(row));
        return json(res, 204, null);
      }
    }

    // --- storage -----------------------------------------------------------
    if (path.startsWith('/storage/v1/object/public/fonts/')) {
      return json(res, 400, { message: 'Bucket not found or not public' });
    }

    if (path.startsWith('/storage/v1/object/sign/fonts/')) {
      const key = decodeURIComponent(path.replace('/storage/v1/object/sign/fonts/', ''));

      if (req.method === 'POST') {
        if (!userFor(req)) return json(res, 401, { message: 'JWT required' });
        if (!db.objects.has(key)) return json(res, 404, { message: 'Object not found' });
        const token = randomUUID();
        db.signed.set(token, key);
        return json(res, 200, { signedURL: `/object/sign/fonts/${encodeURI(key)}?token=${token}` });
      }

      if (req.method === 'GET') {
        const token = url.searchParams.get('token');
        if (!token || db.signed.get(token) !== key) return json(res, 401, { message: 'Invalid signature' });
        const buf = db.objects.get(key);
        const filename = url.searchParams.get('download');
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          ...(filename ? { 'Content-Disposition': `attachment; filename="${filename}"` } : {}),
        });
        return res.end(buf);
      }
    }

    if (path.startsWith('/storage/v1/object/fonts/')) {
      const key = decodeURIComponent(path.replace('/storage/v1/object/fonts/', ''));

      if (req.method === 'POST') {
        if (!userFor(req)) return json(res, 401, { message: 'JWT required' });
        db.objects.set(key, await readBody(req));
        return json(res, 200, { Key: `fonts/${key}` });
      }
      if (req.method === 'DELETE') {
        if (!userFor(req)) return json(res, 401, { message: 'JWT required' });
        db.objects.delete(key);
        return json(res, 200, { message: 'Successfully deleted' });
      }
      if (req.method === 'GET') {
        // Private bucket: the object endpoint needs a session, unlike /public/.
        if (!userFor(req)) return json(res, 401, { message: 'JWT required' });
        const buf = db.objects.get(key);
        if (!buf) return json(res, 404, { message: 'Object not found' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(buf);
      }
    }

    return json(res, 404, { message: `no fake route for ${req.method} ${path}` });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    anonKey: ANON_KEY,
    users: USERS,
    db,
    hashOf: (key) => createHash('sha256').update(db.objects.get(key)).digest('hex'),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
