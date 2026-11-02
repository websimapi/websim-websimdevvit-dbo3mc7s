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
- **Identity:** `x-websim-user-id` / `x-websim-username` come from the Reddit user.
- **Not supported on Reddit:** the `room` realtime export and `env.AI`.

## File uploads (v12+)

`websim.upload(file)` on Reddit posts the raw bytes to `/api/__upload`:
- Images and GIFs are re-hosted with Devvit `media.upload()` on Reddit's CDN. Reddit apps may only display Reddit-hosted media, and this also runs Reddit's safety checks.
- Other files are stored in Redis and served at `/api/__upload/<id>/<name>`.
- The limit is 4 MB. `permissions.media` is requested only when the code calls `websim.upload`.

## Pull merging (v13+)

`npm run pull` merges Devvit CLI edits automatically (`package.json` version/license, `devvit.json` `dev`). Any other local edit is kept, with the new version saved as `<file>.incoming`.

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

The first run creates the Devvit project. Later runs update it in place: generated files are replaced, and the Devvit CLI's own fields (`package.json` version/license, `devvit.json` dev) and a hand-written README.md or DEVELOPMENT.md are kept.

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
