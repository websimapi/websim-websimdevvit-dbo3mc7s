#!/usr/bin/env node
// WebSim -> Reddit (Devvit) from the command line: the same generator the web
// tool runs, pointed at a local copy of a Websim project.
//
//   npm install --prefix cli            (once)
//   node cli/convert.mjs <websim-dir> <reddit-project-dir> --app <reddit-app-name>
//        [--title "Game Title"] [--project <websim-project-id>] [--payments auto|on|off]
//        [--launch inline|live|expanded]   (default inline: plays in the post, as on Websim)
//        [--quality lite]                  (start the game in its light mode; by default the
//                                           port doctor suggests it for large games)
//
// <websim-dir> is the game's files (e.g. from `websim-cli projects pull`).
// <reddit-project-dir> is created the first time; after that it's updated in place:
// generated files are replaced, while the fields the Devvit CLI writes itself
// (package.json version/license, devvit.json dev), devvit.json marketingAssets and a hand-written README.md or
// DEVELOPMENT.md are kept. Then: npm install && npm run build && npx devvit upload.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [gameDir, outDir] = positional;
const appName = flag('app');
if (!gameDir || !outDir || !appName) {
    console.error('Usage: node cli/convert.mjs <websim-dir> <reddit-project-dir> --app <reddit-app-name> [--title T] [--project ID] [--payments auto|on|off]');
    process.exit(1);
}
const JSZip = (await import('jszip')).default;

// The generator imports its parsers from esm.sh (it runs in the browser); map them to
// the packages in cli/node_modules. The copy lives inside cli/ so Node finds them.
const tmp = fs.mkdtempSync(path.join(here, '.work-'));
const src = path.join(tmp, 'src');
fs.cpSync(path.join(here, '..', 'src'), src, { recursive: true });
const URL_IMPORTS = {
    'https://esm.sh/acorn@8.11.3': 'acorn', 'https://esm.sh/acorn-walk@8.3.2': 'acorn-walk',
    'https://esm.sh/magic-string@0.30.5': 'magic-string', 'https://esm.sh/jszip@3.10.1': 'jszip',
};
const rewrite = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { rewrite(p); continue; }
        if (!p.endsWith('.js')) continue;
        let t = fs.readFileSync(p, 'utf8');
        for (const [u, n] of Object.entries(URL_IMPORTS)) t = t.split(u).join(n);
        fs.writeFileSync(p, t);
    }
};
rewrite(src);
globalThis.window ??= globalThis;

// Read the game.
const files = {};
const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'AGENT.md' || e.name === 'node_modules') continue;
        const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p, r); else files[r] = new Uint8Array(fs.readFileSync(p));
    }
};
walk(path.resolve(gameDir));
let manifest = {};
try { manifest = JSON.parse(fs.readFileSync(path.join(gameDir, '.websim.json'), 'utf8')); } catch {}
const projectId = flag('project', manifest.projectId || 'local');
const title = flag('title', appName);
const meta = { project: { id: projectId, slug: appName, title, current_version: manifest.baseVersion || 1, owner: { username: 'api' } } };

const { generateDevvitZip } = await import(pathToFileURL(path.join(src, 'generator.js')).href);
const pullScript = fs.readFileSync(path.join(here, '..', 'pull.mjs'), 'utf8');
const res = await generateDevvitZip(meta, files, true, flag('launch', 'inline'), { appName, pullScript, payments: flag('payments', 'auto'), quality: flag('quality', null) });
const zip = await JSZip.loadAsync(await res.blob.arrayBuffer());

// Write it out, keeping what the Devvit CLI and people own.
const out = path.resolve(outDir);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
// marketingAssets is the app icon you add yourself (keep the file outside src/, scripts/ and assets/,
// which are regenerated, e.g. marketing/icon.png).
const keepJson = { 'package.json': ['version', 'license'], 'devvit.json': ['dev', 'marketingAssets'] };
const keepFiles = new Set(['README.md', 'DEVELOPMENT.md']);
const old = Object.fromEntries(Object.keys(keepJson).map((f) => [f, readJson(path.join(out, f))]));
for (const dir of ['src', 'scripts', 'assets']) fs.rmSync(path.join(out, dir), { recursive: true, force: true });
let written = 0;
for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const dest = path.join(out, name);
    if (keepFiles.has(name) && fs.existsSync(dest)) {
        // A kept README still gets the current "Fetch Domains" section (Reddit's domain review reads it).
        if (name === 'README.md') {
            const section = (t) => t.match(/\n## Fetch Domains\n[\s\S]*?(?=\n## |$)/)?.[0] || '';
            const mine = fs.readFileSync(dest, 'utf8'), fresh = section(await entry.async('string'));
            const without = mine.replace(section(mine), '');
            const merged = fresh ? without.replace(/^(\s*#[^\n]*\n(?:(?!## )[^\n]*\n)*)/, (top) => top + fresh.replace(/^\n/, '') + '\n') : without;
            if (merged !== mine) fs.writeFileSync(dest, merged);
        }
        continue;
    }
    let data = await entry.async('nodebuffer');
    if (keepJson[name] && old[name]) {
        const fresh = JSON.parse(data.toString('utf8'));
        for (const k of keepJson[name]) if (k in old[name]) fresh[k] = old[name][k];
        data = Buffer.from(JSON.stringify(fresh, null, 2) + '\n');
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    written++;
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`✔ ${title} → ${out}  (Reddit app "${res.appName}", ${written} files, payments: ${res.payments ? 'on' : 'off'})`);
if (res.report) {
    const icon = { warn: '⚠', fixed: '🔧', info: 'ℹ', ok: '✓' };
    console.log('Port report (PORT-REPORT.md):');
    for (const f of res.report.findings.filter((x) => x.level !== 'ok')) console.log(`  ${icon[f.level]} ${f.title}${f.fix ? ': ' + f.fix : ''}`);
    console.log(`  hints: ${JSON.stringify(res.report.hints)}`);
}
console.log('Next:');
console.log(`  cd ${JSON.stringify(out)} && npm install && npm run build && npx devvit upload`);
console.log(`  npx devvit install <your_test_subreddit> ${res.appName}@<version>   # test before publishing`);
