// ==========================================
// GERİ TUŞU YÖNETİMİ
//
// APK (Capacitor): tarayıcı geçmişi (history) HİÇ kullanılmaz. Kendi yığınımız var,
// Android geri tuşu gelince yığının tepesindeki kapatıcı çalışır; yığın boşsa uygulama kapanır.
// (Bildirimden açılışta kullanıcı dokunmadan pushState yapılırsa Chrome o kaydı atlıyordu;
//  geçmiş kullanılmadığı için bu sorun APK'da artık yok.)
//
// PWA (tarayıcı): history.pushState kullanılır, ama ilk kullanıcı dokunuşuna kadar ertelenir.
//
// Dışarı açılan fonksiyonlar: pushBackState(kapatici), popBackState()
//  - pushBackState(fn): bir ekran/pencere açıldığında çağrılır, geri tuşuna basılınca fn çalışır.
//  - popBackState(): ekran düğmeyle (geri oku, X vb.) elle kapatıldığında çağrılır, yığından kaydı atar.
// ==========================================

const cap = window.Capacitor;
const isNativeApp = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
const nativeApp = isNativeApp && cap.Plugins ? cap.Plugins.App : null;
const hasCapBack = !!(nativeApp && typeof nativeApp.addListener === 'function');
// APK kabuğu: AuraSplash / AuraLaunch nesnelerini APK'nın kendi Java kodu ekler, Capacitor köprüsüne bağlı değildir
const isAuraShell = !!(window.AuraSplash || window.AuraLaunch);
const useNativeStack = hasCapBack || isAuraShell;

// Her kayıt: { fn, pushed } (pushed: PWA'da gerçekten history.pushState yapıldı mı)
const stack = [];
// Kapatıcı çalışırken içinden popBackState çağrılırsa bir kayıt daha silinmesin
let handlingBack = false;

// ---------- APK ----------
// true dönerse geri tuşu işlendi demektir (bir ekran kapatıldı); false dönerse uygulama arka plana atılır
function nativeBackPress() {
    const entry = stack.pop();
    if (entry) {
        handlingBack = true;
        try { entry.fn(); } catch (e) { console.warn('geri kapatıcı hatası:', e); }
        handlingBack = false;
        return true;
    }
    return false;
}
if (useNativeStack) {
    // Yeni APK: MainActivity geri tuşunu bu fonksiyona sorar (Capacitor köprüsü olmasa da çalışır)
    window.__auraBackPress = nativeBackPress;
}
if (hasCapBack) {
    // Eski APK ya da köprü varsa: Capacitor geri olayı
    nativeApp.addListener('backButton', () => {
        if (!nativeBackPress()) {
            try { nativeApp.exitApp(); } catch (e) {}
        }
    });
}

// GEÇİCİ TANI: açılışta ekranda 8 sn küçük bir yazı gösterir (sorun bulununca silinecek)
function showDiag() {
    try {
        const t = 'TANI: kabuk=' + (isAuraShell ? 'APK' : 'PWA') +
            ' | Capacitor=' + (cap ? 'var' : 'yok') +
            ' | platform=' + (cap && cap.getPlatform ? cap.getPlatform() : '-') +
            ' | köprü=' + (typeof window.androidBridge) +
            ' | App eklentisi=' + (hasCapBack ? 'var' : 'yok');
        const el = document.createElement('div');
        el.textContent = t;
        el.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:2147483647;background:#000c;color:#fff;font:12px sans-serif;padding:8px;border-radius:8px;pointer-events:none';
        document.body.appendChild(el);
        setTimeout(() => { try { el.remove(); } catch (e) {} }, 8000);
    } catch (e) {}
}

// ---------- PWA ----------
let ignorePopstate = 0;

function userHasInteracted() {
    try {
        if (navigator.userActivation) return navigator.userActivation.hasBeenActive;
    } catch (e) {}
    return true;
}

function doPush(entry) {
    try {
        history.pushState({ auraBack: true }, '');
        entry.pushed = true;
    } catch (e) {
        entry.pushed = false;
    }
}

let gestureWaiting = false;
function waitForGesture() {
    if (gestureWaiting) return;
    gestureWaiting = true;
    const events = ['pointerup', 'touchend', 'click', 'keydown'];
    const onFirstGesture = () => {
        events.forEach((ev) => window.removeEventListener(ev, onFirstGesture, true));
        gestureWaiting = false;
        stack.forEach((entry) => { if (!entry.pushed) doPush(entry); });
    };
    events.forEach((ev) => window.addEventListener(ev, onFirstGesture, true));
}

if (!useNativeStack) {
    window.addEventListener('popstate', () => {
        if (ignorePopstate > 0) { ignorePopstate--; return; }
        // Gerçekten pushState yapılmış en üstteki kaydı bul ve kapat
        for (let i = stack.length - 1; i >= 0; i--) {
            if (stack[i].pushed) {
                const entry = stack.splice(i, 1)[0];
                handlingBack = true;
                try { entry.fn(); } catch (e) { console.warn('geri kapatıcı hatası:', e); }
                handlingBack = false;
                return;
            }
        }
        // history'de kaydı olmayan (ertelenmiş) bir ekran varsa onu kapat
        const entry = stack.pop();
        if (entry) {
            handlingBack = true;
            try { entry.fn(); } catch (e) { console.warn('geri kapatıcı hatası:', e); }
            handlingBack = false;
        }
    });
}

// ---------- Ortak API ----------
export function pushBackState(closeFn) {
    const entry = { fn: typeof closeFn === 'function' ? closeFn : () => {}, pushed: false };
    stack.push(entry);
    if (useNativeStack) return;
    if (userHasInteracted()) {
        doPush(entry);
    } else {
        waitForGesture();
    }
}

export function popBackState() {
    // Geri tuşuyla zaten yığından çıkarılmış ve kapatıcı çalışıyorsa tekrar silme
    if (handlingBack) return;
    const entry = stack.pop();
    if (!entry) return;
    if (useNativeStack) return;
    if (entry.pushed) {
        ignorePopstate++;
        try { history.back(); } catch (e) { ignorePopstate--; }
    }
}
