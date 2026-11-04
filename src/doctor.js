// Port doctor: looks over a WebSim project before it becomes a Reddit app and
// reports what will behave differently on Reddit. Safe fixes are applied by the
// converter itself (listed as "fixed"); the rest are suggestions for the game.
// The report is written to PORT-REPORT.md in the Reddit project, shown in the
// web page and printed by the CLI.
//
// It also decides window.__portHints, which every port gets:
//   { platform: 'reddit', view: 'inline'|'live'|'expanded', quality: 'lite'|null, ai: false, room: bool }
// A game can read it (or the ?quality= URL parameter) to pick lighter assets.

const MB = 1048576;
// Total size of a port above which posts should start in the light setting.
const HEAVY_TOTAL = 15 * MB;
// Single files above this are slow for a feed post; above HUGE_FILE they risk
// Reddit's upload and CDN limits.
const BIG_FILE = 5 * MB, HUGE_FILE = 25 * MB;

const text = (c) => (c instanceof Uint8Array ? new TextDecoder().decode(c) : String(c));
const size = (c) => (c instanceof Uint8Array ? c.byteLength : new TextEncoder().encode(String(c)).byteLength);
const mb = (n) => (n / MB).toFixed(1) + ' MB';

// glTF binary: the JSON chunk says which compression extensions are used.
function glbInfo(bytes) {
    try {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (view.getUint32(0, true) !== 0x46546c67) return null; // "glTF"
        const length = view.getUint32(12, true);
        const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
        const ext = json.extensionsUsed || [];
        const images = (json.images || []).length;
        return {
            compressed: ext.some((e) => /meshopt|draco/i.test(e)),
            ktx2: ext.includes('KHR_texture_basisu'),
            images,
            animations: (json.animations || []).length,
        };
    } catch { return null; }
}

// Code that checks an API exists before using it (`websim?.chat`, `if (websim.chat)`,
// `typeof websim.imageGen`) keeps working when the API is missing.
function guarded(code, api) {
    const first = api.split('.')[0];
    return code.includes('websim?.' + first)
        || new RegExp('websim\\.' + first + '\\s*(&&|\\?\\.)').test(code)
        || new RegExp('typeof\\s+(window\\.|globalThis\\.)?websim\\??\\.' + first).test(code);
}

