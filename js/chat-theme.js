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
const DEFAULT_IN = '#202c33';

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
    s.textContent = String.raw`#message-container[data-aura-theme] > div > div.bg-\[\#005c4b\]{background-color:var(--aura-out) !important}
#message-container[data-aura-theme] > div > div.bg-\[\#202c33\]{background-color:var(--aura-in) !important}`;
    document.head.appendChild(s);
})();

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
    const t = resolveTheme(loadSaved(chatId));
    if (!t) {
        mc.removeAttribute('data-aura-theme');
        mc.style.background = '';
        mc.style.removeProperty('--aura-out');
        mc.style.removeProperty('--aura-in');
        return;
    }
    mc.setAttribute('data-aura-theme', t.id);
    mc.style.background = t.bg;
    mc.style.setProperty('--aura-out', t.out);
    mc.style.setProperty('--aura-in', t.inc);
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
        <div class="flex-1 overflow-y-auto min-h-0">
            <div id="theme-preview" class="relative h-52 flex flex-col justify-center px-4 space-y-3">
                <div class="flex justify-start"><div id="theme-prev-in" class="text-white text-sm px-4 py-2 rounded-xl shadow">Selam kanka 👋</div></div>
                <div class="flex justify-end"><div id="theme-prev-out" class="text-white text-sm px-4 py-2 rounded-xl shadow">Tema nasıl olmuş?</div></div>
            </div>
            <p class="text-gray-400 text-xs px-4 pt-4 pb-2">Renkler ve arka planlar</p>
            <div id="theme-grid" class="grid grid-cols-3 gap-3 px-4 pb-8"></div>
        </div>
    `;
    document.body.appendChild(el);
    el.querySelector('#theme-back').addEventListener('click', closePanel);
    panelEl = el;
    return el;
}

function updatePreview() {
    const t = resolveTheme(loadSaved(pickerChatId));
    panelEl.querySelector('#theme-preview').style.background = t ? t.bg : DEFAULT_BG;
    panelEl.querySelector('#theme-prev-in').style.backgroundColor = t ? t.inc : DEFAULT_IN;
    panelEl.querySelector('#theme-prev-out').style.backgroundColor = t ? t.out : DEFAULT_OUT;
}

function renderGrid() {
    const grid = panelEl.querySelector('#theme-grid');
    grid.innerHTML = '';
    const saved = loadSaved(pickerChatId);
    const currentId = saved ? saved.id : 'default';

    // Galeriden seç
    const gal = document.createElement('div');
    gal.className = 'cursor-pointer';
    const galBg = (saved && saved.id === 'custom' && saved.img) ? `background:url('${saved.img}') center/cover;` : 'background:#202c33;';
    gal.innerHTML = `
        <div class="relative rounded-xl border-2 ${currentId === 'custom' ? 'border-emerald-500' : 'border-dashed border-gray-600'} flex items-center justify-center" style="aspect-ratio:3/4;${galBg}">
            <i class="fa-solid fa-image text-gray-300 text-2xl"></i>
            ${currentId === 'custom' ? '<i class="fa-solid fa-circle-check text-emerald-400 absolute top-1.5 right-1.5"></i>' : ''}
        </div>
        <p class="text-gray-300 text-xs text-center mt-1.5">Galeriden seç</p>`;
    gal.addEventListener('click', pickFromGallery);
    grid.appendChild(gal);

    THEMES.forEach((t) => {
        const on = currentId === t.id;
        const tile = document.createElement('div');
        tile.className = 'cursor-pointer';
        tile.innerHTML = `
            <div class="relative rounded-xl border-2 ${on ? 'border-emerald-500' : 'border-transparent'} overflow-hidden" style="aspect-ratio:3/4;background:${t.bg || DEFAULT_BG};">
                <div class="absolute left-2 top-3 w-1/2 h-3 rounded" style="background:${t.inc || DEFAULT_IN};"></div>
                <div class="absolute right-2 top-9 w-2/3 h-3 rounded" style="background:${t.out || DEFAULT_OUT};"></div>
                ${on ? '<i class="fa-solid fa-circle-check text-emerald-400 absolute top-1.5 right-1.5"></i>' : ''}
            </div>
            <p class="text-gray-300 text-xs text-center mt-1.5">${t.name}</p>`;
        tile.addEventListener('click', () => {
            saveSaved(pickerChatId, { id: t.id });
            applyTheme(pickerChatId);
            updatePreview();
            renderGrid();
        });
        grid.appendChild(tile);
    });
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
            if (panelOpen && pickerChatId === chatId) {
                updatePreview();
                renderGrid();
            }
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
    renderGrid();
    if (panelOpen) return;
    el.classList.remove('hidden');
    el.classList.add('flex');
    panelOpen = true;
    pushBackState(closePanelFromBack);
}
