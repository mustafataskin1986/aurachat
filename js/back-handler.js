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

// Bir görünüm/panel açıldığında çağrılır.
// closeFn: geri tuşuna basılınca çalışacak, SADECE arayüzü kapatan
// fonksiyon (history'ye dokunmamalı).
export function pushBackState(closeFn) {
    backStack.push(closeFn);
    history.pushState({ auraBack: backStack.length }, '');
}

// Görünüm kullanıcı arayüzünden (X butonu, dışına tıklama, uygulama
// içi "geri" butonu vb.) kapatıldığında çağrılır - tarayıcı
// geçmişini de senkron tutar.
export function popBackState() {
    if (backStack.length === 0) return;
    backStack.pop();
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
