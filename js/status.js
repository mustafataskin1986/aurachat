// ==========================================
// DURUM (WhatsApp tarzı 24 saatlik durum güncellemeleri)
// - Alt bardaki "Durum" sekmesi paneli açar
// - Fotoğraf (kamera/galeri) + yazı durumu, 24 saat sonra kendiliğinden kaybolur
// - Tam ekran görüntüleyici: ilerleme çubukları, dokun-geç, basılı tut-durdur, aşağı çek-kapat
// - Kendi durumunda görenler listesi ve silme
// - Sohbet listesindeki avatarlarda yeşil (yeni) / gri (görüldü) çember
//
// Firestore:
//   statuses/{id}      -> { uid, type:'text'|'image', text, bg, caption, createdAt, expiresAt, viewers:[uid], hasImage }
//   statusMedia/{id}   -> { uid, image }   (büyük base64 ayrı tutulur; sadece görüntülenirken indirilir)
// ==========================================

import { db } from "./firebase-init.js";
import {
    collection, doc, query, where, onSnapshot, setDoc, updateDoc, deleteDoc, getDoc, getDocs, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getCurrentUser, showToast, selectChat, getCurrentChatId, sendDirectMessage } from "./chat-core.js";
import { startCall } from "./video-call.js";
import { startVoiceCall } from "./voice-call.js";
import { openContactInfo } from "./contact-info.js";
import { getUserColor, getInitials, escapeHtml } from "./ui-helpers.js";
import { pushBackState, popBackState } from "./back-handler.js";
import { auraDialog } from "./aura-dialog.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const TEXT_MS = 5000;
const IMAGE_MS = 6000;
const BG_COLORS = ['#128c7e', '#075e54', '#6a1b9a', '#c2185b', '#d84315', '#1565c0', '#37474f', '#2e7d32', '#ad1457', '#4527a0'];

let inited = false;
let unsub = null;
let myUid = null;
const statuses = new Map();      // id -> status
const mediaCache = new Map();    // id -> dataUrl
const nameCache = new Map();     // uid -> {name, avatar}

// ---------------- yardımcılar ----------------
function me() {
    const u = getCurrentUser();
    return u || null;
}

function userInfo(uid) {
    const map = window.__aurachatUsers;
    const u = map && map.get ? map.get(uid) : null;
    if (u) return { name: u.name || '', avatar: u.avatar || '' };
    return nameCache.get(uid) || { name: '', avatar: '' };
}

async function ensureUserInfo(uid) {
    const known = userInfo(uid);
    if (known.name) return known;
    try {
        const snap = await getDoc(doc(db, 'users', uid));
        if (snap.exists()) {
            const d = snap.data();
            const info = { name: d.name || '', avatar: d.avatar || '' };
            nameCache.set(uid, info);
            return info;
        }
    } catch (e) {}
    return known;
}

function avatarHtml(info, size) {
    if (info.avatar) {
        return `<img src="${info.avatar}" class="rounded-full object-cover" style="width:${size}px;height:${size}px;">`;
    }
    const color = getUserColor(info.name || '?');
    return `<div class="rounded-full flex items-center justify-center text-white font-bold" style="width:${size}px;height:${size}px;background:${color};font-size:${Math.round(size / 3)}px;">${getInitials(info.name || '')}</div>`;
}

function timeLabel(ms) {
    const now = Date.now();
    const diff = now - ms;
    if (diff < 60 * 1000) return 'Az önce';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' dk önce';
    const d = new Date(ms);
    const hm = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Bugün ' + hm;
    return 'Dün ' + hm;
}

function activeStatuses() {
    const now = Date.now();
    return [...statuses.values()].filter((s) => s.expiresAt > now);
}

// Görünür kişiler: ben + sohbet listemdeki kişiler
function canSee(uid) {
    if (uid === myUid) return true;
    const chats = window.__aurachatMyChats;
    if (!chats || !chats.values) return true;
    for (const c of chats.values()) {
        if (!c.isGroup && c.otherUid === uid) return true;
    }
    return false;
}

function statusesOf(uid) {
    return activeStatuses()
        .filter((s) => s.uid === uid)
        .sort((a, b) => a.createdAt - b.createdAt);
}

function hasUnseen(list) {
    return list.some((s) => !(s.viewers || []).includes(myUid));
}

function groupedOthers() {
    const byUid = new Map();
    activeStatuses().forEach((s) => {
        if (s.uid === myUid || !canSee(s.uid)) return;
        if (!byUid.has(s.uid)) byUid.set(s.uid, []);
        byUid.get(s.uid).push(s);
    });
    const arr = [...byUid.entries()].map(([uid, list]) => {
        list.sort((a, b) => a.createdAt - b.createdAt);
        return { uid, list, unseen: hasUnseen(list), last: list[list.length - 1].createdAt };
    });
    arr.sort((a, b) => (a.unseen === b.unseen ? b.last - a.last : a.unseen ? -1 : 1));
    return arr;
}

