// ==========================================
// KİŞİ LİSTESİ + ADMİN PANEL
//
// GÜNCELLEME: Avatarlar artık WhatsApp mantığıyla cihaza yerel dosya
// olarak önbelleğe alınıyor (Capacitor Filesystem). İlk açılışta
// baş harf/ initials placeholder gösteriliyor, arkaplanda avatar
// cihaza yazılıyor/okunuyor, hazır olunca yerine geçiyor. Sonraki
// tüm render'larda artık koca base64 string yerine küçük bir yerel
// dosya yolu kullanılıyor — snapshot tetiklendikçe liste çok daha
// hafif ve hızlı yeniden çiziliyor.
//
// Sohbet seçim modunda avatarın sağ alt köşesinde yeşil tik rozeti
// gösteriliyor. Toolbar'a Sabitle ve Arşivle butonları eklendi
// (pinned/archived alanları users/{uid}/chats/{chatId} dokümanında
// tutuluyor). Sabitlenen sohbetler listenin en üstünde, arşivlenenler
// ana listede görünmüyor.
// ==========================================

import { db, ADMIN_EMAIL } from "./firebase-init.js";
import {
    collection, onSnapshot, query, orderBy, doc, getDocs, updateDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getUserColor, getInitials, formatAdminUser, formatTimestamp, getPhoneLast10, escapeHtml, getChatId } from "./ui-helpers.js";
import { selectChat, getCurrentUser, clearChatForMe } from "./chat-core.js";
import { pushBackState, popBackState } from "./back-handler.js";

const contactList = document.getElementById('contact-list');
const searchContact = document.getElementById('search-contact');
const searchIcon = document.getElementById('search-icon');

const adminBtn = document.getElementById('admin-btn');
const adminModal = document.getElementById('admin-modal');
const adminModalClose = document.getElementById('admin-modal-close');
const adminUserList = document.getElementById('admin-user-list');

const chatSelectionToolbar = document.getElementById('chat-selection-toolbar');
const chatSelectionCancelBtn = document.getElementById('chat-selection-cancel-btn');
const chatSelectionCountEl = document.getElementById('chat-selection-count');
const chatSelectionDeleteBtn = document.getElementById('chat-selection-delete-btn');
const chatSelectionPinBtn = document.getElementById('chat-selection-pin-btn');
const chatSelectionArchiveBtn = document.getElementById('chat-selection-archive-btn');

const contactElementsMap = new Map();

let chatSelectionMode = false;
const selectedChatIds = new Set();

// ------------------------------------------
// AVATAR YEREL DOSYA ÖNBELLEĞİ (WhatsApp mantığı)
// ------------------------------------------
const AVATAR_CACHE_DIR = 'avatars';
const avatarUriCache = new Map(); // uid -> yerel dosyanın gösterilebilir src'si

// Base64 avatarı cihaza dosya olarak yazar (bir kez), sonraki
// çağrılarda direkt yerel dosyadan okur. Capacitor Filesystem yoksa
// (web/PWA) eski davranışa döner: base64'ü olduğu gibi kullanır.
async function resolveLocalAvatar(uid, base64Avatar) {
    if (!base64Avatar) return null;
    if (avatarUriCache.has(uid)) return avatarUriCache.get(uid);

    const Filesystem = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
    if (!Filesystem || !window.Capacitor.convertFileSrc) {
        return base64Avatar;
    }

    const fileName = `${AVATAR_CACHE_DIR}/${uid}.jpg`;

    try {
        const existing = await Filesystem.getUri({ path: fileName, directory: 'DATA' });
        const src = window.Capacitor.convertFileSrc(existing.uri);
        avatarUriCache.set(uid, src);
        return src;
    } catch (e) {
        // Dosya cihazda henüz yok, ilk kez yazılacak
    }

    try {
        const base64Data = base64Avatar.includes(',') ? base64Avatar.split(',')[1] : base64Avatar;
        await Filesystem.mkdir({ path: AVATAR_CACHE_DIR, directory: 'DATA', recursive: true }).catch(() => {});
        const written = await Filesystem.writeFile({ path: fileName, data: base64Data, directory: 'DATA' });
        const src = window.Capacitor.convertFileSrc(written.uri);
        avatarUriCache.set(uid, src);
        return src;
    } catch (err) {
        console.warn("Avatar yerel diske yazılamadı:", err);
        return base64Avatar;
    }
}

