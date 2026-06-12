const CACHE = 'cats3-v4';
const CORE  = ['/unite.html', '/manifest.json'];

self.addEventListener('install',  e => { e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    if(url.protocol==='ws:'||url.protocol==='wss:'||url.pathname.startsWith('/api/')||url.pathname.startsWith('/qrcode/')) return;
    e.respondWith(
        fetch(e.request).then(r=>{ if(r.ok&&e.request.method==='GET'){ const c=r.clone(); caches.open(CACHE).then(ca=>ca.put(e.request,c)); } return r; })
        .catch(()=>caches.match(e.request).then(r=>r||new Response('<h1 style="font-family:monospace;color:red">CATS 3 — HORS LIGNE</h1>',{headers:{'Content-Type':'text/html'}})))
    );
});
