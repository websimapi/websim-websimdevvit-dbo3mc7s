// WebSim → Devvit Converter backend.
//
// The browser fetches a WebSim project and converts it (the Websim runtime
// can't reach api.websim.com or *.c.websim.com from here). This server keeps
// what the conversion produced so a terminal can pull it:
//   links   — one per Reddit app a user ports (stable id = stable pull URL)
//   blobs   — generated files, content-addressed by SHA-1, stored in env.BLOB
//   builds  — a manifest (path -> sha) for each conversion of a link
// All routes live under /api/dv/ so they never collide with the platform's /api/v1/.

export const schema = `
  CREATE TABLE IF NOT EXISTS dv_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT,
    project_id TEXT NOT NULL,
    title TEXT,
    app_name TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{}',
    latest_build_id TEXT,
    latest_version INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS dv_links_user_app ON dv_links (user_id, app_name);
  CREATE TABLE IF NOT EXISTS dv_blobs (
    sha TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dv_builds (
    id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL,
    version INTEGER,
    file_count INTEGER NOT NULL,
    total_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS dv_builds_link ON dv_builds (link_id, created_at);
  CREATE TABLE IF NOT EXISTS dv_build_files (
    build_id TEXT NOT NULL,
    path TEXT NOT NULL,
    sha TEXT NOT NULL,
    size INTEGER NOT NULL,
    PRIMARY KEY (build_id, path)
  );
`;

const APP_NAME = /^[a-z][a-z0-9-]{2,19}$/;           // devvit.json `name` rule
const SHA = /^[0-9a-f]{40}$/;
const PROJECT_ID = /^[a-z0-9_-]{20}$/;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_BUILD_FILES = 3000;
const MAX_BUILD_BYTES = 150 * 1024 * 1024;
const BUILDS_KEPT = 10;
// The runtime's SQLite allows at most 100 bound parameters per statement.
const MAX_SQL_PARAMS = 96;
const SHAS_PER_QUERY = MAX_SQL_PARAMS;                 // IN (...) lists: 1 parameter each
const FILE_ROWS_PER_INSERT = Math.floor(MAX_SQL_PARAMS / 4); // dv_build_files rows: 4 parameters each

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (status, error) => json({ error }, status);

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha1 = async (bytes) => hex(await crypto.subtle.digest('SHA-1', bytes));

function cleanPath(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (!s || s.length > 300 || s.split('/').some((seg) => seg === '..' || seg === '')) return null;
  return s;
}

function viewer(request) {
  const id = request.headers.get('x-websim-user-id');
  const anonymous = request.headers.get('x-websim-user-is-anonymous') === 'true';
  return id && !anonymous ? { id, username: request.headers.get('x-websim-username') || '' } : null;
}

const linkView = (row, origin) => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  appName: row.app_name,
  settings: safeJson(row.settings) || {},
  latestBuildId: row.latest_build_id,
  latestVersion: row.latest_version,
  updatedAt: row.updated_at,
  pullUrl: `${origin}/api/dv/links/${row.id}`,
});

function safeJson(text) { try { return JSON.parse(text); } catch { return null; } }

async function manifestFor(env, link, buildId) {
  const build = await env.DB.prepare('SELECT * FROM dv_builds WHERE id = ? AND link_id = ?').bind(buildId, link.id).first();
  if (!build) return null;
  const { results } = await env.DB.prepare(
    'SELECT f.path, f.sha, f.size, b.url FROM dv_build_files f JOIN dv_blobs b ON b.sha = f.sha WHERE f.build_id = ? ORDER BY f.path'
  ).bind(build.id).all();
  return {
    app: link.app_name,
    title: link.title,
    source: `https://websim.com/p/${link.project_id}`,
    version: build.version,
    buildId: build.id,
    builtAt: new Date(build.created_at).toISOString(),
    files: results,
  };
}

