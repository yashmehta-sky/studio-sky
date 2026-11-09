/* Studio SKY offline shell. Never cache Supabase API responses or uploaded files. */
const CACHE='studio-sky-shell-v2';
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.add('./')).catch(()=>{}));self.skipWaiting()});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('studio-sky-shell-')&&k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener('fetch',event=>{const r=event.request;if(r.method!=='GET'||r.mode!=='navigate'||new URL(r.url).origin!==self.location.origin)return;event.respondWith(fetch(r).then(response=>{if(response.ok){const clone=response.clone();caches.open(CACHE).then(c=>c.put('./',clone))}return response}).catch(()=>caches.match('./')))});
