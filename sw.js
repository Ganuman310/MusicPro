// ── SERVICE WORKER — MusicPro PWA ──
const SW_VERSION = 'v2';
const SHELL_CACHE = 'musicpro-shell-' + SW_VERSION;
const AUDIO_CACHE = 'musicpro-audio-v1';

// App shell files to cache on install
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './assets/css/style.css',
  './assets/js/supabase-config.js',
  './assets/js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// ── INSTALL ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(c => c.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k.startsWith('musicpro-shell-') && k !== SHELL_CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ──
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Skip non-GET and non-http(s) requests
  if (e.request.method !== 'GET') return;
  if (!url.protocol.startsWith('http')) return;

  // Skip Supabase API calls — always go to network
  if (url.hostname.includes('supabase.co')) return;

  // Skip GitHub API calls — always go to network
  if (url.hostname === 'api.github.com') return;

  // Audio files (.ganuman) — cache first, then network
  if (url.pathname.includes('Database/') || url.pathname.endsWith('.ganuman')) {
    e.respondWith(
      caches.open(AUDIO_CACHE).then(async cache => {
        const cached = await cache.match(e.request);
        if (cached) return cached;
        try {
          const resp = await fetch(e.request);
          if (resp.ok) cache.put(e.request, resp.clone());
          return resp;
        } catch {
          return new Response('Offline', { status: 503 });
        }
      })
    );
    return;
  }

  // App shell — cache first, fallback to network
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp.ok) {
          caches.open(SHELL_CACHE).then(c => c.put(e.request, resp.clone()));
        }
        return resp;
      }).catch(() => {
        // Fallback to index.html for navigation requests (SPA)
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
