const CACHE = 'redd-survey-v10';
// 必須資産（これが揃わないとアプリが成立しない）。install時に全部揃わなければ失敗させ、不完全キャッシュで有効化しない
const CORE = [
  './redd_survey.html',
  './manifest.json',
  './leaflet.css',
  './leaflet.js',
  './icon-192.svg',
  './icon-512.svg'
];

// 地図タイルのキャッシュは2種類。
// - PACK: ユーザーが「範囲を囲って保存」した分。上限なし・自動では消さない（明示削除のみ）
// - TILE: スクロールで自然に溜まった分。上限つきで、あふれたら古いものから消す
// 別々にすることで、事前に保存した範囲がスクロールで押し出されて消えるのを防ぐ。
const PACK_CACHE = 'redd-map-pack-v1';
const TILE_CACHE = 'redd-map-tiles-v1';
const MAX_TILES = 3000;

// URLの拡張子から期待するContent-Typeを検査する。
// HTTP 200でも認証画面・メンテHTMLなどをJS/CSS/JSONとして保存しないため。
function typeOkFor(url, res){
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (url.endsWith('.js'))  return ct.includes('javascript') || ct.includes('ecmascript');
  if (url.endsWith('.css')) return ct.includes('css');
  if (url.endsWith('.json') || url.endsWith('/manifest.json')) return ct.includes('json');
  if (url.endsWith('.svg')) return ct.includes('svg');
  if (url.endsWith('.html') || url.endsWith('/')) return ct.includes('html') || ct === '';
  return true;  // その他(画像等)は型検査しない
}
// 正常な同一オリジン応答(2xx)かつ内容型が期待どおりの時だけキャッシュ更新に使う
function cacheable(res, url){ return res && res.ok && res.type === 'basic' && typeOkFor(url, res); }
async function cachePut(cache, url){
  const res = await fetch(url, { cache: 'reload' });
  if (res.ok && typeOkFor(url, res)) { await cache.put(url, res.clone()); return true; }
  throw new Error('bad response for ' + url);
}
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(CORE.map(u => cachePut(c, u)));   // 1つでも失敗ならinstall失敗→再試行
  })());
  self.skipWaiting();
});

// 旧キャッシュ削除は「このアプリのキャッシュ」だけに限定する。
// 同一オリジンに別アプリ(鳥類調査アプリ等)がある場合、そのキャッシュまで消さないため。
function isOwnCache(k){ return k === CACHE || k === TILE_CACHE || k === PACK_CACHE
  || k.startsWith('redd-survey-') || k.startsWith('redd-map-'); }
function isKeepCache(k){ return k === CACHE || k === TILE_CACHE || k === PACK_CACHE; }
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => isOwnCache(k) && !isKeepCache(k)).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function isTile(url){ return url.includes('cyberjapandata.gsi.go.jp'); }
// 静的ベンダ資産（更新頻度が低い）はキャッシュ優先で、圏外でも即表示・毎回の再取得を避ける
function isStaticVendor(url){
  return url.endsWith('/leaflet.js') || url.endsWith('/leaflet.css') ||
         url.endsWith('/icon-192.svg') || url.endsWith('/icon-512.svg');
}
// アプリ本体(HTML/manifest)はネット優先で最新を取りに行く（ただしタイムアウト付き）
function isHtmlShell(url){
  return url.endsWith('/redd_survey.html') || url.endsWith('/') || url.endsWith('/manifest.json');
}
async function handleTile(request){
  // 先に「保存した範囲(パック)」を見て、無ければ「自然に溜まった分」を見る
  const pack = await caches.open(PACK_CACHE);
  const inPack = await pack.match(request);
  if (inPack) return inPack;
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try{
    const res = await fetch(request);
    if (res.ok){
      const keys = await cache.keys();
      if (keys.length >= MAX_TILES){ for (let i=0;i<200;i++) await cache.delete(keys[i]); }
      await cache.put(request, res.clone());
    }
    return res;
  }catch(e){
    if (cached) return cached;
    return new Response('', { status: 408 });
  }
}

// ページからの依頼を受ける（範囲の保存・保存済みの計測・パックの削除）。
// ダウンロードのループはページ側で回し、ここは PACK_CACHE への出し入れだけを担う。
self.addEventListener('message', e => {
  const m = e.data || {};
  const reply = r => { try{ e.ports[0] && e.ports[0].postMessage(r); }catch(err){} };
  if (m.type === 'savePackTiles'){
    (async () => {
      const pack = await caches.open(PACK_CACHE);
      let ok=0, fail=0;
      for (const url of (m.urls||[])){
        try{
          if (await pack.match(url)){ ok++; continue; }   // すでに保存済み
          const res = await fetch(url, { mode:'cors' });
          if (res.ok){ await pack.put(url, res.clone()); ok++; } else fail++;
        }catch(err){ fail++; }
      }
      reply({ ok, fail });
    })();
  } else if (m.type === 'packStats'){
    (async () => {
      const pack = await caches.open(PACK_CACHE);
      const keys = await pack.keys();
      let bytes=0;
      for (const req of keys){
        const r = await pack.match(req);
        try{ bytes += (await r.clone().blob()).size; }catch(err){}
      }
      reply({ count: keys.length, bytes });
    })();
  } else if (m.type === 'deletePack'){
    (async () => {
      const pack = await caches.open(PACK_CACHE);
      let n=0;
      for (const url of (m.urls||[])){ if (await pack.delete(url)) n++; }
      reply({ deleted:n });
    })();
  } else if (m.type === 'clearPacks'){
    caches.delete(PACK_CACHE).then(()=>reply({ ok:true }));
  }
});

// ネット優先＋タイムアウト。時間内に取れなければキャッシュへフォールバック。
async function networkFirst(request){
  const cache = await caches.open(CACHE);
  const netP = fetch(request).then(res => {
    if (cacheable(res, request.url)) cache.put(request, res.clone()).catch(()=>{});
    return res;
  });
  const timeoutP = new Promise(resolve => setTimeout(() => resolve('timeout'), 3500));
  try{
    const r = await Promise.race([netP, timeoutP]);
    // 404/5xx のときは、手元にキャッシュがあればそちらを出す
    // （配信の一時的な不調で、オフライン対応のアプリが白画面になるのを防ぐ）
    if (r !== 'timeout' && r && r.ok) return r;
    if (r !== 'timeout' && r){
      const cachedErr = await cache.match(request);
      if (cachedErr) return cachedErr;
      return r;
    }
    const cached = await cache.match(request);          // タイムアウト→キャッシュ
    if (cached) return cached;
    return await netP;                                  // キャッシュも無ければネット完了を待つ
  }catch(e){
    const cached = await cache.match(request);
    return cached || cache.match('./redd_survey.html');
  }
}

// キャッシュ優先。無ければネット取得し、正常なら保存。
// 静的資産(JS/CSS等)の取得失敗時にHTMLを返すのは不適切なので、その場合はエラー応答を返す。
async function cacheFirst(request){
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try{
    const res = await fetch(request);
    if (cacheable(res, request.url)) cache.put(request, res.clone()).catch(()=>{});
    return res;
  }catch(e){
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (isTile(url)){ e.respondWith(handleTile(req)); return; }
  if (req.mode === 'navigate' || isHtmlShell(url)){ e.respondWith(networkFirst(req)); return; }
  if (isStaticVendor(url)){ e.respondWith(cacheFirst(req)); return; }
  // 自分のキャッシュだけを見る（同一オリジンの別アプリのキャッシュを覗かない）
  e.respondWith(caches.open(CACHE).then(c => c.match(req)).then(cached => cached || fetch(req)));
});
