import { diagnose } from './doctor.js';
import { GOLD_ICON_PNG_BASE64 } from './templates/gold-icon.js';
import JSZip from 'jszip';
import { 
    cleanName, 
    AssetAnalyzer 
} from './processors.js';

import {
    APP_NAME_PATTERN,
    SQLJS_VERSION,
    generatePackageJson,
    generateDevvitJson,
    generateClientViteConfig,
    generateServerViteConfig,
    tsConfig,
    getMainTs,
    simpleLoggerJs,
    webAudioPolyfill,
    websimSocketPolyfill,
    websimStubsJs,
    websimPackageJs,
    jsxDevProxy,
    avatarInjector,
    validateScript,
    setupScript,
    generateReadme,
    generateLauncherHtml,
    protobufInquireStub
} from './templates.js';

import { generateGoldIcon } from './generator/icons.js';
import { downloadExternalAssets } from './generator/downloader.js';

// The app name Devvit would get if the user doesn't choose one.
export function defaultAppName(project) {
    const safeId = project?.id ? String(project.id).slice(0, 4).toLowerCase().replace(/[^a-z0-9]/g, '0') : '0000';
    const slug = cleanName(project?.slug || "websim-game").toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^[^a-z]+/, '');
    return `${(slug || 'game').slice(0, 11)}-${safeId}`;
}

