// WebsimSocket.joinRoom(): a connection to the project's server.js `room`,
// which runs on the Devvit server (templates/server/websim-room.js).
// Messages go up as POSTs (batched, in order, one request at a time) and come
// back on Devvit realtime: this connection's own channel and the post's shared
// broadcast channel. Like WebSim, onmessage gets { data: <string> }; a new
// connection after the server dropped this one calls onreconnect.
export const realtimeRoom = `
    // --- Server room (server.js "room" export) ---
    WebsimSocket.joinRoom = async function () {
        const connectRealtime = window.connectRealtime;
        if (!connectRealtime) throw new Error('Realtime is not available.');
        const post = (path, body) => fetch('/api/__room/' + path, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
        });
        const info = await (await post('info')).json();
        const room = { onmessage: null, onclose: null, onreconnect: null, id: null, closed: false };
        const deliver = (text) => { try { if (room.onmessage) room.onmessage({ data: text }); } catch (e) { console.error('[WebSim] room onmessage error', e); } };
        const shared = await connectRealtime({ channel: info.all, onMessage: (m) => { if (m) deliver(m.d); } });
        let own = null;
        const newId = () => 'c' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
        async function open() {
            const id = newId();
            if (own) { try { await own.disconnect(); } catch (e) {} }
            own = await connectRealtime({ channel: info.own + id, onMessage: (m) => { if (m) deliver(m.d); } });
            room.id = id;
            const res = await post('connect', { id });
            if (!res.ok) throw new Error('Could not join the room (' + res.status + ').');
        }
        await open();

        let queue = [], flushing = false, reconnecting = null;
        async function reconnect() {
            if (!reconnecting) reconnecting = (async () => {
                try { await open(); if (room.onreconnect) room.onreconnect(); }
                catch (e) { room.closed = true; if (room.onclose) room.onclose({ reason: 'Disconnected.' }); }
                finally { reconnecting = null; }
            })();
            return reconnecting;
        }
        async function flush() {
            flushing = true;
            while (queue.length && !room.closed) {
                // Up to ~1 MB per request (Devvit allows 4 MB).
                let size = 0, n = 0;
                while (n < queue.length && (n === 0 || size + queue[n].length < 1000000)) size += queue[n++].length;
                const batch = queue.splice(0, n);
                let res = null;
                try { res = await post('send', { id: room.id, data: batch }); } catch (e) {}
                if (res && res.status === 410) await reconnect();
                else if (!res || !res.ok) await new Promise((r) => setTimeout(r, 500));
            }
            flushing = false;
        }
        room.send = (msg) => {
            if (room.closed) return;
            queue.push(typeof msg === 'string' ? msg : JSON.stringify(msg));
            if (!flushing) flush();
        };
        room.close = () => {
            if (room.closed) return;
            room.closed = true;
            clearInterval(pinger);
            // A string goes as text/plain, which sendBeacon allows; the route parses it.
            try { navigator.sendBeacon('/api/__room/leave', JSON.stringify({ id: room.id })); } catch (e) {}
            try { shared.disconnect(); if (own) own.disconnect(); } catch (e) {}
        };
        const pinger = setInterval(async () => {
            if (room.closed || reconnecting) return;
            try { const res = await post('ping', { id: room.id }); if (res.status === 410) reconnect(); } catch (e) {}
        }, 3000);
        window.addEventListener('pagehide', () => room.close());
        return room;
    };
`;
