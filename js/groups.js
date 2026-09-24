// ==========================================
// GRUPLAR + ÜÇ NOKTA MENÜSÜ
// - Ana ekran sağ üstteki üç nokta: Yeni grup / Ayarlar menüsü
// - Yeni grup: kişi seç, isim ver, oluştur
// - Grup bilgisi: sohbet başlığına dokununca ya da sohbetin
//   üç nokta menüsünden açılır (üyeler, gruptan ayrıl)
// ==========================================

import { db } from "./firebase-init.js";
import { collection, doc, setDoc, getDoc, addDoc, updateDoc, deleteDoc, arrayUnion, arrayRemove, increment, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getCurrentUser, getCurrentChatId, selectChat, sendPushToUser, leaveGroup, showToast, toggleBlockUser } from "./chat-core.js";
import { getUserColor, getInitials, escapeHtml } from "./ui-helpers.js";
import { pushBackState, popBackState } from "./back-handler.js";
import { openImageCropper } from "./image-cropper.js";

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
let infoGroupData = null;

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
             <div class="relative">
                    <div id="group-info-avatar" class="w-24 h-24 rounded-full overflow-hidden flex items-center justify-center text-white text-3xl shadow-lg">
                        <i class="fa-solid fa-user-group"></i>
                    </div>
                    <button type="button" id="group-photo-btn" class="hidden absolute bottom-0 right-0 w-8 h-8 rounded-full bg-emerald-600 text-white text-xs items-center justify-center border-2 border-[#0b141a]"><i class="fa-solid fa-camera"></i></button>
                </div>
            <div class="flex items-center justify-center mt-3 px-4 max-w-full">
                    <h3 id="group-info-name" class="text-white text-lg font-semibold text-center break-words"></h3>
                    <button type="button" id="group-rename-btn" class="hidden ml-2 text-emerald-400 hover:text-emerald-300 text-sm flex-shrink-0"><i class="fa-solid fa-pen"></i></button>
                </div>
                <p id="group-info-count" class="text-gray-400 text-xs mt-1"></p>
            </div>
         <button type="button" id="group-add-member-btn" class="w-full flex items-center px-4 py-3 border-b border-gray-800/30 hover:bg-[#202c33]/60 text-left">
                <span class="w-11 h-11 rounded-full bg-emerald-600 flex items-center justify-center text-white flex-shrink-0"><i class="fa-solid fa-user-plus"></i></span>
                <span class="text-white text-sm font-medium ml-3">Üye ekle</span>
            </button>
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
  el.querySelector('#group-add-member-btn').addEventListener('click', () => openAddPanel());
    el.querySelector('#group-rename-btn').addEventListener('click', () => renameGroup());
    el.querySelector('#group-photo-btn').addEventListener('click', () => changeGroupPhoto());
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
    const wasOpen = infoPanelOpen; // zaten açıksa (yenileme) geri tuşu kaydı tekrar eklenmesin
    infoGroupId = groupId;
    infoGroupData = null;

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
    if (!wasOpen) pushBackState(closeInfoPanelFromBack);

    try {
        const snap = await getDoc(doc(db, "groups", groupId));
        if (!infoPanelOpen || infoGroupId !== groupId) return;

        if (!snap.exists()) {
            membersEl.innerHTML = `<p class="text-center text-gray-500 text-xs py-6">Grup bulunamadı.</p>`;
            return;
        }

        const g = snap.data();
        infoGroupData = g;
        const members = Array.isArray(g.members) ? g.members : [];
        nameEl.textContent = g.name || 'Grup';
        avatarEl.style.backgroundColor = getUserColor(g.name || 'Grup');
        avatarEl.innerHTML = g.photo
            ? `<img src="${g.photo}" class="w-full h-full object-cover">`
            : `<i class="fa-solid fa-user-group"></i>`;
        countEl.textContent = `${members.length} üye`;

        // Yönetici değilse ad değiştirme ve üye ekleme kapalı
        const iAmAdmin = !!(me && isAdmin(g, me.uid));
        const renameBtn = el.querySelector('#group-rename-btn');
        if (renameBtn) renameBtn.classList.toggle('hidden', !iAmAdmin);
        const addBtn = el.querySelector('#group-add-member-btn');
    if (addBtn) addBtn.style.display = iAmAdmin ? '' : 'none';
        const photoBtn = el.querySelector('#group-photo-btn');
        if (photoBtn) {
            photoBtn.classList.toggle('hidden', !iAmAdmin);
            photoBtn.classList.toggle('flex', iAmAdmin);
        }

        const usersMap = window.__aurachatUsers;
        membersEl.innerHTML = '';
        members.forEach((uid) => {
            const isMe = !!(me && uid === me.uid);
            const u = (usersMap && usersMap.get(uid)) || (isMe ? me : { uid: uid, name: 'Bilinmeyen' });
            const tags = [];
            if (isMe) tags.push('Sen');
          if (g.createdBy === uid) tags.push('Kurucu');
            else if (isAdmin(g, uid)) tags.push('Yönetici');

            const row = document.createElement('div');
            row.className = 'flex items-center px-4 py-3 border-b border-gray-800/30';
            row.innerHTML = `
                ${avatarHtml(u, 'w-11 h-11')}
                <span class="text-white text-sm font-medium ml-3 truncate flex-1">${escapeHtml(u.name || '')}</span>
                ${tags.length ? `<span class="text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-bold ml-2 flex-shrink-0">${tags.join(' · ')}</span>` : ''}
            `;
            // Yönetici, kurucu dışındaki üyelere dokunup işlem yapabilir
            if (iAmAdmin && !isMe && g.createdBy !== uid) {
                row.classList.add('cursor-pointer', 'hover:bg-[#202c33]/60');
                row.addEventListener('click', () => openMemberActions(uid, u.name || 'Üye', g));
            }
            membersEl.appendChild(row);
        });
    } catch (err) {
        membersEl.innerHTML = `<p class="text-center text-rose-400 text-xs py-6">Yüklenemedi: ${escapeHtml(err.message)}</p>`;
    }
}

