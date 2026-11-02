export const realtimePresence = `
    // --- Presence Mixin ---
    
    WebsimSocket.prototype._syncExistingPresence = async function() {
        try {
            console.log("[WebSim] Fetching existing presence from server...");
            const res = await fetch('/api/realtime/presence');
            if (!res.ok) throw new Error('Failed to fetch presence');
            
            const data = await res.json();
            const existingPresence = data.presence || [];
            
            console.log(\`[WebSim] Found \${existingPresence.length} existing users\`);
            
            // Process each existing presence
            existingPresence.forEach(item => {
                const { clientId, user, payload } = item;
                
                // Skip ourselves
                if (clientId === this.clientId) return;
                
                // Add to peers
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
                
                // Add to presence
                this.presence[clientId] = payload || {};
                this._lastSeen[clientId] = Date.now();
            });
            
            // Notify UI of synced presence
            this._notifyPresence();
            
        } catch(e) {
            console.warn("[WebSim] Failed to sync existing presence:", e);
        }
    };

    WebsimSocket.prototype.updatePresence = async function(data) {
        await this._ensureReady();
        
        // 1. Update Local
        this.presence[this.clientId] = { ...this.presence[this.clientId], ...data };
        this._notifyPresence();

        // 2. Broadcast via Server (Throttled)
        if (this.isConnected) {
            this._schedulePresenceUpdate();
        }
    };

    WebsimSocket.prototype._schedulePresenceUpdate = function() {
        if (this._updatePending) return;
        
        const now = Date.now();
        const INTERVAL = 80;
        const timeSinceLast = now - this._lastUpdateSent;

        if (timeSinceLast >= INTERVAL) {
            this._sendPresence();
        } else {
            this._updatePending = true;
            setTimeout(() => {
                this._updatePending = false;
                this._sendPresence();
            }, INTERVAL - timeSinceLast);
        }
    };

    WebsimSocket.prototype._sendPresence = async function() {
        this._lastUpdateSent = Date.now();
        await this._sendToServer({
            type: '_ws_presence',
            clientId: this.clientId,
            user: window._currentUser,
            payload: this.presence[this.clientId]
        });
    };

    WebsimSocket.prototype._notifyPresence = function() {
        this.listeners.presence.forEach(cb => cb(this.presence));
    };

    WebsimSocket.prototype._removePeer = function(clientId) {
        if (!this.peers[clientId] && !this.presence[clientId]) return;
        
        const username = this.peers[clientId]?.username || 'Unknown';
        
        delete this.peers[clientId];
        delete this.presence[clientId];
        delete this._lastSeen[clientId];
        
        this._notifyPresence();
        
        console.log("[WebSim] Peer Disconnected:", clientId);

        // Synthesize Disconnected Event for Game Logic
        if (this.listeners.message) {
            try {
                this.listeners.message({
                    data: {
                        type: 'disconnected',
                        clientId: clientId,
                        username: username
                    }
                });
            } catch(e) { console.error("[WebSim] Error in disconnect handler:", e); }
        }
    };

    WebsimSocket.prototype._pruneStalePeers = function() {
        const now = Date.now();
        const TIMEOUT = 15000; // 15s timeout
        
        Object.keys(this._lastSeen).forEach(clientId => {
            if (clientId === this.clientId) return; // Don't prune self
            
            if (now - this._lastSeen[clientId] > TIMEOUT) {
                console.log("[WebSim] Pruning stale peer:", clientId);
                this._removePeer(clientId);
            }
        });
    };

    WebsimSocket.prototype._announceJoin = async function() {
        // Wait for identity
        let tries = 0;
        while (!window._currentUser && tries < 10) {
            await new Promise(r => setTimeout(r, 100));
            tries++;
        }
        
        const user = window._currentUser || { username: 'Guest', avatar_url: '' };
        
        let displayName = user.username;
        const others = Object.values(this.peers).filter(p => p.id !== this.clientId);
        const names = new Set(others.map(p => p.username));
        
        if (names.has(displayName)) {
            let i = 2;
            while (names.has(\`\${displayName} (\${i})\`)) i++;
            displayName = \`\${displayName} (\${i})\`;
        }

        // ADD TO PEERS IMMEDIATELY
        this.peers[this.clientId] = {
            id: this.clientId,
            username: displayName,
            avatarUrl: sanitizeAvatar(user.avatar_url, user.username)
        };

        // Then broadcast (Directly to avoid deadlock with _ensureReady)
        this.presence[this.clientId] = { ...this.presence[this.clientId], joined: true };
        this._notifyPresence();
        
        if (this.isConnected) {
            await this._sendPresence();
        }
    };
`;