// ---------------- sohbet listesi çemberi ----------------
function injectStyle() {
    if (document.getElementById('aura-status-style')) return;
    const st = document.createElement('style');
    st.id = 'aura-status-style';
    st.textContent = `
        .aura-st-new > *{outline:2.5px solid #22c55e;outline-offset:2px;border-radius:9999px;}
        .aura-st-seen > *{outline:2.5px solid #6b7280;outline-offset:2px;border-radius:9999px;}
        @keyframes auraStSheet{from{transform:translateY(100%)}to{transform:translateY(0)}}
        @keyframes auraStFade{from{opacity:0}to{opacity:1}}
    `;
    document.head.appendChild(st);
}

function applyRing(slot) {
    if (!slot || !slot.dataset) return;
    const uid = slot.dataset.statusUid;
    slot.classList.remove('aura-st-new', 'aura-st-seen');
    if (!uid || !myUid) return;
    const list = statusesOf(uid);
    if (!list.length) return;
    slot.classList.add(hasUnseen(list) ? 'aura-st-new' : 'aura-st-seen');
}

function refreshRings() {
    document.querySelectorAll('[data-status-uid]').forEach(applyRing);
    // Alt bardaki Durum sekmesinde yeni durum noktası
    const nav = document.getElementById('nav-status');
    if (nav) {
        let dot = nav.querySelector('.aura-st-dot');
        const anyNew = groupedOthers().some((g) => g.unseen);
        if (anyNew && !dot) {
            const icon = nav.querySelector('i');
            if (icon) {
                nav.style.position = 'relative';
                dot = document.createElement('span');
                dot.className = 'aura-st-dot';
                dot.style.cssText = 'position:absolute;top:-1px;right:-2px;width:9px;height:9px;border-radius:50%;background:#22c55e;';
                nav.appendChild(dot);
            }
        } else if (!anyNew && dot) {
            dot.remove();
        }
    }
}

// contacts.js her avatar slotunu çizdikten sonra çağırır
window.__auraStatusRing = applyRing;
window.__auraOpenUserStatus = (uid) => openUserStatus(uid);

// ---------------- Firestore ----------------
function startListening() {
    if (unsub) return;
    const q = query(collection(db, 'statuses'), where('expiresAt', '>', Date.now()));
    unsub = onSnapshot(q, (snap) => {
        snap.docChanges().forEach((ch) => {
            if (ch.type === 'removed') {
                statuses.delete(ch.doc.id);
            } else {
                statuses.set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
            }
        });
        refreshRings();
        if (panelOpen) renderPanel();
    }, () => {});
}

async function cleanupMyExpired() {
    try {
        const snap = await getDocs(query(collection(db, 'statuses'), where('uid', '==', myUid)));
        const now = Date.now();
        for (const d of snap.docs) {
            const s = d.data();
            if ((s.expiresAt || 0) <= now) {
                try { await deleteDoc(doc(db, 'statusMedia', d.id)); } catch (e) {}
                try { await deleteDoc(d.ref); } catch (e) {}
            }
        }
    } catch (e) {}
}

async function loadMedia(id) {
    if (mediaCache.has(id)) return mediaCache.get(id);
    try {
        const snap = await getDoc(doc(db, 'statusMedia', id));
        if (snap.exists()) {
            const img = snap.data().image || '';
            mediaCache.set(id, img);
            return img;
        }
    } catch (e) {}
    return '';
}

// ---------------- görsel sıkıştırma ----------------
function compressImage(file, targetBytes = 300 * 1024) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            const dims = [1000, 800, 640];
            const quals = [0.7, 0.55, 0.4];
            let best = null;
            for (const maxDim of dims) {
                let w = img.naturalWidth, h = img.naturalHeight;
                const k = Math.min(1, maxDim / Math.max(w, h));
                w = Math.round(w * k); h = Math.round(h * k);
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                c.getContext('2d').drawImage(img, 0, 0, w, h);
                for (const q of quals) {
                    best = c.toDataURL('image/jpeg', q);
                    if (best.length * 0.75 <= targetBytes) return resolve(best);
                }
            }
            resolve(best);
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img')); };
        img.src = url;
    });
}

async function postStatus({ type, text, bg, caption, image }) {
    const ref = doc(collection(db, 'statuses'));
    const now = Date.now();
    if (image) {
        await setDoc(doc(db, 'statusMedia', ref.id), { uid: myUid, image });
        mediaCache.set(ref.id, image);
    }
    const data = {
        uid: myUid,
        type,
        text: text || '',
        bg: bg || '',
        caption: caption || '',
        createdAt: now,
        expiresAt: now + DAY_MS,
        viewers: [],
        hasImage: !!image
    };
    await setDoc(ref, data);
    statuses.set(ref.id, { id: ref.id, ...data });
    refreshRings();
    if (panelOpen) renderPanel();
}

