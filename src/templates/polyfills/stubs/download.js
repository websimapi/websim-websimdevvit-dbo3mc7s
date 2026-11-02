export const downloadStub = `
    // File downloads (<a download> with a blob: or data: link).
    // Reddit's post webview can't save files, so the file is offered through
    // the device share sheet when it accepts files. Otherwise images, and videos
    // turned into GIFs, can be posted as a comment on this post's thread (the
    // player confirms); other files are re-hosted and opened with navigateTo.
    (function() {
        const nativeClick = HTMLAnchorElement.prototype.click;
        const isFileLink = (a) => !!(a && a.hasAttribute && a.hasAttribute('download') && /^(blob|data):/.test(a.href || ''));
        const toast = (text) => { try { if (window.__devvitShowToast) window.__devvitShowToast(text); } catch (e) {} };

        async function deliver(a) {
            const name = a.getAttribute('download') || 'download';
            const blob = await fetch(a.href).then((r) => r.blob());
            const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
            if (navigator.share && navigator.canShare) {
                try {
                    if (navigator.canShare({ files: [file] })) {
                        await navigator.share({ files: [file], title: name });
                        return;
                    }
                } catch (e) {
                    if (e && e.name === 'AbortError') return; // the player closed the share sheet
                }
            }
            // Videos and images: offer to post them on this post's thread (the player says yes first).
            // Reddit media takes only images and GIFs, so a video goes as a GIF of the whole clip.
            if (/^(video|image)\\//.test(file.type)) {
                if (!(await askToShare(name))) return;
                let clip = file;
                if (/^video\\//.test(file.type)) {
                    toast('Making a GIF of your clip...');
                    clip = await videoToGif(file);
                }
                toast('Sharing to this thread...');
                // A game can set the comment text with <a download data-share-text="...">.
                await window.__devvitShareToThread(clip, a.getAttribute('data-share-text') || (document.title ? 'Shared from ' + document.title : ''));
                toast('Posted to this thread!');
                return;
            }
            toast('Preparing ' + name + '...');
            const url = await window.websim.upload(file);
            if (!/^https?:/.test(url)) throw new Error('Only images, GIFs and videos can be saved on Reddit');
            if (!window.__devvitNavigateTo) throw new Error('navigateTo is unavailable');
            window.__devvitNavigateTo(url);
        }

        // Upload in chunks (requests are capped near 4 MB), then the server re-hosts the
        // file on Reddit and comments it on this post as the player.
        // opts.data (<= 1024 chars) rides in a link back into this post (?devvitshare=...);
        // the game reads it with window.__devvitShareData when someone opens that link.
        window.__devvitShareToThread = async (blob, text, opts) => {
            opts = opts || {};
            const CHUNK = 3 * 1024 * 1024; // a multiple of 3 bytes
            const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(16).slice(2);
            const chunks = Math.max(1, Math.ceil(blob.size / CHUNK));
            for (let i = 0; i < chunks; i++) {
                const r = await fetch('/api/__share/chunk?id=' + id + '&i=' + i, {
                    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob.slice(i * CHUNK, (i + 1) * CHUNK),
                });
                if (!r.ok) throw new Error('Upload failed (' + r.status + ')');
            }
            const r = await fetch('/api/__share/finish', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, chunks, type: blob.type || 'image/gif', text: text || '', link: opts.data ? { data: String(opts.data).slice(0, 1024), text: opts.linkText || '' } : null }),
            });
            const result = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(result.detail || result.error || ('Share failed (' + r.status + ')'));
            return result;
        };

        // Video -> animated GIF of the whole clip, in the browser (gifenc). Reddit media
        // takes images and GIFs only, up to 20 MB with a 30 s upload, so long clips get
        // fewer frames per second and a smaller picture until the GIF is under 9 MB.
        const GIF_BUDGET = 9 * 1024 * 1024;
        const GIF_STEPS = [[240, 8], [200, 6], [180, 5], [160, 4], [140, 3], [120, 2]];
        async function videoToGif(blob) {
            const g = window.__gifenc;
            if (!g) throw new Error('GIF encoder missing');
            const url = URL.createObjectURL(blob);
            const v = document.createElement('video');
            v.muted = true;
            v.playsInline = true;
            const seek = (t) => new Promise((resolve) => { v.onseeked = () => resolve(); v.currentTime = t; });
            try {
                await new Promise((resolve, reject) => { v.onloadeddata = resolve; v.onerror = () => reject(new Error('The video could not be read')); v.src = url; });
                // Recorded WebMs often report no duration until seeked to the end.
                if (!isFinite(v.duration)) await seek(1e9);
                const duration = Math.max(0.1, isFinite(v.duration) ? v.duration : v.currentTime);
                let step = GIF_STEPS.findIndex((s) => duration * s[1] <= 900);
                if (step < 0) step = GIF_STEPS.length - 1;
                for (; step < GIF_STEPS.length; step++) {
                    const maxW = GIF_STEPS[step][0], fps = GIF_STEPS[step][1];
                    const w = Math.min(maxW, v.videoWidth || maxW);
                    const h = Math.max(2, Math.round((v.videoHeight || maxW) * w / (v.videoWidth || maxW)));
                    const canvas = document.createElement('canvas');
                    canvas.width = w; canvas.height = h;
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    const enc = g.GIFEncoder();
                    const frames = Math.max(1, Math.floor(duration * fps));
                    let tooBig = false;
                    for (let i = 0; i < frames; i++) {
                        await seek(Math.min(duration - 0.01, i / fps));
                        ctx.drawImage(v, 0, 0, w, h);
                        const data = ctx.getImageData(0, 0, w, h).data;
                        const palette = g.quantize(data, 128);
                        enc.writeFrame(g.applyPalette(data, palette), w, h, { palette, delay: Math.round(1000 / fps) });
                        if (i >= 20 && (enc.bytesView().length / (i + 1)) * frames > GIF_BUDGET * 1.05) { tooBig = true; break; }
                    }
                    if (tooBig) continue;
                    enc.finish();
                    const bytes = enc.bytes();
                    if (bytes.length > GIF_BUDGET && step < GIF_STEPS.length - 1) continue;
                    return new Blob([bytes], { type: 'image/gif' });
                }
                throw new Error('The clip is too long to share');
            } finally {
                URL.revokeObjectURL(url);
            }
        }

        window.__devvitVideoToGif = videoToGif;

        // Games ask the same way before posting: window.__devvitAskToShare(title, text).
        window.__devvitAskToShare = (title, text) => askToShare('', title, text);

        function askToShare(name, title, text) {
            return new Promise((resolve) => {
                const box = document.createElement('div');
                box.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);font-family:system-ui,sans-serif;';
                box.innerHTML = '<div style="background:#1e293b;color:#f8fafc;padding:20px;border-radius:12px;max-width:min(90vw,360px);display:flex;flex-direction:column;gap:14px;text-align:center;">'
                    + '<b style="font-size:1.05rem"></b>'
                    + '<span style="font-size:0.9rem;opacity:0.85"></span>'
                    + '<div style="display:flex;gap:10px;justify-content:center"><button data-a="no" style="padding:9px 16px;border-radius:8px;border:0;background:#334155;color:#fff;font-weight:600">Cancel</button>'
                    + '<button data-a="yes" style="padding:9px 16px;border-radius:8px;border:0;background:#FF4500;color:#fff;font-weight:700">Post comment</button></div></div>';
                box.querySelector('b').textContent = title || 'Share this clip?';
                box.querySelector('span').textContent = text || 'Files can not be saved from a Reddit post. Post it as a comment on this thread instead? Videos are shared as a GIF.';
                box.addEventListener('click', (e) => {
                    const a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
                    if (!a && e.target !== box) return;
                    box.remove();
                    resolve(a === 'yes');
                });
                document.body.appendChild(box);
            });
        }

        function handle(a) {
            deliver(a).catch((e) => {
                console.error('[WebSim] Download failed:', e);
                toast('Could not share: ' + ((e && e.message) || 'unknown error'));
            });
        }

        HTMLAnchorElement.prototype.click = function() {
            if (isFileLink(this)) return handle(this);
            return nativeClick.apply(this, arguments);
        };
        document.addEventListener('click', (e) => {
            const a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
            if (isFileLink(a)) { e.preventDefault(); handle(a); }
        }, true);
    })();
`;
