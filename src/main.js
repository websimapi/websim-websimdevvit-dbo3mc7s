import {
    parseProjectIdentifier,
    fetchProjectMetadata,
    getProjectById,
    getAllProjectRevisions,
    getAssets,
    getProjectHtml,
    processAssets
} from './websim-api.js';

import { generateDevvitZip, defaultAppName } from './generator.js';
import { APP_NAME_PATTERN, DEVVIT_VERSION } from './templates.js';
import { listLinks, saveLink, deleteLink, uploadBuild } from './server-api.js';
import JSZip from 'jszip';

// Simple file save helper to avoid dependency issues
const saveAs = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};

const $ = (id) => document.getElementById(id);

// DOM Elements
const inputEl = $('project-input');
const btnFetch = $('btn-fetch');
const btnProcessZip = $('btn-process-zip');
const zipInput = $('zip-input');
const stepInput = $('step-input');
const stepVersion = $('step-version');
const stepResult = $('step-result');
const versionSelect = $('version-select');
const appNameInput = $('app-name');
const appNameError = $('app-name-error');
const launchModeSelect = $('launch-mode');
const paymentsSelect = $('payments-mode');
const includeReadmeBox = $('include-readme');
const btnBuild = $('btn-build');
const loading = $('loading');
const loadingText = $('loading-text');
const errorEl = $('fetch-error');
const buildErrorEl = $('build-error');
const projectTitle = $('project-title');
const projectAuthor = $('project-author');
const projectThumb = $('project-thumb');
const tabBtns = document.querySelectorAll('.tab-btn');
const linksList = $('links-list');

$('devvit-version').textContent = DEVVIT_VERSION;

let currentProjectMeta = null;
let uploadedAssets = null; // For zip upload mode
let links = [];            // saved Reddit apps (null when signed out)
let lastResult = null;     // last generated build, for the zip fallback

// Tab Handling
tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('.mode-content').forEach(el => el.classList.add('hidden'));
        $(`mode-${btn.dataset.mode}`).classList.remove('hidden');

        errorEl.classList.add('hidden');
    });
});

// Helper: Show/Hide Loading
const toggleLoading = (show, text = 'Processing...') => {
    loadingText.textContent = text;
    loading.classList.toggle('hidden', !show);
};

const showError = (el, msg) => {
    el.textContent = msg;
    el.classList.toggle('hidden', !msg);
};

const showStep = (step) => {
    for (const s of [stepInput, stepVersion, stepResult]) s.classList.toggle('hidden', s !== step);
};

const linkForProject = (projectId) => (links || []).find(l => l.projectId === projectId);

// ---------- Saved Reddit apps ----------

async function refreshLinks() {
    const res = await listLinks();
    links = res.signedIn ? res.links : null;
    $('links-signin').classList.toggle('hidden', res.signedIn);
    $('links-empty').classList.toggle('hidden', !res.signedIn || res.links.length > 0);
    renderLinks();
    // Check each project's live version so outdated apps show an Update badge.
    for (const link of links || []) {
        getProjectById(link.projectId)
            .then(meta => { link.liveVersion = meta?.project?.current_version; renderLinks(); })
            .catch(() => {});
    }
}