async function deleteStatus(id) {
    try { await deleteDoc(doc(db, 'statusMedia', id)); } catch (e) {}
    await deleteDoc(doc(db, 'statuses', id));
    statuses.delete(id);
    mediaCache.delete(id);
    refreshRings();
    if (panelOpen) renderPanel();
}

// ---------------- PANEL ----------------
let panelEl = null;
let panelOpen = false;

function closePanelFromBack() {
    if (panelEl) { panelEl.classList.add('hidden'); panelEl.classList.remove('flex'); }
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
    el.className = 'fixed inset-0 z-50 bg-[#0b141a] hidden flex-col';
    el.innerHTML = `
        <div class="bg-[#202c33] px-4 py-3.5 flex items-center border-b border-gray-800 flex-shrink-0">
            <button type="button" id="st-back" class="text-gray-400 hover:text-white transition text-lg px-1 mr-4"><i class="fa-solid fa-arrow-left"></i></button>
            <h2 class="text-white font-medium text-base">Durum</h2>
        </div>
        <div id="st-list" class="flex-1 overflow-y-auto min-h-0 pb-28"></div>
        <div class="absolute right-5 bottom-6 flex flex-col items-center space-y-4">
            <button type="button" id="st-fab-text" class="w-11 h-11 rounded-full bg-[#202c33] text-gray-200 shadow-lg flex items-center justify-center"><i class="fa-solid fa-pen"></i></button>
            <button type="button" id="st-fab-cam" class="w-14 h-14 rounded-full bg-emerald-500 text-white shadow-lg flex items-center justify-center text-xl"><i class="fa-solid fa-camera"></i></button>
        </div>
        <input type="file" id="st-in-cam" accept="image/*" capture="environment" class="hidden">
        <input type="file" id="st-in-gal" accept="image/*" class="hidden">
    `;
    document.body.appendChild(el);
    el.querySelector('#st-back').addEventListener('click', closePanel);
    el.querySelector('#st-fab-text').addEventListener('click', () => openComposer({ mode: 'text' }));
    el.querySelector('#st-fab-cam').addEventListener('click', openAddSheet);
    const onFile = (inp) => async () => {
        const f = inp.files && inp.files[0];
        inp.value = '';
        if (f) openComposer({ mode: 'image', file: f });
    };
    const cam = el.querySelector('#st-in-cam');
    const gal = el.querySelector('#st-in-gal');
    cam.addEventListener('change', onFile(cam));
    gal.addEventListener('change', onFile(gal));
    panelEl = el;
    return el;
}

function rowHtml(uid, info, subtitle, ringClass, size) {
    return `
        <div class="flex items-center px-4 py-3 hover:bg-[#202c33]/60 cursor-pointer" data-st-uid="${uid}">
            <div class="${ringClass} flex-shrink-0" style="width:${size}px;height:${size}px;">${avatarHtml(info, size)}</div>
            <div class="ml-4 overflow-hidden flex-1">
                <h4 class="text-white text-sm font-medium truncate">${escapeHtml(info.name || '')}</h4>
                <p class="text-[12px] text-gray-400 truncate">${escapeHtml(subtitle)}</p>
            </div>
        </div>`;
}

function renderPanel() {
    const el = ensurePanel();
    const listEl = el.querySelector('#st-list');
    const mine = statusesOf(myUid);
    const u = me() || {};
    const myInfo = { name: u.name || 'Ben', avatar: u.avatar || (userInfo(myUid).avatar) || '' };

    let html = '';
    const mineRing = mine.length ? 'aura-st-new' : '';
    html += `
        <div class="flex items-center px-4 py-3 hover:bg-[#202c33]/60 cursor-pointer" id="st-mine">
            <div class="relative flex-shrink-0" style="width:52px;height:52px;">
                <div class="${mineRing}">${avatarHtml(myInfo, 52)}</div>
                <button type="button" id="st-mine-add" class="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-emerald-500 border-2 border-[#0b141a] flex items-center justify-center text-white text-[10px]"><i class="fa-solid fa-plus"></i></button>
            </div>
            <div class="ml-4 flex-1 overflow-hidden">
                <h4 class="text-white text-sm font-medium">Durumum</h4>
                <p class="text-[12px] text-gray-400 truncate">${mine.length ? timeLabel(mine[mine.length - 1].createdAt) : 'Durum güncellemesi ekle'}</p>
            </div>
        </div>
        <div class="px-4 pt-3 pb-1 text-[11px] text-gray-500 uppercase tracking-wide">Son güncellemeler</div>`;

    const groups = groupedOthers();
    if (!groups.length) {
        html += `<p class="px-6 py-10 text-center text-gray-500 text-xs">Henüz kimse durum paylaşmadı.</p>`;
    } else {
        groups.forEach((g) => {
            const info = userInfo(g.uid);
            html += rowHtml(g.uid, info, timeLabel(g.last), g.unseen ? 'aura-st-new' : 'aura-st-seen', 48);
        });
    }
    listEl.innerHTML = html;

    listEl.querySelector('#st-mine').addEventListener('click', (e) => {
        if (e.target.closest('#st-mine-add') || !mine.length) { openAddSheet(); return; }
        openViewer([{ uid: myUid, list: mine }], 0);
    });
    listEl.querySelectorAll('[data-st-uid]').forEach((row) => {
        row.addEventListener('click', () => {
            const idx = groups.findIndex((g) => g.uid === row.dataset.stUid);
            if (idx >= 0) openViewer(groups.map((g) => ({ uid: g.uid, list: g.list })), idx);
        });
    });
    // Eksik isimleri sonradan tamamla
    groups.forEach((g) => {
        if (!userInfo(g.uid).name) ensureUserInfo(g.uid).then(() => { if (panelOpen) renderPanel(); });
    });
}

