// ==========================================
// SOHBET TEMASI (kişiye özel, sohbet başına)
// Sohbetin üç nokta menüsündeki "Sohbet teması" bu dosyayı açar.
// Seçilen tema sadece bu cihazda (localStorage) tutulur, karşı tarafa gitmez.
// Tema: sohbet arka planı + giden/gelen mesaj balonu renkleri.
//
// Yeni tema eklemek için THEMES listesine bir satır eklemek yeterli.
// Sohbet açılınca tema kendiliğinden uygulanır (başlıktaki isim değişimi izlenir).
// ==========================================

import { getCurrentChatId, showToast } from "./chat-core.js";
import { pushBackState, popBackState } from "./back-handler.js";
import { openImageCropper } from "./image-cropper.js";

const STORE_PREFIX = 'aurachat_theme_';
const DEFAULT_BG = '#0b141a';
const DEFAULT_OUT = '#005c4b';
const DEFAULT_IN = '#212121';

// id, name, bg (CSS arka plan), out (giden balon), inc (gelen balon)
export const THEMES = [
    { id: 'default', name: 'Varsayılan', bg: null, out: null, inc: null },
    { id: 'amoled', name: 'Kömür', bg: '#000000', out: '#1f6f5c', inc: '#1a1a1a' },
    { id: 'mavi', name: 'Gece Mavisi', bg: 'linear-gradient(160deg,#0a1929,#12304d)', out: '#1d5fa8', inc: '#1b2b3c' },
    { id: 'orman', name: 'Orman', bg: 'linear-gradient(160deg,#0b1f14,#14402a)', out: '#1f7a4d', inc: '#183326' },
    { id: 'okyanus', name: 'Okyanus', bg: 'linear-gradient(160deg,#04222b,#0b5563)', out: '#118a9a', inc: '#0d3a45' },
    { id: 'gunbatimi', name: 'Gün Batımı', bg: 'linear-gradient(160deg,#2b1020,#5a2a3a 60%,#7a3f2a)', out: '#b5483a', inc: '#3a2030' },
    { id: 'mor', name: 'Mor Gece', bg: 'linear-gradient(160deg,#160b2e,#3a1b6b)', out: '#6d3fc0', inc: '#2a1a4a' },
    { id: 'pembe', name: 'Pembe', bg: 'linear-gradient(160deg,#2a0f22,#5a1f4a)', out: '#c2347f', inc: '#3d1a35' },
    { id: 'bordo', name: 'Bordo', bg: 'linear-gradient(160deg,#2a0d12,#5a1a26)', out: '#a3283d', inc: '#3a1820' },
    { id: 'kahve', name: 'Kahve', bg: 'linear-gradient(160deg,#1f1510,#3d2a1f)', out: '#8a5a3a', inc: '#33241b' },
    { id: 'celik', name: 'Çelik', bg: 'linear-gradient(160deg,#14171c,#2a3038)', out: '#4b6a8a', inc: '#262c34' }
];