function renderLinks() {
    linksList.replaceChildren();
    for (const link of links || []) {
        const li = document.createElement('li');
        li.className = 'link-row';

        const main = document.createElement('div');
        main.className = 'link-main';
        const title = document.createElement('div');
        title.className = 'link-title';
        title.textContent = link.title || link.projectId;
        const meta = document.createElement('div');
        meta.className = 'link-meta';
        meta.textContent = `Reddit app "${link.appName}" · built from v${link.latestVersion ?? '–'}`;
        main.append(title, meta);

        const badge = document.createElement('span');
        const outdated = link.liveVersion && link.latestVersion && link.liveVersion > link.latestVersion;
        if (!link.latestBuildId) { badge.className = 'badge'; badge.textContent = 'not built'; }
        else if (outdated) { badge.className = 'badge new'; badge.textContent = `v${link.liveVersion} available`; }
        else if (link.liveVersion) { badge.className = 'badge ok'; badge.textContent = 'up to date'; }
        if (badge.textContent) main.append(document.createTextNode(' '), badge);

        const actions = document.createElement('div');
        actions.className = 'link-actions';
        const update = document.createElement('button');
        update.className = outdated || !link.latestBuildId ? 'success-btn' : 'ghost-btn';
        update.type = 'button';
        update.textContent = outdated ? `Update to v${link.liveVersion}` : (link.latestBuildId ? 'Rebuild' : 'Build');
        update.addEventListener('click', () => quickBuild(link));
        const open = document.createElement('button');
        open.className = 'ghost-btn';
        open.type = 'button';
        open.textContent = 'Settings';
        open.addEventListener('click', () => { inputEl.value = link.projectId; fetchProject(); });
        const remove = document.createElement('button');
        remove.className = 'ghost-btn';
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.addEventListener('click', async () => {
            if (remove.dataset.armed !== 'yes') { remove.dataset.armed = 'yes'; remove.textContent = 'Click again to remove'; return; }
            await deleteLink(link.id).catch(e => showError(errorEl, e.message));
            refreshLinks();
        });
        actions.append(update, open, remove);

        li.append(main, actions);
        linksList.append(li);
    }
}

$('btn-refresh-links').addEventListener('click', refreshLinks);

// ---------- 1. Fetch project ----------

async function fetchProject() {
    const rawInput = inputEl.value.trim();
    if (!rawInput) return showError(errorEl, "Enter a WebSim project URL or ID.");

    showError(errorEl, '');
    uploadedAssets = null;
    toggleLoading(true, 'Fetching project details...');

    try {
        const identifier = parseProjectIdentifier(rawInput);
        const meta = await fetchProjectMetadata(identifier);
        if (!meta || !meta.project) throw new Error("Project not found.");
        currentProjectMeta = meta;

        projectTitle.textContent = meta.project.title || 'Untitled project';
        const owner = meta.project.created_by?.username || meta.project.owner?.username;
        projectAuthor.textContent = owner ? `by @${owner}` : '';
        const thumb = meta.project.thumbnail_url || meta.project_revision?.current_screenshot_url;
        projectThumb.classList.toggle('hidden', !thumb);
        if (thumb) projectThumb.src = thumb;

        toggleLoading(true, 'Fetching version history...');
        const revisions = await getAllProjectRevisions(meta.project.id);

        versionSelect.innerHTML = '';
        versionSelect.disabled = false;
        const live = meta.project.current_version;
        versionSelect.append(new Option(`Live version (v${live})`, live));
        revisions
            .map(r => r.project_revision || r)
            .filter(r => r.version && r.version !== live)
            .sort((a, b) => b.version - a.version)
            .forEach(rev => {
                const date = rev.created_at ? new Date(rev.created_at).toLocaleDateString() : '';
                versionSelect.append(new Option(`v${rev.version}${date ? ' · ' + date : ''}${rev.draft ? ' (draft)' : ''}`, rev.version));
            });

        // Reuse a saved app's name and settings so updates go to the same Reddit app.
        const saved = linkForProject(meta.project.id);
        appNameInput.value = saved?.appName || defaultAppName(meta.project);
        launchModeSelect.value = saved?.settings?.launchMode || 'inline';
        paymentsSelect.value = saved?.settings?.payments || 'auto';
        includeReadmeBox.checked = saved?.settings?.includeReadme ?? true;
        appNameInput.disabled = false;
        validateAppName();
        showError(buildErrorEl, '');
        showStep(stepVersion);
    } catch (err) {
        showError(errorEl, err.message || "Failed to fetch project.");
        console.error(err);
    } finally {
        toggleLoading(false);
    }
}

btnFetch.addEventListener('click', fetchProject);
inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') fetchProject(); });

function validateAppName() {
    const v = appNameInput.value.trim();
    const ok = APP_NAME_PATTERN.test(v);
    showError(appNameError, ok ? '' : 'Use 3–20 characters: lowercase letters, numbers and hyphens, starting with a letter.');
    btnBuild.disabled = !ok;
    return ok;
}
appNameInput.addEventListener('input', validateAppName);

// ---------- 2. Zip upload ----------