function openPanel() {
    if (!myUid) return;
    const el = ensurePanel();
    el.classList.remove('hidden');
    el.classList.add('flex');
    if (!panelOpen) {
        panelOpen = true;
        pushBackState(closePanelFromBack);
    }
    renderPanel();
}

// ---------------- Ekle sheet ----------------
function openAddSheet() {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.55);animation:auraStFade .18s ease;';
    const sheet = document.createElement('div');
    sheet.style.cssText = 'position:absolute;left:0;right:0;bottom:0;background:#202c33;border-radius:20px 20px 0 0;padding:18px 20px 26px;animation:auraStSheet .22s ease;';
    sheet.innerHTML = `
        <div class="text-white text-base font-medium mb-4">Durum ekle</div>
        <div class="flex justify-around">
            <button type="button" data-k="cam" class="flex flex-col items-center text-gray-200"><span class="w-14 h-14 rounded-full bg-emerald-500 flex items-center justify-center text-white text-xl mb-2"><i class="fa-solid fa-camera"></i></span><span class="text-xs">Kamera</span></button>
            <button type="button" data-k="gal" class="flex flex-col items-center text-gray-200"><span class="w-14 h-14 rounded-full bg-indigo-500 flex items-center justify-center text-white text-xl mb-2"><i class="fa-solid fa-image"></i></span><span class="text-xs">Galeri</span></button>
            <button type="button" data-k="txt" class="flex flex-col items-center text-gray-200"><span class="w-14 h-14 rounded-full bg-amber-500 flex items-center justify-center text-white text-xl mb-2"><i class="fa-solid fa-font"></i></span><span class="text-xs">Yazı</span></button>
        </div>`;
    ov.appendChild(sheet);
    document.body.appendChild(ov);
    let closed = false;
    const close = (fromBack) => {
        if (closed) return;
        closed = true;
        ov.remove();
        if (!fromBack) popBackState();
    };
    pushBackState(() => close(true));
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    sheet.querySelectorAll('button[data-k]').forEach((b) => {
        b.addEventListener('click', () => {
            const k = b.dataset.k;
            close();
            if (k === 'cam') panelEl.querySelector('#st-in-cam').click();
            else if (k === 'gal') panelEl.querySelector('#st-in-gal').click();
            else openComposer({ mode: 'text' });
        });
    });
}

