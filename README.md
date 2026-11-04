# WebSim → Devvit Converter (v2 fork)

Fork of `q94p2qfvrvydb_o3mc7s` (v48), built for **Devvit 0.15.1** (October 2026).

## What changed from v1

| Area | v1 | v2 |
|---|---|---|
| Getting the result | .zip download only | Build is stored on this project's `server.js`. One command pulls it, and `npm run pull` fetches later updates (changed files only). The .zip is still available. |
| Reddit app name | Always auto-generated (`slug-xxxx`), so every port could become a new app | You choose it, and it's saved per app. Use your existing app's name to update it. |
| Source download | Text files went through an API route that fails outside WebSim; binaries used the bare filename (broke subfolders); `index.html` often came back as a wrapper page | Every file comes from `https://<id>.c.websim.com/<path>?v=<v>&raw=1`: exact bytes, `.jsx` untranspiled. Verified identical to `websim-cli pull`. |
| Version picker | Older versions showed as "vundefined" | Lists every revision |
| Devvit deps | `latest` for everything, plus deprecated `@devvit/public-api`, `@devvit/kit` | Pinned `devvit` / `@devvit/web` 0.15.1. No `public-api` (`Devvit.configure` removed). |
| devvit.json | Deprecated `inline`; no `scripts`; payments without `permissions.payments` | No `inline`; `scripts.build` / `scripts.dev` so the CLI builds before upload and playtest; `permissions.payments` matches the products. |
| Payments | Auto-detected only (broad regex) | Auto, Always or Never |
| server.js / database apps | Not supported | Runs on Devvit (SQLite in Redis, blobs, Reddit identity) |
| `websim.upload` on Reddit | Images became session-only `blob:` URLs | Images on Reddit's CDN; other files stored by the app |

## How a port works

1. **Browser** (`src/main.js`): fetch the project and convert it (`src/generator.js`), then hash every output file and upload only the files the server doesn't have (`src/server-api.js`).
2. **Server** (`server.js`, routes under `/api/dv/`):
   - `dv_links`: one row per user and Reddit app, with a stable id that gives a stable pull URL.
   - `dv_blobs`: files by SHA-1, with bytes stored in `env.BLOB`.
   - `dv_builds` / `dv_build_files`: one manifest per conversion. The last 10 are kept.
3. **Terminal** (`pull.mjs`): `node pull.mjs <link-url> <folder>` the first time. It writes `.websim-devvit.json` so `npm run pull` works afterwards. Files edited locally are never overwritten; the new copy goes to `<file>.incoming`.

## WebSim server.js apps (v10+)