// ------------------------------------------
// ÜYE EKLE PANELİ (grup bilgisinden açılır)
// ------------------------------------------
let addPanelEl = null;
let addPanelOpen = false;
const addSelectedUids = new Set();

function closeAddPanelFromBack() {
    if (addPanelEl) {
        addPanelEl.classList.add('hidden');
        addPanelEl.classList.remove('flex');
    }
    addPanelOpen = false;
}

function closeAddPanel() {
    if (!addPanelOpen) return;
    closeAddPanelFromBack();
    popBackState();
}

function updateAddSelectedCount() {
    const countEl = addPanelEl && addPanelEl.querySelector('#group-add-count');
    if (countEl) countEl.textContent = `${addSelectedUids.size} kişi seçildi`;
}

function ensureAddPanel() {
    if (addPanelEl) return addPanelEl;
    const el = document.createElement('div');
    el.className = 'fixed inset-0 z-[60] bg-[#0b141a] hidden flex-col';
    el.innerHTML = `
        <div class="bg-[#202c33] px-4 py-3.5 flex items-center space-x-4 border-b border-gray-800 flex-shrink-0">
            <button type="button" id="group-add-back" class="text-gray-400 hover:text-white transition text-lg px-1">
                <i class="fa-solid fa-arrow-left"></i>
            </button>
            <h2 class="text-white font-medium text-base">Üye ekle</h2>
        </div>
        <p id="group-add-count" class="text-xs text-gray-500 px-4 py-2 flex-shrink-0">0 kişi seçildi</p>
        <div id="group-add-list" class="flex-1 overflow-y-auto min-h-0"></div>
        <div class="p-3 border-t border-gray-800 flex-shrink-0">
            <button type="button" id="group-add-confirm" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-3 rounded-xl transition flex items-center justify-center space-x-2">
                <i class="fa-solid fa-check"></i>
                <span>Gruba ekle</span>
            </button>
        </div>
    `;
    document.body.appendChild(el);
    el.querySelector('#group-add-back').addEventListener('click', closeAddPanel);
    el.querySelector('#group-add-confirm').addEventListener('click', addMembersToGroup);
    addPanelEl = el;
    return el;
}

