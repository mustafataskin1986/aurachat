// ==========================================
// GERİ TUŞU YÖNETİMİ
//
// APK (Capacitor): tarayıcı geçmişi (history) HİÇ kullanılmaz. Kendi yığınımız var,
// Android geri tuşu gelince yığının tepesindeki kapatıcı çalışır; yığın boşsa uygulama kapanır.
//
// PWA (tarayıcı): history.pushState kullanılır, ama ilk kullanıcı dokunuşuna kadar ertelenir.
//
// Dışarı açılan fonksiyonlar: pushBackState(kapatici), popBackState()
// ==========================================

const cap = window.Capacitor;
const isNativeApp = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
const nativeApp = isNativeApp && cap.Plugins ? cap.Plugins.App : null;
const useNativeStack = !!(nativeApp && typeof nativeApp.addListener === 'function');

// Her kayıt: { fn, pushed } (pushed: PWA'da gerçekten history.pushState yapıldı mı)
const stack = [];
// Kapatıcı çalışırken içinden popBackState çağrılırsa bir kayıt daha silinmesin
let handlingBack = false;

// ---------- APK ----------
if (useNativeStack) {
    nativeApp.addListener('backButton', () => {
        const entry = stack.pop();
        if (entry) {
            handlingBack = true;
            try { entry.fn(); } catch (e) { console.warn('geri kapatıcı hatası:', e); }
            handlingBack = false;
            return;
        }
        // Açık bir ekran yok: uygulamadan çık
        try { nativeApp.exitApp(); } catch (e) {}
    });
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