// ==========================================
// ALT SEKMELER: Sohbetler / Durum / Kişiler / Aramalar
// - Alt çubuk her sayfada görünür
// - Sola/sağa kaydırarak sayfalar arası geçiş (WhatsApp gibi)
// - Sohbetler dışındaki sayfada Android geri tuşu Sohbetler'e döner
// Sayfalar index.html'de: #tab-chats #tab-status #tab-contacts #tab-calls
// ==========================================

import { pushBackState, popBackState } from "./back-handler.js";

const NAMES = ['chats', 'status', 'contacts', 'calls'];
const NAV_IDS = ['nav-chats', 'nav-status', 'nav-contacts', 'nav-calls'];

let cur = 0;
let backPushed = false;
let track = null;
let viewport = null;

export function getTab() { return cur; }

function paintTop() {
    const top = document.getElementById('main-topbar');
    if (top) top.style.display = cur === 0 ? '' : 'none';
}

function paintNav() {
    paintTop();
    NAV_IDS.forEach((id, i) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('text-emerald-500', i === cur);
        el.classList.toggle('text-gray-400', i !== cur);
        const label = el.querySelector('span');
        if (label) label.classList.toggle('font-medium', i === cur);
    });
}

function applyTransform(animate, extraPx) {
    if (!track) return;
    track.style.transition = animate ? 'transform .28s cubic-bezier(.2,.8,.2,1)' : 'none';
    const w = viewport ? viewport.clientWidth : 0;
    const x = -cur * w + (extraPx || 0);
    track.style.transform = (cur === 0 && !extraPx) ? 'translate3d(0,0,0)' : `translate3d(${x}px,0,0)`;
}

export function setTab(i, opts) {
    opts = opts || {};
    i = Math.max(0, Math.min(NAMES.length - 1, i));
    const changed = i !== cur;
    cur = i;
    applyTransform(!opts.instant, 0);
    paintNav();
    if (!changed) return;

    if (i !== 0 && !backPushed) {
        backPushed = true;
        pushBackState(() => { backPushed = false; setTab(0, { fromBack: true }); });
    } else if (i === 0 && backPushed && !opts.fromBack) {
        backPushed = false;
        popBackState();
    }
    try { window.dispatchEvent(new CustomEvent('aura-tab', { detail: { tab: NAMES[i], index: i } })); } catch (e) {}
}

function setupSwipe() {
    let sx = 0, sy = 0, st = 0, mode = 0; // mode: 0 bekle, 1 yatay, 2 dikey/iptal
    let tracking = false;

    viewport.addEventListener('touchstart', (e) => {
        tracking = false;
        if (e.touches.length !== 1) return;
        // Yatay kayan alanlar (filtre çipleri) ve yazı alanları sayfa geçişini tetiklemesin
        if (e.target.closest('#chat-filter-tabs, input, textarea, [data-no-swipe]')) return;
        // Seçim modu açıkken sayfa değişmesin
        const tb = document.getElementById('chat-selection-toolbar');
        if (tb && !tb.classList.contains('hidden')) return;
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
        st = Date.now();
        mode = 0;
        tracking = true;
    }, { passive: true });

    viewport.addEventListener('touchmove', (e) => {
        if (!tracking) return;
        const dx = e.touches[0].clientX - sx;
        const dy = e.touches[0].clientY - sy;
        if (mode === 0) {
            if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) mode = 1;
            else if (Math.abs(dy) > 12) mode = 2;
        }
        if (mode !== 1) return;
        e.preventDefault();
        let off = dx;
        // Uçlarda direnç
        if ((cur === 0 && dx > 0) || (cur === NAMES.length - 1 && dx < 0)) off = dx / 4;
        applyTransform(false, off);
    }, { passive: false });

    const end = (e) => {
        if (!tracking) return;
        tracking = false;
        if (mode !== 1) return;
        const t = e.changedTouches && e.changedTouches[0];
        const dx = t ? t.clientX - sx : 0;
        const dt = Math.max(1, Date.now() - st);
        const w = viewport.clientWidth || 1;
        const fast = Math.abs(dx) / dt > 0.45 && Math.abs(dx) > 40;
        if (dx < 0 && (Math.abs(dx) > w * 0.25 || fast)) setTab(cur + 1);
        else if (dx > 0 && (Math.abs(dx) > w * 0.25 || fast)) setTab(cur - 1);
        else applyTransform(true, 0);
    };
    viewport.addEventListener('touchend', end, { passive: true });
    viewport.addEventListener('touchcancel', () => { tracking = false; if (mode === 1) applyTransform(true, 0); }, { passive: true });
}

function init() {
    track = document.getElementById('tab-track');
    viewport = document.getElementById('tab-viewport');
    if (!track || !viewport) return;
    NAV_IDS.forEach((id, i) => {
        const el = document.getElementById(id);
        if (el && !el.dataset.tabBound) {
            el.dataset.tabBound = '1';
            el.addEventListener('click', () => setTab(i));
        }
    });
    setupSwipe();
    window.addEventListener('resize', () => applyTransform(false, 0));
    paintNav();
    applyTransform(false, 0);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
