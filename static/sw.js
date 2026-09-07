// Dummy Service Worker to satisfy Android PWA requirements
self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
    // Does nothing, but required by Chrome to pass the PWA check
});