// ---------------- Oluşturucu ----------------
async function openComposer({ mode, file }) {
    let imageData = null;
    if (mode === 'image') {
        try { imageData = await compressImage(file); }
        catch (e) { showToast('Fotoğraf açılamadı'); return; }
    }
    let bgIdx = Math.floor(Math.random() * BG_COLORS.length);

    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:65;display:flex;flex-direction:column;animation:auraStFade .15s ease;' +
        (mode === 'text' ? `background:${BG_COLORS[bgIdx]};` : 'background:#000;');
    ov.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;">
            <button type="button" id="sc-close" style="color:#fff;font-size:20px;padding:4px 8px;"><i class="fa-solid fa-xmark"></i></button>
            ${mode === 'text' ? '<button type="button" id="sc-color" style="color:#fff;font-size:20px;padding:4px 8px;"><i class="fa-solid fa-palette"></i></button>' : '<span></span>'}
        </div>
        <div style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:0 20px;">
            ${mode === 'text'
                ? '<textarea id="sc-text" maxlength="300" placeholder="Bir durum yazın" style="width:100%;background:transparent;border:none;outline:none;color:#fff;font-size:30px;text-align:center;resize:none;height:60%;"></textarea>'
                : `<img src="${imageData}" style="max-width:100%;max-height:100%;object-fit:contain;">`}
        </div>
        <div style="display:flex;align-items:center;padding:10px 14px 18px;gap:10px;">
            ${mode === 'image'
                ? '<input id="sc-cap" type="text" maxlength="200" placeholder="Açıklama ekleyin..." style="flex:1;background:#202c33;color:#fff;border-radius:9999px;padding:11px 16px;outline:none;border:none;font-size:15px;">'
                : '<span style="flex:1"></span>'}
            <button type="button" id="sc-send" style="width:52px;height:52px;border-radius:50%;background:#22c55e;color:#fff;font-size:20px;display:flex;align-items:center;justify-content:center;"><i class="fa-solid fa-paper-plane"></i></button>
        </div>`;
    document.body.appendChild(ov);

    let closed = false;
    const close = (fromBack) => {
        if (closed) return;
        closed = true;
        ov.remove();
        if (!fromBack) popBackState();
    };
    pushBackState(() => close(true));
    ov.querySelector('#sc-close').addEventListener('click', () => close());

    const ta = ov.querySelector('#sc-text');
    if (ta) {
        setTimeout(() => ta.focus(), 100);
        ov.querySelector('#sc-color').addEventListener('click', () => {
            bgIdx = (bgIdx + 1) % BG_COLORS.length;
            ov.style.background = BG_COLORS[bgIdx];
        });
    }

    const sendBtn = ov.querySelector('#sc-send');
    sendBtn.addEventListener('click', async () => {
        if (sendBtn.dataset.busy) return;
        const text = ta ? ta.value.trim() : '';
        if (mode === 'text' && !text) { showToast('Önce bir şey yazın'); return; }
        sendBtn.dataset.busy = '1';
        sendBtn.style.opacity = '.6';
        try {
            if (mode === 'text') await postStatus({ type: 'text', text, bg: BG_COLORS[bgIdx] });
            else await postStatus({ type: 'image', image: imageData, caption: (ov.querySelector('#sc-cap').value || '').trim() });
            close();
            showToast('Durum paylaşıldı');
        } catch (e) {
            delete sendBtn.dataset.busy;
            sendBtn.style.opacity = '1';
            showToast('Paylaşılamadı, tekrar deneyin');
        }
    });
}

// ---------------- GÖRÜNTÜLEYİCİ ----------------
function openViewer(users, startUserIdx, startSIdx) {
    let uIdx = startUserIdx;
    let sIdx = 0;
    let raf = 0;
    let startedAt = 0;
    let elapsedBefore = 0;
    let duration = TEXT_MS;
    let paused = false;
    let loading = false;
    let token = 0;
    let closed = false;
    let sheetOpen = false;

    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:68;background:#000;display:flex;flex-direction:column;touch-action:none;animation:auraStFade .15s ease;';
    ov.innerHTML = `
        <div id="sv-stage" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;"></div>
        <div style="position:absolute;top:0;left:0;right:0;padding:10px 10px 0;background:linear-gradient(rgba(0,0,0,.55),transparent);">
            <div id="sv-bars" style="display:flex;gap:3px;margin-bottom:10px;"></div>
            <div style="display:flex;align-items:center;padding-bottom:14px;">
                <button type="button" id="sv-close" style="color:#fff;font-size:18px;padding:4px 10px 4px 4px;"><i class="fa-solid fa-arrow-left"></i></button>
                <div id="sv-av"></div>
                <div style="margin-left:10px;flex:1;min-width:0;">
                    <div id="sv-name" style="color:#fff;font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
                    <div id="sv-time" style="color:#d1d5db;font-size:12px;"></div>
                </div>
                <button type="button" id="sv-more" style="color:#fff;font-size:18px;padding:6px 12px;"><i class="fa-solid fa-ellipsis-vertical"></i></button>
            </div>
        </div>
        <div id="sv-cap" style="position:absolute;left:0;right:0;bottom:84px;text-align:center;color:#fff;font-size:16px;padding:10px 20px;background:rgba(0,0,0,.45);display:none;"></div>
        <button type="button" id="sv-views" style="position:absolute;left:0;right:0;bottom:14px;margin:auto;width:max-content;color:#fff;font-size:14px;display:none;padding:8px 16px;"></button>
        <div id="sv-bar" style="position:absolute;left:0;right:0;bottom:0;display:none;align-items:center;gap:8px;padding:10px 12px 14px;background:linear-gradient(transparent,rgba(0,0,0,.6));">
            <div style="flex:1;min-width:0;display:flex;align-items:center;background:#1f2c34;border-radius:9999px;padding:0 8px 0 18px;">
                <input id="sv-input" type="text" maxlength="500" placeholder="Cevapla" autocomplete="off" style="flex:1;min-width:0;background:transparent;border:none;outline:none;color:#fff;font-size:16px;padding:13px 0;">
                <button type="button" id="sv-emo1" style="font-size:26px;padding:2px 8px;line-height:1;">😍</button>
                <button type="button" id="sv-emo2" style="font-size:26px;padding:2px 8px;line-height:1;">😂</button>
                <button type="button" id="sv-send" style="display:none;width:40px;height:40px;border-radius:50%;background:#22c55e;color:#fff;align-items:center;justify-content:center;"><i class="fa-solid fa-paper-plane"></i></button>
            </div>
            <button type="button" id="sv-heart" style="width:50px;height:50px;border-radius:50%;background:#1f2c34;color:#fff;font-size:22px;display:flex;align-items:center;justify-content:center;"><i class="fa-regular fa-heart"></i></button>
        </div>`;
    document.body.appendChild(ov);

    const stage = ov.querySelector('#sv-stage');

    function cur() { return users[uIdx].list[sIdx]; }

    function buildBars() {
        const bars = ov.querySelector('#sv-bars');
        bars.innerHTML = '';
        users[uIdx].list.forEach((_, i) => {
            const b = document.createElement('div');
            b.style.cssText = 'flex:1;height:3px;background:rgba(255,255,255,.35);border-radius:2px;overflow:hidden;';
            const f = document.createElement('div');
            f.style.cssText = `height:100%;background:#fff;width:${i < sIdx ? '100%' : '0%'};`;
            b.appendChild(f);
            bars.appendChild(b);
        });
    }

    function setFill(pct) {
        const f = ov.querySelector('#sv-bars').children[sIdx];
        if (f && f.firstChild) f.firstChild.style.width = pct + '%';
    }

    function tick(now) {
        if (closed) return;
        if (!paused && !loading) {
            const el = elapsedBefore + (now - startedAt);
            const pct = Math.min(100, (el / duration) * 100);
            setFill(pct);
            if (el >= duration) { next(); return; }
        }
        raf = requestAnimationFrame(tick);
    }

    function startTimer() {
        cancelAnimationFrame(raf);
        elapsedBefore = 0;
        startedAt = performance.now();
        raf = requestAnimationFrame(tick);
    }

    function pause() {
        if (paused) return;
        paused = true;
        elapsedBefore += performance.now() - startedAt;
    }
    function resume() {
        if (!paused) return;
        paused = false;
        startedAt = performance.now();
    }

    async function show() {
        const my = ++token;
        const s = cur();
        const uid = users[uIdx].uid;
        buildBars();
        const info = userInfo(uid);
        ov.querySelector('#sv-av').innerHTML = avatarHtml(info, 38);
        ov.querySelector('#sv-name').textContent = uid === myUid ? 'Durumum' : (info.name || '');
        if (!info.name && uid !== myUid) {
            ensureUserInfo(uid).then((i) => { if (!closed && my === token) ov.querySelector('#sv-name').textContent = i.name || ''; });
        }
        ov.querySelector('#sv-time').textContent = timeLabel(s.createdAt);
        ov.querySelector('#sv-bar').style.display = uid === myUid ? 'none' : 'flex';
        const inp = ov.querySelector('#sv-input');
        if (inp) { inp.value = ''; ov.querySelector('#sv-send').style.display = 'none'; ov.querySelector('#sv-emo1').style.display = ov.querySelector('#sv-emo2').style.display = ''; }
        const views = ov.querySelector('#sv-views');
        if (uid === myUid) {
            views.style.display = 'block';
            views.innerHTML = `<i class="fa-solid fa-eye"></i>&nbsp; ${(s.viewers || []).length}`;
        } else {
            views.style.display = 'none';
        }
        const cap = ov.querySelector('#sv-cap');
        cap.style.display = s.caption ? 'block' : 'none';
        cap.textContent = s.caption || '';

        stage.innerHTML = '';
        stage.style.background = '';
        loading = true;
        if (s.type === 'text') {
            stage.style.background = s.bg || '#128c7e';
            const t = document.createElement('div');
            t.style.cssText = 'color:#fff;font-size:30px;text-align:center;padding:0 24px;word-break:break-word;white-space:pre-wrap;';
            t.textContent = s.text || '';
            stage.appendChild(t);
            duration = TEXT_MS;
            loading = false;
        } else {
            const spin = document.createElement('div');
            spin.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" style="color:#fff;font-size:28px;"></i>';
            stage.appendChild(spin);
            const data = await loadMedia(s.id);
            if (closed || my !== token) return;
            stage.innerHTML = '';
            if (data) {
                const im = document.createElement('img');
                im.src = data;
                im.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
                stage.appendChild(im);
            } else {
                const m = document.createElement('div');
                m.style.cssText = 'color:#9ca3af;font-size:14px;';
                m.textContent = 'Fotoğraf yüklenemedi';
                stage.appendChild(m);
            }
            duration = IMAGE_MS;
            loading = false;
        }
        startTimer();

        // görüldü işaretle
        if (uid !== myUid && !(s.viewers || []).includes(myUid)) {
            s.viewers = [...(s.viewers || []), myUid];
            updateDoc(doc(db, 'statuses', s.id), { viewers: arrayUnion(myUid) }).catch(() => {});
            refreshRings();
        }
        // sonrakini önden yükle
        const nxt = users[uIdx].list[sIdx + 1];
        if (nxt && nxt.type === 'image') loadMedia(nxt.id);
    }

    function close(fromBack) {
        if (closed) return;
        closed = true;
        cancelAnimationFrame(raf);
        ov.remove();
        if (!fromBack) popBackState();
        refreshRings();
        if (panelOpen) renderPanel();
    }

    function next() {
        if (sIdx < users[uIdx].list.length - 1) { sIdx++; show(); return; }
        if (uIdx < users.length - 1) { uIdx++; sIdx = 0; show(); return; }
        close();
    }
    function prev() {
        if (sIdx > 0) { sIdx--; show(); return; }
        if (uIdx > 0) { uIdx--; sIdx = users[uIdx].list.length - 1; show(); return; }
        show();
    }

    pushBackState(() => close(true));
    ov.querySelector('#sv-close').addEventListener('click', () => close());

    async function deleteCurrent() {
        pause();
        const r = await auraDialog({ title: 'Bu durum silinsin mi?', buttons: [{ id: 'cancel', label: 'İptal' }, { id: 'ok', label: 'Sil' }] });
        if (r && r.id === 'ok') {
            const s = cur();
            try { await deleteStatus(s.id); } catch (e) { showToast('Silinemedi'); resume(); return; }
            users[uIdx].list.splice(sIdx, 1);
            if (!users[uIdx].list.length) { close(); return; }
            if (sIdx >= users[uIdx].list.length) sIdx = users[uIdx].list.length - 1;
            resume();
            show();
        } else {
            resume();
        }
    }

    // Kişiye git (Mesaj / arama / kişi bilgisi): görüntüleyici ve panel kapanır
    async function goToPerson(act) {
        const uid = users[uIdx].uid;
        const info = userInfo(uid);
        close();
        closePanel();
        try {
            await selectChat({ uid, name: info.name || '', avatar: info.avatar || '' });
            const chatId = getCurrentChatId();
            if (act === 'voice') startVoiceCall(chatId, uid);
            else if (act === 'video') startCall(chatId, uid);
            else if (act === 'info') openContactInfo(uid);
        } catch (e) {
            showToast('Açılamadı');
        }
    }

    // Sağ üst üç nokta menüsü
    let menuEl = null;
    function closeMenu() {
        if (!menuEl) return;
        menuEl.remove();
        menuEl = null;
        resume();
    }
    ov.querySelector('#sv-more').addEventListener('click', (e) => {
        e.stopPropagation();
        if (menuEl) { closeMenu(); return; }
        pause();
        const mine = users[uIdx].uid === myUid;
        const items = mine
            ? [['del', 'Sil']]
            : [['msg', 'Mesaj'], ['voice', 'Sesli arama'], ['video', 'Görüntülü arama'], ['info', 'Kişiyi görüntüle']];
        menuEl = document.createElement('div');
        menuEl.style.cssText = 'position:absolute;inset:0;z-index:5;';
        menuEl.innerHTML = `<div style="position:absolute;top:96px;right:12px;min-width:210px;background:#111b21;border-radius:14px;padding:6px 0;box-shadow:0 8px 28px rgba(0,0,0,.6);animation:auraStFade .12s ease;">` +
            items.map(([k, label]) => `<button type="button" data-k="${k}" style="display:block;width:100%;text-align:left;color:#fff;font-size:17px;padding:14px 22px;">${label}</button>`).join('') + `</div>`;
        ov.appendChild(menuEl);
        menuEl.addEventListener('click', (ev) => {
            const b = ev.target.closest('button[data-k]');
            if (!b) { closeMenu(); return; }
            const k = b.dataset.k;
            closeMenu();
            if (k === 'del') deleteCurrent();
            else goToPerson(k);
        });
    });

    // Cevap / emoji / kalp: sohbeti açmadan karşı tarafa mesaj olarak gider
    async function sendReply(text) {
        text = (text || '').trim();
        if (!text) return;
        const s = cur();
        const uid = users[uIdx].uid;
        const info = userInfo(uid);
        const preview = 'Durum: ' + (s.caption || s.text || (s.type === 'image' ? 'Fotoğraf' : ''));
        const rid = await sendDirectMessage(uid, info.name || '', text, {
            msgId: s.id, senderName: info.name || '', senderUid: uid, previewText: preview.slice(0, 80), isStatus: true
        });
        showToast(rid ? 'Cevap gönderildi' : 'Gönderilemedi');
        return !!rid;
    }
    const inpEl = ov.querySelector('#sv-input');
    const sendEl = ov.querySelector('#sv-send');
    const emo1 = ov.querySelector('#sv-emo1');
    const emo2 = ov.querySelector('#sv-emo2');
    inpEl.addEventListener('focus', () => pause());
    inpEl.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== inpEl) resume(); }, 50); });
    inpEl.addEventListener('input', () => {
        const has = inpEl.value.trim().length > 0;
        sendEl.style.display = has ? 'flex' : 'none';
        emo1.style.display = emo2.style.display = has ? 'none' : '';
    });
    inpEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendEl.click(); } });
    sendEl.addEventListener('click', async () => {
        const t = inpEl.value;
        inpEl.value = '';
        inpEl.dispatchEvent(new Event('input'));
        inpEl.blur();
        await sendReply(t);
    });
    emo1.addEventListener('click', () => sendReply('😍'));
    emo2.addEventListener('click', () => sendReply('😂'));
    ov.querySelector('#sv-heart').addEventListener('click', async (e) => {
        const ic = e.currentTarget.querySelector('i');
        if (ic) { ic.className = 'fa-solid fa-heart'; ic.style.color = '#ef4444'; }
        await sendReply('❤️');
    });

    ov.querySelector('#sv-views').addEventListener('click', (e) => {
        e.stopPropagation();
        openViewersSheet(cur(), pause, resume);
    });

    // Dokunma / basılı tut / aşağı çek
    let down = null;
    ov.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button, input, #sv-bar')) return;
        if (document.activeElement === inpEl) { inpEl.blur(); return; }
        down = { x: e.clientX, y: e.clientY, t: performance.now() };
        pause();
    });
    ov.addEventListener('pointermove', (e) => {
        if (!down) return;
        const dy = e.clientY - down.y;
        if (dy > 0) ov.style.transform = `translateY(${dy}px)`;
    });
    const end = (e) => {
        if (!down) return;
        const d = down; down = null;
        const dy = e.clientY - d.y;
        const dt = performance.now() - d.t;
        ov.style.transform = '';
        if (dy > 110) { close(); return; }
        resume();
        if (dt < 250 && Math.abs(dy) < 15 && Math.abs(e.clientX - d.x) < 15) {
            if (e.clientX < window.innerWidth * 0.35) prev(); else next();
        }
    };
    ov.addEventListener('pointerup', end);
    ov.addEventListener('pointercancel', () => { down = null; ov.style.transform = ''; resume(); });

    // Başlangıç: ilk görülmemiş durum
    const startList = users[uIdx].list;
    const firstUnseen = startList.findIndex((s) => !(s.viewers || []).includes(myUid));
    sIdx = (typeof startSIdx === 'number') ? startSIdx : (users[uIdx].uid === myUid ? 0 : Math.max(0, firstUnseen));
    show();
}

