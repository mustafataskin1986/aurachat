// ==========================================
// UYGULAMA İKONU (Profil > Uygulama ikonu)
// - Yalnızca Android uygulamasında (APK) görünür; tarayıcıda satır eklenmez
// - Simgeler: static/icons/ikon-1.png ... ikon-15.png (0 = mevcut/varsayılan simge)
// - Bir simgeye dokununca uygulama simgesi hemen değişir (AuraIcon köprüsü)
// ==========================================

import { pushBackState, popBackState } from "./back-handler.js";
import { showToast } from "./chat-core.js";

const COUNT = 15;
let panelEl = null;

function bridge() {
    return window.AuraIcon && window.AuraIcon.set ? window.AuraIcon : null;
}

function currentIcon() {
    try { return Number(bridge().current()) || 0; } catch (e) { return 0; }
}

function accent() {
    try { return getComputedStyle(document.documentElement).getPropertyValue('--aura-btn').trim() || '#22c55e'; } catch (e) { return '#22c55e'; }
}

function closePanel(fromBack) {
    if (!panelEl) return;
    panelEl.remove();
    panelEl = null;
    if (!fromBack) popBackState();
}

// Ana ekrandaki ikonla aynı görünsün diye: arka plan = görselin köşe rengi, görsel %83 boyutunda ortada
// (APK'daki adaptive ikonla aynı işlem). Varsayılan ikon için maskable görsel kullanılır.
function iconSrc(n) {
    return n === 0 ? '/static/icons/icon-maskable-512.png' : `/static/icons/ikon-${n}.png`;
}

function tileHtml(n, label, selected, bg) {
    return `<button type="button" data-icon="${n}" style="display:flex;flex-direction:column;align-items:center;gap:8px;background:none;border:0;padding:6px;cursor:pointer;">
        <span style="position:relative;display:flex;align-items:center;justify-content:center;width:76px;height:76px;border-radius:20px;background:${bg || '#202c33'};${selected ? 'outline:3px solid ' + accent() + ';outline-offset:3px;' : ''}">
            <img src="${iconSrc(n)}" alt="" style="width:83.33%;height:83.33%;object-fit:contain;">
            ${selected ? `<span data-check style="position:absolute;right:-6px;bottom:-6px;width:22px;height:22px;border-radius:9999px;background:${accent()};color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;"><i class="fa-solid fa-check"></i></span>` : ''}
        </span>
        <span style="color:#8696a0;font-size:11px;">${label}</span>
    </button>`;
}

// Hangi ikon dosyaları gerçekten var? Boş kutular hiç çizilmez. Köşe rengi de burada okunur.
let availableIcons = null; // [{ n, bg }]
function probe(n) {
    return new Promise((resolve) => {
        const im = new Image();
        const t = setTimeout(() => resolve(null), 4000);
        im.onload = () => {
            clearTimeout(t);
            let bg = '#000';
            try {
                const c = document.createElement('canvas');
                c.width = 8; c.height = 8;
                const cx = c.getContext('2d');
                cx.drawImage(im, 0, 0, 8, 8);
                const d = cx.getImageData(1, 1, 1, 1).data;
                bg = d[3] < 255 ? '#000' : `rgb(${d[0]},${d[1]},${d[2]})`;
            } catch (e) {}
            resolve({ n, bg });
        };
        im.onerror = () => { clearTimeout(t); resolve(null); };
        im.src = iconSrc(n);
    });
}
async function loadAvailable() {
    if (availableIcons) return availableIcons;
    const res = await Promise.all(Array.from({ length: COUNT + 1 }, (_, i) => probe(i)));
    availableIcons = res.filter(Boolean);
    return availableIcons;
}

function renderGrid(cur) {
    const grid = panelEl.querySelector('[data-grid]');
    grid.innerHTML = (availableIcons || []).map((it) => tileHtml(it.n, it.n === 0 ? 'Varsayılan' : String(it.n), cur === it.n, it.bg)).join('');
}

function openPanel() {
    if (panelEl) return;
    const black = document.documentElement.hasAttribute('data-aura-black');
    panelEl = document.createElement('div');
    panelEl.className = 'fixed inset-0 flex flex-col';
    panelEl.style.cssText = 'z-index:55;background:' + (black ? '#000' : '#0b141a') + ';';
    panelEl.innerHTML = `
        <div class="px-4 py-3.5 flex items-center space-x-4 border-b border-gray-800 flex-shrink-0" style="background:${black ? '#000' : '#202c33'};">
            <button type="button" data-back class="text-gray-400 hover:text-white transition text-lg px-1"><i class="fa-solid fa-arrow-left"></i></button>
            <h2 class="text-white font-medium text-base">Uygulama ikonu</h2>
        </div>
        <div class="flex-1 overflow-y-auto px-4 py-5">
            <p class="text-gray-400 text-sm mb-5">Bir ikona dokununca ana ekrandaki uygulama ikonu değişir. Telefonun ana ekranı birkaç saniye içinde yenilenir.</p>
            <div data-grid style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;justify-items:center;"></div>
        </div>`;
    document.body.appendChild(panelEl);
        loadAvailable().then(() => { if (panelEl) renderGrid(currentIcon()); });
    panelEl.querySelector('[data-back]').addEventListener('click', () => closePanel(false));
    panelEl.addEventListener('click', (e) => {
        const b = e.target.closest('[data-icon]');
        if (!b) return;
        const n = Number(b.dataset.icon);
        if (n === currentIcon()) { showToast('Bu ikon zaten seçili', 2000); return; }
        let ok = false;
        try { ok = bridge().set(n); } catch (err) {}
        if (ok) {
            renderGrid(n);
            showToast('Uygulama ikonu değişti', 2500);
        } else {
            showToast('İkon değiştirilemedi', 2500);
        }
    });
    pushBackState(() => closePanel(true));
}

// Profil sayfasına "Uygulama ikonu" satırı ekler (yalnızca APK'da)
export function addAppearanceRow(beforeEl) {
    if (!beforeEl || !bridge()) return;
    if (document.getElementById('aura-appearance-row')) return;
    const row = document.createElement('button');
    row.type = 'button';
    row.id = 'aura-appearance-row';
    row.className = 'w-full max-w-sm mt-3 bg-[#202c33] text-gray-100 rounded-xl px-4 py-3 flex items-center justify-between';
    row.innerHTML = `
        <span class="flex items-center space-x-3 min-w-0">
            <i class="fa-solid fa-palette text-gray-400 w-4"></i>
            <span class="text-sm">Uygulama ikonu</span>
        </span>
        <i class="fa-solid fa-chevron-right text-gray-500 text-xs"></i>`;
    row.addEventListener('click', openPanel);
    beforeEl.insertAdjacentElement('beforebegin', row);
}