btnProcessZip.addEventListener('click', async () => {
    const file = zipInput.files[0];
    if (!file) return showError(errorEl, "Choose a .zip file first.");

    toggleLoading(true, 'Reading zip file...');
    showError(errorEl, '');

    try {
        const zip = await JSZip.loadAsync(file);
        const assets = {};
        const promises = [];
        zip.forEach((relativePath, zipEntry) => {
            if (zipEntry.dir) return;
            promises.push((async () => {
                const isText = /\.(html|js|css|json|txt|md)$/i.test(relativePath);
                assets[relativePath] = await zipEntry.async(isText ? 'string' : 'uint8array');
            })());
        });
        await Promise.all(promises);
        uploadedAssets = assets;

        currentProjectMeta = {
            project: {
                id: 'imported-zip',
                slug: 'imported-game',
                title: file.name.replace(/\.zip$/i, ''),
                current_version: '1',
                owner: { username: 'you' }
            }
        };

        projectTitle.textContent = currentProjectMeta.project.title;
        projectAuthor.textContent = "Imported from zip";
        projectThumb.classList.add('hidden');
        versionSelect.innerHTML = '<option value="zip">Uploaded zip content</option>';
        versionSelect.disabled = true;
        appNameInput.value = defaultAppName({ slug: currentProjectMeta.project.title, id: 'zip0' });
        validateAppName();
        showStep(stepVersion);
    } catch(err) {
        showError(errorEl, "Couldn't read the zip: " + err.message);
        console.error(err);
    } finally {
        toggleLoading(false);
    }
});

// ---------- 3. Build ----------

async function collectAssets(meta, version) {
    toggleLoading(true, 'Downloading files from WebSim...');
    const [assetList, htmlContent] = await Promise.all([
        getAssets(meta.project.id, version),
        getProjectHtml(meta.project.id, version).catch(() => null),
    ]);
    if (!assetList?.length) throw new Error(`No files found for v${version}. Check that the project is public.`);
    toggleLoading(true, `Downloading ${assetList.length} files...`);
    const assets = await processAssets(assetList, meta.project.id, version);

    // Untitled projects (e.g. forks made with websim-cli) use the page's <title>.
    if (!meta.project.title && assets['index.html']) {
        const html = new TextDecoder().decode(assets['index.html']);
        const title = html.match(/<title>([^<]{1,120})<\/title>/i)?.[1]?.trim();
        if (title) meta.project.title = title;
    }

    if (!assets['index.html']) {
        if (htmlContent) {
            assets['index.html'] = new TextEncoder().encode(htmlContent);
        } else {
            const anyHtml = Object.keys(assets).find(k => k.endsWith('.html'));
            if (!anyHtml) throw new Error("This project has no index.html, so there is nothing for Reddit to open.");
            assets['index.html'] = assets[anyHtml];
        }
    }
    return assets;
}

let pullScriptText = null;
async function getPullScript() {
    if (pullScriptText === null) {
        pullScriptText = await fetch('./pull.mjs', { cache: 'no-store' }).then(r => r.ok ? r.text() : '').catch(() => '');
    }
    return pullScriptText;
}

async function build({ meta, version, appName, settings }) {
    const assets = uploadedAssets || await collectAssets(meta, version);

    toggleLoading(true, 'Converting for Reddit...');
    const result = await generateDevvitZip(meta, assets, settings.includeReadme, settings.launchMode, {
        appName,
        payments: settings.payments,
        pullScript: await getPullScript(),
    });
    lastResult = result;

    // Zip imports and signed-out visitors get the download only.
    if (uploadedAssets || links === null) {
        showZipOnly(result, links === null ? 'Sign in to WebSim to get a pull command that keeps this folder updated.' : 'Zip imports are download only.');
        return;
    }

    toggleLoading(true, 'Saving your Reddit app...');
    const link = await saveLink({ projectId: meta.project.id, title: meta.project.title, appName, settings });
    const uploaded = await uploadBuild(link.id, Number(version), result.files, (done, total) => {
        toggleLoading(true, total ? `Uploading changed files... ${done}/${total}` : 'Recording build...');
    });
    showPullResult(uploaded, result);
    refreshLinks();
}