function renderAddList() {
    const listEl = addPanelEl.querySelector('#group-add-list');
    listEl.innerHTML = '';

    const current = (infoGroupData && Array.isArray(infoGroupData.members)) ? infoGroupData.members : [];
    const usersMap = window.__aurachatUsers;
    const users = usersMap ? Array.from(usersMap.values()).filter((u) => !current.includes(u.uid)) : [];
    users.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'tr'));

    if (!users.length) {
        listEl.innerHTML = `<p class="text-center text-gray-500 text-xs py-8">Eklenecek başka kişi yok.</p>`;
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
            if (addSelectedUids.has(u.uid)) addSelectedUids.delete(u.uid);
            else addSelectedUids.add(u.uid);

            const on = addSelectedUids.has(u.uid);
            const mark = row.querySelector('.pick-mark');
            mark.classList.toggle('bg-emerald-500', on);
            mark.classList.toggle('border-emerald-500', on);
            mark.classList.toggle('border-gray-600', !on);
            mark.firstElementChild.classList.toggle('hidden', !on);
            updateAddSelectedCount();
        });
        listEl.appendChild(row);
    });
}

function openAddPanel() {
    if (!infoGroupData || !infoGroupId) return;
    const el = ensureAddPanel();
    addSelectedUids.clear();
    updateAddSelectedCount();
    renderAddList();

    el.classList.remove('hidden');
    el.classList.add('flex');
    addPanelOpen = true;
    pushBackState(closeAddPanelFromBack);
}

// ------------------------------------------
// GRUP YÖNETİMİ: yönetici kontrolü, ad değiştirme, üye çıkarma, yönetici yapma
// ------------------------------------------
function adminsOf(g) {
    if (g && Array.isArray(g.admins) && g.admins.length) return g.admins;
    return (g && g.createdBy) ? [g.createdBy] : [];
}

function isAdmin(g, uid) {
    return adminsOf(g).includes(uid);
}

// Sohbete sistem mesajı yazar, üyelerin liste özetini günceller, diğerlerine bildirim atar
async function postGroupEvent(gid, g, text, extra) {
    const me = getCurrentUser();
    const members = Array.isArray(g.members) ? g.members : [];
    const gname = (extra && extra.groupName) || g.name || 'Grup';

    await addDoc(collection(db, "chats", gid, "messages"), {
        type: 'system',
        text: text,
        senderUid: me.uid,
        senderName: me.name || '',
        createdAt: serverTimestamp(),
        read: false
    });

    await Promise.allSettled(members.map((uid) => setDoc(doc(db, "users", uid, "chats", gid), {
        isGroup: true,
        groupName: gname,
        ...((extra && extra.groupPhoto) ? { groupPhoto: extra.groupPhoto } : {}),
        lastMessage: text,
        lastMessageTime: serverTimestamp(),
        lastSenderUid: me.uid,
        lastSenderName: '',
        lastMessageRead: false,
        unreadCount: uid === me.uid ? 0 : increment(1),
        updatedAt: serverTimestamp()
    }, { merge: true })));

    members.forEach((uid) => {
        if (uid === me.uid) return;
        sendPushToUser(uid, gname, text, { chatId: gid, otherUid: gid, otherName: gname });
    });
}

async function renameGroup() {
    const me = getCurrentUser();
    const gid = infoGroupId;
    const g = infoGroupData;
    if (!me || !gid || !g || !isAdmin(g, me.uid)) return;

    const input = prompt('Yeni grup adı:', g.name || '');
    if (input === null) return;
    const newName = input.trim().slice(0, 40);
    if (!newName || newName === g.name) return;

    try {
        await updateDoc(doc(db, "groups", gid), { name: newName });
        await postGroupEvent(gid, g, `${me.name} grubun adını "${newName}" olarak değiştirdi`, { groupName: newName });
        showToast('Grup adı değişti');
        openGroupInfo(gid);
    } catch (err) {
        showToast('Değiştirilemedi: ' + err.message, 3500);
    }
}

// ------------------------------------------
// GRUP FOTOĞRAFI (yönetici değiştirir; küçük kare önizleme olarak grup belgesinde tutulur)
// ------------------------------------------
function pickGroupPhotoFile() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';
        input.addEventListener('change', () => {
            resolve(input.files && input.files[0] ? input.files[0] : null);
            input.remove();
        });
        input.addEventListener('cancel', () => {
            resolve(null);
            input.remove();
        });
        document.body.appendChild(input);
        input.click();
    });
}

