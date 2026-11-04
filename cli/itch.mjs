#!/usr/bin/env node
// WebSim (and other web builds) -> itch.io HTML5 from the command line.
//
//   npm install --prefix cli            (once; brings sql.js)
//   node cli/itch.mjs <game-dir> <out-dir> [--game <slug>] [--zip <file.zip>] [--push <user/game:channel>] [--version <v>]
//
// <game-dir> is a Websim project folder (websim-cli projects pull), a web build folder like
// splashy-bear/repo/web, or a Unity WebGL build folder.
// - Websim games get src/templates/itch/itch-shim.js (see there): a local player, server.js run in the
//   page with SQLite saved on the device, and WebsimSocket collections kept locally.
// - Unity WebGL builds are copied as they are (they already run as static files).
// The result is checked against itch.io's HTML5 limits, zipped with index.html at the
// root, and optionally pushed with butler (the owner logs in to butler first).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// itch.io HTML5 limits (itch.io/docs/creators/html5).
const LIMITS = { files: 1000, totalBytes: 500e6, fileBytes: 200e6, pathChars: 240 };
// Websim project files and local clutter that don't belong in the upload.
const SKIP = [/^\.websim(-manifest)?\.json$/, /^\.git$/, /^node_modules$/, /^\.DS_Store$/, /^__itch$/, /^tools$/, /^Screenshot_.*\.(jpg|png)$/i];

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const game = opt('game'), zipPath = opt('zip'), push = opt('push'), userVersion = opt('version');
const [src, out] = args;
if (!src || !out) { console.log('usage: node cli/itch.mjs <game-dir> <out-dir> [--game slug] [--zip file.zip] [--push user/game:channel] [--version v]'); process.exit(1); }
if (!fs.existsSync(path.join(src, 'index.html'))) throw new Error(`${src} has no index.html`);

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true, filter: (p) => !SKIP.some((re) => re.test(path.basename(p))) || p === src });

const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const unity = fs.existsSync(path.join(out, 'Build')) && /createUnityInstance/.test(html);
const hasServer = fs.existsSync(path.join(out, 'server.js'));
const usesWebsim = /websim|WebsimSocket/.test(html) || hasServer || walk(out).some((f) => f.endsWith('.js') && /\bwebsim\.|WebsimSocket/.test(fs.readFileSync(f, 'utf8')));
let kind = unity ? 'Unity WebGL build' : 'static web game';

if (!unity && usesWebsim) {
  kind = hasServer ? 'Websim game with server.js (run in the page)' : 'Websim game (no server)';
  fs.mkdirSync(path.join(out, '__itch'), { recursive: true });
  fs.copyFileSync(path.join(HERE, '..', 'src', 'templates', 'itch', 'itch-shim.js'), path.join(out, '__itch', 'itch-shim.js'));
  if (hasServer) for (const f of ['sql-wasm.js', 'sql-wasm.wasm']) fs.copyFileSync(path.join(HERE, 'node_modules', 'sql.js', 'dist', f), path.join(out, '__itch', f));
  const config = { game: game || path.basename(path.resolve(src)), server: hasServer ? 'server.js' : null };
  // First thing in <head>: before the import map and the game's own scripts.
  const tag = `<script>window.__ITCH_PORT = ${JSON.stringify(config)};</script>\n    <script src="__itch/itch-shim.js"></script>\n    `;
  const patched = html.replace(/<head([^>]*)>\s*/i, (m) => m + tag);
  if (patched === html) throw new Error('index.html has no <head>');
  fs.writeFileSync(path.join(out, 'index.html'), patched);
}

// Root-relative paths ("/music.ogg") break on itch, where the game lives in a subfolder:
// any quoted path that names a file in the build is made relative. Imports resolve from
// the module's own folder; everything else (fetch, Audio, src) from index.html's.
const rootRefs = [];
for (const f of walk(out).filter((f) => /\.(html|css|js|mjs)$/.test(f) && !f.includes(`${path.sep}__itch${path.sep}`))) {
  const text = fs.readFileSync(f, 'utf8');
  // A quoted path (may hold spaces and brackets) or a CSS url(/path).
  const fixed = text.replace(/(from\s*|import\s*\(?\s*)?(?:(["'`])\/(?!\/)([^"'`\n?#]+?)(?=\2)|(url\(\s*)\/(?!\/)([^)"'\s?#]+))/g, (m, imp, quote, quoted, url, unquoted) => {
    const q = quote || url, ref = quoted || unquoted;
    let file;
    try { file = path.join(out, decodeURIComponent(ref)); } catch { return m; }
    if (ref.startsWith('api/') || !fs.existsSync(file) || !fs.statSync(file).isFile()) return m;
    const base = imp && /\.m?js$/.test(f) ? path.dirname(f) : out;
    let rel = path.relative(base, file).split(path.sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    rootRefs.push(`${path.relative(out, f)}: /${ref} → ${rel}`);
    return (imp || '') + q + (quote ? rel : encodeURI(rel));
  });
  if (fixed !== text) fs.writeFileSync(f, fixed);
}

const files = walk(out);
const sizes = files.map((f) => fs.statSync(f).size);
const total = sizes.reduce((a, b) => a + b, 0);
const problems = [];
if (files.length > LIMITS.files) problems.push(`${files.length} files (itch allows ${LIMITS.files})`);
if (total > LIMITS.totalBytes) problems.push(`${(total / 1e6).toFixed(0)} MB in total (itch allows 500 MB)`);
files.forEach((f, i) => {
  if (sizes[i] > LIMITS.fileBytes) problems.push(`${path.relative(out, f)} is ${(sizes[i] / 1e6).toFixed(0)} MB (itch allows 200 MB per file)`);
  if (path.relative(out, f).length > LIMITS.pathChars) problems.push(`path too long: ${path.relative(out, f)}`);
});

console.log(`${kind}: ${files.length} files, ${(total / 1e6).toFixed(1)} MB → ${out}`);
for (const r of rootRefs.slice(0, 10)) console.log(`  made relative: ${r}`);
for (const p of problems) console.log(`  ✖ ${p}`);
if (problems.length) process.exit(2);

if (zipPath) {
  fs.rmSync(zipPath, { force: true });
  // index.html at the root of the zip, as itch requires.
  execFileSync('python3', ['-c', 'import sys,os,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED)\nfor r,_,fs in os.walk(sys.argv[2]):\n  for f in fs:\n    p=os.path.join(r,f); z.write(p,os.path.relpath(p,sys.argv[2]))\nz.close()', path.resolve(zipPath), out]);
  console.log(`zip: ${zipPath} (${(fs.statSync(zipPath).size / 1e6).toFixed(1)} MB)`);
}
if (push) {
  // The owner runs `butler login` once (or sets BUTLER_API_KEY); first push, then set the
  // project to HTML and tick "This file will be played in the browser" on its edit page.
  execFileSync('butler', ['push', out, push, ...(userVersion ? ['--userversion', userVersion] : [])], { stdio: 'inherit' });
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
