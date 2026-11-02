export const assetRoutes = `
// --- Avatar Lookup Route (Client Injection) ---
router.get('/_websim_avatar_/:username', async (req, res) => {
    // Redirect to proxy which handles the lookup
    res.redirect('/api/proxy/avatar/' + req.params.username);
});

router.get('/api/lookup/avatar/:username', async (req, res) => {
    const { username } = req.params;
    const defaultAvatar = 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png';
    
    if (username === 'guest' || username === 'null' || !username) {
        return res.json({ url: defaultAvatar });
    }

    try {
        let user;
        // Handle Reddit User IDs (t2_...) used in /api/tips and /api/supporters
        if (username.startsWith('t2_')) {
            user = await reddit.getUserById(username);
        } else {
            user = await reddit.getUserByUsername(username);
        }

        let url = null;
        if (user) {
            url = await user.getSnoovatarUrl();
        }
        res.json({ url: url || defaultAvatar });
    } catch (e) {
        console.warn('Avatar lookup failed for', username, e.message);
        res.json({ url: defaultAvatar });
    }
});

// --- WebSim Search Proxies ---
router.get('/api/v1/search/assets', async (req, res) => {
    try {
        const query = new URLSearchParams(req.query).toString();
        const response = await fetch(\`https://websim.ai/api/v1/search/assets?\${query}\`);
        if (!response.ok) return res.status(response.status).json({ error: 'Upstream Error' });
        const data = await response.json();
        res.json(data);
    } catch (e) {
        console.error('Search Proxy Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.get('/api/v1/search/assets/relevant', async (req, res) => {
    try {
        const query = new URLSearchParams(req.query).toString();
        const response = await fetch(\`https://websim.ai/api/v1/search/assets/relevant?\${query}\`);
        if (!response.ok) return res.status(response.status).json({ error: 'Upstream Error' });
        const data = await response.json();
        res.json(data);
    } catch (e) {
        console.error('Search Proxy Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- Avatar Proxy Route (Legacy/Fallback) ---
router.get('/api/proxy/avatar/:username', async (req, res) => {
    const { username } = req.params;
    try {
        let user;
        // Handle Reddit User IDs (t2_...)
        if (username.startsWith('t2_')) {
            user = await reddit.getUserById(username);
        } else {
            user = await reddit.getUserByUsername(username);
        }

        let url = null;
        if (user) {
            url = await user.getSnoovatarUrl();
        }
        res.redirect(url || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png');
    } catch (e) {
        // Fallback silently if user not found or API error
        res.redirect('https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png');
    }
});

// --- JSON "File" Upload Routes (Redis-backed) ---
router.post('/api/json/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const data = req.body;
        // Persist JSON to Redis
        await redis.set('json:' + key, JSON.stringify(data));
        res.json({ ok: true, url: '/api/json/' + key });
    } catch(e) {
        console.error('JSON Upload Error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.get('/api/json/:key', async (req, res) => {
    try {
        const { key } = req.params;
        const data = await redis.get('json:' + key);
        if (!data) return res.status(404).json({ error: 'Not found' });
        
        // Return as proper JSON
        res.header('Content-Type', 'application/json');
        res.send(data);
    } catch(e) {
        console.error('JSON Load Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// --- File uploads (websim.upload) ---
// Reddit apps may only display media hosted on Reddit, so images and GIFs go
// through media.upload() to Reddit's CDN (which also runs Reddit's safety
// checks). Everything else (JSON, audio, ...) is app data kept in Redis in
// chunks and served from here. Bodies arrive as raw bytes.
const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;   // Devvit request payload limit
const UPLOAD_CHUNK = 400000;                // base64 characters per Redis value
// media.upload() accepts only 'image' and 'gif' (developers.reddit.com/docs/capabilities/server/media-uploads).
// Videos are turned into GIFs in the browser before they get here.
const REDDIT_MEDIA_TYPES = {
    'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image', 'image/gif': 'gif',
};

router.post('/api/__upload', express.raw({ type: () => true, limit: UPLOAD_MAX_BYTES }), async (req, res) => {
    try {
        const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
        if (!bytes.length) return res.status(400).json({ error: 'Empty upload' });
        const type = String(req.headers['x-upload-type'] || 'application/octet-stream').toLowerCase().split(';')[0].trim();
        const name = String(req.headers['x-upload-name'] || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'file';

        const mediaKind = REDDIT_MEDIA_TYPES[type];
        if (mediaKind) {
            const uploaded = await media.upload({ url: 'data:' + type + ';base64,' + bytes.toString('base64'), type: mediaKind });
            return res.json({ url: uploaded.mediaUrl, mediaId: uploaded.mediaId, hostedBy: 'reddit' });
        }

        const id = crypto.randomUUID();
        const encoded = bytes.toString('base64');
        let chunks = 0;
        for (let i = 0; i < encoded.length; i += UPLOAD_CHUNK) {
            await redis.set('upload:' + id + ':' + chunks, encoded.slice(i, i + UPLOAD_CHUNK));
            chunks++;
        }
        await redis.set('upload:' + id + ':meta', JSON.stringify({ chunks, type, name, size: bytes.length }));
        res.json({ url: '/api/__upload/' + id + '/' + name, hostedBy: 'app' });
    } catch (e) {
        console.error('Upload failed:', e);
        res.status(500).json({ error: 'Upload failed', detail: String(e && e.message || e).slice(0, 200) });
    }
});

router.get('/api/__upload/:id/:name', async (req, res) => {
    try {
        const id = String(req.params.id).replace(/[^A-Za-z0-9-]/g, '');
        const metaRaw = await redis.get('upload:' + id + ':meta');
        if (!metaRaw) return res.status(404).json({ error: 'Not found' });
        const meta = JSON.parse(metaRaw);
        const keys = [];
        for (let i = 0; i < meta.chunks; i++) keys.push('upload:' + id + ':' + i);
        const parts = await redis.mGet(keys);
        if (parts.some((p) => p == null)) return res.status(404).json({ error: 'Upload is incomplete' });
        res.setHeader('Content-Type', meta.type || 'application/octet-stream');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.send(Buffer.from(parts.join(''), 'base64'));
    } catch (e) {
        console.error('Upload read failed:', e);
        res.status(500).json({ error: 'Could not read upload' });
    }
});

// --- Share a clip to this post's thread (replays) ---
// Reddit's webview can't save files, so a game's clip can be posted as a comment on
// the game's own post instead: chunks come in (requests are capped at 4 MB), the GIF
// or image is re-hosted with media.upload (max 20 MB, 30 s) and commented as the player.
const SHARE_PART = 400000; // base64 characters per Redis value

router.post('/api/__share/chunk', express.raw({ type: () => true, limit: UPLOAD_MAX_BYTES }), async (req, res) => {
    try {
        const id = String(req.query.id || '').replace(/[^A-Za-z0-9-]/g, '');
        const index = Number(req.query.i);
        if (!id || !Number.isInteger(index) || index < 0 || index > 40) return res.status(400).json({ error: 'Bad chunk' });
        const encoded = (Buffer.isBuffer(req.body) ? req.body : Buffer.from([])).toString('base64');
        const parts = [];
        for (let k = 0; k < encoded.length; k += SHARE_PART) parts.push(encoded.slice(k, k + SHARE_PART));
        for (let k = 0; k < parts.length; k++) await redis.set('share:' + id + ':' + index + ':' + k, parts[k]);
        await redis.set('share:' + id + ':' + index + ':n', String(parts.length));
        await redis.expire('share:' + id + ':' + index + ':n', 3600);
        res.json({ ok: true });
    } catch (e) {
        console.error('Share chunk failed:', e);
        res.status(500).json({ error: 'Upload failed' });
    }
});

router.post('/api/__share/finish', express.json({ limit: '64kb' }), async (req, res) => {
    try {
        const { id: rawId, chunks, type: rawType, text } = req.body || {};
        const id = String(rawId || '').replace(/[^A-Za-z0-9-]/g, '');
        const type = String(rawType || 'video/webm').toLowerCase().split(';')[0].trim();
        const kind = REDDIT_MEDIA_TYPES[type];
        if (!id || !Number.isInteger(chunks) || chunks < 1 || chunks > 40 || !kind) return res.status(400).json({ error: 'Nothing to share' });
        if (!context.postId) return res.status(400).json({ error: 'Not in a post' });
        const buffers = [];
        const keys = [];
        for (let i = 0; i < chunks; i++) {
            const n = Number(await redis.get('share:' + id + ':' + i + ':n'));
            if (!n) return res.status(400).json({ error: 'Upload is incomplete' });
            const partKeys = Array.from({ length: n }, (_, k) => 'share:' + id + ':' + i + ':' + k);
            const parts = await redis.mGet(partKeys);
            if (parts.some((p) => p == null)) return res.status(400).json({ error: 'Upload is incomplete' });
            buffers.push(Buffer.from(parts.join(''), 'base64'));
            keys.push('share:' + id + ':' + i + ':n', ...partKeys);
        }
        const encoded = Buffer.concat(buffers).toString('base64');
        const uploaded = await media.upload({ url: 'data:' + type + ';base64,' + encoded, type: kind });
        const message = String(text || '').slice(0, 500);
        // A link back into this post that hands the app its data (the devvitshare deep link).
        const link = req.body && req.body.link && req.body.link.data ? {
            text: String(req.body.link.text || 'Watch it in the game').slice(0, 120),
            url: 'https://www.reddit.com/comments/' + String(context.postId).replace(/^t3_/, '') + '/?devvitshare='
                + encodeURIComponent(JSON.stringify({ path: '', params: {}, hash: '', userData: String(req.body.link.data).slice(0, 1024) })),
        } : null;
        let comment;
        // Rich text as in the docs: media sits inside a paragraph.
        const rich = () => {
            const r = new RichTextBuilder();
            if (message) r.paragraph((p) => { p.text({ text: message }); });
            r.paragraph((p) => { p.image({ mediaUrl: uploaded.mediaUrl }); });
            if (link) r.paragraph((p) => { p.link({ text: link.text, url: link.url }); });
            return r;
        };
        try {
            comment = await reddit.submitComment({ id: context.postId, richtext: rich(), runAs: 'USER' })
                .catch((e) => { console.warn('Comment as the player failed, posting as the app:', e && e.message); return reddit.submitComment({ id: context.postId, richtext: rich() }); });
        } catch (e) {
            // Rich media or posting as the player isn't available: a plain comment with the link.
            console.warn('Rich comment failed, posting a link instead:', e && e.message);
            comment = await reddit.submitComment({ id: context.postId, text: (message ? message + '\\n\\n' : '') + uploaded.mediaUrl + (link ? '\\n\\n[' + link.text + '](' + link.url + ')' : ''), runAs: 'USER' })
                .catch(() => reddit.submitComment({ id: context.postId, text: (message ? message + '\\n\\n' : '') + uploaded.mediaUrl + (link ? '\\n\\n[' + link.text + '](' + link.url + ')' : '') }));
        }
        for (const k of keys) await redis.del(k).catch(() => {});
        res.json({ ok: true, url: uploaded.mediaUrl, commentId: comment && comment.id, permalink: comment && comment.permalink });
    } catch (e) {
        console.error('Share failed:', e);
        res.status(500).json({ error: 'Could not share', detail: String(e && e.message || e).slice(0, 200) });
    }
});
`;