// Seçilen resmi ortadan kare kırpıp küçültür (kayıt boyutu ~10 KB)
function makeSquareThumb(file, size) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const side = Math.min(img.width, img.height);
                const sx = Math.round((img.width - side) / 2);
                const sy = Math.round((img.height - side) / 2);
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, size, size);
                resolve(canvas.toDataURL('image/jpeg', 0.7));
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function changeGroupPhoto() {
    const me = getCurrentUser();
    const gid = infoGroupId;
    const g = infoGroupData;
    if (!me || !gid || !g || !isAdmin(g, me.uid)) return;

    const file = await pickGroupPhotoFile();
    if (!file) return;

    try {
        const photo = await openImageCropper(file, { size: 192, quality: 0.7 });
        if (!photo) return; // İptal
        await updateDoc(doc(db, "groups", gid), { photo: photo });
        await postGroupEvent(gid, g, `${me.name} grup fotoğrafını değiştirdi`, { groupPhoto: photo });
        showToast('Grup fotoğrafı değişti');
        openGroupInfo(gid);
    } catch (err) {
        showToast('Fotoğraf değiştirilemedi: ' + err.message, 3500);
    }
}

let memberSheetEl = null;

function closeMemberSheetFromBack() {
    if (memberSheetEl) {
        memberSheetEl.remove();
        memberSheetEl = null;
    }
}

function closeMemberSheet() {
    if (!memberSheetEl) return;
    closeMemberSheetFromBack();
    popBackState();
}

function openMemberActions(uid, name, g) {
    closeMemberSheetFromBack();
    const admin = isAdmin(g, uid);
    const el = document.createElement('div');
    el.className = 'fixed inset-0 z-[70] bg-black/60 flex items-end';
    el.innerHTML = `
        <div class="w-full bg-[#202c33] rounded-t-2xl pb-6">
            <p class="text-gray-400 text-xs px-5 pt-4 pb-2 truncate">${escapeHtml(name)}</p>
            <button type="button" data-act="admin" class="w-full text-left px-5 py-3.5 text-sm text-gray-100 hover:bg-[#2a3942]"><i class="fa-solid fa-user-shield text-emerald-400 w-6"></i>${admin ? 'Yöneticiliği kaldır' : 'Yönetici yap'}</button>
            <button type="button" data-act="remove" class="w-full text-left px-5 py-3.5 text-sm text-rose-400 hover:bg-[#2a3942]"><i class="fa-solid fa-user-minus w-6"></i>Gruptan çıkar</button>
            <button type="button" data-act="cancel" class="w-full text-left px-5 py-3.5 text-sm text-gray-400 hover:bg-[#2a3942]"><i class="fa-solid fa-xmark w-6"></i>Vazgeç</button>
        </div>
    `;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
        if (e.target === el) { closeMemberSheet(); return; }
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        closeMemberSheet();
        if (act === 'admin') toggleAdmin(uid, name, admin);
        else if (act === 'remove') removeMember(uid, name);
    });
    memberSheetEl = el;
    pushBackState(closeMemberSheetFromBack);
}

async function toggleAdmin(uid, name, wasAdmin) {
    const me = getCurrentUser();
    const gid = infoGroupId;
    const g = infoGroupData;
    if (!me || !gid || !g || !isAdmin(g, me.uid) || uid === g.createdBy) return;

    try {
        const base = adminsOf(g);
        const next = wasAdmin ? base.filter((x) => x !== uid) : base.concat([uid]);
        await updateDoc(doc(db, "groups", gid), { admins: next });
        await postGroupEvent(gid, g, wasAdmin ? `${name} artık yönetici değil` : `${name} yönetici yapıldı`);
        openGroupInfo(gid);
    } catch (err) {
        showToast('İşlem yapılamadı: ' + err.message, 3500);
    }
}

async function removeMember(uid, name) {
    const me = getCurrentUser();
    const gid = infoGroupId;
    const g = infoGroupData;
    if (!me || !gid || !g || !isAdmin(g, me.uid) || uid === g.createdBy) return;
    if (!confirm(`${name} gruptan çıkarılsın mı?`)) return;

    try {
        const remaining = (Array.isArray(g.members) ? g.members : []).filter((x) => x !== uid);
        await updateDoc(doc(db, "groups", gid), { members: arrayRemove(uid), admins: arrayRemove(uid) });
        await postGroupEvent(gid, { name: g.name, members: remaining }, `${name} gruptan çıkarıldı`);
        await deleteDoc(doc(db, "users", uid, "chats", gid)).catch(() => {});
        openGroupInfo(gid);
    } catch (err) {
        showToast('Çıkarılamadı: ' + err.message, 3500);
    }
}