function buildAvatarPlaceholder(name, sizeClasses) {
    const initials = getInitials(name || '?');
    const color = getUserColor(name || '?');
    return `<div class="${sizeClasses} rounded-full flex items-center justify-center text-white font-bold text-sm shadow" style="background-color: ${color};">${initials}</div>`;
}

// Bir avatar slotunu senkron olarak (placeholder veya önbellekten) doldurur,
// önbellekte yoksa arkaplanda cihaza yazıp hazır olunca yerine geçirir.
function renderAvatarInto(containerEl, uid, avatarBase64, name, sizeClasses) {
    if (!containerEl) return;

    const cached = avatarUriCache.get(uid);
    if (cached) {
        containerEl.innerHTML = `<img src="${cached}" class="${sizeClasses} rounded-full object-cover shadow">`;
        return;
    }

    if (!avatarBase64) {
        containerEl.innerHTML = buildAvatarPlaceholder(name, sizeClasses);
        return;
    }

    containerEl.innerHTML = buildAvatarPlaceholder(name, sizeClasses);
    resolveLocalAvatar(uid, avatarBase64).then((src) => {
        if (src && containerEl.isConnected) {
            containerEl.innerHTML = `<img src="${src}" class="${sizeClasses} rounded-full object-cover shadow">`;
        }
    });
}

// ------------------------------------------
// İSKELET (LOADING) LİSTESİ
// ------------------------------------------
function renderSkeletonList() {
    let skeletonHtml = '';
    for (let i = 0; i < 5; i++) {
        skeletonHtml += `
            <div class="flex items-center px-4 py-3 animate-pulse border-b border-gray-800/30">
                <div class="w-12 h-12 bg-gray-700/50 rounded-full mr-3 flex-shrink-0"></div>
                <div class="flex-1">
                    <div class="h-3.5 bg-gray-700/60 rounded w-1/3 mb-2"></div>
                    <div class="h-2.5 bg-gray-800/80 rounded w-2/3"></div>
                </div>
            </div>
        `;
    }
    contactList.innerHTML = skeletonHtml;
}

// Avatarı, seçim modunda gösterilecek yeşil tik rozetiyle birlikte sarmalar.
// slotId, avatarın async olarak sonradan doldurulacağı hedefi işaretler.
function wrapAvatarWithSelectionBadge(slotId) {
    return `
        <div class="relative flex-shrink-0">
            <div data-avatar-slot="${slotId}"></div>
            <div class="selection-check hidden absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-emerald-500 border-2 border-[#111b21] items-center justify-center">
                <i class="fa-solid fa-check text-white text-[9px]"></i>
            </div>
        </div>
    `;
}

