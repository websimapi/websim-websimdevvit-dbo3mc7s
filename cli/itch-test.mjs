// Boots an itch build served from a subfolder (like itch.io) and reports errors and missing files.
//   PW_DIR=<folder with playwright-core> CHROME=<chrome binary> node cli/itch-test.mjs <build-dir> <screenshot.png>
import { createRequire } from 'node:module';
const { chromium } = createRequire((process.env.PW_DIR || process.cwd()) + '/')('playwright-core');
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const root = process.argv[2], PREFIX = '/html/777';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.mp3': 'audio/mpeg', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };
const srv = createServer(async (q, s) => { let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (!p.startsWith(PREFIX + '/')) { s.writeHead(404); return s.end(); } p = p.slice(PREFIX.length); if (p.endsWith('/')) p += 'index.html'; try { const b = await readFile(join(root, p)); s.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }); s.end(b); } catch { s.writeHead(404); s.end(); } }).listen(8794);
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ['--headless=new', '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
const errors = [], missing = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', (r) => { if (r.status() >= 400) missing.push(r.status() + ' ' + r.url()); });
await page.goto('http://localhost:8794' + PREFIX + '/index.html');
await page.waitForTimeout(8000);
await page.mouse.click(210, 400); await page.waitForTimeout(2000);
const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('itch-port')));
console.log('errors:', errors.length ? errors.slice(0, 6) : 'none'); console.log('missing:', missing.slice(0, 6)); console.log('itch storage keys:', stored);
await page.screenshot({ path: process.argv[3] }); await browser.close(); srv.close();