// Sohbetin üç nokta menüsünden: grup bilgisini okuyup doğrudan üye ekleme panelini açar
async function openAddPanelForGroup(groupId) {
    try {
        const snap = await getDoc(doc(db, "groups", groupId));
        if (!snap.exists()) { showToast('Grup bulunamadı'); return; }
        infoGroupId = groupId;
        infoGroupData = snap.data();
        const meAdd = getCurrentUser();
        if (!meAdd || !isAdmin(infoGroupData, meAdd.uid)) {
            showToast('Sadece yöneticiler üye ekleyebilir');
            return;
        }
        openAddPanel();
    } catch (err) {
        showToast('Grup bilgisi okunamadı: ' + err.message, 3500);
    }
}

async function addMembersToGroup() {
    const me = getCurrentUser();
    const gid = infoGroupId;
    const g = infoGroupData;
    if (!me || !gid || !g) return;

    const newUids = Array.from(addSelectedUids);
    if (!newUids.length) { showToast('En az bir kişi seç'); return; }

    const btn = addPanelEl.querySelector('#group-add-confirm');
    btn.disabled = true;

    try {
        const usersMap = window.__aurachatUsers;
        const addedNames = newUids.map((uid) => {
            const u = usersMap && usersMap.get(uid);
            return (u && u.name) ? u.name : 'Biri';
        });
        const text = `${addedNames.join(', ')} gruba eklendi`;
        const oldMembers = Array.isArray(g.members) ? g.members : [];
        const groupName = g.name || 'Grup';

        // 1) Üyeleri gruba ekle
        await updateDoc(doc(db, "groups", gid), { members: arrayUnion(...newUids) });

        // 2) Sohbete "X gruba eklendi" mesajı
        await addDoc(collection(db, "chats", gid, "messages"), {
            type: 'system',
            text: text,
            senderUid: me.uid,
            senderName: me.name,
            createdAt: serverTimestamp(),
            read: false
        });

        // 3) Herkesin sohbet listesini güncelle (yeni üyelerde grup belirir)
        await Promise.allSettled(oldMembers.concat(newUids).map((uid) => setDoc(doc(db, "users", uid, "chats", gid), {
            isGroup: true,
            groupName: groupName,
         ...(newUids.includes(uid) ? { clearedAt: serverTimestamp() } : {}), // yeni üye eski mesajları görmesin
            ...(g.photo ? { groupPhoto: g.photo } : {}),
            lastMessage: text,
            lastMessageTime: serverTimestamp(),
            lastSenderUid: me.uid,
            lastSenderName: '',
            lastMessageRead: false,
            unreadCount: uid === me.uid ? 0 : increment(1),
            updatedAt: serverTimestamp()
        }, { merge: true })));

        // 4) Bildirimler: eski üyelere "X gruba eklendi", yeni üyelere "seni gruba ekledi"
        oldMembers.forEach((uid) => {
            if (uid === me.uid) return;
            sendPushToUser(uid, groupName, text, { chatId: gid, otherUid: gid, otherName: groupName });
        });
        newUids.forEach((uid) => {
            sendPushToUser(uid, groupName, `${me.name} seni gruba ekledi`, { chatId: gid, otherUid: gid, otherName: groupName });
        });

        closeAddPanel();
        showToast(text);
        if (infoPanelOpen) openGroupInfo(gid); // menüden açıldıysa grup bilgisi paneli kendiliğinden açılmasın
    } catch (err) {
        showToast('Eklenemedi: ' + err.message, 3500);
    } finally {
        btn.disabled = false;
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
// SOHBET ÜST BARINDAKİ ÜÇ NOKTA MENÜSÜ
// Grupta: Grup bilgisi / Üye ekle / Sessize al / Gruptan ayrıl
// Bire bir sohbette: Sessize al / Engelle
// ------------------------------------------
let chatMenuEl = null;

function closeChatMenu() {
    if (chatMenuEl) chatMenuEl.classList.add('hidden');
}

function ensureChatMenuContainer() {
    if (chatMenuEl) return chatMenuEl;
    const el = document.createElement('div');
    el.className = 'hidden absolute right-3 top-14 z-40 w-52 bg-[#233138] rounded-xl shadow-2xl border border-gray-700/60 py-1';
    chatAreaEl.appendChild(el);
    chatMenuEl = el;
    return el;
}

async function openChatMenu() {
    const id = getCurrentChatId();
    const me = getCurrentUser();
    if (!id || id === 'global' || !me) return;

    const el = ensureChatMenuContainer();
    const isGrp = isGroupId(id);

    let muted = false;
    try {
        const snap = await getDoc(doc(db, "users", me.uid, "chats", id));
        if (snap.exists()) muted = !!snap.data().muted;
    } catch (e) {}

    let itemsHtml = '';
    if (isGrp) {
        itemsHtml += `
            <button type="button" data-chat-menu="info" class="w-full flex items-center space-x-3 px-4 py-3 text-sm text-gray-100 hover:bg-[#2a3942] text-left">
                <i class="fa-solid fa-circle-info text-sky-400 w-4"></i><span>Grup bilgisi</span>
            </button>
            <button type="button" data-chat-menu="add" class="w-full flex items-center space-x-3 px-4 py-3 text-sm text-gray-100 hover:bg-[#2a3942] text-left">
                <i class="fa-solid fa-user-plus text-emerald-400 w-4"></i><span>Üye ekle</span>
            </button>`;
    }

    itemsHtml += `
        <button type="button" data-chat-menu="mute" class="w-full flex items-center space-x-3 px-4 py-3 text-sm text-gray-100 hover:bg-[#2a3942] text-left">
            <i class="fa-solid ${muted ? 'fa-bell' : 'fa-bell-slash'} text-amber-400 w-4"></i><span>${muted ? 'Sesi aç' : 'Sessize al'}</span>
        </button>`;

    let otherUidForBlock = null;
    if (!isGrp) {
        otherUidForBlock = id.split('_').find((u) => u !== me.uid) || null;
        const usersMap = window.__aurachatUsers;
        const meRecord = usersMap && usersMap.get(me.uid);
        const blockedByMe = !!(meRecord && Array.isArray(meRecord.blockedUids) && meRecord.blockedUids.includes(otherUidForBlock));
        itemsHtml += `
            <button type="button" data-chat-menu="block" class="w-full flex items-center space-x-3 px-4 py-3 text-sm ${blockedByMe ? 'text-gray-100' : 'text-rose-400'} hover:bg-[#2a3942] text-left">
                <i class="fa-solid fa-ban w-4"></i><span>${blockedByMe ? 'Engeli kaldır' : 'Engelle'}</span>
            </button>`;
    } else {
        itemsHtml += `
            <button type="button" data-chat-menu="leave" class="w-full flex items-center space-x-3 px-4 py-3 text-sm text-rose-400 hover:bg-[#2a3942] text-left">
                <i class="fa-solid fa-right-from-bracket w-4"></i><span>Gruptan ayrıl</span>
            </button>`;
    }

    el.innerHTML = itemsHtml;
    el.onclick = async (e) => {
        const item = e.target.closest('[data-chat-menu]');
        if (!item) return;
        closeChatMenu();
        const action = item.dataset.chatMenu;
        if (getCurrentChatId() !== id) return;

        if (action === 'info') { openGroupInfo(id); return; }
        if (action === 'add') { openAddPanelForGroup(id); return; }

        if (action === 'mute') {
            try {
                await setDoc(doc(db, "users", me.uid, "chats", id), { muted: !muted }, { merge: true });
                showToast(!muted ? 'Sohbet sessize alındı' : 'Sohbetin sesi açıldı');
            } catch (err) {
                showToast('İşlem yapılamadı: ' + err.message, 3500);
            }
            return;
        }

        if (action === 'block' && otherUidForBlock) {
            toggleBlockUser(otherUidForBlock);
            return;
        }

        if (action === 'leave') {
            if (!confirm('Gruptan ayrılmak istiyor musun?')) return;
            try {
                await leaveGroup(id);
                showToast('Gruptan ayrıldın');
            } catch (err) {
                showToast('Ayrılınamadı: ' + err.message, 3500);
            }
        }
    };

    el.classList.toggle('hidden');
}

if (chatMenuBtn) {
    chatMenuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openChatMenu();
    });
}

// Menülerin dışına dokununca ikisini de kapat
document.addEventListener('click', (e) => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
    if (chatMenuEl && !chatMenuEl.contains(e.target)) closeChatMenu();
});