// ------------------------------------------
// KİŞİLERİ YÜKLE
// ------------------------------------------
export async function loadContacts() {
    renderSkeletonList();

    const currentUser = getCurrentUser();
    if (!currentUser) return;

    let localPhoneNumbers = new Set();

    try {
        const ContactsPlugin = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Contacts)
            ? window.Capacitor.Plugins.Contacts
            : null;

        if (ContactsPlugin) {
            let perm = await ContactsPlugin.checkPermissions();
            if (perm.contacts !== 'granted') {
                perm = await ContactsPlugin.requestPermissions();
            }
            if (perm.contacts === 'granted') {
                const result = await ContactsPlugin.getContacts({ projection: { phones: true } });
                if (result && result.contacts) {
                    result.contacts.forEach(c => {
                        if (c.phones && Array.isArray(c.phones)) {
                            c.phones.forEach(p => {
                                if (p.number) {
                                    const last10 = getPhoneLast10(p.number);
                                    if (last10) {
                                        localPhoneNumbers.add(last10);
                                        localPhoneNumbers.add('+90' + last10);
                                    }
                                }
                            });
                        }
                    });
                }
            }
        }
    } catch (err) {
        console.warn("Rehber okunurken bir durum oluştu:", err);
    }

    contactList.innerHTML = '';

    const globalDiv = document.createElement('div');
    globalDiv.className = "contact-list-item flex items-center px-4 py-3 bg-[#202c33]/40 hover:bg-[#202c33] cursor-pointer transition border-b border-gray-800/30";
    globalDiv.innerHTML = `
        <div class="w-12 h-12 bg-gradient-to-tr from-emerald-600 to-cyan-600 rounded-full flex items-center text-white font-bold justify-center mr-3 shadow flex-shrink-0">
            <i class="fa-solid fa-globe"></i>
        </div>
        <div class="flex-1 overflow-hidden">
            <div class="flex justify-between items-baseline">
                <h4 class="text-white font-medium text-sm">Genel Kanka Odası 🌍</h4>
                <span class="text-[11px] text-gray-400 global-time"></span>
            </div>
            <p class="text-xs text-gray-400 truncate mt-0.5 global-preview">Ortak sohbet alanı</p>
        </div>
    `;
    globalDiv.addEventListener('click', () => {
        if (!chatSelectionMode) selectChat('global');
    });
    contactList.appendChild(globalDiv);

    const globalTimeSpan = globalDiv.querySelector('.global-time');
    const globalPreview = globalDiv.querySelector('.global-preview');

    onSnapshot(query(collection(db, "chats", "global", "messages"), orderBy("createdAt", "desc")), (msgSnap) => {
        if (!msgSnap.empty) {
            const lastMsg = msgSnap.docs[0].data();
            globalPreview.textContent = (lastMsg.type === 'image') ? '📷 Fotoğraf' : lastMsg.text;
            if (lastMsg.createdAt) {
                globalTimeSpan.textContent = formatTimestamp(lastMsg.createdAt.toDate());
            }
        }
    });

    const dynamicListContainer = document.createElement('div');
    contactList.appendChild(dynamicListContainer);

    let allUsersById = new Map();
    let myChats = new Map();
    let usersLoaded = false;
    let chatsLoaded = false;

    function renderAll() {
        if (!usersLoaded || !chatsLoaded) return;

        dynamicListContainer.innerHTML = '';
        contactElementsMap.clear();
        exitChatSelectionMode();

        // 1) Gerçek sohbet özetleri (mesajlaşılmış olanlar).
        myChats.forEach((chatData, chatId) => {
            if (chatData.archived) return;

            const clearedAt = chatData.clearedAt;
            const lastTimeMs = chatData.lastMessageTime ? chatData.lastMessageTime.toDate().getTime() : 0;
            const clearedAtMs = clearedAt ? clearedAt.toDate().getTime() : 0;
            if (clearedAt && lastTimeMs <= clearedAtMs) return;

            const liveUser = allUsersById.get(chatData.otherUid);
            const mergedChatData = {
                ...chatData,
                otherName: liveUser ? liveUser.name : chatData.otherName,
                otherAvatar: liveUser ? (liveUser.avatar || '') : chatData.otherAvatar
            };
            renderChatItem(chatId, mergedChatData);
        });

        // 2) Rehberde kayıtlı ama henüz mesajlaşılmamış kullanıcılar
        allUsersById.forEach((user, uid) => {
            if (uid === currentUser.uid) return;
            const chatId = getChatId(currentUser.uid, uid);
            if (myChats.has(chatId)) return;

            const targetPhoneLast10 = getPhoneLast10(user.phone);
            const isInContacts = targetPhoneLast10 && (localPhoneNumbers.has(targetPhoneLast10) || localPhoneNumbers.has('+90' + targetPhoneLast10));
            if (!isInContacts) return;

            renderEmptyContactItem(chatId, user);
        });

        sortContactList();
    }

    function renderChatItem(chatId, chatData) {
        const userDiv = document.createElement('div');
        userDiv.className = "contact-list-item flex items-center px-4 py-3 hover:bg-[#202c33]/60 cursor-pointer transition border-b border-gray-800/30";
        userDiv.dataset.chatId = chatId;

        const isLastMsgMine = chatData.lastSenderUid === currentUser.uid;
        const lastText = chatData.lastMessage || "Henüz mesaj yok";
        const lastTime = chatData.lastMessageTime ? formatTimestamp(chatData.lastMessageTime.toDate()) : '';
        const unreadCount = isLastMsgMine ? 0 : (chatData.unreadCount || 0);

        let tickHtml = '';
        if (isLastMsgMine) {
            const tickColor = chatData.lastMessageRead ? 'text-[#53bdeb]' : 'text-gray-400';
            tickHtml = `<span class="tick-container mr-1 flex-shrink-0"><i class="fa-solid fa-check-double text-[10px] ${tickColor}"></i></span>`;
        }

        const pinIconHtml = chatData.pinned ? `<i class="fa-solid fa-thumbtack text-[10px] text-amber-400 mr-1"></i>` : '';

        userDiv.innerHTML = `
            ${wrapAvatarWithSelectionBadge(chatId)}
            <div class="flex-1 overflow-hidden ml-3">
                <div class="flex justify-between items-baseline">
                    <h4 class="text-white font-medium text-sm">${pinIconHtml}${escapeHtml(chatData.otherName || '')}</h4>
                    <span class="text-[11px] text-gray-400">${lastTime}</span>
                </div>
                <div class="flex justify-between items-center mt-0.5">
                    <p class="text-xs text-gray-400 truncate msg-preview flex items-center">
                        ${tickHtml}
                        <span class="preview-text truncate">${isLastMsgMine ? 'Siz: ' : ''}${escapeHtml(lastText)}</span>
                    </p>
                    ${unreadCount > 0 ? `<div class="unread-badge bg-emerald-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center ml-2">${unreadCount}</div>` : ''}
                </div>
            </div>
        `;

        const avatarSlot = userDiv.querySelector(`[data-avatar-slot="${chatId}"]`);
        renderAvatarInto(avatarSlot, chatData.otherUid, chatData.otherAvatar, chatData.otherName, 'w-12 h-12');

        userDiv.addEventListener('click', () => {
            if (!chatSelectionMode) {
                selectChat({ uid: chatData.otherUid, name: chatData.otherName, avatar: chatData.otherAvatar || '' });
            }
        });

        attachChatSelectionHandlers(userDiv, chatId);
        contactElementsMap.set(chatId, {
            element: userDiv,
            lastTimeObj: chatData.lastMessageTime ? chatData.lastMessageTime.toDate() : null,
            pinned: !!chatData.pinned,
            hasChat: true
        });
        dynamicListContainer.appendChild(userDiv);
    }

    function renderEmptyContactItem(chatId, user) {
        const userDiv = document.createElement('div');
        userDiv.className = "contact-list-item flex items-center px-4 py-3 hover:bg-[#202c33]/60 cursor-pointer transition border-b border-gray-800/30";
        userDiv.dataset.chatId = chatId;

        userDiv.innerHTML = `
            ${wrapAvatarWithSelectionBadge(chatId)}
            <div class="flex-1 overflow-hidden ml-3">
                <div class="flex justify-between items-baseline">
                    <h4 class="text-white font-medium text-sm">${escapeHtml(user.name)}</h4>
                    <span class="text-[11px] text-gray-400"></span>
                </div>
                <div class="flex justify-between items-center mt-0.5">
                    <p class="text-xs text-gray-400 truncate msg-preview flex items-center">
                        <span class="preview-text truncate">Henüz mesaj yok</span>
                    </p>
                </div>
            </div>
        `;

        const avatarSlot = userDiv.querySelector(`[data-avatar-slot="${chatId}"]`);
        renderAvatarInto(avatarSlot, user.uid, user.avatar, user.name, 'w-12 h-12');

        userDiv.addEventListener('click', () => {
            if (!chatSelectionMode) {
                selectChat({ uid: user.uid, name: user.name, avatar: user.avatar || '' });
            }
        });

        attachChatSelectionHandlers(userDiv, chatId);
        contactElementsMap.set(chatId, { element: userDiv, lastTimeObj: null, pinned: false, hasChat: false });
        dynamicListContainer.appendChild(userDiv);
    }

    onSnapshot(collection(db, "users"), (snapshot) => {
        allUsersById.clear();
        snapshot.forEach((docSnap) => {
            let user = docSnap.data();
            if (!user || !user.name || !user.uid) return;
            user = formatAdminUser(user, ADMIN_EMAIL);
            allUsersById.set(user.uid, user);
        });
        usersLoaded = true;
        renderAll();
    });

    onSnapshot(query(collection(db, "users", currentUser.uid, "chats"), orderBy("updatedAt", "desc")), (snapshot) => {
        myChats.clear();
        snapshot.forEach((docSnap) => {
            myChats.set(docSnap.id, docSnap.data());
        });
        chatsLoaded = true;
        renderAll();
    });
}

