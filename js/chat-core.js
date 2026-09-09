// ==========================================
// CHAT CORE
// Mesajlaşma mantığının tamamı burada.
// chatId artık İSİM değil UID bazlı üretiliyor (getChatId).
// contacts.js, kişi listesinden bir kullanıcıya tıklanınca
// selectChat({ uid, name, avatar }) çağıracak.
// ==========================================

import { db } from "./firebase-init.js";
import {
    collection, addDoc, onSnapshot, query, orderBy,
    serverTimestamp, doc, setDoc, updateDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getChatId, getUserColor, getInitials, escapeHtml } from "./ui-helpers.js";

// DOM elementleri
const messageContainer = document.getElementById('message-container');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const sidebar = document.getElementById('sidebar');
const chatArea = document.getElementById('chat-area');
const backBtn = document.getElementById('back-btn');
const activeChatName = document.getElementById('active-chat-name');
const activeChatAvatar = document.getElementById('active-chat-avatar');
const activeChatStatus = document.getElementById('active-chat-status');

// Modül durumu
let currentUser = null;       // { uid, name, email, phone, avatar }
let currentChatId = null;
let currentChatName = '';
let currentOtherUid = null;   // 'global' sohbetinde null
let unsubscribeMessages = null;
let unsubscribeChatDoc = null;
let typingTimeout = null;

// index.html / giris sonrası bir kere çağrılır
export function setCurrentUser(user) {
    currentUser = user;
}

export function getCurrentChatId() {
    return currentChatId;
}

export function getCurrentUser() {
    return currentUser;
}

// ------------------------------------------
// SOHBET SEÇİMİ
// otherUser: 'global' ya da { uid, name, avatar }
// ------------------------------------------
export function selectChat(otherUser) {
    if (unsubscribeChatDoc) { unsubscribeChatDoc(); unsubscribeChatDoc = null; }

    if (otherUser === 'global') {
        currentChatId = 'global';
        currentChatName = 'Genel Kanka Odası 🌍';
        currentOtherUid = null;

        activeChatName.textContent = currentChatName;
        activeChatAvatar.style.backgroundColor = '';
        activeChatAvatar.className = "w-10 h-10 bg-gradient-to-tr from-emerald-600 to-cyan-600 rounded-full flex items-center text-white font-bold justify-center shadow flex-shrink-0";
        activeChatAvatar.innerHTML = `<i class="fa-solid fa-globe text-sm"></i>`;
        activeChatStatus.textContent = "Herkes çevrimiçi";
    } else {
        if (!currentUser || !currentUser.uid) {
            console.warn("selectChat: currentUser.uid yok, önce setCurrentUser çağrılmalı");
            return;
        }
        currentOtherUid = otherUser.uid;
        currentChatId = getChatId(currentUser.uid, otherUser.uid);
        currentChatName = otherUser.name;

        activeChatName.textContent = currentChatName;

        if (otherUser.avatar && otherUser.avatar.startsWith('data:image')) {
            activeChatAvatar.style.backgroundColor = '';
            activeChatAvatar.className = "w-10 h-10 rounded-full overflow-hidden shadow flex-shrink-0";
            activeChatAvatar.innerHTML = `<img src="${otherUser.avatar}" class="w-full h-full object-cover">`;
        } else {
            const initials = getInitials(otherUser.name);
            const color = getUserColor(otherUser.name);
            activeChatAvatar.style.backgroundColor = color;
            activeChatAvatar.className = "w-10 h-10 rounded-full flex items-center text-white font-bold justify-center shadow flex-shrink-0 text-sm";
            activeChatAvatar.innerHTML = `<span>${initials}</span>`;
        }

        listenToChatDoc(currentChatId, currentOtherUid);
    }

    // Mobilde sohbet ekranına geç
    if (window.innerWidth < 768) {
        sidebar.classList.add('-translate-x-full');
        chatArea.classList.remove('translate-x-full');
    }

    loadMessages(currentChatId);
}

// "yazıyor..." durumunu dinler (uid bazlı alan adıyla)
function listenToChatDoc(chatId, otherUid) {
    activeChatStatus.textContent = "";

    unsubscribeChatDoc = onSnapshot(doc(db, "chats", chatId), (docSnap) => {
        if (docSnap.exists()) {
            const data = docSnap.data();
            const isOtherTyping = otherUid && data[`typing_${otherUid}`];

            if (isOtherTyping) {
                activeChatStatus.innerHTML = `<span class="text-emerald-400 font-medium animate-pulse">yazıyor...</span>`;
            } else {
                activeChatStatus.textContent = "";
            }
        }
    });
}

