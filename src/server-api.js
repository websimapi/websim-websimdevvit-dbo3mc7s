// Client for this project's own server.js (routes under /api/dv/).

const BASE = '/api/dv';

async function call(path, options = {}) {
    const res = await fetch(`${BASE}${path}`, options);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error((body.error || `The converter server answered ${res.status}.`) + (body.detail ? ` (${body.detail})` : ''));
        err.status = res.status;
        throw err;
    }
    return body;
}

const jsonBody = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

// Returns { signedIn, links }. Signed-out visitors can still build a .zip.
export async function listLinks() {
    try {
        const { links } = await call('/links');
        return { signedIn: true, links };
    } catch (e) {
        if (e.status === 401) return { signedIn: false, links: [] };
        console.warn('[Server] Could not load saved apps:', e.message);
        return { signedIn: true, links: [] };
    }
}

export async function saveLink({ projectId, title, appName, settings }) {
    const { link } = await call('/links', jsonBody('POST', { projectId, title, appName, settings }));
    return link;
}

export const deleteLink = (id) => call(`/links/${id}`, { method: 'DELETE' });

async function sha1(bytes) {
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Uploads only the files the server doesn't already store, then records the build.
// files: { path: Uint8Array }. Returns the server's { buildId, link, changes, firstBuild }.
export async function uploadBuild(linkId, version, files, onProgress = () => {}) {
    const entries = await Promise.all(Object.entries(files).map(async ([path, bytes]) => ({
        path, bytes, size: bytes.byteLength, sha: await sha1(bytes),
    })));

    const { missing } = await call('/blobs/check', jsonBody('POST', { shas: entries.map(e => e.sha) }));
    const need = new Set(missing);
    const queue = entries.filter(e => need.delete(e.sha)); // one upload per unique sha
    const total = queue.length;
    let done = 0;
    onProgress(done, total);

    const worker = async () => {
        for (let e; (e = queue.shift());) {
            for (let attempt = 1; ; attempt++) {
                try {
                    await call(`/blobs/${e.sha}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: e.bytes });
                    break;
                } catch (err) {
                    if (attempt >= 3 || (err.status && err.status < 500)) throw new Error(`Upload failed for ${e.path}: ${err.message}`);
                    await new Promise(r => setTimeout(r, 500 * attempt));
                }
            }
            onProgress(++done, total);
        }
    };
    await Promise.all(Array.from({ length: 4 }, worker));

    onProgress(0, 0);
    return call(`/links/${linkId}/builds`, jsonBody('POST', {
        version,
        files: entries.map(({ path, sha, size }) => ({ path, sha, size })),
    }));
}
