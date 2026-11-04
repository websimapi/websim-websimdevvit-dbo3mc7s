// itch.io runtime for ported Websim games (added by itch-porter, loaded before the game).
// itch.io only hosts static files and gives HTML5 games no user identity, so this stands in
// for what Websim provides:
// - a local player: a random id kept in localStorage (no username);
// - the game's server.js, run in the page: same-origin /api/* requests go to its fetch()
//   with env.DB as SQLite (sql.js) saved to IndexedDB, env.BLOB in IndexedDB, and
//   env.PLATFORM = 'itch'; its own requests to other sites (e.g. Supabase) go out as usual;
// - window.websim and WebsimSocket collections kept on this device, multiplayer off.
(() => {
  const CONFIG = window.__ITCH_PORT || {};
  // The game's folder (index.html's), where server.js and __itch/ live.
  const BASE = new URL('./', document.baseURI);

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16)));
  const playerId = store.get('itch-port:player') || uuid();
  store.set('itch-port:player', playerId);
  const user = { id: playerId, username: '', avatar_url: null, is_anonymous: false };

  // --- IndexedDB key/value (the database file and stored blobs) ---
  const idb = (() => {
    let dbp;
    const open = () => (dbp ||= new Promise((ok, fail) => {
      const r = indexedDB.open('itch-port:' + (CONFIG.game || 'game'), 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    }));
    const tx = async (mode, fn) => { const db = await open(); return new Promise((ok, fail) => { const t = db.transaction('kv', mode); const req = fn(t.objectStore('kv')); t.oncomplete = () => ok(req?.result); t.onerror = () => fail(t.error); }); };
    return {
      get: (k) => tx('readonly', (s) => s.get(k)).catch(() => undefined),
      set: (k, v) => tx('readwrite', (s) => s.put(v, k)).catch((e) => console.warn('[itch] could not save', k, e)),
    };
  })();

  // --- the game's server.js, run here ---
  const loadScript = (src) => new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error('could not load ' + src)); document.head.appendChild(s); });

  // env.DB: the D1-style API Websim gives server.js, over sql.js (same as the Devvit bridge).
  function makeDb(db, state) {
    const toParam = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
    const isRead = (sql) => /^\s*(select|with|pragma|explain)\b/i.test(sql);
    function prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) { params = args.map(toParam); return stmt; },
        async all() {
          const s = db.prepare(sql);
          try {
            s.bind(params);
            const results = [];
            while (s.step()) results.push(s.getAsObject());
            if (!isRead(sql)) state.dirty = true;
            return { results, success: true, meta: { changes: db.getRowsModified() } };
          } finally { s.free(); }
        },
        async first(column) { const { results } = await stmt.all(); const row = results[0] ?? null; return column && row ? row[column] : row; },
        async run() {
          db.run(sql, params);
          const changes = db.getRowsModified();
          if (!isRead(sql)) state.dirty = true;
          const idRow = db.exec('SELECT last_insert_rowid() AS id')[0];
          return { success: true, changes, meta: { changes, last_row_id: idRow ? idRow.values[0][0] : null } };
        },
        async raw() { const { results } = await stmt.all(); return results.map((r) => Object.values(r)); },
      };
      return stmt;
    }
    return {
      prepare,
      async batch(statements) { const out = []; for (const s of statements) out.push(await s.run()); return out; },
      async exec(sql) { db.exec(sql); if (!isRead(sql)) state.dirty = true; return { count: 1 }; },
    };
  }

  const BLOB_PATH = '/api/__itch_blob/';
  let server;
  const getServer = () => (server ||= (async () => {
    await loadScript(new URL('__itch/sql-wasm.js', BASE).href);
    const SQL = await window.initSqlJs({ locateFile: (f) => new URL('__itch/' + f, BASE).href });
    const saved = await idb.get('db');
    const db = new SQL.Database(saved ? new Uint8Array(saved) : undefined);
    const state = { dirty: false };
    const mod = await import(new URL(CONFIG.server || 'server.js', BASE).href);
    // Websim applies server.js's schema when it changes; so does this.
    const schema = typeof mod.schema === 'string' ? mod.schema : '';
    if (schema && (await idb.get('schema')) !== schema) { db.exec(schema); state.dirty = true; await idb.set('schema', schema); }
    let timer = null;
    const save = () => { if (!state.dirty) return; clearTimeout(timer); timer = setTimeout(() => { state.dirty = false; idb.set('db', db.export()); }, 400); };
    addEventListener('pagehide', () => { if (state.dirty) { state.dirty = false; idb.set('db', db.export()); } });
    const env = {
      DB: makeDb(db, state),
      BLOB: { async put(name, bytes) { const id = uuid() + '-' + String(name).replace(/[^\w.-]/g, '_'); await idb.set('blob:' + id, bytes instanceof Uint8Array ? bytes : new Uint8Array(await new Response(bytes).arrayBuffer())); return { id, url: BLOB_PATH + id }; } },
      AI: { chat() { throw new Error('AI is not available in the itch.io version.'); } },
      NOTIFICATIONS: { async send() {} },
      SECRETS: {},
      PLATFORM: 'itch',
    };
    return { handler: mod.default, env, save };
  })());

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const at = url.origin === location.origin ? url.pathname.indexOf('/api/') : -1;
    if (at < 0 || !CONFIG.server) return realFetch(input, init);
    const path = url.pathname.slice(at);
    if (path.startsWith(BLOB_PATH)) {
      const bytes = await idb.get('blob:' + decodeURIComponent(path.slice(BLOB_PATH.length)));
      return bytes ? new Response(bytes, { headers: { 'content-type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream' } }) : new Response('not found', { status: 404 });
    }
    const s = await getServer();
    const headers = new Headers(req.headers);
    headers.set('x-websim-user-id', user.id);
    headers.set('x-websim-username', user.username);
    headers.set('x-websim-user-is-anonymous', 'false');
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const res = await s.handler.fetch(new Request('https://game.local' + path + url.search, { method: req.method, headers, body: hasBody ? await req.arrayBuffer() : undefined }), s.env);
    s.save();
    return res;
  };

  // --- window.websim, for games that use it in the page ---
  const ws = (window.websim ||= {});
  ws.getCurrentUser ||= async () => user;
  ws.getUser ||= async () => user;
  ws.getCurrentProject ||= async () => ({ id: CONFIG.game || 'itch', title: document.title });
  ws.getCreatedBy ||= async () => null;
  ws.upload ||= async (file) => URL.createObjectURL(file);
  // chat, imageGen, textToSpeech and postComment stay undefined, so games that check for
  // them hide those features (AI needs a server key; itch.io has no comments API).

  // --- WebsimSocket: collections saved on this device; no other players ---
  if (!window.WebsimSocket) {
    const listeners = new Set();
    const key = (type) => 'itch-port:collection:' + type;
    const read = (type) => { try { return JSON.parse(store.get(key(type)) || '[]'); } catch { return []; } };
    const write = (type, rows) => { store.set(key(type), JSON.stringify(rows)); for (const l of listeners) l(type); };
    const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
    function collection(type, where = {}) {
      const list = () => read(type).filter((r) => matches(r, where)).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return {
        getList: list,
        filter: (more) => collection(type, { ...where, ...more }),
        async create(data) { const row = { ...data, id: uuid(), created_at: new Date().toISOString(), user_id: user.id, username: user.username || 'player' }; write(type, [...read(type), row]); return row; },
        async update(id, data) { let out = null; write(type, read(type).map((r) => (r.id === id ? (out = { ...r, ...data }) : r))); return out; },
        async upsert(data) { return data.id && read(type).some((r) => r.id === data.id) ? this.update(data.id, data) : this.create(data); },
        async delete(id) { write(type, read(type).filter((r) => r.id !== id)); },
        subscribe(cb) { const l = (t) => t === type && cb(list()); listeners.add(l); queueMicrotask(() => cb(list())); return () => listeners.delete(l); },
      };
    }
    window.WebsimSocket = class {
      constructor() { this.clientId = user.id; this.peers = { [user.id]: { username: user.username || 'player', avatarUrl: null } }; this.presence = {}; this.roomState = {}; }
      async initialize() {}
      collection(type) { return collection(type); }
      updatePresence(p) { this.presence[user.id] = { ...(this.presence[user.id] || {}), ...p }; }
      updateRoomState(s) { Object.assign(this.roomState, s); }
      requestPresenceUpdate() {}
      subscribePresence() { return () => {}; }
      subscribeRoomState() { return () => {}; }
      subscribePresenceUpdateRequests() { return () => {}; }
      send() {}
      set onmessage(fn) { this._onmessage = fn; }
      get onmessage() { return this._onmessage; }
    };
  }
})();