async function openViewersSheet(s, pause, resume) {
    pause();
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:75;background:rgba(0,0,0,.5);';
    const sheet = document.createElement('div');
    sheet.style.cssText = 'position:absolute;left:0;right:0;bottom:0;max-height:70%;overflow-y:auto;background:#202c33;border-radius:20px 20px 0 0;padding:16px 0 20px;animation:auraStSheet .22s ease;';
    const viewers = s.viewers || [];
    sheet.innerHTML = `<div style="color:#fff;font-size:15px;font-weight:600;padding:0 20px 10px;"><i class="fa-solid fa-eye"></i>&nbsp; ${viewers.length} görüntülenme</div><div id="vs-list"></div>`;
    ov.appendChild(sheet);
    document.body.appendChild(ov);
    let closed = false;
    const close = (fromBack) => {
        if (closed) return;
        closed = true;
        ov.remove();
        resume();
        if (!fromBack) popBackState();
    };
    pushBackState(() => close(true));
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    const list = sheet.querySelector('#vs-list');
    if (!viewers.length) {
        list.innerHTML = '<p style="color:#9ca3af;font-size:13px;padding:10px 20px;">Henüz kimse görmedi.</p>';
        return;
    }
    for (const uid of viewers) {
        const info = await ensureUserInfo(uid);
        if (closed) return;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;padding:8px 20px;';
        row.innerHTML = `${avatarHtml(info, 40)}<span style="color:#fff;font-size:14px;margin-left:12px;">${escapeHtml(info.name || 'Kullanıcı')}</span>`;
        list.appendChild(row);
    }
}

