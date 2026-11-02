export const websimStub = `
    if (!window.websim) {
        window.websim = {
            getCurrentUser: async () => {
                // Wait for handshake (up to 3s)
                let tries = 0;
                while(!getSharedUser() && tries < 30) {
                    await new Promise(r => setTimeout(r, 100));
                    tries++;
                }
                
                const u = getSharedUser() || {
                    id: 'guest', username: 'Guest', avatar_url: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                };
                
                // Polyfill camelCase for consistency (Game ports often expect avatarUrl)
                if (u.avatar_url && !u.avatarUrl) u.avatarUrl = u.avatar_url;
                
                return u;
            },
            getProject: async () => {
                try {
                    const res = await fetch('/api/project');
                    if (res.ok) return await res.json();
                } catch(e) { console.warn("[Polyfill] getProject failed:", e); }
                return { id: 'local', title: 'Reddit Game', current_version: '1', owner: { username: 'unknown' } };
            },
            getCurrentProject: async () => {
                return window.websim.getProject();
            },
            getCreator: async () => {
                try {
                    const res = await fetch('/api/project');
                    if (res.ok) {
                        const data = await res.json();
                        return data.owner;
                    }
                } catch(e) { console.warn("[Polyfill] getCreator failed:", e); }
                return { id: 'owner', username: 'GameOwner' };
            },
            
            // --- Commenting & Tipping Polyfill ---
            postComment: async (data) => {
                // Data: { content: string, parent_comment_id?: string, credits?: number }
                console.log("[Polyfill] postComment:", data);
                return new Promise((resolve) => {
                    _showWebSimModal(data, resolve, originalFetch);
                });
            },
            addEventListener: (event, cb) => {
                if (event === 'comment:created') {
                     if (!window._websim_comment_listeners) window._websim_comment_listeners = [];
                     window._websim_comment_listeners.push(cb);
                }
            },

            collection: (name) => {
                // Return safe stubs to prevent crashes before hydration
                // If WebsimSocket exists (realtime.js), use it. Otherwise use generic DB stub.
                if (window.websimSocketInstance && typeof window.websimSocketInstance.collection === 'function') {
                    return window.websimSocketInstance.collection(name);
                }
                // Fallback / Pre-init stub
                return {
                    subscribe: (cb) => { if(cb) cb([]); return () => {}; }, 
                    getList: () => [], 
                    create: async () => ({}), 
                    update: async () => ({}), 
                    delete: async () => {}, 
                    filter: () => ({ subscribe: (cb) => { if(cb) cb([]); return () => {}; }, getList: () => [] })
                };
            },
            search: {
                assets: async (opts) => {
                    const params = new URLSearchParams();
                    if (opts.q) params.set('q', opts.q);
                    if (opts.mime_type_prefix) params.set('mime_type_prefix', opts.mime_type_prefix);
                    if (opts.limit) params.set('limit', opts.limit);
                    return fetch('/api/v1/search/assets?' + params.toString()).then(r => r.json());
                },
                relevant: async (opts) => {
                    const params = new URLSearchParams();
                    if (opts.q) params.set('q', opts.q);
                    if (opts.limit) params.set('limit', opts.limit);
                    return fetch('/api/v1/search/assets/relevant?' + params.toString()).then(r => r.json());
                }
            },
            upload: async (file) => {
                // Uploads go to the app server (/api/__upload). Images, GIFs and videos are
                // re-hosted on Reddit's media CDN (Reddit apps may only display
                // Reddit-hosted media); other files are stored by the app. Either
                // way the URL works for every player, unlike a session blob: URL.
                const blob = file instanceof Blob ? file : new Blob([file]);
                let type = (blob.type || '').toLowerCase();
                const name = (file && file.name) || 'upload';
                if (!type && /\\.json$/i.test(name)) type = 'application/json';
                const res = await fetch('/api/__upload', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'X-Upload-Type': type || 'application/octet-stream',
                        'X-Upload-Name': name
                    },
                    body: blob
                });
                const result = await res.json().catch(() => ({}));
                if (!res.ok || !result.url) {
                    throw new Error(result.error || ('Upload failed (' + res.status + ')'));
                }
                return result.url;
            }
        };
    }
`;