// ==========================================
// ARAMALAR SAYFASI (alt bar "Aramalar" sekmesi)
// users/{uid}/calls kayıtlarını okur (chat-core.js yazar).
// Satıra dokununca sohbeti açar; sağdaki ikona dokununca aramayı başlatır.
// ==========================================

import { db } from "./firebase-init.js";
import { collection, query, orderBy, limit, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getCurrentUser, selectChat, getCurrentChatId, showToast } from "./chat-core.js";
import { startCall } from "./video-call.js";
import { startVoiceCall } from "./voice-call.js";
import { getUserColor, getInitials, escapeHtml } from "./ui-helpers.js";
import { setTab } from "./tabs.js";

let unsub = null;
let myUid = null;
let items = [];
let el = null;

function userInfo(uid) {
    const map = window.__aurachatUsers;
    const u = map && map.get ? map.get(uid) : null;
    return { name: (u && u.name) || '', avatar: (u && u.avatar) || '' };
}

function avatarHtml(info, size) {
    if (info.avatar) return `<img src="${info.avatar}" class="rounded-full object-cover" style="width:${size}px;height:${size}px;">`;
    return `<div class="rounded-full flex items-center justify-center text-white font-bold" style="width:${size}px;height:${size}px;background:${getUserColor(info.name || '?')};font-size:${Math.round(size / 3)}px;">${getInitials(info.name || '')}</div>`;
}

function timeLabel(ms) {
    const d = new Date(ms);
    const now = new Date();
    const hm = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return hm;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Dün ' + hm;
    return d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' }) + ' ' + hm;
}

function durLabel(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(s / 60), r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function render() {
    if (!el) return;
    const header = `
        <div class="bg-[#202c33] px-4 py-3.5 flex items-center justify-between border-b border-gray-800 flex-shrink-0">
            <h2 class="text-white font-medium text-base">Aramalar</h2>
        </div>`;
    if (!items.length) {
        el.innerHTML = header + `<p class="px-6 py-10 text-center text-gray-500 text-xs">Henüz arama yok.</p>`;
        return;
    }
    const rows = items.map((c) => {
        const info = userInfo(c.otherUid);
        const name = info.name || c.otherName || 'Kullanıcı';
        const missed = c.result === 'missed' || c.result === 'declined';
        const color = missed ? '#f87171' : '#e5e7eb';
        const arrow = c.direction === 'out' ? 'fa-arrow-up-right' : 'fa-arrow-down-left';
        const arrowColor = missed && c.direction === 'in' ? '#f87171' : (c.result === 'answered' ? '#22c55e' : '#f87171');
        const sub = c.result === 'answered' ? durLabel(c.duration) : (c.result === 'missed' ? 'Cevapsız' : (c.result === 'declined' ? 'Reddedildi' : ''));
        const callIcon = c.callType === 'audio' ? 'fa-phone' : 'fa-video';
        return `
        <div class="flex items-center px-4 py-3 border-b border-gray-800/30" data-open="${escapeHtml(c.otherUid)}">
            <div class="flex-shrink-0 cursor-pointer">${avatarHtml(info, 48)}</div>
            <div class="ml-3 flex-1 min-w-0 cursor-pointer">
                <div class="text-[15px] font-medium truncate" style="color:${color}">${escapeHtml(name)}</div>
                <div class="text-[12px] text-gray-400 flex items-center gap-1 truncate">
                    <i class="fa-solid ${arrow} text-[10px]" style="color:${arrowColor}"></i>
                    <span>${escapeHtml(timeLabel(c.at))}${sub ? ' · ' + escapeHtml(sub) : ''}</span>
                </div>
            </div>
            <button type="button" data-call="${escapeHtml(c.otherUid)}" data-type="${c.callType === 'audio' ? 'audio' : 'video'}" class="w-10 h-10 rounded-full flex items-center justify-center text-emerald-500 hover:bg-[#202c33]"><i class="fa-solid ${callIcon}"></i></button>
        </div>`;
    }).join('');
    el.innerHTML = header + `<div id="calls-list" class="flex-1 overflow-y-auto min-h-0">${rows}</div>`;
}

async function openChatWith(uid, andCall) {
    const info = userInfo(uid);
    try {
        await selectChat({ uid, name: info.name || '', avatar: info.avatar || '' });
        const chatId = getCurrentChatId();
        if (andCall === 'audio') startVoiceCall(chatId, uid);
        else if (andCall === 'video') startCall(chatId, uid);
        else setTab(0, { instant: true });
    } catch (e) {
        showToast('Açılamadı');
    }
}

function bindClicks() {
    if (!el || el.dataset.callsBound) return;
    el.dataset.callsBound = '1';
    el.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-call]');
        if (b) { openChatWith(b.dataset.call, b.dataset.type); return; }
        const row = e.target.closest('[data-open]');
        if (row) openChatWith(row.dataset.open, null);
    });
}

export function initCalls() {
    const u = getCurrentUser();
    if (!u || !u.uid) return;
    if (unsub && myUid === u.uid) return;
    if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
    myUid = u.uid;
    el = document.getElementById('tab-calls');
    if (!el) return;
    bindClicks();
    const q = query(collection(db, "users", myUid, "calls"), orderBy("at", "desc"), limit(100));
    unsub = onSnapshot(q, (snap) => {
        items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        render();
    }, () => {});
    window.addEventListener('aura-tab', (e) => { if (e.detail && e.detail.tab === 'calls') render(); });
    render();
}
