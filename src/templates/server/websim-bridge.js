// Runs a WebSim project's own server.js inside the Devvit server.
//
// WebSim's server.js is a fetch handler: `export default { fetch(request, env) }`
// with env.DB (SQLite, D1-style API) and env.BLOB (file storage). Devvit has
// Redis but no SQL, so env.DB is SQLite compiled to WebAssembly (sql.js) whose
// database file lives in Redis. Writes are saved with a versioned Redis
// transaction and the request is re-run on a conflict, so concurrent players
// never overwrite each other. env.BLOB stores files in Redis and serves them
// at /api/__websim_blob/<id>/<name>.
//
// Not available on Reddit: env.AI (no LLM access) and the `room` realtime
// export (Devvit realtime is one-way, server to client).
//
// The code below is emitted as-is into src/server/index.ts; it avoids template
// literals so it can live inside this module's template string.
export const websimBridgeImports = `
import * as websimServerModule from './websim/server.js';
import initSqlJs from 'sql.js/dist/sql-wasm.js';
import SQLJS_WASM_BASE64 from 'virtual:sqljs-wasm';
`;

export const websimBridge = `
// ---------- WebSim server.js bridge ----------
const websimServer = websimServerModule.default;
const WEBSIM_SCHEMA = typeof websimServerModule.schema === 'string' ? websimServerModule.schema : '';
const WS_DB = 'websim:sqlite';
const WS_CHUNK = 400000;           // characters of base64 per Redis value
const WS_RETRIES = 5;
if (websimServerModule.room) console.warn('[websim] server.js exports a realtime room; that part is not supported on Reddit.');

let wsSQL = null;
async function wsSqlEngine() {
    if (!wsSQL) wsSQL = await initSqlJs({ wasmBinary: Uint8Array.from(Buffer.from(SQLJS_WASM_BASE64, 'base64')) });
    return wsSQL;
}

function wsHash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
}

// Chunked values in Redis: <key>:meta holds { version, chunks, ... }.
async function wsReadChunked(key) {
    const metaRaw = await redis.get(key + ':meta');
    if (!metaRaw) return { meta: { version: 0, chunks: 0 }, data: null };
    const meta = JSON.parse(metaRaw);
    if (!meta.chunks) return { meta, data: '' };
    const keys = [];
    for (let i = 0; i < meta.chunks; i++) keys.push(key + ':' + meta.version + ':' + i);
    const parts = await redis.mGet(keys);
    if (parts.some((p) => p == null)) throw new Error('Stored data for ' + key + ' is incomplete.');
    return { meta, data: parts.join('') };
}

function wsSplit(text) {
    const out = [];
    for (let i = 0; i < text.length; i += WS_CHUNK) out.push(text.slice(i, i + WS_CHUNK));
    return out;
}

// env.DB: the subset of Cloudflare D1's API that WebSim server.js code uses.
function wsMakeDb(db, state) {
    const toParam = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
    const isRead = (sql) => /^\\s*(select|with|pragma|explain)\\b/i.test(sql);
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
            async first(column) {
                const { results } = await stmt.all();
                const row = results[0] ?? null;
                return column && row ? row[column] : row;
            },
            async run() {
                db.run(sql, params);
                const changes = db.getRowsModified();
                if (!isRead(sql)) state.dirty = true;
                const idRow = db.exec('SELECT last_insert_rowid() AS id')[0];
                return { success: true, changes, meta: { changes, last_row_id: idRow ? idRow.values[0][0] : null } };
            },
            async raw() {
                const { results } = await stmt.all();
                return results.map((r) => Object.values(r));
            },
        };
        return stmt;
    }
    return {
        prepare,
        async batch(statements) { const out = []; for (const s of statements) out.push(await s.run()); return out; },
        async exec(sql) { db.exec(sql); if (!isRead(sql)) state.dirty = true; return { count: 1 }; },
    };
}

// env.BLOB: put(name, bytes) -> { url, id }, like WebSim's.
const wsBlob = {
    async put(name, value) {
        if (!name) throw new Error('filename is required');
        let bytes;
        if (typeof value === 'string') bytes = Buffer.from(value, 'utf8');
        else if (value instanceof ArrayBuffer) bytes = Buffer.from(value);
        else if (ArrayBuffer.isView(value)) bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        else if (value && typeof value.arrayBuffer === 'function') bytes = Buffer.from(await value.arrayBuffer());
        else throw new Error('Unsupported blob value');
        const id = crypto.randomUUID();
        const safeName = String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
        const parts = wsSplit(bytes.toString('base64'));
        for (let i = 0; i < parts.length; i++) await redis.set('websim:blob:' + id + ':1:' + i, parts[i]);
        await redis.set('websim:blob:' + id + ':meta', JSON.stringify({ version: 1, chunks: parts.length, name: safeName, size: bytes.length }));
        return { url: '/api/__websim_blob/' + id + '/' + safeName, id };
    },
    async get(id) {
        const { meta, data } = await wsReadChunked('websim:blob:' + id);
        return data == null ? null : { name: meta.name, bytes: Buffer.from(data, 'base64') };
    },
};

const WS_TYPES = { json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', webm: 'video/webm', mp4: 'video/mp4', txt: 'text/plain' };
router.get('/api/__websim_blob/:id/:name', async (req, res) => {
    try {
        const blob = await wsBlob.get(String(req.params.id).replace(/[^A-Za-z0-9-]/g, ''));
        if (!blob) return res.status(404).json({ error: 'Not found' });
        const ext = String(blob.name).split('.').pop().toLowerCase();
        res.setHeader('Content-Type', WS_TYPES[ext] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.send(blob.bytes);
    } catch (e) {
        console.error('[websim] blob read failed', e);
        res.status(500).json({ error: 'Could not read file' });
    }
});

async function wsIdentityHeaders() {
    const headers = {};
    const userId = context && context.userId;
    if (userId) {
        let username = context.username;
        if (!username) { try { username = await reddit.getCurrentUsername(); } catch (e) {} }
        headers['x-websim-user-id'] = userId;
        headers['x-websim-username'] = username || userId;
        headers['x-websim-user-is-anonymous'] = 'false';
    } else {
        headers['x-websim-user-is-anonymous'] = 'true';
    }
    return headers;
}

// One attempt: load the database, run the handler, save if it wrote anything.
async function wsAttempt(makeRequest) {
    const SQL = await wsSqlEngine();
    const { meta, data } = await wsReadChunked(WS_DB);
    const db = data ? new SQL.Database(Uint8Array.from(Buffer.from(data, 'base64'))) : new SQL.Database();
    const state = { dirty: false };
    try {
        const schemaHash = wsHash(WEBSIM_SCHEMA);
        if (WEBSIM_SCHEMA && meta.schema !== schemaHash) { db.exec(WEBSIM_SCHEMA); state.dirty = true; }
        const env = { DB: wsMakeDb(db, state), BLOB: wsBlob, AI: { chat() { throw new Error('AI is not available on Reddit.'); } }, NOTIFICATIONS: { async send() {} } };
        const response = await websimServer.fetch(await makeRequest(), env);
        if (!state.dirty) return { response };

        // Save with optimistic locking: fail if someone else saved first.
        const encoded = Buffer.from(db.export()).toString('base64');
        const parts = wsSplit(encoded);
        const version = (meta.version || 0) + 1;
        const tx = await redis.watch(WS_DB + ':meta');
        const current = await redis.get(WS_DB + ':meta');
        const currentVersion = current ? JSON.parse(current).version : 0;
        if (currentVersion !== (meta.version || 0)) { await tx.unwatch(); return { conflict: true }; }
        await tx.multi();
        for (let i = 0; i < parts.length; i++) await tx.set(WS_DB + ':' + version + ':' + i, parts[i]);
        await tx.set(WS_DB + ':meta', JSON.stringify({ version, chunks: parts.length, schema: schemaHash, savedAt: Date.now() }));
        let result;
        try { result = await tx.exec(); } catch (e) { return { conflict: true }; }
        if (result == null) return { conflict: true };
        // Old chunks are no longer referenced; expire them.
        for (let i = 0; i < (meta.chunks || 0); i++) { try { await redis.expire(WS_DB + ':' + meta.version + ':' + i, 60); } catch (e) {} }
        return { response };
    } finally {
        db.close();
    }
}

app.use(async (req, res, next) => {
    if (!req.path.startsWith('/api/') || !websimServer || typeof websimServer.fetch !== 'function') return next();
    try {
        let body;
        if (!['GET', 'HEAD'].includes(req.method)) {
            if (!req._body) {
                // No body parser claimed it (e.g. binary uploads): read the raw stream.
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                if (chunks.length) body = Buffer.concat(chunks);
            } else if (Buffer.isBuffer(req.body)) body = req.body;
            else if (typeof req.body === 'string') body = req.body;
            else if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) body = JSON.stringify(req.body);
        }
        const identity = await wsIdentityHeaders();
        const makeRequest = async () => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers)) {
                if (typeof v === 'string' && !k.startsWith('x-websim-') && k !== 'content-length' && k !== 'host') headers.set(k, v);
            }
            for (const [k, v] of Object.entries(identity)) headers.set(k, v);
            return new Request('https://webview.devvit.net' + req.originalUrl, { method: req.method, headers, body });
        };

        let outcome = null;
        for (let attempt = 1; attempt <= WS_RETRIES; attempt++) {
            outcome = await wsAttempt(makeRequest);
            if (!outcome.conflict) break;
            await new Promise((r) => setTimeout(r, 40 * attempt + Math.random() * 60));
        }
        if (!outcome || outcome.conflict) return res.status(503).json({ error: 'Busy, please try again.' });

        const response = outcome.response;
        if (response.status === 404 && !response.headers.get('content-type')?.includes('json')) return next();
        res.status(response.status);
        response.headers.forEach((value, key) => {
            if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key)) res.setHeader(key, value);
        });
        res.send(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
        console.error('[websim] server.js bridge error', e);
        res.status(500).json({ error: 'Server error', detail: String((e && e.message) || e).slice(0, 300) });
    }
});
// ---------- end WebSim server.js bridge ----------
`;