// ---------- Balon renklerini değiştiren CSS (sadece tema açıkken çalışır) ----------
(function injectCss() {
    if (document.getElementById('aura-theme-css')) return;
    const s = document.createElement('style');
    s.id = 'aura-theme-css';
    s.textContent = String.raw`html[data-aura-theme] #message-container > div > div.bg-\[\#005c4b\]{background-color:var(--aura-out) !important}
#message-container > div > div.bg-\[\#202c33\]{background-color:#212121 !important}
html[data-aura-theme] #send-btn,html[data-aura-theme] #mic-btn{background-color:var(--aura-out) !important;background-image:none !important}
#chat-area,#sidebar{transition:none !important}
#message-input,#message-input:focus{border:1px solid var(--aura-btn,#22c55e) !important;outline:none !important;--tw-ring-shadow:0 0 #0000 !important;background-color:#000000 !important;caret-color:var(--aura-btn,#22c55e)}
#message-input{box-shadow:none !important}
#message-input:focus{box-shadow:inset 0 0 0 1px var(--aura-btn,#22c55e) !important}
div:has(> #message-input){border-color:transparent !important}
#chat-area [class*="border-b"],#chat-area [class*="border-t"]{border-top-width:0 !important;border-bottom-width:0 !important}
#message-container{scrollbar-width:none;-ms-overflow-style:none}
#message-container::-webkit-scrollbar{display:none;width:0;height:0}
#back-btn,#back-btn *,#voice-call-btn,#voice-call-btn *,#video-call-btn,#video-call-btn *,#chat-menu-btn,#chat-menu-btn *,#attach-btn,#attach-btn *,#send-btn,#send-btn *,#mic-btn,#mic-btn *,#selection-cancel-btn,#selection-cancel-btn *,#selection-delete-btn,#selection-delete-btn *,#main-menu-btn,#main-menu-btn *,#sidebar > div:first-child button,#sidebar > div:first-child button *{color:#ffffff !important}
#sidebar [class*="border-b"],#sidebar [class*="border-t"]{border-top-width:0 !important;border-bottom-width:0 !important}
#sidebar [class*="divide-y"] > *,#chat-area [class*="divide-y"] > *{border-top-width:0 !important;border-bottom-width:0 !important}
nav,footer{border-top-width:0 !important}
#sidebar,#chat-area{border-width:0 !important}
body :has(#sidebar),body :has(#chat-area){border-width:0 !important}
html[data-aura-black] #sidebar{background-color:#000 !important}
html[data-aura-black] #sidebar [class*="bg-[#202c33]"]:not(input):not(textarea),html[data-aura-black] #sidebar [class*="bg-[#111b21]"]:not(input):not(textarea),html[data-aura-black] #sidebar [class*="bg-[#0b141a]"]:not(input):not(textarea){background-color:#000 !important}
html[data-aura-black] #chat-area [class*="bg-[#202c33]"]:not(input):not(textarea):not(#message-container *){background-color:#000 !important}
html[data-aura-black] #chat-area [class*="bg-[#111b21]"]:not(input):not(textarea):not(#message-container *):not(#message-container){background-color:#000 !important}
*{accent-color:var(--aura-btn,#22c55e)}
::selection{background:var(--aura-btn,#22c55e) !important;color:#ffffff !important}
::-moz-selection{background:var(--aura-btn,#22c55e) !important;color:#ffffff !important}
.msg-selected{background-color:rgba(34,197,94,0.35) !important;background-color:color-mix(in srgb, var(--aura-btn, #22c55e) 35%, transparent) !important}
:root{--aura-composer-bg:#202c33}
html[data-aura-black]{--aura-composer-bg:#000}
html[data-aura-black] #chat-scroll-wrapper div:has(> #search-contact){background-color:#202c33 !important}`;
    document.head.appendChild(s);
})();

// ---------- Siyah arayüz (tüm sohbetler için tek ayar) ----------
const BLACK_KEY = 'aurachat_black_ui';

function isBlackUi() {
    try { return localStorage.getItem(BLACK_KEY) === '1'; } catch (e) { return false; }
}

function applyBlackUi() {
    if (isBlackUi()) document.documentElement.setAttribute('data-aura-black', '1');
    else document.documentElement.removeAttribute('data-aura-black');
}
applyBlackUi();

