#!/usr/bin/env node
// Pulls (or updates) a Reddit Devvit project built by the WebSim → Devvit Converter.
//
// First time:   node pull.mjs <link-url> [folder]
// Later:        npm run pull        (inside the project; reads .websim-devvit.json)
//
// Only files that changed are downloaded. Files you edited locally are never
// overwritten: the new version is saved next to them as <file>.incoming.
// Requires Node 18+ (built-in fetch). No other dependencies.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STATE_FILE = '.websim-devvit.json';
const args = process.argv.slice(2);
const force = args.includes('--force');
const positional = args.filter((a) => !a.startsWith('--'));

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const fail = (msg) => { console.error(`\n✖ ${msg}`); process.exit(1); };

let linkUrl = positional.find((a) => /^https?:\/\//.test(a));
let dir = positional.find((a) => !/^https?:\/\//.test(a));

// Inside a pulled project (npm run pull) the link comes from the state file.
const stateIn = (d) => { try { return JSON.parse(fs.readFileSync(path.join(d, STATE_FILE), 'utf8')); } catch { return null; } };
let state = stateIn(dir || '.');
if (!linkUrl) {
  if (!state?.link) fail(`No link given and no ${STATE_FILE} found.\n  Usage: node pull.mjs <link-url> [folder]`);
  linkUrl = state.link;
  dir ||= '.';
}

console.log(`↓ Reading build info from ${linkUrl}`);
const res = await fetch(`${linkUrl.replace(/\/+$/, '')}/manifest`).catch((e) => fail(`Could not reach the converter: ${e.message}`));
if (!res.ok) fail(`The converter answered ${res.status}: ${await res.text()}`);
const manifest = await res.json();
if (!Array.isArray(manifest.files)) fail('The converter returned an unexpected response (no file list).');

dir ||= manifest.app;
fs.mkdirSync(dir, { recursive: true });
state = stateIn(dir) || {};
if (state.link && state.link !== linkUrl && !force) {
  fail(`${dir} is linked to a different converter link (${state.link}).\n  Use another folder, or add --force to relink it.`);
}

const root = path.resolve(dir);
const known = state.files || {};          // path -> sha we last wrote
const snapshots = state.snapshots || {};  // CLI-managed JSON files: content we last wrote
const nextSnapshots = { ...snapshots };

// Fields the Devvit CLI itself writes into these files. If those are the only
// local differences, the new version is taken and the fields are kept.
const CLI_MANAGED = { 'package.json': ['version', 'license'], 'devvit.json': ['dev'] };
const omit = (obj, keys) => { const o = { ...obj }; for (const k of keys) delete o[k]; return o; };

function mergeCliManaged(p, localBuf, incomingBuf) {
  const keys = CLI_MANAGED[p];
  if (!keys) return null;
  try {
    const local = JSON.parse(localBuf.toString('utf8'));
    // Compare with what we last wrote; without a snapshot (older pulls), with
    // the new version itself, which is safe: then nothing else differs.
    const before = JSON.parse(snapshots[p] ?? incomingBuf.toString('utf8'));
    if (JSON.stringify(omit(local, keys)) !== JSON.stringify(omit(before, keys))) return null; // other edits: let the user merge
    const merged = JSON.parse(incomingBuf.toString('utf8'));
    for (const k of keys) if (k in local) merged[k] = local[k];
    return Buffer.from(JSON.stringify(merged, null, 2) + '\n');
  } catch { return null; }
}
const next = {};
const counts = { added: 0, updated: 0, unchanged: 0, kept: 0, removed: 0 };
const kept = [];

const inside = (p) => {
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) fail(`Refusing to write outside the project folder: ${p}`);
  return abs;
};

const download = async (file) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(file.url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (sha1(buf) !== file.sha) throw new Error('checksum mismatch');
      return buf;
    } catch (e) {
      if (attempt === 3) fail(`Download failed for ${file.path}: ${e.message}`);
    }
  }
};

const queue = [...manifest.files];
const worker = async () => {
  for (let file; (file = queue.shift());) {
    const abs = inside(file.path);
    next[file.path] = file.sha;
    const exists = fs.existsSync(abs);
    const local = exists ? sha1(fs.readFileSync(abs)) : null;
    if (local === file.sha) {
      if (CLI_MANAGED[file.path] && nextSnapshots[file.path] === undefined) nextSnapshots[file.path] = fs.readFileSync(abs, 'utf8');
      counts.unchanged++;
      continue;
    }
    // Edited locally since the last pull: keep the user's version.
    const editedLocally = exists && !force && (known[file.path] ? local !== known[file.path] : true);
    const buf = await download(file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (CLI_MANAGED[file.path]) nextSnapshots[file.path] = buf.toString('utf8');
    const merged = editedLocally ? mergeCliManaged(file.path, fs.readFileSync(abs), buf) : null;
    if (merged) {
      fs.writeFileSync(abs, merged);
      next[file.path] = sha1(merged);
      counts.updated++;
    } else if (editedLocally) {
      fs.writeFileSync(`${abs}.incoming`, buf);
      next[file.path] = known[file.path] || local;
      kept.push(file.path);
      counts.kept++;
    } else {
      fs.writeFileSync(abs, buf);
      counts[exists ? 'updated' : 'added']++;
    }
  }
};
await Promise.all(Array.from({ length: 6 }, worker));

// Files the converter no longer produces: remove them unless edited locally.
for (const [p, sha] of Object.entries(known)) {
  if (p in next) continue;
  const abs = inside(p);
  if (!fs.existsSync(abs)) continue;
  if (sha1(fs.readFileSync(abs)) === sha || force) { fs.rmSync(abs); counts.removed++; }
  else { next[p] = sha; kept.push(`${p} (no longer generated)`); }
}

const pkgChanged = (known['package.json'] || null) !== (next['package.json'] || null);
fs.writeFileSync(path.join(root, STATE_FILE), JSON.stringify({
  link: linkUrl, app: manifest.app, title: manifest.title, source: manifest.source,
  version: manifest.version, buildId: manifest.buildId, pulledAt: new Date().toISOString(), files: next, snapshots: nextSnapshots,
}, null, 2));

console.log(`\n✔ ${manifest.title} → ${dir}  (WebSim v${manifest.version}, Reddit app "${manifest.app}")`);
console.log(`  ${counts.added} added · ${counts.updated} updated · ${counts.unchanged} unchanged · ${counts.removed} removed` + (counts.kept ? ` · ${counts.kept} kept` : ''));
if (kept.length) {
  console.log('\n  You edited these files, so they were left as they are. The new version is in <file>.incoming:');
  for (const k of kept) console.log(`   - ${k}`);
}
const cd = dir === '.' ? '' : `cd ${JSON.stringify(dir)} && `;
const needInstall = pkgChanged || !fs.existsSync(path.join(root, 'node_modules'));
console.log('\nNext:');
if (needInstall) console.log(`  ${cd}npm install`);
console.log(`  ${cd}npx devvit upload      # first time: npx devvit login`);
console.log('  Later updates: npm run pull, then npx devvit upload');
