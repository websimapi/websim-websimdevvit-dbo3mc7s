import { realtimePresence } from './realtime/presence.js';
import { realtimeMessaging } from './realtime/messaging.js';

export const socketRealtime = `
    // ------------------------------------------------------------------------
    // 1. WebsimSocket (Realtime Multiplayer)
    // ------------------------------------------------------------------------
    class WebsimSocket {
        constructor() {
            this.presence = {};
            this.roomState = {};
            this.peers = {};
            this.clientId = 'user-' + Math.random().toString(36).substr(2, 9);
            this.listeners = {
                presence: new Set(),
                roomState: new Set(),
                updateRequest: new Set(),
                message: null
            };
            this.socket = null;
            this.subscription = null;
            this.isConnected = false;
            this._initPromise = null; 
            this._initialized = false;
            
            // Throttling state
            this._lastUpdateSent = 0;
            this._updatePending = false;
            
            // Disconnect Handling
            this._lastSeen = {};
            this._pruneInterval = null;

            // Singleton logic
            if (window.websimSocketInstance) {
                return window.websimSocketInstance;
            }
            window.websimSocketInstance = this;
            
            // AUTO-INITIALIZE
            this._initPromise = this.initialize();

            // Setup disconnect handlers
            this._leaveSent = false;
            const handleLeave = () => {
                if (!this._leaveSent) {
                    this._leaveSent = true;
                    this._sendLeave();
                }
            };
            window.addEventListener('beforeunload', handleLeave);
            window.addEventListener('pagehide', handleLeave);
            
            // Prune stale peers every 5s
            this._pruneInterval = setInterval(() => this._pruneStalePeers(), 5000);

            // Heartbeat
            this._heartbeatInterval = setInterval(() => this._sendHeartbeat(), 5000);
        }

        async _sendHeartbeat() {
            if (this.isConnected && this.presence[this.clientId]) {
                this._sendPresence().catch(e => console.warn("[WebSim] Heartbeat failed", e));
            }
        }

        async initialize() {
            if (this._initialized) return; 
            
            console.log("[WebSim] Initializing Realtime Socket...");
            try {
                console.log("[WebSim] Connecting to realtime channel 'global_room'...");
                const connectRealtime = window.connectRealtime;

                if (!connectRealtime) throw new Error("connectRealtime not available");

                this.subscription = await connectRealtime({
                    channel: 'global_room',
                    onMessage: (msg) => {
                        this._handleMessage(msg);
                    },
                    onConnect: () => {
                        console.log("[WebSim] Realtime Connected. ClientID:", this.clientId);
                        this.isConnected = true;
                    },
                    onDisconnect: () => {
                        console.log("[WebSim] Realtime Disconnected");
                        this.isConnected = false;
                    }
                });
                
                this.isConnected = true;
                
                try {
                    await this._syncExistingPresence();
                    await this._announceJoin();
                } catch (err) {
                    console.warn("[WebSim] Initial presence sync failed:", err);
                }
                
                this._initialized = true;
                console.log("[WebSim] Socket initialization complete. Peers:", Object.keys(this.peers));

            } catch (e) {
                console.warn("[WebSim] Realtime init failed:", e);
                // Fallback: Local loopback
                this.clientId = 'local-player';
                this.peers[this.clientId] = {
                    id: this.clientId,
                    username: 'Player',
                    avatarUrl: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                };
                this._initialized = true;
            }
        }
        
        // removed _syncExistingPresence -> ./realtime/presence.js
        // removed updatePresence -> ./realtime/presence.js
        // removed _schedulePresenceUpdate -> ./realtime/presence.js
        // removed _sendPresence -> ./realtime/presence.js
        // removed _notifyPresence -> ./realtime/presence.js
        // removed _removePeer -> ./realtime/presence.js
        // removed _pruneStalePeers -> ./realtime/presence.js
        // removed _announceJoin -> ./realtime/presence.js
        
        // removed _sendToServer -> ./realtime/messaging.js
        // removed updateRoomState -> ./realtime/messaging.js
        // removed requestPresenceUpdate -> ./realtime/messaging.js
        // removed send -> ./realtime/messaging.js
        // removed _sendLeave -> ./realtime/messaging.js
        // removed _handleMessage -> ./realtime/messaging.js
        // removed _notifyRoomState -> ./realtime/messaging.js

        async _ensureReady() {
            if (!this._initialized && this._initPromise) {
                await this._initPromise;
            }
        }

        async subscribePresence(cb) {
            await this._ensureReady();
            this.listeners.presence.add(cb);
            try { cb(this.presence); } catch(e){}
            return () => this.listeners.presence.delete(cb);
        }

        async subscribeRoomState(cb) {
            await this._ensureReady();
            this.listeners.roomState.add(cb);
            try { cb(this.roomState); } catch(e){}
            return () => this.listeners.roomState.delete(cb);
        }

        async subscribePresenceUpdateRequests(cb) {
            await this._ensureReady();
            this.listeners.updateRequest.add(cb);
            return () => this.listeners.updateRequest.delete(cb);
        }
        
        set onmessage(cb) {
            this.listeners.message = cb;
        }

        collection(name) {
             return window.GenericDB.getAdapter(name);
        }
        
        static updateIdentity(user) {
            if (user) {
                if (user.avatar_url) {
                    user.avatar_url = sanitizeAvatar(user.avatar_url, user.username);
                }
                if (user.avatar_url && !user.avatarUrl) {
                    user.avatarUrl = user.avatar_url;
                }
            }
            window._currentUser = user;
            const inst = window.websimSocketInstance;
            if (inst && inst.peers[inst.clientId]) {
                inst.peers[inst.clientId].username = user.username;
                inst.peers[inst.clientId].avatarUrl = user.avatar_url;
                inst.updatePresence({}).catch(e => console.warn('[WebSim] Identity update broadcast failed:', e));
            }
        }
    }

    // Load Mixins
    ${realtimePresence}
    ${realtimeMessaging}

    // Expose Global Class
    window.WebsimSocket = WebsimSocket;

    // Auto-create singleton instance
    if (!window.party) {
         console.log("[WebSim] Creating global party instance...");
         window.party = new WebsimSocket();
    }
`;