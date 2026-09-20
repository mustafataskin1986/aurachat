// ==========================================
// GRUPLAR + ÜÇ NOKTA MENÜSÜ
// - Ana ekran sağ üstteki üç nokta: Yeni grup / Ayarlar menüsü
// - Yeni grup: kişi seç, isim ver, oluştur
// - Grup bilgisi: sohbet başlığına dokununca ya da sohbetin
//   üç nokta menüsünden açılır (üyeler, gruptan ayrıl)
// ==========================================

import { db } from "./firebase-init.js";
import { collection, doc, setDoc, getDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getCurrentUser, getCurrentChatId, selectChat, sendPushToUser, leaveGroup, showToast } from "./chat-core.js";
import { getUserColor, getInitials, escapeHtml } from "./ui-helpers.js";
import { pushBackState, popBackState } from "./back-handler.js";

const sidebar = document.getElementById('sidebar');
const chatAreaEl = document.getElementById('chat-area');
const menuBtn = document.getElementById('main-menu-btn');
const chatMenuBtn = document.getElementById('chat-menu-btn');

function avatarHtml(u, size) {
    if (u.avatar) {
        return `<img src="${u.avatar}" class="${size} rounded-full object-cover shadow flex-shrink-0">`;
    }
    return `<div class="${size} rounded-full flex items-center justify-center text-white font-bold text-sm shadow flex-shrink-0" style="background-color:${getUserColor(u.name || '?')};">${getInitials(u.name || '?')}</div>`;
}

function isGroupId(id) {
    return !!(id && window.__aurachatGroupIds && window.__aurachatGroupIds.has(id));
}

// ------------------------------------------
// ANA EKRAN ÜÇ NOKTA MENÜSÜ
// ------------------------------------------
let menuEl = null;

function ensureMenu() {
    if (menuEl) return menuEl;
    const el = document.createElement('div');
    el.className = 'hidden absolute right-3 top-14 z-40 w-48 bg-[#233138] rounded-xl shadow-2xl border border-gray-700/60 py-1';
    el.innerHTML = `
        <button type="button" data-menu="new-group" class="w-full flex items-center space-x-3 px-4 py-3 text-sm text-gray-100 hover:bg-[#2a3942] text-left">
            <i class="fa-solid fa-user-group text-emerald-400 w-4"></i><span>Yeni grup</span>
        </button>
        <button type="button" data-menu="settings" class="w-full flex items-center space-x-3 px-4 py-3 text-sm text-gray-100 hover:bg-[#2a3942] text-left">
            <i class="fa-solid fa-gear text-gray-400 w-4"></i><span>Ayarlar</span>
        </button>
    `;
    sidebar.appendChild(el);
    el.addEventListener('click', (e) => {
        const item = e.target.closest('[data-menu]');
        if (!item) return;
        closeMenu();
        if (item.dataset.menu === 'new-group') {
            openCreatePanel();
        } else if (item.dataset.menu === 'settings' && window.openProfilePanel) {
            window.openProfilePanel();
        }
    });
    menuEl = el;
    return el;
}

function closeMenu() {
    if (menuEl) menuEl.classList.add('hidden');
}

if (menuBtn) {
    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const el = ensureMenu();
        el.classList.toggle('hidden');
    });
}

// ------------------------------------------
// YENİ GRUP PANELİ
// ------------------------------------------
let createPanelEl = null;
let createPanelOpen = false;
const selectedUids = new Set();

function closeCreatePanelFromBack() {
    if (createPanelEl) {
        createPanelEl.classList.add('hidden');
        createPanelEl.classList.remove('flex');
    }
    createPanelOpen = false;
}

function closeCreatePanel() {
    if (!createPanelOpen) return;
    closeCreatePanelFromBack();
    popBackState();
}

function updateSelectedCount() {
    const countEl = createPanelEl && createPanelEl.querySelector('#group-selected-count');
    if (countEl) countEl.textContent = `${selectedUids.size} kişi seçildi`;
}

