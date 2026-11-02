export const realtimeMessaging = `
    // --- Messaging Mixin ---

    WebsimSocket.prototype._sendToServer = async function(payload) {
        // Callers must ensure the socket is in a valid state to send.
        try {
            const res = await fetch('/api/realtime/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!res.ok) console.error("[WebSim] RT Send Failed:", res.status);
        } catch(e) {
            console.error("[WebSim] RT Send Error:", e);
        }
    };

    WebsimSocket.prototype.updateRoomState = async function(data) {
        await this._ensureReady();
        
        // 1. Update Local
        this.roomState = { ...this.roomState, ...data };
        this._notifyRoomState();

        // 2. Broadcast via Server
        if (this.isConnected) {
            await this._sendToServer({
                type: '_ws_roomstate',
                payload: data
            });
        }
    };

    WebsimSocket.prototype.requestPresenceUpdate = async function(targetClientId, update) {
        await this._ensureReady();
        if (this.isConnected) {
            await this._sendToServer({
                type: '_ws_req_update',
                targetId: targetClientId,
                fromId: this.clientId,
                payload: update
            });
        }
    };

    WebsimSocket.prototype.send = async function(event) {
        await this._ensureReady();
        if (this.isConnected) {
            await this._sendToServer({
                type: '_ws_event',
                clientId: this.clientId,
                username: window._currentUser?.username || 'Guest',
                data: event
            });
        }
    };

    WebsimSocket.prototype._sendLeave = async function() {
        // Best effort leave notification
        if (this.clientId) {
            const payload = JSON.stringify({
                type: '_ws_leave',
                clientId: this.clientId
            });
            
            // Prioritize fetch with keepalive
            if (window.fetch) {
                fetch('/api/realtime/message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: payload,
                    keepalive: true
                }).catch(e => console.warn("[WebSim] Leave signal failed:", e));
            } else if (navigator.sendBeacon) {
                const blob = new Blob([payload], { type: 'application/json' });
                navigator.sendBeacon('/api/realtime/message', blob);
            }
        }
    };

    WebsimSocket.prototype._handleMessage = function(msg) {
        let data = msg;
        if (msg.message) data = msg.message;
        else if (msg.data && !msg.type) data = msg.data;

        const type = data.type;

        if (type === '_ws_presence') {
            const { clientId, payload: presenceData, user } = data;
            
            // Track liveness
            this._lastSeen[clientId] = Date.now();
            
            if (user) {
                const originalName = user.username;
                let displayName = originalName;
                
                const others = Object.values(this.peers).filter(p => p.id !== clientId);
                const names = new Set(others.map(p => p.username));
                
                if (names.has(displayName)) {
                    let i = 2;
                    while (names.has(\`\${displayName} (\${i})\`)) i++;
                    displayName = \`\${displayName} (\${i})\`;
                }
                
                this.peers[clientId] = {
                    id: clientId,
                    username: displayName,
                    avatarUrl: sanitizeAvatar(user.avatar_url, originalName)
                };
            }

            this.presence[clientId] = { ...this.presence[clientId], ...presenceData };
            this._notifyPresence();
        }
        else if (type === '_ws_leave') {
            const { clientId } = data;
            if (clientId && clientId !== this.clientId) {
                this._removePeer(clientId);
            }
        }
        else if (type === '_ws_roomstate') {
            this.roomState = { ...this.roomState, ...data.payload };
            this._notifyRoomState();
        }
        else if (type === '_ws_req_update') {
            if (data.targetId === this.clientId) {
                this.listeners.updateRequest.forEach(cb => cb(data.payload, data.fromId));
            }
        }
        else if (type === '_ws_event') {
            if (this.listeners.message) {
                const evt = {
                    data: {
                        ...data.data,
                        clientId: data.clientId,
                        username: data.username
                    }
                };
                this.listeners.message(evt);
            }
        }
    };

    WebsimSocket.prototype._notifyRoomState = function() {
        this.listeners.roomState.forEach(cb => cb(this.roomState));
    };
`;