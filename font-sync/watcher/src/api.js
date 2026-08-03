// Thin Supabase REST client built on global fetch. Deliberately dependency-free
// so the watcher can be run with plain `node` — no install step, no build.

const BUCKET = 'fonts';

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describe(body, fallback) {
  if (!body) return fallback;
  if (typeof body === 'string') return body;
  return body.error_description || body.msg || body.message || body.error || fallback;
}

export class FontSyncApi {
  constructor({ url, anonKey }) {
    this.url = url.replace(/\/+$/, '');
    this.anonKey = anonKey;
    this.session = null; // { access_token, refresh_token, expires_at, user }
  }

  get user() {
    return this.session?.user ?? null;
  }

  get signedIn() {
    return Boolean(this.session?.access_token);
  }

  async request(path, { method = 'GET', headers = {}, body, auth = true, raw = false } = {}) {
    if (auth && this.session) await this.ensureFreshSession();

    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${auth && this.session ? this.session.access_token : this.anonKey}`,
        ...headers,
      },
      body,
    });

    if (!res.ok) {
      const errBody = await readBody(res);
      throw new ApiError(describe(errBody, `${method} ${path} failed (${res.status})`), res.status, errBody);
    }
    return raw ? res : readBody(res);
  }

  // --- auth ---------------------------------------------------------------

  setSession(session) {
    this.session = session ?? null;
  }

  #storeSession(data) {
    this.session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      // expires_at is seconds-since-epoch; fall back to expires_in when absent.
      expires_at: data.expires_at ?? Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
      user: { id: data.user?.id, email: data.user?.email },
    };
    return this.session;
  }

  async signIn(email, password) {
    const data = await this.request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      auth: false,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    return this.#storeSession(data);
  }

  async refresh() {
    if (!this.session?.refresh_token) throw new ApiError('No refresh token available', 401);
    const data = await this.request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      auth: false,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.session.refresh_token }),
    });
    return this.#storeSession(data);
  }

  // Refresh a minute before expiry so long-running uploads don't die mid-flight.
  async ensureFreshSession() {
    if (!this.session) return null;
    if (this.session.expires_at - 60 > Math.floor(Date.now() / 1000)) return this.session;
    return this.refresh();
  }

  signOut() {
    this.session = null;
  }

  // --- metadata -----------------------------------------------------------

  async insertFonts(rows) {
    return this.request('/rest/v1/fonts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Identical file re-detected (reinstall, second machine) -> no-op
        // instead of a unique-violation.
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(rows),
    });
  }

  async listMine(limit = 50) {
    const uid = this.user?.id;
    if (!uid) return [];
    return this.request(
      `/rest/v1/fonts?uploader_id=eq.${uid}&select=*&order=created_at.desc&limit=${limit}`,
    );
  }

  async setProjectTag(ids, projectTag) {
    if (!ids.length) return [];
    const list = ids.map((id) => `"${id}"`).join(',');
    return this.request(`/rest/v1/fonts?id=in.(${list})`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ project_tag: projectTag || null }),
    });
  }

  // Look up a batch of families in one round trip. Style matching happens
  // client-side so we can fall back to "same family, different style".
  async findByFamilies(familyKeys) {
    if (!familyKeys.length) return [];
    // Family keys contain spaces, so the value has to be percent-encoded;
    // the parentheses are PostgREST syntax and stay literal.
    const list = encodeURIComponent(familyKeys.map((k) => `"${k.replace(/"/g, '')}"`).join(','));
    return this.request(
      `/rest/v1/fonts?family_key=in.(${list})&select=*&order=created_at.desc`,
    );
  }

  // --- storage ------------------------------------------------------------

  async uploadFile(storagePath, buffer, contentType = 'application/octet-stream') {
    return this.request(`/storage/v1/object/${BUCKET}/${encodeURI(storagePath)}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'x-upsert': 'true' },
      body: buffer,
    });
  }

  async createSignedUrl(storagePath, expiresIn = 3600) {
    const data = await this.request(`/storage/v1/object/sign/${BUCKET}/${encodeURI(storagePath)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn }),
    });
    return `${this.url}/storage/v1${data.signedURL || data.signedUrl}`;
  }

  async removeFile(storagePath) {
    return this.request(`/storage/v1/object/${BUCKET}/${encodeURI(storagePath)}`, { method: 'DELETE' });
  }
}
