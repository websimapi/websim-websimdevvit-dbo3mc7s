export const inlineStub = `
    // Inline mode (the post in the feed). Both launch modes make the page feed-friendly
    // (developers.reddit.com/docs/guides/best-practices/scroll-traps): touch-action
    // pan-y so vertical swipes scroll the feed, no scrolling inside the post, no
    // scroll bars, never preventDefault.
    //   "inline": the game plays in the post as on Websim (taps and sideways drags work).
    //   "live":   the post is the game's title screen; only taps, and a tap opens the
    //             game expanded (the "game" entrypoint). A game can hide the badge with
    //             <meta name="devvit-inline-hint" content="none">.
    (function() {
        const launch = window.__DEVVIT_LAUNCH;
        if (launch !== 'live' && launch !== 'inline') return;
        // Outside a Devvit webview (local testing) this throws: no guard there.
        let mode = 'expanded';
        try { if (window.__devvitGetWebViewMode) mode = window.__devvitGetWebViewMode(); } catch (e) {}
        window.__DEVVIT_VIEW_MODE = mode;
        if (mode !== 'inline') return;

        const root = document.documentElement;
        root.classList.add('devvit-inline');
        const css = document.createElement('style');
        css.textContent = [
            'html.devvit-inline, html.devvit-inline body { overflow: hidden !important; overscroll-behavior: auto !important; touch-action: pan-y !important; }',
            'html.devvit-inline body * { touch-action: pan-y !important; overscroll-behavior: auto !important; scrollbar-width: none !important; }',
            'html.devvit-inline body *::-webkit-scrollbar { display: none !important; }',
            '.devvit-inline-hint { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 2147483647; padding: 6px 16px; border-radius: 999px;',
            '  background: rgba(0,0,0,0.6); color: #fff; font: 600 14px/1.2 system-ui, sans-serif; pointer-events: none; }',
        ].join('\\n');
        (document.head || root).appendChild(css);

        // "inline": the game plays in the post as on Websim. Taps and sideways drags
        // reach it (pan-y lets vertical swipes scroll the feed); nothing else changes.
        if (launch === 'inline') return;

        // Gestures never reach the game inline. Nothing calls preventDefault, so
        // swipes and the mouse wheel still scroll the feed.
        const swallow = (e) => { e.stopImmediatePropagation(); };
        ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup',
         'touchstart', 'touchmove', 'touchend', 'wheel', 'keydown', 'keyup', 'contextmenu']
            .forEach((type) => window.addEventListener(type, swallow, { capture: true, passive: true }));

        // A tap (a trusted click) opens the game.
        window.addEventListener('click', (e) => {
            e.stopImmediatePropagation();
            e.preventDefault();
            try { window.__devvitRequestExpandedMode(e, 'game'); }
            catch (err) { console.warn('[WebSim] Could not open expanded mode:', err); }
        }, { capture: true });

        const addHint = () => {
            const meta = document.querySelector('meta[name="devvit-inline-hint"]');
            if (meta && meta.getAttribute('content') === 'none') return;
            const hint = document.createElement('div');
            hint.className = 'devvit-inline-hint';
            hint.textContent = (meta && meta.getAttribute('content')) || 'Tap to play';
            document.body.appendChild(hint);
        };
        if (document.body) addHint(); else document.addEventListener('DOMContentLoaded', addHint);
    })();
`;
