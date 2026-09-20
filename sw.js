/* Studio SKY service worker: lets the app open with no connection (flight mode) once it has been opened online once.
   Put this file next to index.html on the same https address. It never touches Supabase API calls. */
const CACHE='studio-sky-shell-v1';
const CDN=['cdn.jsdelivr.net','fonts.googleapis.com','fonts.gstatic.com','cdnjs.cloudflare.com','unpkg.com'];
self.addEventListener('install',e=>{
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['./','./index.html']).catch(()=>{})));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.hostname.endsWith('supabase.co')||url.hostname.endsWith('supabase.in'))return;
  /* the app itself: newest copy when online, cached copy when offline */
  if(url.origin===self.location.origin){
    e.respondWith(fetch(req).then(r=>{if(r&&r.ok){const c=r.clone();caches.open(CACHE).then(x=>x.put(req,c))}return r})
      .catch(()=>caches.match(req).then(r=>r||caches.match('./index.html')||caches.match('./'))));
    return;
  }
  /* libraries and fonts: serve from cache instantly, refresh in the background */
  if(CDN.includes(url.hostname)){
    e.respondWith(caches.open(CACHE).then(c=>c.match(req).then(hit=>{
      const net=fetch(req).then(r=>{if(r&&(r.ok||r.type==='opaque'))c.put(req,r.clone());return r}).catch(()=>hit);
      return hit||net;
    })));
  }
});