function sortContactList() {
    const itemsArray = Array.from(contactElementsMap.values());
    itemsArray.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;

        if (!a.lastTimeObj) return 1;
        if (!b.lastTimeObj) return -1;
        return b.lastTimeObj - a.lastTimeObj;
    });
    const dynamicListContainer = contactList.children[1];
    if (dynamicListContainer) {
        itemsArray.forEach(item => dynamicListContainer.appendChild(item.element));
    }
}

// ------------------------------------------
// SOHBET LİSTESİ SEÇME MODU (silmek/sabitlemek/arşivlemek için)
// ------------------------------------------
function enterChatSelectionMode(firstChatId) {
    chatSelectionMode = true;
    selectedChatIds.clear();
    if (firstChatId) toggleChatSelectionInternal(firstChatId);
    updateChatSelectionUI();
    pushBackState(exitChatSelectionModeFromBack);
}

function exitChatSelectionModeFromBack() {
    chatSelectionMode = false;
    selectedChatIds.forEach((id) => {
        const item = contactElementsMap.get(id);
        if (item) setItemSelectedVisual(item.element, false);
    });
    selectedChatIds.clear();
    updateChatSelectionUI();
}

function exitChatSelectionMode() {
    if (!chatSelectionMode) return;
    exitChatSelectionModeFromBack();
    popBackState();
}