export function diagnose(assets, { launchMode = 'inline', forceQuality = null } = {}) {
    const findings = [];
    const add = (level, title, detail, fix = null) => findings.push({ level, title, detail, fix });
    const files = Object.entries(assets).filter(([p]) => !p.includes('..'));
    const code = files.filter(([p]) => /\.(html|js|mjs|jsx|ts|tsx)$/i.test(p)).map(([p, c]) => [p, text(c)]);
    const client = code.filter(([p]) => p !== 'server.js' && !/-server\.js$/.test(p));
    const all = client.map(([, c]) => c).join('\n');
    const has = (re) => re.test(all);

    // --- Size ---
    const total = files.reduce((n, [, c]) => n + size(c), 0);
    const byExt = {};
    for (const [p, c] of files) { const e = (p.split('.').pop() || '').toLowerCase(); byExt[e] = (byExt[e] || 0) + size(c); }
    const top = Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([e, n]) => '.' + e + ' ' + mb(n)).join(', ');
    const heavy = total > HEAVY_TOTAL;
    const qualityAware = has(/__portHints|[?&]quality=|get\(\s*["']quality["']\s*\)/);
    if (heavy) {
        add(qualityAware ? 'fixed' : 'warn', 'Large game: ' + mb(total),
            'Largest file types: ' + top + '. Inline posts load in the feed, often on phones.',
            qualityAware ? 'The game reads a quality setting, so posts start it with quality "lite" (window.__portHints.quality).'
                : 'Add a light mode the game picks when window.__portHints.quality === "lite" (or ?quality=lite): smaller models and textures, assets loaded after the first screen.');
    } else add('ok', 'Size: ' + mb(total), 'Small enough to load in a feed post.');

    for (const [p, c] of files) {
        const n = size(c);
        if (n > HUGE_FILE) add('warn', p + ' is ' + mb(n), 'Very large single file; Reddit uploads and phones may struggle.', 'Split or compress it.');
        else if (n > BIG_FILE && !/\.(glbz?|gltf)$/i.test(p)) add('info', p + ' is ' + mb(n), 'Big for a feed post.', 'Load it after the first screen, or compress it.');
    }

    // --- 3D models ---
    const glbs = files.filter(([p]) => /\.glb$/i.test(p));
    const uncompressed = [];
    for (const [p, c] of glbs) {
        const info = c instanceof Uint8Array ? glbInfo(c) : null;
        if (info && !info.compressed && size(c) > MB) uncompressed.push(p + ' (' + mb(size(c)) + ')');
    }
    if (uncompressed.length) add('warn', uncompressed.length + ' uncompressed 3D model(s)', uncompressed.slice(0, 8).join(', '),
        'Compress geometry without changing the mesh: npx @gltf-transform/cli meshopt in.glb out.glb (load with GLTFLoader.setMeshoptDecoder).');
    else if (glbs.length) add('ok', glbs.length + ' 3D models', 'All large models use mesh compression.');

    // --- Rendering ---
    const webgpu = has(/WebGPURenderer|navigator\.gpu/);
    const webglFallback = has(/WebGLRenderer|forceWebGL|getContext\(\s*["']webgl/);
    if (webgpu && !webglFallback) add('warn', 'WebGPU without a WebGL fallback', 'Many Reddit viewers (iOS, older Android, some desktops) have no WebGPU.',
        'Use three.js WebGPURenderer (it falls back to WebGL 2 by itself) or create a WebGLRenderer when navigator.gpu is missing.');
    else if (webgpu) add('ok', 'WebGPU with a WebGL fallback', 'Works for viewers without WebGPU.');

    // --- AI ---
    const aiApis = [['chat.completions', 'AI text'], ['imageGen', 'AI images'], ['textToSpeech', 'AI voices']];
    const unguarded = [];
    for (const [api, label] of aiApis) {
        const users = client.filter(([, c]) => c.includes('websim.' + api) || c.includes('websim?.' + api));
        if (!users.length) continue;
        const bad = users.filter(([, c]) => !guarded(c, api)).map(([p]) => p);
        if (bad.length) unguarded.push(...bad);
        add(bad.length ? 'fixed' : 'ok', label + ' (websim.' + api + ')',
            'Reddit has no WebSim AI. Used in ' + users.map(([p]) => p).slice(0, 5).join(', ') + '.',
            bad.length ? 'Some calls don\'t check that the API exists (' + bad.slice(0, 5).join(', ') + '), so the port defines it and makes every call fail at once; check that those places fall back gracefully.'
                : 'Every call checks first, so the game uses its own fallback immediately. Live AI on Reddit is only possible through OpenAI or Gemini via the app server (Reddit review, your own API key).');
    }

    // --- Server and multiplayer ---
    const server = code.find(([p]) => p === 'server.js');
    let room = false;
    // Sites server.js reaches (string URLs) and secrets it reads with env.SECRETS.get('NAME').
    // A line like `// Fetch domain api.example.com: what it's for` gives the README's reason.
    const serverHosts = [], secrets = [], hostReasons = {};
    if (server) {
        const s = server[1];
        room = /export\s+const\s+room\b|export\s*\{[^}]*\broom\b/.test(s);
        add('ok', 'server.js', 'Runs on the Devvit server (SQLite kept in Redis, files in Redis).');
        if (room) {
            const hooks = /saveState\s*\(/.test(s) && /loadState\s*\(/.test(s);
            add(hooks ? 'fixed' : 'warn', 'Realtime room (server.js "room")',
                'Runs on the Devvit server: messages up by POST, down by Devvit realtime, one room per post.',
                hooks ? 'The room saves its state (saveState/loadState), so it survives server restarts and multiple server instances.'
                    : 'Add room.saveState() returning the room\'s state and room.loadState(state) restoring it. Until then the room lives in one server instance\'s memory: lobbies can vanish or split under load.');
        }
        if (/env\.AI\b/.test(s)) add('warn', 'server.js uses env.AI', 'No AI on the Devvit server.', 'Keep a fallback when env.AI throws.');

        for (const m of s.matchAll(/["'`]https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?=[\/"'`:])/gi)) {
            const host = m[1].toLowerCase();
            if (!/(^|\.)(websim\.(com|ai)|reddit\.com|redditstatic\.com|redd\.it)$/.test(host) && !serverHosts.includes(host)) serverHosts.push(host);
        }
        for (const m of s.matchAll(/\/\/\s*Fetch domain\s+([a-z0-9.-]+)\s*:\s*(.+)/gi)) hostReasons[m[1].toLowerCase()] = m[2].trim();
        for (const m of s.matchAll(/\bSECRETS\??\.get\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g)) if (!secrets.includes(m[1])) secrets.push(m[1]);
        if (serverHosts.length) add('fixed', 'server.js fetches other sites', serverHosts.join(', '),
            'Requested in devvit.json (permissions.http.domains) and listed under "Fetch Domains" in README.md. Reddit reviews each domain on upload (usually 1-2 business days) and only approves public APIs and some cloud providers (Supabase, Firebase, SpacetimeDB, S3, Google Cloud Storage). ' + (serverHosts.every((h) => hostReasons[h]) ? 'The README gives server.js\'s reasons; add terms' : 'Say why each is needed with a `// Fetch domain <host>: <reason>` line in server.js (it goes into the README), and add terms') + ' and privacy links in the app\'s developer settings, and keep a fallback: until a domain is approved its fetches fail.');
        if (secrets.length) add('fixed', 'Server secrets (env.SECRETS)', secrets.join(', '),
            'Declared as app secrets in devvit.json; env.SECRETS.get(name) reads them on Reddit (on Websim env.SECRETS is undefined). Set each once after the first install: ' + secrets.map((n) => '`npx devvit settings set ' + n + '`').join(', ') + '. Until then get() returns undefined.');
    }
    if (has(/new\s+WebsimSocket\(|\bparty\./) && !room) add('ok', 'WebsimSocket (presence, room state, events)', 'Bridged to Devvit realtime and Redis.');

    // --- Network ---
    const hosts = new Set();
    for (const m of all.matchAll(/fetch\(\s*["'`](https?:\/\/[^/"'`]+)/g)) hosts.add(m[1]);
    const allowed = /cdn\.jsdelivr|esm\.sh|unpkg|cdnjs|googleapis\.com\/css|gstatic/;
    const external = [...hosts].filter((h) => !allowed.test(h));
    if (external.length) add('warn', 'Fetches other sites', external.slice(0, 6).join(', '), 'Devvit blocks fetches to sites Reddit hasn\'t approved for the app. Route them through server.js, or request the domain in devvit.json (permissions.http) with a reason.');

    // --- Inline feed rules ---
    if (launchMode === 'inline') {
        if (has(/overflow(-y)?\s*:\s*(auto|scroll)/)) add('info', 'Scrolling areas', 'Inline posts must not trap the feed\'s scroll.', 'The port adds feed-safe CSS; long panels are better as pages (‹ ›).');
        if (has(/requestPointerLock|wheel['"]\s*,/)) add('info', 'Pointer lock or mouse wheel', 'Inline posts take taps and clicks only.', 'These work once the post is expanded (live or expanded launch).');
    }

    const quality = forceQuality || (heavy ? 'lite' : null);
    const hints = { platform: 'reddit', view: launchMode, quality, ai: false, room };
    return { findings, hints, unguardedAi: unguarded.length > 0, server: { hosts: serverHosts, hostReasons, secrets }, total, markdown: toMarkdown(findings, hints, total) };
}

function toMarkdown(findings, hints, total) {
    const icon = { warn: '⚠️', fixed: '🔧', info: 'ℹ️', ok: '✅' };
    const order = { warn: 0, fixed: 1, info: 2, ok: 3 };
    const lines = ['# Port report', '', 'What the converter found in this game and what it did about it. ⚠️ needs a change in the game; 🔧 handled by the port; ℹ️ worth knowing; ✅ fine.', '',
        'Hints the game gets as `window.__portHints`: `' + JSON.stringify(hints) + '`', ''];
    for (const f of [...findings].sort((a, b) => order[a.level] - order[b.level])) {
        lines.push('- ' + icon[f.level] + ' **' + f.title + '**: ' + f.detail + (f.fix ? '\n  - ' + f.fix : ''));
    }
    lines.push('', 'Total size: ' + (total / MB).toFixed(1) + ' MB.');
    return lines.join('\n') + '\n';
}
