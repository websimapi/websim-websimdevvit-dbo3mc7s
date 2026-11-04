// Runs a WebSim server.js `room` export (its realtime multiplayer room) on the
// Devvit server. Emitted after websimBridge, whose helpers it uses.
//
// On WebSim, `export const room = { onConnect, onMessage, onClose, onTick, tickMs }`
// receives websocket connections. Devvit realtime only goes server -> client,
// so the browser polyfill (polyfills/socket/room.js) posts its messages to
// /api/__room/* and listens on two realtime channels per post: its own
// (conn.send, and room.broadcast with an except list) and a shared one
// (room.broadcast to everyone).
//
// Room state: WebSim keeps it in the server's memory. A Devvit request can land
// on any server instance, so every room event runs under a short Redis lock, and
// a room that also exports saveState() and loadState(state) has that state saved
// to Redis after each event and restored on whichever instance runs the next one.
// Maps, Sets and conn objects inside the state are handled. Without those hooks
// the state stays in one instance's memory, shared by all posts (enough for a
// test; lobbies can be lost or split), and the port report says so.
//
// Emitted as-is into src/server/index.ts: no template literals, no backslashes.
export const websimRoomBridge = `
// ---------- WebSim realtime room bridge ----------
const wsRoom = websimServerModule.room || null;
const wsRoomHooks = !!(wsRoom && typeof wsRoom.saveState === 'function' && typeof wsRoom.loadState === 'function');
const WSR_STALE_MS = 30000;           // a browser that hasn't pinged for this long has left
const WSR_LOCK_MS = 8000;
if (wsRoom && !wsRoomHooks) console.warn('[websim] server.js room has no saveState/loadState: room state lives in this server instance only.');

const wsRoomInstances = new Map();    // post -> { version, conns: { id: { userId, username } }, lastTick, savedText }
const wsConnObjects = new Map();      // post:id -> conn object handed to the room
let wsOutbox = null;                  // realtime messages of the event being run
// One room module serves every post on this instance, so it holds one post's
// state at a time: which one, and the module's own starting state for new posts.
let wsRoomLoadedKey = null, wsRoomInitial = null;

function wsRoomKey() { return 'websim:room:' + String((context && context.postId) || 'app').replace(/[^A-Za-z0-9_]/g, '_'); }
function wsRoomChannel(key, suffix) { return key.replace(/[^A-Za-z0-9_]/g, '_') + '_' + suffix; }
function wsText(msg) { return typeof msg === 'string' ? msg : JSON.stringify(msg); }

function wsConn(key, id) {
    const local = wsRoomInstances.get(key);
    const info = (local && local.conns[id]) || {};
    let conn = wsConnObjects.get(key + ':' + id);
    if (!conn) {
        conn = { id, send(msg) { if (wsOutbox) wsOutbox.push([wsRoomChannel(key, 'c_' + id), { d: wsText(msg) }]); } };
        Object.defineProperty(conn, '__wsConn', { value: id, enumerable: false });
        wsConnObjects.set(key + ':' + id, conn);
    }
    conn.userId = info.userId || null;
    conn.username = info.username || 'guest';
    conn.identity = info.userId ? 'user' : 'anonymous';
    return conn;
}

function wsRoomApi(key) {
    return {
        // With an except list the message goes only to the others' own channels, so a
        // browser never receives (and could never read) messages meant for other players.
        broadcast(msg, opts) {
            if (!wsOutbox) return;
            const except = (opts && opts.except) || [];
            if (!except.length) { wsOutbox.push([wsRoomChannel(key, 'all'), { d: wsText(msg) }]); return; }
            const l = wsRoomInstances.get(key);
            for (const id of Object.keys((l && l.conns) || {})) if (!except.includes(id)) wsConn(key, id).send(msg);
        },
        send(id, msg) { wsConn(key, id).send(msg); },
        get connections() { const l = wsRoomInstances.get(key); return Object.keys((l && l.conns) || {}).map((id) => wsConn(key, id)); },
    };
}

// State with Maps, Sets and conns, as JSON.
function wsEncodeState(value) {
    return JSON.stringify(value, function (k, v) {
        if (v instanceof Map) return { __wsMap: Array.from(v.entries()) };
        if (v instanceof Set) return { __wsSet: Array.from(v) };
        if (v && typeof v === 'object' && v.__wsConn) return { __wsConnRef: v.__wsConn };
        return v;
    });
}
function wsDecodeState(key, text) {
    return JSON.parse(text, function (k, v) {
        if (!v || typeof v !== 'object') return v;
        if (v.__wsMap) return new Map(v.__wsMap);
        if (v.__wsSet) return new Set(v.__wsSet);
        if (v.__wsConnRef) return wsConn(key, v.__wsConnRef);
        return v;
    });
}

async function wsRoomLock(key) {
    const lock = key + ':lock';
    const started = Date.now();
    for (let i = 0; ; i++) {
        const n = await redis.incrBy(lock, 1);
        if (n === 1) { await redis.expire(lock, Math.ceil(WSR_LOCK_MS / 1000)); return; }
        if (Date.now() - started > WSR_LOCK_MS) { await redis.del(lock); continue; } // a crashed holder
        await new Promise((r) => setTimeout(r, Math.min(15 + i * 10, 120)));
    }
}

async function wsRoomLoad(key) {
    let local = wsRoomInstances.get(key);
    if (!local) { local = { version: 0, conns: {}, lastTick: 0, savedText: '' }; wsRoomInstances.set(key, local); }
    if (wsRoomHooks && wsRoomInitial === null) wsRoomInitial = wsEncodeState(await wsRoom.saveState());
    const metaRaw = await redis.get(key + ':meta');
    const version = metaRaw ? JSON.parse(metaRaw).version : 0;
    if (version === local.version && (!wsRoomHooks || wsRoomLoadedKey === key)) return local;
    const { data } = await wsReadChunked(key);
    const saved = data ? JSON.parse(data) : { conns: {}, lastTick: 0, app: null };
    local.version = version; local.conns = saved.conns || {}; local.lastTick = saved.lastTick || 0; local.savedText = data || '';
    if (wsRoomHooks) { await wsRoom.loadState(wsDecodeState(key, saved.app != null ? saved.app : wsRoomInitial)); wsRoomLoadedKey = key; }
    return local;
}

async function wsRoomSave(key, local) {
    const text = JSON.stringify({ conns: local.conns, lastTick: local.lastTick, app: wsRoomHooks ? wsEncodeState(await wsRoom.saveState()) : null });
    if (text === local.savedText) return;
    const parts = wsSplit(text);
    const version = local.version + 1;
    for (let i = 0; i < parts.length; i++) await redis.set(key + ':' + version + ':' + i, parts[i]);
    const oldRaw = await redis.get(key + ':meta');
    await redis.set(key + ':meta', JSON.stringify({ version, chunks: parts.length, savedAt: Date.now() }));
    if (oldRaw) { const old = JSON.parse(oldRaw); for (let i = 0; i < (old.chunks || 0); i++) { try { await redis.expire(key + ':' + old.version + ':' + i, 60); } catch (e) {} } }
    local.version = version; local.savedText = text;
}

// env.DB for room handlers: opened on first use. Writes are recorded so they can
// be replayed on a fresh copy if another request saved the database meanwhile.
function wsRoomEnv() {
    const box = { db: null, meta: null, dirty: false, writes: [] };
    async function open() {
        if (box.db) return box.db;
        const SQL = await wsSqlEngine();
        const { meta, data } = await wsReadChunked(WS_DB);
        box.meta = meta;
        box.db = data ? new SQL.Database(Uint8Array.from(Buffer.from(data, 'base64'))) : new SQL.Database();
        if (WEBSIM_SCHEMA && meta.schema !== wsHash(WEBSIM_SCHEMA)) { box.db.exec(WEBSIM_SCHEMA); box.dirty = true; }
        return box.db;
    }
    const isRead = (sql) => /^[ ]*(select|with|pragma|explain)[ ]/i.test(String(sql).replace(/[^ -~]/g, ' '));
    function prepare(sql) {
        let args = [];
        const call = async (method, column) => {
            const db = await open();
            const stmt = wsMakeDb(db, box).prepare(sql).bind(...args);
            if (!isRead(sql)) box.writes.push({ sql, args });
            return method === 'first' ? stmt.first(column) : stmt[method]();
        };
        const stmt = {
            bind(...a) { args = a; return stmt; },
            all() { return call('all'); }, first(column) { return call('first', column); }, run() { return call('run'); }, raw() { return call('raw'); },
        };
        return stmt;
    }
    const DB = {
        prepare,
        async batch(statements) { const out = []; for (const s of statements) out.push(await s.run()); return out; },
        async exec(sql) { const db = await open(); db.exec(sql); if (!isRead(sql)) { box.dirty = true; box.writes.push({ sql, args: null }); } return { count: 1 }; },
    };
    const env = { DB, BLOB: wsBlob, AI: { chat() { throw new Error('AI is not available on Reddit.'); } }, NOTIFICATIONS: { async send() {} }, PLATFORM: 'reddit', SECRETS: wsSecrets };
    async function save() {
        if (!box.db || !box.dirty) { if (box.db) box.db.close(); return; }
        const SQL = await wsSqlEngine();
        for (let attempt = 1; attempt <= WS_RETRIES; attempt++) {
            const encoded = Buffer.from(box.db.export()).toString('base64');
            const parts = wsSplit(encoded);
            const version = (box.meta.version || 0) + 1;
            const tx = await redis.watch(WS_DB + ':meta');
            const current = await redis.get(WS_DB + ':meta');
            const currentVersion = current ? JSON.parse(current).version : 0;
            let ok = false;
            if (currentVersion === (box.meta.version || 0)) {
                await tx.multi();
                for (let i = 0; i < parts.length; i++) await tx.set(WS_DB + ':' + version + ':' + i, parts[i]);
                await tx.set(WS_DB + ':meta', JSON.stringify({ version, chunks: parts.length, schema: wsHash(WEBSIM_SCHEMA), savedAt: Date.now() }));
                try { ok = (await tx.exec()) != null; } catch (e) { ok = false; }
            } else await tx.unwatch();
            if (ok) { for (let i = 0; i < (box.meta.chunks || 0); i++) { try { await redis.expire(WS_DB + ':' + box.meta.version + ':' + i, 60); } catch (e) {} } break; }
            // Someone else saved: replay this event's writes on their copy.
            box.db.close();
            const { meta, data } = await wsReadChunked(WS_DB);
            box.meta = meta;
            box.db = data ? new SQL.Database(Uint8Array.from(Buffer.from(data, 'base64'))) : new SQL.Database();
            if (WEBSIM_SCHEMA && meta.schema !== wsHash(WEBSIM_SCHEMA)) box.db.exec(WEBSIM_SCHEMA);
            for (const w of box.writes) { try { if (w.args) box.db.run(w.sql, w.args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v))); else box.db.exec(w.sql); } catch (e) { console.error('[websim] room write replay failed', e); } }
            await new Promise((r) => setTimeout(r, 30 * attempt));
        }
        box.db.close();
    }
    return { env, save };
}

// One room event: lock, catch up, run, sweep/tick, save, send, unlock.
async function wsRoomEvent(run) {
    const key = wsRoomKey();
    await wsRoomLock(key);
    wsOutbox = [];
    const { env, save } = wsRoomEnv();
    try {
        const local = await wsRoomLoad(key);
        const api = wsRoomApi(key);
        const result = await run(local, api, env, key);
        const now = Date.now();
        const seen = (await redis.hGetAll(key + ':seen')) || {};
        for (const id of Object.keys(local.conns)) {
            if (now - Number(seen[id] || 0) > WSR_STALE_MS) {
                try { if (wsRoom.onClose) await wsRoom.onClose(wsConn(key, id), api, env); } catch (e) { console.error('[websim] room onClose failed', e); }
                delete local.conns[id]; wsConnObjects.delete(key + ':' + id);
                try { await redis.hDel(key + ':seen', [id]); } catch (e) {}
            }
        }
        if (wsRoom.onTick && now - local.lastTick >= (wsRoom.tickMs || 1000)) {
            local.lastTick = now;
            try { await wsRoom.onTick(api, env); } catch (e) { console.error('[websim] room onTick failed', e); }
        }
        await wsRoomSave(key, local);
        await save();
        for (const [channel, msg] of wsOutbox) { try { await realtime.send(channel, msg); } catch (e) { console.error('[websim] room send failed', channel, e); } }
        return result;
    } finally {
        wsOutbox = null;
        try { await redis.del(key + ':lock'); } catch (e) {}
    }
}

const wsRoomId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);

if (wsRoom) {
    router.post('/api/__room/info', (req, res) => { const key = wsRoomKey(); res.json({ all: wsRoomChannel(key, 'all'), own: wsRoomChannel(key, 'c_') }); });

    router.post('/api/__room/connect', async (req, res) => {
        const id = wsRoomId(req.body && req.body.id);
        if (!id) return res.status(400).json({ error: 'Bad connection id' });
        try {
            const identity = await wsIdentityHeaders();
            const userId = identity['x-websim-user-id'] || null;
            await redis.hSet(wsRoomKey() + ':seen', { [id]: String(Date.now()) });
            await wsRoomEvent(async (local, api, env, key) => {
                local.conns[id] = { userId, username: identity['x-websim-username'] || 'guest' };
                if (wsRoom.onConnect) await wsRoom.onConnect(wsConn(key, id), api, env);
            });
            res.json({ ok: true, id });
        } catch (e) { console.error('[websim] room connect failed', e); res.status(500).json({ error: 'Room error' }); }
    });

    router.post('/api/__room/send', async (req, res) => {
        const id = wsRoomId(req.body && req.body.id);
        const data = Array.isArray(req.body && req.body.data) ? req.body.data : [];
        if (!id) return res.status(400).json({ error: 'Bad connection id' });
        try {
            await redis.hSet(wsRoomKey() + ':seen', { [id]: String(Date.now()) });
            const gone = await wsRoomEvent(async (local, api, env, key) => {
                if (!local.conns[id]) return true;
                for (const message of data) {
                    try { if (wsRoom.onMessage) await wsRoom.onMessage(wsConn(key, id), wsText(message), api, env); }
                    catch (e) { console.error('[websim] room onMessage failed', e); }
                }
                return false;
            });
            res.status(gone ? 410 : 200).json({ ok: !gone });
        } catch (e) { console.error('[websim] room send failed', e); res.status(500).json({ error: 'Room error' }); }
    });

    // Keeps a connection alive; also gives the room its ticks while players are around.
    router.post('/api/__room/ping', async (req, res) => {
        const id = wsRoomId(req.body && req.body.id);
        if (!id) return res.status(400).json({ error: 'Bad connection id' });
        try {
            const key = wsRoomKey();
            await redis.hSet(key + ':seen', { [id]: String(Date.now()) });
            const local = wsRoomInstances.get(key);
            let gone = local ? !local.conns[id] : false;
            if (!local || Date.now() - local.lastTick >= (wsRoom.tickMs || 1000)) gone = await wsRoomEvent(async (l) => !l.conns[id]);
            res.status(gone ? 410 : 200).json({ ok: !gone });
        } catch (e) { console.error('[websim] room ping failed', e); res.status(500).json({ error: 'Room error' }); }
    });

    router.post('/api/__room/leave', async (req, res) => {
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
        const id = wsRoomId(body && body.id);
        if (!id) return res.status(400).json({ error: 'Bad connection id' });
        try {
            await wsRoomEvent(async (local, api, env, key) => {
                if (!local.conns[id]) return;
                try { if (wsRoom.onClose) await wsRoom.onClose(wsConn(key, id), api, env); } catch (e) { console.error('[websim] room onClose failed', e); }
                delete local.conns[id]; wsConnObjects.delete(key + ':' + id);
                try { await redis.hDel(key + ':seen', [id]); } catch (e) {}
            });
            res.json({ ok: true });
        } catch (e) { console.error('[websim] room leave failed', e); res.status(500).json({ error: 'Room error' }); }
    });
}
// ---------- end WebSim realtime room bridge ----------
`;