function setItemSelectedVisual(el, isSelected) {
    el.classList.toggle('bg-emerald-900/40', isSelected);
    const checkBadge = el.querySelector('.selection-check');
    if (checkBadge) {
        checkBadge.classList.toggle('hidden', !isSelected);
        checkBadge.classList.toggle('flex', isSelected);
    }
}

function toggleChatSelectionInternal(chatId) {
    if (selectedChatIds.has(chatId)) {
        selectedChatIds.delete(chatId);
    } else {
        selectedChatIds.add(chatId);
    }
    const item = contactElementsMap.get(chatId);
    if (item) setItemSelectedVisual(item.element, selectedChatIds.has(chatId));
}

function toggleChatSelection(chatId) {
    toggleChatSelectionInternal(chatId);
    if (selectedChatIds.size === 0) {
        exitChatSelectionMode();
    } else {
        updateChatSelectionUI();
    }
}

function updateChatSelectionUI() {
    if (!chatSelectionToolbar) return;
    if (chatSelectionMode) {
        chatSelectionToolbar.classList.remove('hidden');
        chatSelectionToolbar.classList.add('flex');
        if (chatSelectionCountEl) chatSelectionCountEl.textContent = `${selectedChatIds.size} seçildi`;
    } else {
        chatSelectionToolbar.classList.add('hidden');
        chatSelectionToolbar.classList.remove('flex');
    }
}

if (chatSelectionCancelBtn) {
    chatSelectionCancelBtn.addEventListener('click', () => exitChatSelectionMode());
}

