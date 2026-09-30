const CACHE_NAME = 'aurachat-offline-v5';
const ASSETS_TO_CACHE = [
  './',
  './index.html'
];

// true yaparsan yerel dosyalar eskisi gibi her açılışta önce ağdan gelir (test sırasında işe yarar).
// false: önce cache'ten anında açılır, güncelleme arkadan iner ve bir SONRAKİ açılışta görünür.
const ALWAYS_FRESH = false;

// Bu sitelerdeki dosyalar cihazda tutulur (ilk çizimi bekletmesinler)
const CDN_HOSTS = ['cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];

// 1. Kurulum
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 2. Etkinleştirme: eski önbellekleri temizle
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Önce cache'teki kopya hemen verilir, arkadan ağdan tazelenir
function staleWhileRevalidate(e) {
  const isNav = e.request.mode === 'navigate';
  const key = isNav ? './index.html' : e.request;
  const sameOrigin = new URL(e.request.url).origin === self.location.origin;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(key);
    const req = sameOrigin ? new Request(e.request, { cache: 'no-store' }) : e.request;

    const network = fetch(req).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) {
        cache.put(key, res.clone());
      }
      return res;
    }).catch(() => null);

    if (cached) {
      e.waitUntil(network);
      return cached;
    }

    const res = await network;
    if (res) return res;
    if (isNav) {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    return Response.error();
  })());
}

// Eski davranış: önce ağ, olmazsa cache
function networkFirst(e) {
  const noCacheRequest = new Request(e.request, { cache: 'no-store' });
  e.respondWith(
    fetch(noCacheRequest)
      .then((response) => {
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(e.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          if (e.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
      })
  );
}

// 3. Yakalama: Firestore, Firebase Auth gibi istekler asla karışmaz
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isCdn = CDN_HOSTS.includes(url.hostname);

  if (!isSameOrigin && !isCdn) return;
  if (isSameOrigin && url.pathname.startsWith('/api/')) return;

  if (isSameOrigin && ALWAYS_FRESH) {
    networkFirst(e);
  } else {
    staleWhileRevalidate(e);
  }
});

// --- FIREBASE PUSH NOTIFICATION DİNLEYİCİSİ ---
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: "AIzaSyDTOmajjZsfnikrJLM1UVmXMlUobFNyJGs",
    authDomain: "aurachat-99f69.firebaseapp.com",
    projectId: "aurachat-99f69",
    storageBucket: "aurachat-99f69.firebasestorage.app",
    messagingSenderId: "447747395966",
    appId: "1:447747395966:web:7db71f9f912a188d17632f"
});

const messaging = firebase.messaging();

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const data = event.notification.data || {};

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) {
                    client.postMessage({
                        type: 'OPEN_CHAT',
                        otherUid: data.otherUid,
                        otherName: data.otherName,
                        otherAvatar: data.otherAvatar
                    });
                    return client.focus();
                }
            }
            if (clients.openWindow && data.otherUid) {
                const params = new URLSearchParams({
                    openChat: data.otherUid,
                    otherName: data.otherName || '',
                    otherAvatar: data.otherAvatar || ''
                });
                return clients.openWindow(`./?${params.toString()}`);
            } else if (clients.openWindow) {
                return clients.openWindow('./');
            }
        })
    );
});

messaging.onBackgroundMessage((payload) => {
    console.log('[sw.js] Arka planda bildirim geldi:', payload);

    // Otomatik bildirim ekran basımını kontrol et:
    // Eğer payload.notification varsa Firebase Web SDK bazı durumlarda bildirimi kendi basar.
    // Çift bildirimi önlemek için tag ve veri önceliklendirmesi ekliyoruz.
    const title = payload.notification?.title || payload.data?.title || 'Yeni Mesaj';
    const body = payload.notification?.body || payload.data?.body || 'AuraChat yeni bir mesajınız var.';

    // Gönderenin avatarı data paketiyle gelmişse onu kullan, yoksa ikon dosyasını bas
    const iconUrl = payload.data?.senderAvatar || payload.notification?.icon || './icon.png';

    const options = {
        body: body,
        icon: iconUrl,
        badge: './icon.png',
        // tag parametresi aynı sohbetten gelen bildirimleri tekilleştirerek üst üste binmeyi engeller
        tag: payload.data?.chatId ? `aurachat-${payload.data.chatId}` : 'aurachat-general',
        renotify: true,
        data: payload.data || {}
    };

    if (!payload.notification) {
        self.registration.showNotification(title, options);
    }
});