If a project has a root `server.js` (Websim's `export default { fetch(request, env) }` with `env.DB` / `env.BLOB`), the converter copies it and everything it imports into `src/server/websim/` and runs it inside the Devvit server:
- **env.DB:** SQLite via sql.js 1.13.0 (WebAssembly inlined at build time). The database file lives in Redis in 400 KB chunks and is saved with a versioned `watch`/`multi` transaction; a request is re-run on conflict, up to 5 times.
- **env.BLOB:** `put(name, bytes)` stores in Redis and returns `/api/__websim_blob/<id>/<name>`.
- **Identity:** `x-websim-user-id` / `x-websim-username` come from the Reddit user. `env.USERS.name(id)` looks up any Reddit user's current username (`t2_…` id), so servers can show usernames without storing them.
- **Not supported on Reddit:** `env.AI`. The `room` realtime export: see "Realtime rooms" below.

## Port doctor (v50+)

Every conversion runs `src/doctor.js` over the game and writes **PORT-REPORT.md** into the Reddit project (the web page shows it under "Port report"; the CLI prints it). ⚠️ needs a change in the game, 🔧 handled by the port, ℹ️ worth knowing.

It checks: total and per-file size, uncompressed 3D models, WebGPU without a WebGL fallback, Websim AI calls (and whether each checks the API exists), server.js and its realtime room, fetches to other sites, and inline-feed concerns (scroll areas, pointer lock).

What it does on its own:
- Every port gets `window.__portHints = { platform, view, quality, ai, room }`. For games over 15 MB, `quality` is `"lite"`; a game can read it (or `?quality=`) to load lighter assets. `--quality lite` forces it.
- AI calls that don't check the API exists get a `websim.chat` / `imageGen` / `textToSpeech` that fails at once, so they reach their own fallback instead of throwing. Games that check first see no AI and fall back straight away.
- Node scripts shipped with a game (anything importing `node:` modules, e.g. `tools/*.mjs`) are left out of the client.

## Realtime rooms: server.js `room` (v50+)

`export const room = { onConnect, onMessage, onClose, onTick, tickMs }` runs on the Devvit server (`templates/server/websim-room.js`), one room per Reddit post. The browser's `WebsimSocket.joinRoom()` (`polyfills/socket/room.js`) posts messages to `/api/__room/*` in order and in batches, and gets replies on Devvit realtime: its own channel for `conn.send` and for `room.broadcast(msg, { except })`, a shared channel for plain broadcasts. Pings every 3 s keep a connection and drive `onTick`; 30 s without one calls `onClose`.

A Devvit request can land on any server instance, so each room event runs under a short Redis lock. If the room also exports `saveState()` (return its state) and `loadState(state)`, that state is saved to Redis after every event and restored on whichever instance runs the next one; Maps, Sets and conn objects inside it are handled. Without the hooks the state lives in one instance's memory, and the report warns. Database writes made in room handlers are replayed if another request saved the database first.

Messages go up over HTTP, so a room is slower than a websocket: fine for lobbies and turn-based traffic, to be measured for fast real-time play.

## Outside services and secrets in server.js (v51+)

For games whose server talks to an outside database or API (for example Supabase):
- **Domains:** every `https://host` string in `server.js` is requested in `devvit.json` (`permissions.http.domains`) and listed under **Fetch Domains** in the Reddit app's README, which Reddit's domain review reads. Write the reason in `server.js` as `// Fetch domain api.example.com: what it's for`; the converter copies it in, and keeps the section current in a README you've edited. Reddit reviews each domain on upload (usually 1-2 business days) and only approves public APIs and some cloud providers (Supabase, Firebase, SpacetimeDB, S3, Google Cloud Storage); the app also needs terms and privacy links. Until approval those fetches fail, so the game needs a fallback.
- **Secrets:** `await env.SECRETS?.get('NAME')` in `server.js` reads a Devvit app secret on Reddit. Each name found becomes a secret setting in `devvit.json`; set it once after the first install with `npx devvit settings set NAME`. On Websim `env.SECRETS` is undefined (Websim has no server secrets).
- **`env.PLATFORM`** is `'reddit'` on Devvit and undefined on Websim, so one `server.js` can tell them apart.

The port doctor lists both in PORT-REPORT.md.

## File uploads (v12+)

`websim.upload(file)` on Reddit posts the raw bytes to `/api/__upload`:
- Images and GIFs are re-hosted with Devvit `media.upload()` on Reddit's CDN. Reddit apps may only display Reddit-hosted media, and this also runs Reddit's safety checks.
- Other files are stored in Redis and served at `/api/__upload/<id>/<name>`.
- The limit is 4 MB. `permissions.media` is requested only when the code calls `websim.upload`.

## Pull merging (v13+)

`npm run pull` merges Devvit CLI edits automatically (`package.json` version/license, `devvit.json` `dev` and `marketingAssets`). Any other local edit is kept, with the new version saved as `<file>.incoming`.

## Launch modes (v20: inline is the default again)

Reddit allows only taps inside a post in the feed: no drags, no scrolling inside the post, no scroll traps (`touch-action: none` or `overscroll-behavior: none` on the page, or `preventDefault` on wheel/touch). Games that need gestures belong in expanded mode. The **live** mode:

- `devvit.json` gets `default` (inline, `inline: true`) and `game` (expanded), both pointing at the game's `index.html`.
- Inline, a guard (`polyfills/stubs/inline.js`) shows the game as its live title screen and makes the page feed-friendly (`touch-action: pan-y`, no inner scrolling or scroll bars). Drags and keys don't reach the game, and it never calls `preventDefault`, so the feed keeps scrolling. A tap calls `requestExpandedMode(event, 'game')`.
- Expanded, the game runs as it does on Websim, with full gestures.
- A game can hide the "Tap to play" badge with `<meta name="devvit-inline-hint" content="none">`, or change its text with `content="…"`.

**Inline** (the default) plays the game in the post, as on Websim. The same guard makes the page feed-friendly (`touch-action: pan-y`, no inner scrolling, no scroll bars), but taps and sideways drags reach the game. **Expanded** uses a static launcher page.

The owner prefers inline: live mode's pop-out felt off, and every tap in the post opened the game, so its buttons couldn't work. Reddit's featuring checklist asks for tap-only input inline, so games with drag controls may need live mode if they apply for featuring.

## Command line (v17+)

`cli/convert.mjs` runs the same generator from a terminal on a local copy of a Websim project. Agents and scripts use this, for example Splashy Bear's `tools/port/reddit.sh`:

```
npm install --prefix cli                       # once
node cli/convert.mjs <websim-folder> <reddit-project-folder> --app <reddit-app> [--title T] [--payments auto|on|off] [--launch live|inline|expanded]
cd <reddit-project-folder> && npm install && npm run build && npx devvit upload
npx devvit install <test_subreddit> <reddit-app>@<version>
```

The first run creates the Devvit project. Later runs update it in place: generated files are replaced, and the Devvit CLI's own fields (`package.json` version/license, `devvit.json` dev), your `devvit.json` `marketingAssets` and a hand-written README.md or DEVELOPMENT.md are kept.

**App icon:** Reddit shows `marketingAssets.icon` (a 1024×1024 PNG, at most 500 KB) on the app's page. Put the file at `marketing/icon.png` in the Devvit project, not in `assets/`, `src/` or `scripts/` (those are regenerated), and add `"marketingAssets": { "icon": "marketing/icon.png" }` to `devvit.json` once.

## itch.io (v51+)

`cli/itch.mjs` turns a Websim game, or a Unity WebGL build, into an itch.io HTML5 upload:

```bash
npm install --prefix cli
node cli/itch.mjs <websim-folder> <out-folder> --game <slug> --zip <game-html5.zip> [--push <user>/<game>:html5 --version 1.0.0]
```

itch.io only serves static files and gives HTML5 games no user identity. So Websim games get `src/templates/itch/itch-shim.js`, loaded first in `<head>`:

- **Player:** a random id kept in localStorage. There is no username, so games should show a generated name.
- **`server.js`** runs in the page. Same-origin `/api/*` requests go to its `fetch()`, with:
  - `env.DB`: the D1-style API over sql.js, saved to IndexedDB, with the schema applied when it changes;
  - `env.BLOB`: files in IndexedDB;
  - `env.PLATFORM = 'itch'`.

  The server's own requests to other sites, such as Supabase, go out as usual.
- **`WebsimSocket` collections** are kept on the device. Presence and multiplayer do nothing.
- `websim.chat`, `imageGen`, `textToSpeech` and `postComment` stay undefined, so games hide AI and tips.

The CLI also:

- rewrites root paths (`"/music.ogg"`) to relative ones, because itch serves games from a subfolder;
- checks itch's limits: 1,000 files, 500 MB in total, 200 MB per file, 240-character paths;
- zips the build with `index.html` at the root;
- runs butler with `--push`. The owner runs `butler login` first.

`cli/itch-test.mjs` boots a build from `/html/<id>/`, the way itch serves it, and reports page errors and missing files.

Port Devvit games from their Websim source. On the itch page:

- set **Kind of project: HTML**;
- tick **played in the browser**;
- pick the embed size and **Mobile friendly**.

## Port fixes (v15–v17)

- **Downloads on Reddit:** `<a download>` goes through the device share sheet when it accepts files. Otherwise images and videos can be **shared to the post's thread as a comment** (v21):
  - `media.upload` only accepts images and GIFs, so a video is turned into an animated GIF in the browser first (gifenc: its last ~12 s, 240 px wide, shrinking until it's under 15 MB).
  - The player confirms, the file is uploaded in chunks (4 MB request limit), re-hosted with `media.upload` (`type: 'gif'`) and commented inside a rich-text paragraph, as the player.
  - If commenting as the player isn't allowed it posts as the app, and failing that a text comment with the link.
  - The whole clip is used (v22): long clips get fewer frames per second and a smaller picture (240 px / 8 fps down to 120 px / 2 fps) until the GIF is under 9 MB. That covers roughly 2 minutes at the top setting and around 9 minutes at 160 px / 4 fps.
  - **For game code** (v23), the Remotion games use these:
    - `window.__gifenc`: the GIF encoder.
    - `window.__devvitAskToShare(title, text)`: the confirm prompt.
    - `window.__devvitShareToThread(gif, text, { data, linkText })`: posts the comment.
    - `window.__devvitShareData`: the data from the link someone opened.

    Splashy Bear, Infinite Stacker and Circle Tap draw their GIF straight from their replay data and show **Share to thread** instead of a download button on Reddit.
  - **Link back into the game** (v22): `__devvitShareToThread(blob, text, { data, linkText })` adds a link to this post with `?devvitshare={"userData": data}` (up to 1,024 chars). When someone opens it, the game reads `window.__devvitShareData` (from `getShareData()`), so it can play the shared replay itself in full quality. A game can set the comment text with `<a download data-share-text="…">`. Other files are re-hosted and opened with `navigateTo`.
- **Exact CDN versions** (v19): `remotion@4.0.350` installs 4.0.350, not the newest 4.x.
- **Asset folders are kept** (`assets/models/x.glb` stays there), so paths a game builds at runtime still work. HTML paths are rewritten in one pass; before, they could stack up as `/assets/ui//assets/ui/...`.
- **Library versions in CDN links are honoured** (`tween.js@18.6.4`, `three@0.160.0`). A newer major made Splashy Bear's held fish jitter.
- **The client builds for ES2022**, so top-level `await` works.
- **Gold tip product icons** are built in. The old download link was dead, and Devvit refuses an upload whose products name missing images.

## Websim runtime facts this design depends on (measured 2026-11-02)

- `server.js` routes are reachable from any terminal at `https://<id>.c.websim.com/api/dv/...`.
- `server.js` **cannot** fetch `api.websim.com` or `*.c.websim.com` (HTTP 522), so the browser does the WebSim download.
- Bound SQL parameters are limited to 128 KB, so file bytes go in `env.BLOB.put(filename, bytes)`, which returns `{ url, id }` on `api.websim.com/blobs/`.
- Request bodies of 5 MB are accepted. Per-file limit here is 20 MB, per-build 150 MB.

## Tests

The test harness lives outside the project (it needs npm packages). It runs the generator on real projects, builds the output with Devvit 0.15.1, validates `devvit.json` against the shipped schema, and runs an end-to-end test of `server.js` + `server-api.js` + `pull.mjs` (20 checks), plus bridge (10) and upload (7) tests.