if (chatSelectionDeleteBtn) {
    chatSelectionDeleteBtn.addEventListener('click', async () => {
        if (selectedChatIds.size === 0) return;

        const count = selectedChatIds.size;
        const proceed = confirm(`${count} sohbet kalıcı olarak silinsin mi?\n\n(Karşı taraf etkilenmez, ama bu hesapta eski mesajlar bir daha görünmez. Yeni mesaj gelirse sohbet tekrar listeye düşer, sadece yeni mesajla.)`);
        if (!proceed) return;

        chatSelectionDeleteBtn.disabled = true;

        try {
            for (const chatId of selectedChatIds) {
                await clearChatForMe(chatId);
                const item = contactElementsMap.get(chatId);
                if (item && item.element && item.element.parentNode) {
                    item.element.parentNode.removeChild(item.element);
                }
                contactElementsMap.delete(chatId);
            }
        } catch (err) {
            alert("Bazı sohbetler silinemedi: " + err.message);
        }

        chatSelectionDeleteBtn.disabled = false;
        selectedChatIds.clear();
        exitChatSelectionMode();
    });
}

if (chatSelectionPinBtn) {
    chatSelectionPinBtn.addEventListener('click', async () => {
        if (selectedChatIds.size === 0) return;

        const currentUser = getCurrentUser();
        if (!currentUser) return;

        const validIds = Array.from(selectedChatIds).filter((chatId) => {
            const item = contactElementsMap.get(chatId);
            return item && item.hasChat;
        });

        if (validIds.length === 0) {
            alert("Henüz mesajlaşılmamış bir sohbeti sabitleyemezsin kanka.");
            return;
        }

        chatSelectionPinBtn.disabled = true;
        try {
            for (const chatId of validIds) {
                const item = contactElementsMap.get(chatId);
                await updateDoc(doc(db, "users", currentUser.uid, "chats", chatId), {
                    pinned: !item.pinned
                });
            }
        } catch (err) {
            alert("Sabitleme işlemi başarısız: " + err.message);
        }
        chatSelectionPinBtn.disabled = false;
        exitChatSelectionMode();
    });
}

if (chatSelectionArchiveBtn) {
    chatSelectionArchiveBtn.addEventListener('click', async () => {
        if (selectedChatIds.size === 0) return;

        const currentUser = getCurrentUser();
        if (!currentUser) return;

        const validIds = Array.from(selectedChatIds).filter((chatId) => {
            const item = contactElementsMap.get(chatId);
            return item && item.hasChat;
        });

        if (validIds.length === 0) {
            alert("Henüz mesajlaşılmamış bir sohbeti arşivleyemezsin kanka.");
            return;
        }

        chatSelectionArchiveBtn.disabled = true;
        try {
            for (const chatId of validIds) {
                await updateDoc(doc(db, "users", currentUser.uid, "chats", chatId), {
                    archived: true,
                    pinned: false
                });
            }
        } catch (err) {
            alert("Arşivleme işlemi başarısız: " + err.message);
        }
        chatSelectionArchiveBtn.disabled = false;
        exitChatSelectionMode();
    });
}

function attachChatSelectionHandlers(el, chatId) {
    let pressTimer = null;
    let longPressTriggered = false;

    const startPress = () => {
        longPressTriggered = false;
        pressTimer = setTimeout(() => {
            longPressTriggered = true;
            if (!chatSelectionMode) {
                enterChatSelectionMode(chatId);
            } else {
                toggleChatSelection(chatId);
            }
            if (navigator.vibrate) navigator.vibrate(30);
        }, 450);
    };

    const cancelPress = () => {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    };

    el.addEventListener('pointerdown', startPress);
    el.addEventListener('pointerup', cancelPress);
    el.addEventListener('pointerleave', cancelPress);
    el.addEventListener('pointercancel', cancelPress);

    el.addEventListener('click', (e) => {
        if (longPressTriggered) {
            e.stopPropagation();
            longPressTriggered = false;
            return;
        }
        if (chatSelectionMode) {
            e.stopPropagation();
            toggleChatSelection(chatId);
        }
    }, true);
}

// ------------------------------------------
// ARAMA BARI
// ------------------------------------------
searchContact.addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase().trim();

    if (term.length > 0) {
        searchIcon.className = "fa-solid fa-arrow-left text-emerald-400 text-sm mr-2.5 ml-0.5 cursor-pointer hover:text-white transition flex-shrink-0";
    } else {
        searchIcon.className = "fa-solid fa-magnifying-glass text-gray-400 text-sm mr-2.5 ml-0.5 flex-shrink-0";
    }

    const items = contactList.querySelectorAll('.contact-list-item');
    items.forEach((item) => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(term) ? 'flex' : 'none';
    });
});