btnBuild.addEventListener('click', async () => {
    if (!currentProjectMeta || !validateAppName()) return;
    showError(buildErrorEl, '');
    try {
        await build({
            meta: currentProjectMeta,
            version: versionSelect.value,
            appName: appNameInput.value.trim(),
            settings: {
                launchMode: launchModeSelect.value,
                payments: paymentsSelect.value,
                includeReadme: includeReadmeBox.checked,
            },
        });
    } catch (err) {
        console.error(err);
        showError(buildErrorEl, err.message || 'The build failed.');
    } finally {
        toggleLoading(false);
    }
});

// One-click rebuild of a saved app at its project's live version.
async function quickBuild(link) {
    showError(errorEl, '');
    uploadedAssets = null;
    try {
        toggleLoading(true, `Fetching ${link.title || link.projectId}...`);
        const meta = await getProjectById(link.projectId);
        currentProjectMeta = meta;
        await build({ meta, version: meta.project.current_version, appName: link.appName, settings: link.settings });
    } catch (err) {
        console.error(err);
        showError(errorEl, `Update failed: ${err.message}`);
        showStep(stepInput);
    } finally {
        toggleLoading(false);
    }
}

// ---------- Results ----------

const quote = (s) => /^[A-Za-z0-9._-]+$/.test(s) ? s : JSON.stringify(s);

function showPullResult({ link, changes, firstBuild }, result) {
    const origin = location.origin;
    const folder = link.appName;
    $('result-title').textContent = `${link.title || 'Your app'} is ready for Reddit`;
    const n = Object.keys(result.files).length;
    $('result-summary').textContent = firstBuild
        ? `${n} files built for the Reddit app "${link.appName}" from v${link.latestVersion}.`
        : `Built v${link.latestVersion} for "${link.appName}": ${changes.added.length} added, ${changes.changed.length} changed, ${changes.removed.length} removed.`
          + (result.payments ? ' Reddit Gold tips are included.' : '');
    $('cmd-first').textContent = `curl -fsSL ${origin}/pull.mjs -o pull.mjs && node pull.mjs ${link.pullUrl} ${quote(folder)}`;
    $('cmd-first-ps').textContent = `iwr ${origin}/pull.mjs -OutFile pull.mjs; node pull.mjs ${link.pullUrl} ${quote(folder)}`;
    $('cmd-update').textContent = `cd ${quote(folder)} && npm run pull && npx devvit upload`;

    const list = $('changes-list');
    list.replaceChildren();
    const rows = firstBuild ? [] : [
        ...changes.added.map(p => `+ ${p}`), ...changes.changed.map(p => `~ ${p}`), ...changes.removed.map(p => `− ${p}`),
    ];
    for (const r of rows.length ? rows : [firstBuild ? 'First build: every file is new.' : 'Nothing changed since the last build.']) {
        const li = document.createElement('li');
        li.textContent = r;
        list.append(li);
    }
    $('result-pull').classList.remove('hidden');
    $('result-zip-only').classList.add('hidden');
    showStep(stepResult);
}

function showZipOnly(result, why) {
    $('result-title').textContent = 'Your Reddit project is ready';
    $('result-summary').textContent = `${Object.keys(result.files).length} files for the Reddit app "${result.appName}".`;
    $('result-pull').classList.add('hidden');
    const note = $('result-zip-only');
    note.textContent = `${why} Unzip it, then run: npm install && npx devvit upload`;
    note.classList.remove('hidden');
    showStep(stepResult);
}

$('btn-download').addEventListener('click', () => { if (lastResult) saveAs(lastResult.blob, lastResult.filename); });
$('btn-new').addEventListener('click', () => { inputEl.value = ''; showStep(stepInput); });
$('btn-back').addEventListener('click', () => showStep(stepInput));

document.querySelectorAll('.copy-btn').forEach(btn => btn.addEventListener('click', async () => {
    const text = $(btn.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
    catch {
        const range = document.createRange();
        range.selectNodeContents($(btn.dataset.copy));
        getSelection().removeAllRanges(); getSelection().addRange(range);
        btn.textContent = 'Selected';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
}));

refreshLinks();
