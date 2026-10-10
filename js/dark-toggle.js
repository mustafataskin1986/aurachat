// ==========================================
// KARANLIK TEMA DÜĞMESİ
// - Liste ekranındaki üst barda, üç noktanın yanındaki ay simgesi: dokununca açılır/kapanır
// - Açıkken tüm tam ekran paneller (profil, yıldızlı mesajlar, grup bilgisi, kişiler, tema seçici...),
//   açılır menüler ve alttan açılan kartlar da siyah olur
// - Ayar eski "Siyah arayüz" ile aynı anahtarı kullanır (aurachat_black_ui); sohbet temasındaki eski satır gizlenir
// ==========================================

const BLACK_KEY = 'aurachat_black_ui';

(function injectCss() {
    if (document.getElementById('aura-dark-toggle-css')) return;
    const s = document.createElement('style');
    s.id = 'aura-dark-toggle-css';
    s.textContent = `
#theme-black-row{display:none !important}
html[data-aura-black] .fixed[class*="bg-[#0b141a]"]{background-color:#000 !important}
html[data-aura-black] .fixed[class*="bg-[#0b141a]"] [class*="bg-[#202c33]"]:not(input):not(textarea){background-color:#121212 !important}
html[data-aura-black] .fixed[class*="bg-[#0b141a]"] [class*="bg-[#202c33]"][class*="border-b"]:not(input):not(textarea){background-color:#000 !important}
html[data-aura-black] .fixed[class*="bg-[#0b141a]"] [class*="bg-[#111b21]"]:not(input):not(textarea){background-color:#121212 !important}
html[data-aura-black] .fixed.items-end > [class*="bg-[#202c33]"]{background-color:#121212 !important}
html[data-aura-black] [class*="bg-[#233138]"]{background-color:#121212 !important}
html[data-aura-black] #dark-toggle-btn{color:var(--aura-btn,#22c55e) !important}`;
    document.head.appendChild(s);
})();

function isOn() {
    try { return localStorage.getItem(BLACK_KEY) === '1'; } catch (e) { return false; }
}

function apply() {
    if (isOn()) document.documentElement.setAttribute('data-aura-black', '1');
    else document.documentElement.removeAttribute('data-aura-black');
}

function paint() {
    const b = document.getElementById('dark-toggle-btn');
    if (!b) return;
    b.className = (isOn() ? 'fa-solid' : 'fa-regular') + ' fa-moon cursor-pointer hover:text-white transition';
    b.setAttribute('aria-pressed', isOn() ? 'true' : 'false');
}

function init() {
    const b = document.getElementById('dark-toggle-btn');
    if (!b || b.dataset.bound) return;
    b.dataset.bound = '1';
    b.addEventListener('click', () => {
        try {
            if (isOn()) localStorage.removeItem(BLACK_KEY);
            else localStorage.setItem(BLACK_KEY, '1');
        } catch (e) {}
        apply();
        paint();
    });
    apply();
    paint();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