searchIcon.addEventListener('click', () => {
    if (searchContact.value.length > 0) {
        searchContact.value = '';
        searchContact.dispatchEvent(new Event('input'));
    }
});

// ------------------------------------------
// ADMİN PANEL
// ------------------------------------------
export function initAdminPanel() {
    const currentUser = getCurrentUser();
    if (!currentUser) return;

    if (currentUser.email && currentUser.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
        adminBtn.classList.remove('hidden');
    } else {
        adminBtn.classList.add('hidden');
    }
}

if (adminBtn) {
    adminBtn.addEventListener('click', async () => {
        const currentUser = getCurrentUser();

        adminUserList.innerHTML = `
            <div class="text-center py-8 text-gray-400">
                <i class="fa-solid fa-spinner fa-spin text-2xl mb-2 text-amber-400"></i>
                <p class="text-xs">Veritabanından tüm kullanıcılar çekiliyor...</p>
            </div>`;
        adminModal.classList.remove('hidden');
        pushBackState(closeAdminModal);

        try {
            const snapshot = await getDocs(collection(db, "users"));
            adminUserList.innerHTML = '';

            if (snapshot.empty) {
                adminUserList.innerHTML = `<p class="text-xs text-gray-400 text-center py-4">Kayıtlı kullanıcı bulunamadı.</p>`;
                return;
            }

            snapshot.forEach((docSnap) => {
                let user = docSnap.data();
                user = formatAdminUser(user, ADMIN_EMAIL);

                const isMe = currentUser && user.uid === currentUser.uid;

                const userDiv = document.createElement('div');
                userDiv.className = "flex items-center justify-between p-3 bg-[#202c33]/60 hover:bg-[#202c33] rounded-xl border border-gray-800 transition";

                const avatarSlotId = `admin-${user.uid}`;

                userDiv.innerHTML = `
                    <div class="flex items-center space-x-3 overflow-hidden">
                        <div data-avatar-slot="${avatarSlotId}" class="flex-shrink-0"></div>
                        <div class="overflow-hidden">
                            <h5 class="text-white text-sm font-medium truncate flex items-center gap-1.5">
                                ${escapeHtml(user.name || 'İsimsiz')}
                                ${isMe ? '<span class="text-[9px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded font-bold">SEN</span>' : ''}
                            </h5>
                            <p class="text-xs text-gray-400 truncate">${escapeHtml(user.email || '-')}</p>
                            <p class="text-[11px] text-emerald-400 font-mono">${escapeHtml(user.phone || '-')}</p>
                        </div>
                    </div>
                    ${!isMe ? `
                    <button class="btn-admin-chat bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-2 rounded-xl text-xs font-medium transition flex-shrink-0 ml-2 flex items-center space-x-1">
                        <i class="fa-solid fa-comment"></i>
                        <span>Sohbet Et</span>
                    </button>` : ''}
                `;

                const avatarSlot = userDiv.querySelector(`[data-avatar-slot="${avatarSlotId}"]`);
                renderAvatarInto(avatarSlot, user.uid, user.avatar, user.name, 'w-10 h-10');

                if (!isMe) {
                    const chatBtn = userDiv.querySelector('.btn-admin-chat');
                    chatBtn.addEventListener('click', () => {
                        closeAdminModal();
                        popBackState();
                        selectChat({ uid: user.uid, name: user.name, avatar: user.avatar || '' });
                    });
                }

                adminUserList.appendChild(userDiv);
            });
        } catch (err) {
            adminUserList.innerHTML = `<p class="text-xs text-rose-400 text-center py-4">Hata oluştu: ${err.message}</p>`;
        }
    });
}

function closeAdminModal() {
    if (!adminModal) return;
    adminModal.classList.add('hidden');
}

if (adminModalClose) {
    adminModalClose.addEventListener('click', () => {
        closeAdminModal();
        popBackState();
    });
}