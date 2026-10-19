// Adds the cross-origin isolation headers needed by Emscripten pthreads on
// static hosts such as GitHub Pages. Loaded from the page, it registers itself
// as a service worker and reloads once after the worker takes control; normal
// servers should still send these headers directly, which avoids the reload.
'use strict';

if (typeof window === 'undefined') {
    self.addEventListener('install', event => {
        event.waitUntil(self.skipWaiting());
    });

    self.addEventListener('activate', event => {
        event.waitUntil(self.clients.claim());
    });

    self.addEventListener('fetch', event => {
        const requestUrl = new URL(event.request.url);
        if (requestUrl.origin !== self.location.origin) return;
        if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') return;

        event.respondWith((async () => {
            const response = await fetch(event.request);
            if (response.type === 'opaque' || response.status === 0) return response;

            const headers = new Headers(response.headers);
            headers.set('Cross-Origin-Opener-Policy', 'same-origin');
            headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
            headers.set('Cross-Origin-Resource-Policy', 'same-origin');
            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        })());
    });
} else if (!window.crossOriginIsolated && window.isSecureContext && navigator.serviceWorker) {
    const reloadKey = 'coiReloaded';
    navigator.serviceWorker.register(document.currentScript.src).then(registration => {
        const reloadOnce = () => {
            // Guards against a reload loop if isolation still fails after the worker is active.
            if (sessionStorage.getItem(reloadKey)) return;
            sessionStorage.setItem(reloadKey, '1');
            location.reload();
        };
        if (navigator.serviceWorker.controller) {
            reloadOnce();
        } else {
            navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
            if (registration.active && !navigator.serviceWorker.controller) reloadOnce();
        }
    }).catch(error => console.error('COI service worker registration failed:', error));
} else if (window.crossOriginIsolated) {
    sessionStorage.removeItem('coiReloaded');
}