// ---------- Kayıt ----------
function loadSaved(chatId) {
    try {
        const raw = localStorage.getItem(STORE_PREFIX + chatId);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

function saveSaved(chatId, data) {
    try {
        if (!data || data.id === 'default') localStorage.removeItem(STORE_PREFIX + chatId);
        else localStorage.setItem(STORE_PREFIX + chatId, JSON.stringify(data));
        return true;
    } catch (e) {
        showToast('Tema kaydedilemedi (yer yok)', 3000);
        return false;
    }
}

function resolveTheme(saved) {
    if (!saved) return null;
    if (saved.id === 'custom' && saved.img) {
        return { id: 'custom', bg: `url("${saved.img}") center/cover no-repeat ${DEFAULT_BG}`, out: DEFAULT_OUT, inc: DEFAULT_IN };
    }
    const t = THEMES.find((x) => x.id === saved.id);
    return (t && t.id !== 'default') ? t : null;
}

// ---------- Sohbete uygula ----------
function applyTheme(chatId) {
    const mc = document.getElementById('message-container');
    if (!mc || !chatId) return;
    const ca = document.getElementById('chat-area');
    const root = document.documentElement;
    const t = resolveTheme(loadSaved(chatId));
    if (!t) {
        root.removeAttribute('data-aura-theme');
        root.style.removeProperty('--aura-out');
        root.style.removeProperty('--aura-in');
        // Varsayılan temada gönder butonunun asıl rengini oku, input çerçevesi onu kullansın
        const sb = document.getElementById('send-btn');
        const c = sb ? getComputedStyle(sb).backgroundColor : '';
        if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') root.style.setProperty('--aura-btn', c);
        else root.style.removeProperty('--aura-btn');
        mc.style.background = '';
        if (ca) ca.style.background = '';
        syncAccentToNative();
        return;
    }
    root.setAttribute('data-aura-theme', t.id);
    root.style.setProperty('--aura-out', t.out);
    root.style.setProperty('--aura-in', t.inc);
    root.style.setProperty('--aura-btn', t.out);
    mc.style.background = 'transparent';
    if (ca) ca.style.setProperty('background', t.bg, 'important');
    syncAccentToNative();
}

// Sohbet temasının ana rengini (--aura-btn) APK'ya bildirir: seçim tutamakları bu renge boyanır
function syncAccentToNative() {
    try {
        if (!window.AuraTheme || !window.AuraTheme.setAccent) return;
        const probe = document.createElement('i');
        probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--aura-btn').trim() || '#22c55e';
        document.body.appendChild(probe);
        const m = getComputedStyle(probe).color.match(/\d+/g);
        probe.remove();
        if (!m) return;
        const hex = '#' + m.slice(0, 3).map((n) => ('0' + parseInt(n, 10).toString(16)).slice(-2)).join('');
        window.AuraTheme.setAccent(hex);
    } catch (e) {}
}

// Sohbet değişince (başlıktaki isim yenilenince) o sohbetin temasını uygula
(function watchChatChange() {
    const nameEl = document.getElementById('active-chat-name');
    if (!nameEl) return;
    new MutationObserver(() => {
        const id = getCurrentChatId();
        if (id) applyTheme(id);
    }).observe(nameEl, { childList: true, characterData: true, subtree: true });
})();

// Bu dosya sohbet açıldıktan sonra yüklendiyse (bildirimle açılış) açık sohbetin temasını hemen uygula
(function applyForOpenChat() {
    const id = getCurrentChatId();
    if (id) applyTheme(id);
})();

// ---------- Tema seçme ekranı ----------
let panelEl = null;
let panelOpen = false;
let pickerChatId = null;

function closePanelFromBack() {
    if (panelEl) {
        panelEl.classList.add('hidden');
        panelEl.classList.remove('flex');
    }
    panelOpen = false;
}

function closePanel() {
    if (!panelOpen) return;
    closePanelFromBack();
    popBackState();
}

function ensurePanel() {
    if (panelEl) return panelEl;
    const el = document.createElement('div');
    el.className = 'fixed inset-0 z-[60] bg-[#0b141a] hidden flex-col';
    el.innerHTML = `
        <div class="bg-[#202c33] px-4 py-3.5 flex items-center space-x-4 border-b border-gray-800 flex-shrink-0">
            <button type="button" id="theme-back" class="text-gray-400 hover:text-white transition text-lg px-1">
                <i class="fa-solid fa-arrow-left"></i>
            </button>
            <h2 class="text-white font-medium text-base">Sohbet teması</h2>
        </div>
        <div id="theme-preview" class="relative flex-1 min-h-0 flex flex-col justify-center px-4 space-y-3 overflow-hidden">
            <div class="flex justify-start"><div class="theme-prev-in text-white text-sm px-4 py-2 rounded-xl shadow">Selam kanka 👋</div></div>
            <div class="flex justify-end"><div class="theme-prev-out text-white text-sm px-4 py-2 rounded-xl shadow">Tema nasıl olmuş?</div></div>
            <div class="flex justify-start"><div class="theme-prev-in text-white text-sm px-4 py-2 rounded-xl shadow">Çok güzel olmuş, tam istediğim gibi</div></div>
            <div class="flex justify-end"><div class="theme-prev-out text-white text-sm px-4 py-2 rounded-xl shadow">Süper, o zaman bunu kullanalım 😎</div></div>
        </div>
        <div class="flex-shrink-0 bg-[#0b141a]/95" style="padding-bottom:max(env(safe-area-inset-bottom),8px);">
            <div id="theme-black-row" class="flex items-center justify-between px-4 py-2.5 border-t border-gray-800/40 cursor-pointer">
                <div class="pr-3">
                    <p class="text-white text-sm">Siyah arayüz</p>
                    <p class="text-gray-400 text-xs mt-0.5">Üst bar, alt bar ve liste ekranı siyah olur (tüm sohbetlerde)</p>
                </div>
                <div id="theme-black-track" style="width:44px;height:24px;border-radius:12px;position:relative;flex:none;transition:background .15s;">
                    <div id="theme-black-knob" style="position:absolute;top:2px;width:20px;height:20px;border-radius:10px;background:#fff;transition:left .15s;"></div>
                </div>
            </div>
            <p class="text-gray-400 text-xs px-4 pt-2 pb-0">Renkler ve arka planlar · dokununca uygulanır</p>
            <style>#theme-grid::-webkit-scrollbar{display:none;width:0;height:0}</style>
            <div id="theme-grid" style="position:relative;display:flex;align-items:flex-start;gap:12px;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding:10px 0 4px;"></div>
        </div>
    `;
    document.body.appendChild(el);
    el.querySelector('#theme-back').addEventListener('click', closePanel);
    el.querySelector('#theme-black-row').addEventListener('click', () => {
        try {
            if (isBlackUi()) localStorage.removeItem(BLACK_KEY);
            else localStorage.setItem(BLACK_KEY, '1');
        } catch (e) {
            showToast('Ayar kaydedilemedi', 2500);
        }
        applyBlackUi();
        paintBlackSwitch();
    });
    panelEl = el;
    return el;
}

function paintBlackSwitch() {
    if (!panelEl) return;
    const on = isBlackUi();
    panelEl.querySelector('#theme-black-track').style.background = on ? '#22c55e' : '#4b5563';
    panelEl.querySelector('#theme-black-knob').style.left = on ? '22px' : '2px';
}

function setPreview(t) {
    panelEl.querySelector('#theme-preview').style.background = t ? t.bg : DEFAULT_BG;
    panelEl.querySelectorAll('.theme-prev-in').forEach((x) => { x.style.backgroundColor = DEFAULT_IN; });
    panelEl.querySelectorAll('.theme-prev-out').forEach((x) => { x.style.backgroundColor = t ? t.out : DEFAULT_OUT; });
}

function updatePreview() {
    setPreview(resolveTheme(loadSaved(pickerChatId)));
}

// ---------- Tek satır, kayan tema listesi ----------
// Ortadaki tema öne çıkar ve üstteki önizleme onunla değişir. Bir temaya dokununca hemen uygulanır.
let stripItems = [];
let stripCenterIdx = -1;
let stripScrollRaf = 0;

function paintStrip() {
    const saved = loadSaved(pickerChatId);
    const currentId = saved ? saved.id : 'default';
    stripItems.forEach((it, i) => {
        const isCenter = i === stripCenterIdx;
        const on = it.id === currentId;
        it.el.style.transform = isCenter ? 'scale(1)' : 'scale(0.86)';
        it.el.style.opacity = isCenter ? '1' : '0.7';
        const box = it.el.firstElementChild;
        if (box) {
            box.style.borderColor = on ? '#10b981' : (it.id === 'custom' && !on ? '#4b5563' : 'transparent');
            const chk = box.querySelector('[data-chk]');
            if (chk) chk.style.display = on ? 'block' : 'none';
        }
    });
}

function previewForCenter() {
    const it = stripItems[stripCenterIdx];
    if (!it) return;
    if (it.id === 'custom') { updatePreview(); return; }
    setPreview(it.t && it.t.id !== 'default' ? it.t : null);
}

function updateStripCenter() {
    const strip = panelEl && panelEl.querySelector('#theme-grid');
    if (!strip || !stripItems.length) return;
    const r = strip.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    let best = 0;
    let bestD = Infinity;
    stripItems.forEach((it, i) => {
        const b = it.el.getBoundingClientRect();
        const d = Math.abs(b.left + b.width / 2 - cx);
        if (d < bestD) { bestD = d; best = i; }
    });
    if (best !== stripCenterIdx) {
        stripCenterIdx = best;
        paintStrip();
        previewForCenter();
    }
}

function centerStripOn(idx, smooth) {
    const strip = panelEl && panelEl.querySelector('#theme-grid');
    const it = stripItems[idx];
    if (!strip || !it) return;
    const target = it.el.offsetLeft + it.el.offsetWidth / 2 - strip.clientWidth / 2;
    if (smooth && strip.scrollTo) strip.scrollTo({ left: target, behavior: 'smooth' });
    else strip.scrollLeft = target;
}

function renderGrid() {
    const strip = panelEl.querySelector('#theme-grid');
    strip.innerHTML = '';
    stripItems = [];
    stripCenterIdx = -1;
    const saved = loadSaved(pickerChatId);
    const currentId = saved ? saved.id : 'default';

    const W = strip.clientWidth || window.innerWidth;
    const tw = Math.max(70, Math.floor((W - 48) / 3));
    const pad = Math.max(0, Math.floor((W - tw) / 2));
    strip.style.paddingLeft = pad + 'px';
    strip.style.paddingRight = pad + 'px';

    const mkTile = (id, t, boxHtml, label) => {
        const tile = document.createElement('div');
        tile.style.cssText = `flex:0 0 ${tw}px;width:${tw}px;scroll-snap-align:center;cursor:pointer;transition:transform .18s,opacity .18s;`;
        tile.innerHTML = boxHtml + `<p class="text-gray-300 text-xs text-center mt-1.5">${label}</p>`;
        strip.appendChild(tile);
        const item = { id, t, el: tile };
        stripItems.push(item);
        return item;
    };

    // Galeriden seç
    const galBg = (saved && saved.id === 'custom' && saved.img) ? `background:url('${saved.img}') center/cover;` : 'background:#202c33;';
    const gal = mkTile('custom', null, `
        <div class="relative rounded-xl border-2 flex items-center justify-center" style="aspect-ratio:3/4;${galBg}border-style:${currentId === 'custom' ? 'solid' : 'dashed'};">
            <i class="fa-solid fa-image text-gray-300 text-2xl"></i>
            <i data-chk class="fa-solid fa-circle-check text-emerald-400 absolute top-1.5 right-1.5" style="display:none"></i>
        </div>`, 'Galeriden seç');
    gal.el.addEventListener('click', () => {
        pickFromGallery();
    });

    THEMES.forEach((t) => {
        const item = mkTile(t.id, t, `
            <div class="relative rounded-xl border-2 overflow-hidden" style="aspect-ratio:3/4;background:${t.bg || DEFAULT_BG};">
                <div class="absolute left-2 top-3 w-1/2 h-3 rounded" style="background:${DEFAULT_IN};"></div>
                <div class="absolute right-2 top-9 w-2/3 h-3 rounded" style="background:${t.out || DEFAULT_OUT};"></div>
                <i data-chk class="fa-solid fa-circle-check text-emerald-400 absolute top-1.5 right-1.5" style="display:none"></i>
            </div>`, t.name);
        item.el.addEventListener('click', () => {
            // Dokununca hemen uygula ve sayfayı kapat
            saveSaved(pickerChatId, { id: t.id });
            applyTheme(pickerChatId);
            closePanel();
        });
    });

    strip.onscroll = () => {
        if (stripScrollRaf) return;
        stripScrollRaf = requestAnimationFrame(() => { stripScrollRaf = 0; updateStripCenter(); });
    };

    // Seçili temayı ortaya getir
    let startIdx = stripItems.findIndex((it) => it.id === currentId);
    if (startIdx < 0) startIdx = 1;
    centerStripOn(startIdx, false);
    updateStripCenter();
    paintStrip();
}

async function pickFromGallery() {
    const chatId = pickerChatId;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) return;
        const img = await openImageCropper(file, { aspect: 9 / 16, size: 540, quality: 0.6 });
        if (!img) return;
        if (saveSaved(chatId, { id: 'custom', img: img })) {
            applyTheme(chatId);
            if (panelOpen && pickerChatId === chatId) closePanel();
        }
    });
    document.body.appendChild(input);
    input.click();
}

export function openChatThemePicker(chatId) {
    if (!chatId) return;
    const el = ensurePanel();
    pickerChatId = chatId;
    updatePreview();
    paintBlackSwitch();
    if (!panelOpen) {
        el.classList.remove('hidden');
        el.classList.add('flex');
        panelOpen = true;
        pushBackState(closePanelFromBack);
    }
    // Liste ölçüleri panel görünür olduktan sonra hesaplanır
    renderGrid();
}
