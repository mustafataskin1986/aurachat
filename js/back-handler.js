// ==========================================
// GERİ TUŞU (BACK BUTTON) YÖNETİMİ
// Android'in sistem geri tuşu, açık bir panel/sohbet/modal varken
// onu kapatması gerekirken direkt uygulamadan çıkıyordu - çünkü
// tarayıcı geçmişinde geri gidecek bir kayıt yoktu.
//
// Bu modül: bir panel/görünüm açıldığında sahte bir geçmiş kaydı
// ekler (pushBackState). Geri tuşuna basılınca o kaydı tüketip
// ilgili panelin "kapat" fonksiyonunu çalıştırır - uygulamadan
// çıkmak yerine.
// ==========================================

const backStack = [];
let ignoreNextPopstate = false;

// Chrome'un "geçmiş manipülasyonu koruması": kullanıcı sayfaya hiç dokunmadan
// (örn. bildirimden açılış) sahte geçmiş kaydı eklenirse, PWA'da sistem geri tuşu
// o kaydı ATLAYIP uygulamadan çıkıyor. O yüzden PWA'da ilk dokunuşa kadar kayıt
// eklemeyi erteliyoruz. APK'da geri tuşu JS ile history.back() çağırdığı için
// bu koruma etkilemiyor, orada kaydı hemen ekliyoruz.
const isNativeApp = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
let pendingHistoryPushes = 0;
let gestureListenersOn = false;
const GESTURE_EVENTS = ['pointerup', 'touchend', 'click', 'keydown'];

function userHasInteracted() {
    if (isNativeApp) return true;
    const ua = navigator.userActivation;
    return !ua || ua.hasBeenActive;
}

function flushPendingPushes() {
    while (pendingHistoryPushes > 0) {
        pendingHistoryPushes--;
        history.pushState({ auraBack: backStack.length }, '');
    }
}

function onFirstGesture() {
    GESTURE_EVENTS.forEach((t) => window.removeEventListener(t, onFirstGesture, true));
    gestureListenersOn = false;
    flushPendingPushes();
}

function waitForGesture() {
    if (gestureListenersOn) return;
    gestureListenersOn = true;
    GESTURE_EVENTS.forEach((t) => window.addEventListener(t, onFirstGesture, true));
}

// Bir görünüm/panel açıldığında çağrılır.
// closeFn: geri tuşuna basılınca çalışacak, SADECE arayüzü kapatan
// fonksiyon (history'ye dokunmamalı).
export function pushBackState(closeFn) {
    backStack.push(closeFn);
    if (userHasInteracted()) {
        if (pendingHistoryPushes > 0) flushPendingPushes(); // sıra bozulmasın
        history.pushState({ auraBack: backStack.length }, '');
    } else {
        pendingHistoryPushes++;
        waitForGesture();
    }
}

// Görünüm kullanıcı arayüzünden (X butonu, dışına tıklama, uygulama
// içi "geri" butonu vb.) kapatıldığında çağrılır - tarayıcı
// geçmişini de senkron tutar.
export function popBackState() {
    if (backStack.length === 0) return;
    backStack.pop();
    if (pendingHistoryPushes > 0) {
        // Bu kayıt için henüz gerçek geçmiş girişi eklenmemişti
        pendingHistoryPushes--;
        return;
    }
    ignoreNextPopstate = true;
    history.back();
}

window.addEventListener('popstate', () => {
    if (ignoreNextPopstate) {
        ignoreNextPopstate = false;
        return;
    }
    const closeFn = backStack.pop();
    if (closeFn) closeFn();
});

// ------------------------------------------
// CAPACITOR NATIVE GERİ TUŞU KÖPRÜSÜ
// TWA'da (gerçek Chrome) donanım geri tuşu otomatik olarak
// tarayıcı geçmişine bağlıdır. Capacitor'de ise DEĞİLDİR - native
// "App" eklentisi kendi backButton olayını fırlatır, bizim
// history/popstate sistemimizden habersizdir. Burada o olayı
// yakalayıp history.back()'e yönlendiriyoruz; böylece backStack'imiz
// hem TWA'da hem Capacitor APK'sında aynı şekilde çalışır.
// ------------------------------------------
if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    const CapApp = window.Capacitor.Plugins.App;

    CapApp.addListener('backButton', ({ canGoBack }) => {
        if (backStack.length > 0) {
            // Bizim açtığımız bir panel/görünüm var - normal history.back() akışına sok,
            // popstate listener'ımız zaten yukarıda bunu yakalayıp kapatacak.
            history.back();
        } else if (canGoBack) {
            history.back();
        } else {
            CapApp.exitApp();
        }
    });
}