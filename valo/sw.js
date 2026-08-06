/* ============================================================
   VALO // 股票資產管理與記憶庫 — Service Worker
   離線快取策略：
   - App Shell（index.html / manifest.json）：Network-First
     每次都優先嘗試連網抓最新版本，抓不到（離線／斷線）才退回快取，
     確保使用者只要開過一次網頁，離線時仍能看到最後一次的畫面骨架。
   - 靜態資源（CDN 上的 JS 函式庫、Google Fonts、圖示等 GET 請求）：Cache-First
     優先直接回快取（載入更快、離線也能用），背景仍會再打一次網路把快取刷新，
     下次開啟時就是最新版本（Stale-While-Revalidate 的簡化版）。
   - Firebase Auth／Firestore 與其他非 GET 請求（登入、雲端讀寫、AI 分析 API 等）：
     完全略過快取，直接放行給瀏覽器原生處理，避免快取到過期或錯誤的雲端資料。
============================================================ */

const CACHE_VERSION = 'valo-portfolio-v1';
const PRECACHE_URLS = [
    './',
    './index.html',
    './manifest.json'
];

// 不快取的網域關鍵字：Firebase Auth／Firestore、Google 帳號登入相關網址一律放行給瀏覽器原生處理
const NO_CACHE_HOSTS = [
    'firestore.googleapis.com',
    'firebaseio.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'accounts.google.com',
    'www.googleapis.com'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then((cache) => cache.addAll(PRECACHE_URLS))
            .catch((err) => console.log('SW precache failed:', err))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

function isNoCacheRequest(url) {
    return NO_CACHE_HOSTS.some((host) => url.includes(host));
}

// Network-First：先打網路，成功就順便更新快取；失敗（離線）才退回快取，
// 導覽（HTML 頁面）請求都走這條，確保拿到的是最新版本的儀表板骨架。
async function networkFirst(request) {
    const cache = await caches.open(CACHE_VERSION);
    try {
        const networkResponse = await fetch(request);
        if (networkResponse && networkResponse.ok) {
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (err) {
        const cached = await cache.match(request);
        if (cached) return cached;
        const fallback = await cache.match('./index.html');
        if (fallback) return fallback;
        throw err;
    }
}

// Cache-First：先看快取有沒有，有就直接回傳（速度最快、離線也能用），
// 背景同時再打一次網路把快取刷新成最新版本，下次載入自動生效。
async function cacheFirst(request) {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(request);

    const networkFetchPromise = fetch(request)
        .then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
                cache.put(request, networkResponse.clone());
            }
            return networkResponse;
        })
        .catch(() => null);

    if (cached) {
        // 背景刷新快取，不阻塞這次回應
        networkFetchPromise.catch(() => {});
        return cached;
    }

    const networkResponse = await networkFetchPromise;
    if (networkResponse) return networkResponse;
    throw new Error('SW cacheFirst: 網路與快取都拿不到資源');
}

self.addEventListener('fetch', (event) => {
    const request = event.request;

    // 只處理 GET 請求；POST/PUT 等寫入型請求（登入、雲端寫入、AI 分析等）一律放行給瀏覽器原生處理
    if (request.method !== 'GET') return;

    const url = request.url;
    if (isNoCacheRequest(url)) return;

    // 導覽請求（切換頁面／PWA 啟動）：Network-First，離線時退回快取的 index.html
    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request));
        return;
    }

    // 其餘同源或 CDN 靜態資源（JS 函式庫、字型、CSS、Data URI 圖示等）：Cache-First
    event.respondWith(cacheFirst(request));
});