function ensureCreatePanel() {
    if (createPanelEl) return createPanelEl;
    const el = document.createElement('div');
    el.className = 'fixed inset-0 z-50 bg-[#0b141a] hidden flex-col';
    el.innerHTML = `
        <div class="bg-[#202c33] px-4 py-3.5 flex items-center space-x-4 border-b border-gray-800 flex-shrink-0">
            <button type="button" id="group-create-back" class="text-gray-400 hover:text-white transition text-lg px-1">
                <i class="fa-solid fa-arrow-left"></i>
            </button>
            <h2 class="text-white font-medium text-base">Yeni grup</h2>
        </div>
        <div class="p-3 flex-shrink-0">
            <input id="group-name-input" type="text" maxlength="40" placeholder="Grup adı" autocomplete="off" class="w-full bg-[#202c33] text-white text-sm px-4 py-3 rounded-xl border border-transparent focus:border-emerald-500/50 focus:outline-none placeholder-gray-500">
            <p id="group-selected-count" class="text-xs text-gray-500 mt-2 px-1">0 kişi seçildi</p>
        </div>
        <div id="group-member-list" class="flex-1 overflow-y-auto min-h-0"></div>
        <div class="p-3 border-t border-gray-800 flex-shrink-0">
            <button type="button" id="group-create-btn" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-3 rounded-xl transition flex items-center justify-center space-x-2">
                <i class="fa-solid fa-check"></i>
                <span>Grubu oluştur</span>
            </button>
        </div>
    `;
    document.body.appendChild(el);
    el.querySelector('#group-create-back').addEventListener('click', closeCreatePanel);
    el.querySelector('#group-create-btn').addEventListener('click', createGroup);
    createPanelEl = el;
    return el;
}

function renderCreateList() {
    const me = getCurrentUser();
    const listEl = createPanelEl.querySelector('#group-member-list');
    listEl.innerHTML = '';

    const usersMap = window.__aurachatUsers;
    const users = usersMap ? Array.from(usersMap.values()).filter((u) => u.uid !== me.uid) : [];
    users.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'tr'));

    if (!users.length) {
        listEl.innerHTML = `<p class="text-center text-gray-500 text-xs py-8">Eklenecek kişi bulunamadı.</p>`;
        return;
    }

    users.forEach((u) => {
        const row = document.createElement('div');
        row.className = 'flex items-center px-4 py-3 hover:bg-[#202c33]/60 cursor-pointer border-b border-gray-800/30';
        row.innerHTML = `
            ${avatarHtml(u, 'w-11 h-11')}
            <span class="text-white text-sm font-medium ml-3 truncate flex-1">${escapeHtml(u.name || '')}</span>
            <div class="pick-mark w-6 h-6 rounded-full border-2 border-gray-600 flex items-center justify-center flex-shrink-0">
                <i class="fa-solid fa-check text-white text-[10px] hidden"></i>
            </div>
        `;
        row.addEventListener('click', () => {
            if (selectedUids.has(u.uid)) selectedUids.delete(u.uid);
            else selectedUids.add(u.uid);

            const on = selectedUids.has(u.uid);
            const mark = row.querySelector('.pick-mark');
            mark.classList.toggle('bg-emerald-500', on);
            mark.classList.toggle('border-emerald-500', on);
            mark.classList.toggle('border-gray-600', !on);
            mark.firstElementChild.classList.toggle('hidden', !on);
            updateSelectedCount();
        });
        listEl.appendChild(row);
    });
}

function openCreatePanel() {
    const me = getCurrentUser();
    if (!me || !me.uid) return;
    const el = ensureCreatePanel();
    selectedUids.clear();
    el.querySelector('#group-name-input').value = '';
    updateSelectedCount();
    renderCreateList();

    el.classList.remove('hidden');
    el.classList.add('flex');
    createPanelOpen = true;
    pushBackState(closeCreatePanelFromBack);
}

async function createGroup() {
    const me = getCurrentUser();
    if (!me || !me.uid) return;

    const name = createPanelEl.querySelector('#group-name-input').value.trim();
    if (!name) { showToast('Grup adı yaz kanka'); return; }
    if (selectedUids.size === 0) { showToast('En az bir kişi seç'); return; }

    const btn = createPanelEl.querySelector('#group-create-btn');
    btn.disabled = true;

    try {
        const members = [me.uid].concat(Array.from(selectedUids));
        const groupRef = doc(collection(db, "groups"));
        const groupId = groupRef.id;

        await setDoc(groupRef, {
            name: name,
            members: members,
            createdBy: me.uid,
            createdAt: serverTimestamp()
        });

        await Promise.all(members.map((uid) => setDoc(doc(db, "users", uid, "chats", groupId), {
            isGroup: true,
            groupName: name,
            lastMessage: 'Grup oluşturuldu',
            lastMessageTime: serverTimestamp(),
            lastSenderUid: me.uid,
            lastSenderName: me.name,
            lastMessageRead: false,
            unreadCount: uid === me.uid ? 0 : 1,
            updatedAt: serverTimestamp()
        }, { merge: true })));

        members.forEach((uid) => {
            if (uid === me.uid) return;
            sendPushToUser(uid, name, `${me.name} seni gruba ekledi`, {
                chatId: groupId,
                otherUid: groupId,
                otherName: name
            });
        });

        window.__aurachatGroupIds = window.__aurachatGroupIds || new Set();
        window.__aurachatGroupIds.add(groupId);

        closeCreatePanel();
        selectChat({ isGroup: true, groupId: groupId, name: name });
    } catch (err) {
        showToast('Grup oluşturulamadı: ' + err.message, 3500);
    } finally {
        btn.disabled = false;
    }
}

