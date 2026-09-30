// Service worker: makes the app installable and usable offline (reading already-imported books needs no network).
// Strategy: network-first for the app itself (so updates show up immediately), cache-first for big vendor files.
const CACHE = 'audiobook-v1';
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest', '/css/app.css',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png',
  '/js/app.js', '/js/ai.js', '/js/book.js', '/js/commands.js', '/js/context.js', '/js/feedback.js', '/js/i18n.js', '/js/lang.js', '/js/library.js', '/js/memory.js',
  '/js/recorder.js', '/js/retrieval.js', '/js/segmenter.js', '/js/session.js', '/js/shake.js', '/js/stt.js', '/js/tts.js', '/js/util.js',
  '/js/parsers/common.js', '/js/parsers/epub.js', '/js/parsers/index.js', '/js/parsers/pdf.js', '/js/parsers/text.js',
  '/vendor/jszip.min.js', '/vendor/mammoth.browser.min.js', '/vendor/pdfjs/pdf.min.mjs', '/vendor/pdfjs/pdf.worker.min.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/vendor/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  event.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error()))));
});
