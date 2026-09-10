// ==========================================
// KİŞİ LİSTESİ + ADMİN PANEL
// Kullanıcıları Firestore'dan çeker, sohbet önizlemelerini
// canlı günceller, tıklanınca chat-core.js'deki selectChat()'i çağırır.
// ==========================================

import { db, ADMIN_EMAIL } from "./firebase-init.js";
import {
    collection, onSnapshot, query, orderBy, doc, getDocs
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getUserColor, getInitials, formatAdminUser, formatTimestamp, getPhoneLast10, escapeHtml, getChatId } from "./ui-helpers.js";
import { selectChat, getCurrentUser } from "./chat-core.js";
import { pushBackState, popBackState } from "./back-handler.js";

const contactList = document.getElementById('contact-list');
const searchContact = document.getElementById('search-contact');
const searchIcon = document.getElementById('search-icon');

const adminBtn = document.getElementById('admin-btn');
const adminModal = document.getElementById('admin-modal');
const adminModalClose = document.getElementById('admin-modal-close');
const adminUserList = document.getElementById('admin-user-list');

const contactElementsMap = new Map();

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

// ------------------------------------------
// KİŞİLERİ YÜKLE (rehber + Firestore users)
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

    onSnapshot(collection(db, "users"), (snapshot) => {
        contactList.innerHTML = '';
        contactElementsMap.clear();

        // Genel Oda Elementi
        const globalDiv = document.createElement('div');
        globalDiv.className = "flex items-center px-4 py-3 bg-[#202c33]/40 hover:bg-[#202c33] cursor-pointer transition border-b border-gray-800/30";
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
        globalDiv.addEventListener('click', () => selectChat('global'));
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

        const myPhoneLast10 = getPhoneLast10(currentUser.phone);

        snapshot.forEach((docSnap) => {
            let user = docSnap.data();
            if (!user || !user.name || !user.uid) return;

            user = formatAdminUser(user, ADMIN_EMAIL);

            // Kendimi listeleme
            if (user.uid === currentUser.uid) return;

            const targetPhoneLast10 = getPhoneLast10(user.phone);
            const chatId = getChatId(currentUser.uid, user.uid);
            const isInContacts = targetPhoneLast10 && (localPhoneNumbers.has(targetPhoneLast10) || localPhoneNumbers.has('+90' + targetPhoneLast10));

            onSnapshot(query(collection(db, "chats", chatId, "messages"), orderBy("createdAt", "desc")), (msgSnapshot) => {
                const hasMessages = !msgSnapshot.empty;

                if (!isInContacts && !hasMessages) {
                    if (contactElementsMap.has(chatId)) {
                        const item = contactElementsMap.get(chatId);
                        if (item.element && item.element.parentNode) {
                            item.element.parentNode.removeChild(item.element);
                        }
                        contactElementsMap.delete(chatId);
                    }
                    return;
                }

                if (!contactElementsMap.has(chatId)) {
                    const userDiv = document.createElement('div');
                    userDiv.className = "flex items-center px-4 py-3 hover:bg-[#202c33]/60 cursor-pointer transition border-b border-gray-800/30";

                    let avatarContent = '';
                    if (user.avatar) {
                        avatarContent = `<img src="${user.avatar}" class="w-12 h-12 rounded-full object-cover shadow flex-shrink-0">`;
                    } else {
                        const initials = getInitials(user.name);
                        const color = getUserColor(user.name);
                        avatarContent = `<div class="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-sm shadow flex-shrink-0" style="background-color: ${color};">${initials}</div>`;
                    }

                    userDiv.innerHTML = `
                        ${avatarContent}
                        <div class="flex-1 overflow-hidden ml-3">
                            <div class="flex justify-between items-baseline">
                                <h4 class="text-white font-medium text-sm">${escapeHtml(user.name)}</h4>
                                <span class="text-[11px] text-gray-400 time-span"></span>
                            </div>
                            <div class="flex justify-between items-center mt-0.5">
                                <p class="text-xs text-gray-400 truncate msg-preview flex items-center">
                                    <span class="tick-container hidden mr-1 flex-shrink-0"></span>
                                    <span class="preview-text truncate">Henüz mesaj yok</span>
                                </p>
                                <div class="unread-badge hidden bg-emerald-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center ml-2"></div>
                            </div>
                        </div>
                    `;

                    userDiv.addEventListener('click', () => {
                        selectChat({ uid: user.uid, name: user.name, avatar: user.avatar || '' });
                    });

                    contactElementsMap.set(chatId, { element: userDiv, lastTimeObj: null });
                    contactList.appendChild(userDiv);
                }

                const itemData = contactElementsMap.get(chatId);
                if (!itemData) return;

                const timeSpan = itemData.element.querySelector('.time-span');
                const previewText = itemData.element.querySelector('.preview-text');
                const tickContainer = itemData.element.querySelector('.tick-container');
                const unreadBadge = itemData.element.querySelector('.unread-badge');

                let lastText = "Henüz mesaj yok";
                let lastTime = "";
                let lastTimeObj = null;
                let unreadCount = 0;
                let isLastMsgMine = false;
                let lastMsgRead = false;

                if (hasMessages) {
                    const latestMsg = msgSnapshot.docs[0].data();
                    lastText = (latestMsg.type === 'image') ? '📷 Fotoğraf' : latestMsg.text;
                    isLastMsgMine = latestMsg.senderUid
                        ? latestMsg.senderUid === currentUser.uid
                        : latestMsg.senderName === currentUser.name;
                    lastMsgRead = latestMsg.read;
                    if (latestMsg.createdAt) {
                        lastTimeObj = latestMsg.createdAt.toDate();
                        lastTime = formatTimestamp(lastTimeObj);
                    }
                }

                msgSnapshot.forEach((mDoc) => {
                    const mData = mDoc.data();
                    const isMine = mData.senderUid ? mData.senderUid === currentUser.uid : mData.senderName === currentUser.name;
                    if (!isMine && mData.read === false) {
                        unreadCount++;
                    }
                });

                previewText.textContent = isLastMsgMine ? `Siz: ${lastText}` : lastText;
                timeSpan.textContent = lastTime;

                if (isLastMsgMine) {
                    const tickColor = lastMsgRead ? 'text-[#53bdeb]' : 'text-gray-400';
                    tickContainer.innerHTML = `<i class="fa-solid fa-check-double text-[10px] ${tickColor}"></i>`;
                    tickContainer.classList.remove('hidden');
                } else {
                    tickContainer.classList.add('hidden');
                }

                if (unreadCount > 0) {
                    unreadBadge.textContent = unreadCount;
                    unreadBadge.classList.remove('hidden');
                } else {
                    unreadBadge.classList.add('hidden');
                }

                itemData.lastTimeObj = lastTimeObj;
                sortContactList();
            });
        });
    });
}

function sortContactList() {
    const itemsArray = Array.from(contactElementsMap.values());
    itemsArray.sort((a, b) => {
        if (!a.lastTimeObj) return 1;
        if (!b.lastTimeObj) return -1;
        return b.lastTimeObj - a.lastTimeObj;
    });
    itemsArray.forEach(item => contactList.appendChild(item.element));
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

    const items = contactList.children;
    for (let item of items) {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(term) ? 'flex' : 'none';
    }
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

                let avatarHtml = '';
                if (user.avatar) {
                    avatarHtml = `<img src="${user.avatar}" class="w-10 h-10 rounded-full object-cover shadow flex-shrink-0">`;
                } else {
                    const initials = getInitials(user.name);
                    const color = getUserColor(user.name);
                    avatarHtml = `<div class="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-xs shadow flex-shrink-0" style="background-color: ${color};">${initials}</div>`;
                }

                userDiv.innerHTML = `
                    <div class="flex items-center space-x-3 overflow-hidden">
                        ${avatarHtml}
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
