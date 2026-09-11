const CACHE_NAME = 'aurachat-offline-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html'
];

// 1. Kurulum (Install) Aşaması: Temel dosyaları önbelleğe al
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// 2. Etkinleştirme (Activate) Aşaması: Eski önbellekleri temizle
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

// 3. Yakalama (Fetch) Aşaması: Önce ağdan dene, internet yoksa önbellekten sun
self.addEventListener('fetch', (e) => {
  // Sadece GET isteklerini işleme al
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then((response) => {
        // Ağdan başarılı yanıt gelirse, bunu kopyalayıp önbelleğe de kaydet (Dış CDN'ler dahil)
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, responseClone);
        });
        return response;
      })
      .catch(() => {
        // İnternet yoksa (çevrimdışıysan) önbellekten getir
        return caches.match(e.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // Sayfa istekleri için (çevrimdışı yönlendirmelerde) ana sayfayı sun
          if (e.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
      })
  );
});

// --- FIREBASE PUSH NOTIFICATION DİNLEYİCİSİ ---
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: "SENIN_API_KEY",
    authDomain: "SENIN_AUTH_DOMAIN",
    projectId: "SENIN_PROJECT_ID",
    storageBucket: "SENIN_STORAGE_BUCKET",
    messagingSenderId: "SENIN_MESSAGING_SENDER_ID",
    appId: "SENIN_APP_ID"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
    console.log('[sw.js] Arka planda bildirim geldi:', payload);
    const title = payload.notification?.title || 'Yeni Mesaj';
    const options = {
        body: payload.notification?.body || 'AuraChat yeni bir mesajınız var.',
        icon: '/icon.png',
        badge: '/icon.png',
        data: payload.data
    };
    self.registration.showNotification(title, options);
});

