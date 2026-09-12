const CACHE_NAME = 'aurachat-offline-v2';
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
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request)
      .then((response) => {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, responseClone);
        });
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

self.registration.showNotification(title, options);
});