// ------------------------------------------
// GRUP BİLGİSİ PANELİ
// ------------------------------------------
let infoPanelEl = null;
let infoPanelOpen = false;
let infoGroupId = null;

function closeInfoPanelFromBack() {
    if (infoPanelEl) {
        infoPanelEl.classList.add('hidden');
        infoPanelEl.classList.remove('flex');
    }
    infoPanelOpen = false;
}

function closeInfoPanel() {
    if (!infoPanelOpen) return;
    closeInfoPanelFromBack();
    popBackState();
}

function ensureInfoPanel() {
    if (infoPanelEl) return infoPanelEl;
    const el = document.createElement('div');
    el.className = 'fixed inset-0 z-50 bg-[#0b141a] hidden flex-col';
    el.innerHTML = `
        <div class="bg-[#202c33] px-4 py-3.5 flex items-center space-x-4 border-b border-gray-800 flex-shrink-0">
            <button type="button" id="group-info-back" class="text-gray-400 hover:text-white transition text-lg px-1">
                <i class="fa-solid fa-arrow-left"></i>
            </button>
            <h2 class="text-white font-medium text-base">Grup bilgisi</h2>
        </div>
        <div class="flex-1 overflow-y-auto min-h-0">
            <div class="flex flex-col items-center py-6 border-b border-gray-800/40">
                <div id="group-info-avatar" class="w-24 h-24 rounded-full flex items-center justify-center text-white text-3xl shadow-lg">
                    <i class="fa-solid fa-user-group"></i>
                </div>
                <h3 id="group-info-name" class="text-white text-lg font-semibold mt-3 px-4 text-center break-words"></h3>
                <p id="group-info-count" class="text-gray-400 text-xs mt-1"></p>
            </div>
            <div id="group-info-members"></div>
            <div class="p-4">
                <button type="button" id="group-leave-btn" class="w-full bg-rose-600/10 hover:bg-rose-600/20 text-rose-400 font-medium py-3 rounded-xl transition flex items-center justify-center space-x-2 border border-rose-600/20">
                    <i class="fa-solid fa-right-from-bracket"></i>
                    <span>Gruptan ayrıl</span>
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(el);
    el.querySelector('#group-info-back').addEventListener('click', closeInfoPanel);

    el.querySelector('#group-leave-btn').addEventListener('click', async () => {
        if (!infoGroupId) return;
        if (!confirm('Gruptan ayrılmak istiyor musun?')) return;
        const gid = infoGroupId;
        closeInfoPanel();
        try {
            await leaveGroup(gid);
            showToast('Gruptan ayrıldın');
        } catch (err) {
            showToast('Ayrılınamadı: ' + err.message, 3500);
        }
    });

    infoPanelEl = el;
    return el;
}

async function openGroupInfo(groupId) {
    const me = getCurrentUser();
    const el = ensureInfoPanel();
    infoGroupId = groupId;

    const nameEl = el.querySelector('#group-info-name');
    const countEl = el.querySelector('#group-info-count');
    const membersEl = el.querySelector('#group-info-members');
    const avatarEl = el.querySelector('#group-info-avatar');

    nameEl.textContent = '';
    countEl.textContent = '';
    membersEl.innerHTML = `<p class="text-center text-gray-500 text-xs py-6"><i class="fa-solid fa-spinner fa-spin"></i></p>`;

    el.classList.remove('hidden');
    el.classList.add('flex');
    infoPanelOpen = true;
    pushBackState(closeInfoPanelFromBack);

    try {
        const snap = await getDoc(doc(db, "groups", groupId));
        if (!infoPanelOpen || infoGroupId !== groupId) return;

        if (!snap.exists()) {
            membersEl.innerHTML = `<p class="text-center text-gray-500 text-xs py-6">Grup bulunamadı.</p>`;
            return;
        }

        const g = snap.data();
        const members = Array.isArray(g.members) ? g.members : [];
        nameEl.textContent = g.name || 'Grup';
        avatarEl.style.backgroundColor = getUserColor(g.name || 'Grup');
        countEl.textContent = `${members.length} üye`;

        const usersMap = window.__aurachatUsers;
        membersEl.innerHTML = '';
        members.forEach((uid) => {
            const isMe = !!(me && uid === me.uid);
            const u = (usersMap && usersMap.get(uid)) || (isMe ? me : { uid: uid, name: 'Bilinmeyen' });
            const tags = [];
            if (isMe) tags.push('Sen');
            if (g.createdBy === uid) tags.push('Kurucu');

            const row = document.createElement('div');
            row.className = 'flex items-center px-4 py-3 border-b border-gray-800/30';
            row.innerHTML = `
                ${avatarHtml(u, 'w-11 h-11')}
                <span class="text-white text-sm font-medium ml-3 truncate flex-1">${escapeHtml(u.name || '')}</span>
                ${tags.length ? `<span class="text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-bold ml-2 flex-shrink-0">${tags.join(' · ')}</span>` : ''}
            `;
            membersEl.appendChild(row);
        });
    } catch (err) {
        membersEl.innerHTML = `<p class="text-center text-rose-400 text-xs py-6">Yüklenemedi: ${escapeHtml(err.message)}</p>`;
    }
}

// Grup sohbetinde başlığa (avatar veya isim) dokununca grup bilgisi açılır
const headerName = document.getElementById('active-chat-name');
const headerAvatar = document.getElementById('active-chat-avatar');
[headerAvatar, headerName ? headerName.parentElement : null].forEach((el) => {
    if (!el) return;
    el.addEventListener('click', () => {
        const id = getCurrentChatId();
        if (isGroupId(id)) openGroupInfo(id);
    });
});

// ------------------------------------------
// SOHBET ÜST BARINDAKİ ÜÇ NOKTA MENÜSÜ (sadece grup sohbetinde açılır)
// ------------------------------------------
let chatMenuEl = null;

function closeChatMenu() {
    if (chatMenuEl) chatMenuEl.classList.add('hidden');
}

function ensureChatMenu() {
    if (chatMenuEl) return chatMenuEl;
    const el = document.createElement('div');
    el.className = 'hidden absolute right-3 top-14 z-40 w-48 bg-[#233138] rounded-xl shadow-2xl border border-gray-700/60 py-1';
    el.innerHTML = `
        <button type="button" data-chat-menu="info" class="w-full flex items-center space-x-3 px-4 py-3 text-sm text-gray-100 hover:bg-[#2a3942] text-left">
            <i class="fa-solid fa-circle-info text-sky-400 w-4"></i><span>Grup bilgisi</span>
        </button>
        <button type="button" data-chat-menu="leave" class="w-full flex items-center space-x-3 px-4 py-3 text-sm text-rose-400 hover:bg-[#2a3942] text-left">
            <i class="fa-solid fa-right-from-bracket w-4"></i><span>Gruptan ayrıl</span>
        </button>
    `;
    chatAreaEl.appendChild(el);

    el.addEventListener('click', async (e) => {
        const item = e.target.closest('[data-chat-menu]');
        if (!item) return;
        closeChatMenu();

        const id = getCurrentChatId();
        if (!isGroupId(id)) return;

        if (item.dataset.chatMenu === 'info') {
            openGroupInfo(id);
            return;
        }

        if (!confirm('Gruptan ayrılmak istiyor musun?')) return;
        try {
            await leaveGroup(id);
            showToast('Gruptan ayrıldın');
        } catch (err) {
            showToast('Ayrılınamadı: ' + err.message, 3500);
        }
    });

    chatMenuEl = el;
    return el;
}

if (chatMenuBtn) {
    chatMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!isGroupId(getCurrentChatId())) return;
        ensureChatMenu().classList.toggle('hidden');
    });
}

// Menülerin dışına dokununca ikisini de kapat
document.addEventListener('click', (e) => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
    if (chatMenuEl && !chatMenuEl.contains(e.target)) closeChatMenu();
});