// ---------------- Başlatma ----------------
export function initStatus() {
    const u = me();
    if (!u || !u.uid) return;
    if (inited && myUid === u.uid) return;
    inited = true;
    myUid = u.uid;
    injectStyle();
    startListening();
    cleanupMyExpired();

    const nav = document.getElementById('nav-status');
    if (nav && !nav.dataset.bound) {
        nav.dataset.bound = '1';
        nav.addEventListener('click', openPanel);
    }
    // Liste yeniden çizildikçe çemberler tazelensin
    setInterval(refreshRings, 15000);
    refreshRings();
}

export function openStatusPanel() { openPanel(); }

// Sohbetteki "Durum: ..." alıntısına dokununca o durumu aç (süresi dolduysa false döner)
window.__auraOpenStatusById = (statusId, ownerUid) => {
    if (!myUid) return false;
    const s = statuses.get(statusId);
    if (!s || s.expiresAt <= Date.now()) return false;
    const list = statusesOf(s.uid);
    const idx = list.findIndex((x) => x.id === statusId);
    if (idx < 0) return false;
    openViewer([{ uid: s.uid, list }], 0, idx);
    return true;
};

// Sohbet listesindeki avatara basınca: durumu varsa doğrudan göster (true döner)
export function openUserStatus(uid) {
    if (!myUid || !uid) return false;
    if (uid !== myUid && !canSee(uid)) return false;
    const list = statusesOf(uid);
    if (!list.length) return false;
    openViewer([{ uid, list }], 0);
    return true;
}