// Mobilde geri tuşu
backBtn.addEventListener('click', () => {
    if (unsubscribeMessages) { unsubscribeMessages(); unsubscribeMessages = null; }
    if (unsubscribeChatDoc) { unsubscribeChatDoc(); unsubscribeChatDoc = null; }

    currentChatId = null;
    currentChatName = '';
    currentOtherUid = null;
    messageContainer.innerHTML = '';

    if (window.innerWidth < 768) {
        sidebar.classList.remove('-translate-x-full');
        chatArea.classList.add('translate-x-full');
    }
});

// ------------------------------------------
// MESAJ YÜKLEME / DİNLEME
// ------------------------------------------
function loadMessages(chatId) {
    if (unsubscribeMessages) unsubscribeMessages();

    const q = query(collection(db, "chats", chatId, "messages"), orderBy("createdAt", "asc"));

    unsubscribeMessages = onSnapshot(q, (snapshot) => {
        messageContainer.innerHTML = '';
        snapshot.forEach((docSnap) => {
            const msg = docSnap.data();

            const isMine = currentUser && msg.senderUid
                ? msg.senderUid === currentUser.uid
                : (currentUser && msg.senderName === currentUser.name); // eski mesajlarla geriye dönük uyumluluk

            if (currentChatId === chatId && chatId !== 'global' && !isMine && msg.read === false) {
                updateDoc(doc(db, "chats", chatId, "messages", docSnap.id), { read: true });
            }

            renderMessage(msg, isMine);
        });
        scrollToBottom();
    }, (error) => {
        console.error("Mesajlar yüklenirken hata:", error);
    });
}

function renderMessage(msg, isMine) {
    const msgDiv = document.createElement('div');
    const timeStr = msg.createdAt ? new Date(msg.createdAt.toDate()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Şimdi';

    if (isMine) {
        const tickColor = msg.read ? 'text-[#53bdeb]' : 'text-gray-400';
        msgDiv.className = "flex justify-end";
        msgDiv.innerHTML = `
            <div class="bg-[#005c4b] text-white px-4 py-2 rounded-xl max-w-[80%] md:max-w-md text-sm shadow relative">
                <p class="break-words">${escapeHtml(msg.text)}</p>
                <div class="flex items-center justify-end space-x-1 mt-1">
                    <span class="text-[10px] text-emerald-200">${timeStr}</span>
                    <i class="fa-solid fa-check-double text-[10px] ${tickColor}"></i>
                </div>
            </div>
        `;
    } else {
        msgDiv.className = "flex justify-start";
        msgDiv.innerHTML = `
            <div class="bg-[#202c33] text-gray-100 px-4 py-2 rounded-xl max-w-[80%] md:max-w-md text-sm shadow relative">
                ${currentChatId === 'global' ? `<span class="text-[11px] font-bold text-amber-400 block mb-0.5">${escapeHtml(msg.senderName)}</span>` : ''}
                <p class="break-words">${escapeHtml(msg.text)}</p>
                <span class="text-[10px] text-gray-400 float-right ml-3 mt-1">${timeStr}</span>
            </div>
        `;
    }
    messageContainer.appendChild(msgDiv);
}

function scrollToBottom() {
    setTimeout(() => {
        messageContainer.scrollTop = messageContainer.scrollHeight;
    }, 50);
}

// ------------------------------------------
// MESAJ GÖNDERME
// ------------------------------------------
async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !currentUser || !currentChatId) return;

    try {
        if (currentChatId !== 'global') {
            await setDoc(doc(db, "chats", currentChatId), {
                [`typing_${currentUser.uid}`]: false
            }, { merge: true });
        }

        messageInput.value = '';

        await addDoc(collection(db, "chats", currentChatId, "messages"), {
            text: text,
            senderUid: currentUser.uid,
            senderName: currentUser.name,
            senderAvatar: currentUser.avatar || '',
            createdAt: serverTimestamp(),
            read: false
        });

        scrollToBottom();
    } catch (e) {
        console.error("Mesaj gönderilemedi: ", e);
        alert("Mesaj gönderilirken hata oluştu!");
    }
}

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
    }
});

// "Yazıyor..." bildirimi (uid bazlı)
messageInput.addEventListener('input', () => {
    if (!currentChatId || currentChatId === 'global' || !currentUser) return;

    setDoc(doc(db, "chats", currentChatId), {
        [`typing_${currentUser.uid}`]: true
    }, { merge: true });

    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        if (currentChatId && currentChatId !== 'global') {
            setDoc(doc(db, "chats", currentChatId), {
                [`typing_${currentUser.uid}`]: false
            }, { merge: true });
        }
    }, 2000);
});