async function ownedLink(env, id, user) {
  const link = await env.DB.prepare('SELECT * FROM dv_links WHERE id = ?').bind(id).first();
  return link && link.user_id === user.id ? link : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = url.origin;
    const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1); // ['api','dv',...]
    if (parts[0] !== 'api' || parts[1] !== 'dv') return fail(404, 'Not found');
    const [, , resource, id, sub] = parts;
    const method = request.method;

    try {
      if (resource === 'health') return json({ ok: true });

      // ---- Public reads (used by pull.mjs from any terminal) ----
      if (resource === 'links' && id && sub === 'manifest' && method === 'GET') {
        const link = await env.DB.prepare('SELECT * FROM dv_links WHERE id = ?').bind(id).first();
        if (!link) return fail(404, 'This link does not exist. Open the converter and copy a fresh pull command.');
        if (!link.latest_build_id) return fail(409, 'This link has no build yet. Build it in the converter first.');
        return json(await manifestFor(env, link, link.latest_build_id));
      }

      // ---- Everything below needs a signed-in WebSim user ----
      const user = viewer(request);
      if (!user) return fail(401, 'Sign in to WebSim to save Reddit app links.');

      if (resource === 'links' && !id && method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM dv_links WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100').bind(user.id).all();
        return json({ links: results.map((r) => linkView(r, origin)) });
      }

      if (resource === 'links' && !id && method === 'POST') {
        const body = await request.json().catch(() => null);
        const appName = String(body?.appName || '');
        const projectId = String(body?.projectId || '');
        if (!APP_NAME.test(appName)) return fail(400, 'App name must be 3–20 characters: lowercase letters, numbers and hyphens, starting with a letter.');
        if (!PROJECT_ID.test(projectId)) return fail(400, 'That is not a WebSim project id.');
        const settings = JSON.stringify({
          launchMode: body?.settings?.launchMode === 'expanded' ? 'expanded' : 'inline',
          payments: ['auto', 'on', 'off'].includes(body?.settings?.payments) ? body.settings.payments : 'auto',
          includeReadme: body?.settings?.includeReadme !== false,
        });
        const title = String(body?.title || '').slice(0, 120);
        const now = Date.now();
        const existing = await env.DB.prepare('SELECT * FROM dv_links WHERE user_id = ? AND app_name = ?').bind(user.id, appName).first();
        if (existing) {
          await env.DB.prepare('UPDATE dv_links SET project_id = ?, title = ?, settings = ?, username = ?, updated_at = ? WHERE id = ?')
            .bind(projectId, title, settings, user.username, now, existing.id).run();
        } else {
          await env.DB.prepare('INSERT INTO dv_links (id, user_id, username, project_id, title, app_name, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(crypto.randomUUID(), user.id, user.username, projectId, title, appName, settings, now, now).run();
        }
        const row = await env.DB.prepare('SELECT * FROM dv_links WHERE user_id = ? AND app_name = ?').bind(user.id, appName).first();
        return json({ link: linkView(row, origin) });
      }

      if (resource === 'links' && id && !sub && method === 'DELETE') {
        const link = await ownedLink(env, id, user);
        if (!link) return fail(404, 'Link not found.');
        const { results } = await env.DB.prepare('SELECT id FROM dv_builds WHERE link_id = ?').bind(id).all();
        for (const b of results) await env.DB.prepare('DELETE FROM dv_build_files WHERE build_id = ?').bind(b.id).run();
        await env.DB.prepare('DELETE FROM dv_builds WHERE link_id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM dv_links WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }

      // Which of these files does the server still need?
      if (resource === 'blobs' && id === 'check' && method === 'POST') {
        const body = await request.json().catch(() => null);
        const shas = [...new Set((body?.shas || []).filter((s) => SHA.test(s)))].slice(0, MAX_BUILD_FILES);
        const have = new Set();
        for (let i = 0; i < shas.length; i += SHAS_PER_QUERY) {
          const chunk = shas.slice(i, i + SHAS_PER_QUERY);
          const { results } = await env.DB.prepare(`SELECT sha FROM dv_blobs WHERE sha IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
          for (const r of results) have.add(r.sha);
        }
        return json({ missing: shas.filter((s) => !have.has(s)) });
      }

      if (resource === 'blobs' && id && SHA.test(id) && method === 'PUT') {
        const known = await env.DB.prepare('SELECT url FROM dv_blobs WHERE sha = ?').bind(id).first();
        if (known) return json({ sha: id, url: known.url });
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length > MAX_FILE_BYTES) return fail(413, `Files over ${MAX_FILE_BYTES / 1048576} MB can't be stored.`);
        if ((await sha1(bytes)) !== id) return fail(400, 'Checksum mismatch: the upload was corrupted. Try again.');
        const stored = await env.BLOB.put(`devvit-${id}.bin`, bytes);
        await env.DB.prepare('INSERT OR IGNORE INTO dv_blobs (sha, url, size, created_at) VALUES (?, ?, ?, ?)')
          .bind(id, stored.url, bytes.length, Date.now()).run();
        return json({ sha: id, url: stored.url });
      }

      // Record a finished conversion: { version, files: [{ path, sha, size }] }
      if (resource === 'links' && id && sub === 'builds' && method === 'POST') {
        const link = await ownedLink(env, id, user);
        if (!link) return fail(404, 'Link not found.');
        const body = await request.json().catch(() => null);
        const seen = new Set();
        const files = [];
        for (const f of body?.files || []) {
          const p = cleanPath(f.path);
          if (!p || seen.has(p) || !SHA.test(f.sha)) return fail(400, `Bad file entry: ${String(f.path).slice(0, 80)}`);
          seen.add(p);
          files.push({ path: p, sha: f.sha, size: Math.max(0, Number(f.size) || 0) });
        }
        if (!files.length || files.length > MAX_BUILD_FILES) return fail(400, `A build needs 1–${MAX_BUILD_FILES} files.`);
        const total = files.reduce((n, f) => n + f.size, 0);
        if (total > MAX_BUILD_BYTES) return fail(413, `This build is ${(total / 1048576).toFixed(0)} MB; the limit is ${MAX_BUILD_BYTES / 1048576} MB.`);

        const shas = [...new Set(files.map((f) => f.sha))];
        let found = 0;
        for (let i = 0; i < shas.length; i += SHAS_PER_QUERY) {
          const chunk = shas.slice(i, i + SHAS_PER_QUERY);
          const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM dv_blobs WHERE sha IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).first();
          found += row.n;
        }
        if (found !== shas.length) return fail(409, `${shas.length - found} file(s) were not uploaded yet. Run the build again.`);

        const previous = link.latest_build_id
          ? (await env.DB.prepare('SELECT path, sha FROM dv_build_files WHERE build_id = ?').bind(link.latest_build_id).all()).results
          : [];
        const buildId = crypto.randomUUID();
        const now = Date.now();
        const version = Number.isFinite(Number(body?.version)) ? Number(body.version) : null;
        await env.DB.prepare('INSERT INTO dv_builds (id, link_id, version, file_count, total_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(buildId, link.id, version, files.length, total, now).run();
        for (let i = 0; i < files.length; i += FILE_ROWS_PER_INSERT) {
          const chunk = files.slice(i, i + FILE_ROWS_PER_INSERT);
          await env.DB.prepare(`INSERT INTO dv_build_files (build_id, path, sha, size) VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(',')}`)
            .bind(...chunk.flatMap((f) => [buildId, f.path, f.sha, f.size])).run();
        }
        await env.DB.prepare('UPDATE dv_links SET latest_build_id = ?, latest_version = ?, updated_at = ? WHERE id = ?')
          .bind(buildId, version, now, link.id).run();

        // Keep the newest builds for this link; blobs are shared and stay.
        const { results: old } = await env.DB.prepare('SELECT id FROM dv_builds WHERE link_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?').bind(link.id, BUILDS_KEPT).all();
        for (const b of old) {
          await env.DB.prepare('DELETE FROM dv_build_files WHERE build_id = ?').bind(b.id).run();
          await env.DB.prepare('DELETE FROM dv_builds WHERE id = ?').bind(b.id).run();
        }

        const before = new Map(previous.map((f) => [f.path, f.sha]));
        const changes = { added: [], changed: [], removed: [] };
        for (const f of files) {
          if (!before.has(f.path)) changes.added.push(f.path);
          else if (before.get(f.path) !== f.sha) changes.changed.push(f.path);
          before.delete(f.path);
        }
        changes.removed = [...before.keys()];
        const updated = await env.DB.prepare('SELECT * FROM dv_links WHERE id = ?').bind(link.id).first();
        return json({ buildId, link: linkView(updated, origin), changes, firstBuild: previous.length === 0 });
      }

      return fail(404, 'Not found');
    } catch (err) {
      console.error('converter server error', err);
      return json({ error: 'Something went wrong on the converter server. Try again in a minute.', detail: String(err?.message || err).slice(0, 300) }, 500);
    }
  },
};
