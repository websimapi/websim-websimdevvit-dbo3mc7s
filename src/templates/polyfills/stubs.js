import { modalStub } from './stubs/modal.js';
import { fetchStub } from './stubs/fetch.js';
import { websimStub } from './stubs/websim.js';
import { hotswapStub } from './stubs/hotswap.js';
import { downloadStub } from './stubs/download.js';
import { inlineStub } from './stubs/inline.js';

export const websimStubsJs = `
// [WebSim] API Stubs - Global Script
(function() {
    // Shared state via window._currentUser (managed by socket.js/DevvitBridge)
    const getSharedUser = () => window._currentUser;

    // 1. Modal Helper
    ${modalStub}

    // 2. Fetch Monkeypatch
    ${fetchStub}

    // 3. WebSim API Stub
    ${websimStub}

    // 4. Hotswap Logic
    ${hotswapStub}

    // 5. File downloads
    ${downloadStub}

    // 6. Inline mode: taps only, the game opens expanded
    ${inlineStub}
})();
`;