// options.appName   — devvit.json `name`; reuse your existing app's name to update it instead of creating a new app
// options.payments  — 'auto' (detect tipping code), 'on' or 'off'
// options.pullScript — text of pull.mjs, shipped as scripts/pull.mjs so `npm run pull` fetches updates
// server.js plus the modules it imports by relative path (recursively), as
// { path: content }, or null when the project has no server.js.
function collectWebsimServerFiles(codeFiles) {
    const text = (c) => (c instanceof Uint8Array ? new TextDecoder().decode(c) : String(c));
    if (!codeFiles['server.js']) return null;
    const out = {};
    const queue = ['server.js'];
    while (queue.length) {
        const path = queue.shift();
        if (out[path] || codeFiles[path] === undefined) continue;
        const code = text(codeFiles[path]);
        out[path] = code;
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
        for (const m of code.matchAll(/(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
            const spec = m[1] || m[2];
            const parts = (dir + spec).split('/');
            const resolved = [];
            for (const part of parts) {
                if (part === '..') resolved.pop();
                else if (part !== '.' && part !== '') resolved.push(part);
            }
            queue.push(resolved.join('/'));
        }
    }
    return out;
}

export async function generateDevvitZip(projectMeta, assets, includeReadme = true, launchMode = 'inline', options = {}) {
    const zip = new JSZip();

    const projectSlug = options.appName || defaultAppName(projectMeta.project);
    if (!APP_NAME_PATTERN.test(projectSlug)) {
        throw new Error(`"${projectSlug}" is not a valid Reddit app name: use 3–20 lowercase letters, numbers or hyphens, starting with a letter.`);
    }
    const projectTitle = projectMeta.project.title || "WebSim Game";

    // Initialize Analyzer
    const analyzer = new AssetAnalyzer();
    
    // Separation: Code vs Static Assets
    const codeFiles = {};
    const staticFiles = {}; // These go to src/client/public/
    const urlMap = new Map(); // original -> clean filename

    console.log(`[Generator] Generating Zip. Input files: ${Object.keys(assets).length}`);
    
    // 1. Initial Sort & Clean
    for (const [path, content] of Object.entries(assets)) {
        if (path.includes('..')) continue;

        // Code Files
        if (/\.(html|js|mjs|ts|jsx|tsx|css|json|txt|md)$/i.test(path)) {
            codeFiles[path] = content;
            // Data the game fetch()es at runtime (npc/<id>/soul.md, levels.json…)
            // only reaches the build if it's also a static file, at its exact path.
            const base = path.split('/').pop();
            if (/\.(json|txt|md)$/i.test(path) && !base.startsWith('.') && !/^(package(-lock)?|tsconfig|jsconfig)\.json$/i.test(base)) staticFiles[path] = content;
        } else {
            // Static Assets (Images, Audio, Models). They keep their folders, so
            // paths the game builds at runtime (`assets/models/${id}.glb`) still
            // resolve; literal references are rewritten through urlMap as before.
            const name = path.split('/').pop();
            // URL-safe names stay exactly as they are (case too): paths the game
            // builds at runtime (`models/${name}.glb`) can't be rewritten.
            const clean = path.split('/').map((part) => /^[A-Za-z0-9_.-]+$/.test(part) ? part : cleanName(part)).join('/');
            
            // Avoid overwrite collision
            let finalName = clean;
            let counter = 1;
            while (staticFiles[finalName]) {
                const parts = clean.split('.');
                const ext = parts.pop();
                const base = parts.join('.');
                finalName = `${base}_${counter}.${ext}`;
                counter++;
            }

            staticFiles[finalName] = content;
            
            // Map common ways this file might be referenced
            urlMap.set(path, finalName);           // "Folder/My Song.mp3" -> "folder/my-song.mp3"
            urlMap.set('/' + path, finalName);
            urlMap.set('./' + path, finalName);
            if (!urlMap.has(name)) {               // bare "My Song.mp3" (first file of that name wins)
                urlMap.set(name, finalName);
                urlMap.set('/' + name, finalName);
            }
        }
    }

    // 2. Scan Code for External Audio/Images
    const externalUrls = new Set();
    for (const content of Object.values(codeFiles)) {
        const found = analyzer.scanForAssets(content);
        found.forEach(url => {
            // Ignore if already mapped or looks local
            if (!urlMap.has(url) && !url.startsWith('.') && !url.startsWith('/')) {
                externalUrls.add(url);
            }
        });
    }

    // 3. Download External Assets (Refactored to module)
    // removed const downloadPromises = ...
    // removed await Promise.all(downloadPromises);
    await downloadExternalAssets(externalUrls, staticFiles, urlMap);

    analyzer.setExternalMap(urlMap);

    // 3b. WebSim server.js: it runs on the Devvit server (see templates/server/websim-bridge.js),
    // together with every module it imports by relative path. server.js itself is
    // never shipped to the browser; imported modules may still be shared with the client.
    const websimServerFiles = collectWebsimServerFiles(codeFiles);
    const hasWebsimServer = !!websimServerFiles;
    if (hasWebsimServer) delete codeFiles['server.js'];

    // Node scripts that ship with a project (build tools such as tools/*.mjs) import
    // node: built-ins and never run in the browser: leave them out of the client.
    for (const [path, content] of Object.entries(codeFiles)) {
        if (!/\.(m?js|ts)$/i.test(path)) continue;
        const code = content instanceof Uint8Array ? new TextDecoder().decode(content) : String(content);
        if (/(from\s*|import\(\s*|require\(\s*)['"]node:/.test(code)) {
            delete codeFiles[path];
            console.log(`[Generator] Left out Node script ${path}`);
        }
    }

    // 4. Process Code Files
    const clientFiles = {};

    // Entrypoint Configuration
    let entrypoints = null; // Default handled in config.js if null
    let viteInputs = {};

    if (launchMode === 'live') {
        // The game itself is the inline post (its live title screen, taps only: see
        // polyfills/stubs/inline.js); a tap opens the same page expanded as "game".
        entrypoints = {
            "default": { "entry": "index.html", "height": "tall", "inline": true },
            "game": { "entry": "index.html" }
        };
    } else if (launchMode === 'expanded') {
        const launcherHtml = generateLauncherHtml(projectTitle, projectMeta.project.thumbnail_url);
        clientFiles['launcher.html'] = launcherHtml;

        // Configure Vite Multi-Page App
        viteInputs = {
            default: 'launcher.html',
            game: 'index.html'
        };

        // Configure Devvit Entrypoints
        entrypoints = {
            "default": {
                "entry": "launcher.html",
                "height": "regular", 
                "inline": true
            },
            "game": {
                "entry": "index.html",
                "height": "tall"
            }
        };
    }
    
    for (const [path, content] of Object.entries(codeFiles)) {
        if (/\.(js|mjs|ts|jsx|tsx)$/i.test(path)) {
            clientFiles[path] = analyzer.processJS(content, path);
        } else if (path.endsWith('.html')) {
            const { html, extractedScripts } = analyzer.processHTML(content, path.split('/').pop());
            clientFiles[path] = html;
            
            extractedScripts.forEach(script => {
                const parts = path.split('/');
                parts.pop();
                const dir = parts.join('/');
                const fullPath = dir ? `${dir}/${script.filename}` : script.filename;
                clientFiles[fullPath] = script.content;
            });
        } else if (path.endsWith('.css')) {
            clientFiles[path] = analyzer.processCSS(content, path);
        } else {
            clientFiles[path] = content;
        }
    }

    // 2. Configs
    const hasRemotion = !!analyzer.dependencies['remotion'];
    let hasReact = hasRemotion || !!analyzer.dependencies['react'];
    const hasTailwind = analyzer.hasTailwind;

    // Final check for React if not caught by dependency analysis (handles inline scripts)
    if (!hasReact) {
        for (const content of Object.values(clientFiles)) {
            const code = (content instanceof Uint8Array) ? new TextDecoder().decode(content) : String(content);
            if (/<[A-Z][A-Za-z0-9]*[\s>]/g.test(code) || /className=/g.test(code)) {
                hasReact = true;
                break;
            }
        }
    }

    const extraDevDeps = {};
    if (hasWebsimServer) analyzer.dependencies['sql.js'] = SQLJS_VERSION;

    // 5. Detect Tipping Logic
    let hasTips = false;
    const tipKeywords = [
        /\.purchase\s*\(/, 
        /\bcredits\s*:/, 
        /\bprice\s*:/,
        /\bcost\s*:/,
        /\bamount\s*:/,
        /(?:\.|^|\s)postComment\s*\(/,
        /\b(userTotalTipped|total_tipped|totalTipped)\b/,
        /\btip_(?:5|25|50|100)_gold\b/,
        /window\.purchase/
    ];
    
    // Scan all code content for tipping indications
    let tipsDetected = false;
    for (const content of Object.values(codeFiles)) {
        const str = (content instanceof Uint8Array) ? new TextDecoder().decode(content) : String(content);
        if (tipKeywords.some(rx => rx.test(str))) {
            tipsDetected = true;
            console.log("[Generator] Tipping logic detected.");
            break;
        }
    }
    hasTips = options.payments === 'on' || (options.payments !== 'off' && tipsDetected);

    // 6. Add Payment Product Icons (Gold Fallback) - Only if tips detected
    if (hasTips) {
        // Reddit Gold standards (5, 25, 50, 100, 150, 250, 500, 1000, 2500)
        const validGoldTiers = [5, 25, 50, 100, 150, 250, 500, 1000, 2500];

        // removed async function generateGoldIcon() {} (Moved to icons.js)
        let iconData = null;
        try { iconData = await generateGoldIcon(); } catch (e) {}
        // No canvas (Node) or drawing failed: use the built-in coin icon. Devvit
        // refuses an upload whose products.json names missing images.
        if (!iconData || !iconData.length) {
            iconData = Uint8Array.from(atob(GOLD_ICON_PNG_BASE64), (c) => c.charCodeAt(0));
        }

        // Populate the /assets directory at the project root
        // We ALWAYS create the folder and at least one file if hasTips is true to avoid Devvit CLI "missing dir" errors
        const assetsFolder = zip.folder("assets");
        const prodFolder = assetsFolder.folder("products");

        if (iconData) {
            // Map the generated icon to all standard tip increments defined in products.json
            validGoldTiers.forEach(amount => {
                prodFolder.file(`tip_${amount}.png`, iconData);
            });
        } else {
            // Extreme fallback: empty file to ensure directory exists
            prodFolder.file(".gitkeep", "");
        }
    }

    if (hasReact) {
        extraDevDeps['@vitejs/plugin-react'] = '^4.2.0';
        extraDevDeps['@babel/core'] = '^7.23.0';
        extraDevDeps['@babel/preset-react'] = '^7.23.0';
    }

    if (hasTailwind) {
        extraDevDeps['tailwindcss'] = '^3.4.0';
        extraDevDeps['postcss'] = '^8.4.0';
        extraDevDeps['autoprefixer'] = '^10.4.0';
        
        // Place config files in src/client so Vite/PostCSS can find them during build:client
        zip.file("src/client/tailwind.config.js", `
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html", 
    "./*.{js,ts,jsx,tsx}", 
    "./**/*.{js,ts,jsx,tsx}"
  ],
  theme: { extend: {} },
  plugins: [],
}`.trim());
        
        zip.file("src/client/postcss.config.js", `
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
}`.trim());

        // Prepend tailwind directives to the first found CSS file
        let cssFound = false;
        for (const path of Object.keys(clientFiles)) {
            if (path.endsWith('.css')) {
                clientFiles[path] = `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n` + clientFiles[path];
                cssFound = true;
                break;
            }
        }

        // If no CSS file exists, create one and inject it to ensure Tailwind base styles load
        if (!cssFound) {
            const cssPath = 'tailwind_generated.css';
            clientFiles[cssPath] = `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n`;
            
            // Find index.html to inject the link
            const indexPath = Object.keys(clientFiles).find(p => p.endsWith('index.html'));
            if (indexPath) {
                let htmlContent = clientFiles[indexPath];
                if (htmlContent instanceof Uint8Array) {
                    htmlContent = new TextDecoder().decode(htmlContent);
                }
                
                // Only inject if not already present
                if (!htmlContent.includes(cssPath)) {
                    // Try to inject before </head>, fallback to body
                    if (htmlContent.includes('</head>')) {
                        htmlContent = htmlContent.replace('</head>', `<link rel="stylesheet" href="./${cssPath}">\n</head>`);
                    } else {
                        htmlContent = `<link rel="stylesheet" href="./${cssPath}">\n` + htmlContent;
                    }
                    clientFiles[indexPath] = htmlContent;
                }
            }
        }
    }

    // Games that call websim.upload, or save files with <a download> (re-hosted on
    // Reddit by the download polyfill), need Reddit's media permission.
    const usesUpload = Object.values(codeFiles).some(c => {
        const code = c instanceof Uint8Array ? new TextDecoder().decode(c) : String(c);
        return /websim\.upload\s*\(/.test(code) || /\.download\s*=|\sdownload\s*=\s*["']|setAttribute\(\s*['"]download['"]/.test(code);
    });
    // Reddit media only takes images and GIFs, so shared videos are turned into GIFs.
    if (usesUpload) analyzer.dependencies['gifenc'] = '1.0.3';

    // Port doctor: what behaves differently on Reddit, the hints the game gets,
    // and safe fixes (see doctor.js). Written to PORT-REPORT.md.
    const report = diagnose(assets, { launchMode, forceQuality: options.quality || null });
    zip.file("package.json", generatePackageJson(projectSlug, analyzer.dependencies, extraDevDeps));
    zip.file("devvit.json", generateDevvitJson(projectSlug, entrypoints, hasTips, { media: usesUpload, httpDomains: report.server.hosts, secrets: report.server.secrets }));
    zip.file("tsconfig.json", tsConfig);

    if (hasTips) {
        // Reddit Gold standards (5, 25, 50, 100, 150, 250, 500, 1000, 2500)
        const validGoldTiers = [5, 25, 50, 100, 150, 250, 500, 1000, 2500];

        const products = validGoldTiers.map(amount => ({
            sku: `tip_${amount}_gold`,
            displayName: `${amount} Gold Tip`,
            description: `Support the creator with a ${amount} gold tip`,
            price: amount,
            metadata: { credits: String(amount), category: "tip" },
            accountingType: "INSTANT",
            images: { icon: `products/tip_${amount}.png` }
        }));

        zip.file("products.json", JSON.stringify({
            "$schema": "https://developers.reddit.com/schema/products.json",
            "products": products
        }, null, 2));
    }
    zip.file(".gitignore", "node_modules\n.devvit\ndist\n*.incoming\n");

    if (includeReadme) {
        zip.file("README.md", generateReadme(projectTitle, `https://websim.ai/p/${projectMeta.project.id}`, { httpDomains: report.server.hosts, reasons: report.server.hostReasons }));
    }

    zip.file("PORT-REPORT.md", report.markdown);
    zip.file("scripts/setup.js", setupScript);
    if (options.pullScript) zip.file("scripts/pull.mjs", options.pullScript);
    zip.file("scripts/validate.js", validateScript);

    // 3. Client Folder (src/client)
    const srcFolder = zip.folder("src");
    const clientFolder = srcFolder.folder("client");
    
    clientFolder.file("vite.config.ts", generateClientViteConfig({ hasReact, hasRemotion, inputs: viteInputs }));

    // Write processed code
    for (const [path, content] of Object.entries(clientFiles)) {
        clientFolder.file(path, content);
    }

    // Write static assets to src/client/public
    // Vite will copy these to dist/client root
    if (Object.keys(staticFiles).length > 0) {
        const publicFolder = clientFolder.folder("public");
        for (const [name, content] of Object.entries(staticFiles)) {
            publicFolder.file(name, content);
        }
    }

    // Polyfills in src/client
    
    // Generate Global Shims for CDN packages
    let shimCode = '';
    if (analyzer.globalShims.size > 0) {
        shimCode += '// Global Shims for CDN libraries\n';
        if (analyzer.globalShims.has('react')) shimCode += "import React from 'react'; window.React = React;\n";
        if (analyzer.globalShims.has('react-dom')) shimCode += "import ReactDOM from 'react-dom'; window.ReactDOM = ReactDOM;\n";
        if (analyzer.globalShims.has('three')) shimCode += "import * as THREE from 'three'; window.THREE = THREE;\n";
        if (analyzer.globalShims.has('jquery')) shimCode += "import $ from 'jquery'; window.$ = window.jQuery = $;\n";
        if (analyzer.globalShims.has('pixi.js')) shimCode += "import * as PIXI from 'pixi.js'; window.PIXI = PIXI;\n";
        if (analyzer.globalShims.has('p5')) shimCode += "import p5 from 'p5'; window.p5 = p5;\n";
        shimCode += '\n';
    }

    // Prepare Polyfill Imports (Static) - hoisting import to top to avoid dynamic import issues
    let polyfillImports = "import { connectRealtime, purchase, OrderResultStatus, navigateTo, showToast, getWebViewMode, requestExpandedMode, getShareData } from '@devvit/web/client';\nwindow.connectRealtime = connectRealtime;\nwindow.purchase = purchase;\nwindow.OrderResultStatus = OrderResultStatus;\nwindow.__devvitNavigateTo = navigateTo;\nwindow.__devvitShowToast = showToast;\nwindow.__devvitGetWebViewMode = getWebViewMode;\nwindow.__devvitRequestExpandedMode = requestExpandedMode;\nwindow.__DEVVIT_LAUNCH = " + JSON.stringify(launchMode) + ";\n// Opened from a share link (?devvitshare=...): the data the link carries, e.g. which replay to play.\ntry { window.__devvitShareData = getShareData(); } catch (e) {}\n";
    if (usesUpload) polyfillImports += "import { GIFEncoder, quantize, applyPalette } from 'gifenc';\nwindow.__gifenc = { GIFEncoder, quantize, applyPalette };\n";
    // What the game can adapt to (doctor.js): platform, launch view, suggested quality.
    polyfillImports += "window.__portHints = " + JSON.stringify(report.hints) + ";\n";
    
    // Combine
    // AI calls that don't check the API exists would throw; give them an API that fails at once.
    const aiStub = report.unguardedAi ? "(function () { var no = function () { return Promise.reject(new Error('AI is not available on Reddit.')); }; var w = window.websim; if (!w) return; w.chat = w.chat || { completions: { create: no } }; w.imageGen = w.imageGen || no; w.textToSpeech = w.textToSpeech || no; })();" : '';
    const combinedPolyfills = [polyfillImports, shimCode, simpleLoggerJs, webAudioPolyfill, websimSocketPolyfill, websimStubsJs, aiStub, avatarInjector].join('\n\n');
    clientFolder.file("websim_polyfills.js", combinedPolyfills);
    clientFolder.file("websim_package.js", websimPackageJs);
    clientFolder.file("jsx-dev-proxy.js", jsxDevProxy);
    clientFolder.file("protobuf-inquire-stub.js", protobufInquireStub);

    if (hasRemotion) {
        clientFolder.file("remotion_bridge.js", `
export * from 'remotion';
export { Player } from '@remotion/player';
        `.trim());
    }

    // 4. Server Folder (src/server)
    const serverFolder = srcFolder.folder("server");
    serverFolder.file("index.ts", getMainTs(projectTitle, { websimServer: hasWebsimServer }));
    serverFolder.file("vite.config.ts", generateServerViteConfig({ websimServer: hasWebsimServer }));
    if (hasWebsimServer) {
        for (const [path, content] of Object.entries(websimServerFiles)) serverFolder.file(`websim/${path}`, content);
    }
    
    // The same files as a flat map, for uploading a build to the converter server.
    const files = {};
    for (const [path, entry] of Object.entries(zip.files)) {
        if (!entry.dir) files[path] = await entry.async('uint8array');
    }

    const blob = await zip.generateAsync({ type: "blob" });
    return { blob, filename: `${projectSlug}-devvit.zip`, files, appName: projectSlug, payments: hasTips, tipsDetected, report };
}

