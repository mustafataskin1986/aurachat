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
import { pushBackState, popBackState } from "./back-handler.js";

// DOM elementleri
const messageContainer = document.getElementById('message-container');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const attachBtn = document.getElementById('attach-btn');
const imageInput = document.getElementById('image-input');
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
        pushBackState(doCloseChatView);
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

// Sohbet görünümünü kapatır (sadece arayüz - history'ye dokunmaz).
// Hem hardware geri tuşundan hem "geri" butonundan çağrılır.
function doCloseChatView() {
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
}

// Mobilde "geri" butonu (UI üzerinden kapatma - history'yi de senkron tutar)
backBtn.addEventListener('click', () => {
    doCloseChatView();
    popBackState();
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
    const isImage = msg.type === 'image' && msg.imageUrl;

    const bodyHtml = isImage
        ? `<img src="${msg.imageUrl}" class="rounded-lg max-w-full max-h-72 object-cover cursor-pointer" onclick="openImageLightbox(this.src)">`
        : `<p class="break-words">${escapeHtml(msg.text)}</p>`;

    if (isMine) {
        const tickColor = msg.read ? 'text-[#53bdeb]' : 'text-gray-400';
        msgDiv.className = "flex justify-end";
        msgDiv.innerHTML = `
            <div class="bg-[#005c4b] text-white ${isImage ? 'p-1' : 'px-4 py-2'} rounded-xl max-w-[80%] md:max-w-md text-sm shadow relative">
                ${bodyHtml}
                <div class="flex items-center justify-end space-x-1 mt-1 ${isImage ? 'px-2 pb-1' : ''}">
                    <span class="text-[10px] text-emerald-200">${timeStr}</span>
                    <i class="fa-solid fa-check-double text-[10px] ${tickColor}"></i>
                </div>
            </div>
        `;
    } else {
        msgDiv.className = "flex justify-start";
        msgDiv.innerHTML = `
            <div class="bg-[#202c33] text-gray-100 ${isImage ? 'p-1' : 'px-4 py-2'} rounded-xl max-w-[80%] md:max-w-md text-sm shadow relative">
                ${currentChatId === 'global' ? `<span class="text-[11px] font-bold text-amber-400 block mb-0.5 ${isImage ? 'px-2 pt-1' : ''}">${escapeHtml(msg.senderName)}</span>` : ''}
                ${bodyHtml}
                <span class="text-[10px] text-gray-400 ${isImage ? 'block text-right px-2 pb-1' : 'float-right ml-3 mt-1'}">${timeStr}</span>
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

// Resme tıklayınca sayfa içi büyütme (data: URI'lerde window.open engellendiği için)
window.openImageLightbox = function (src) {
    const lightbox = document.getElementById('image-lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    if (!lightbox || !lightboxImg) return;
    lightboxImg.src = src;
    lightbox.classList.remove('hidden');
    lightbox.classList.add('flex');
    pushBackState(doCloseLightbox);
};

function doCloseLightbox() {
    const lightbox = document.getElementById('image-lightbox');
    if (!lightbox) return;
    lightbox.classList.add('hidden');
    lightbox.classList.remove('flex');
}

// Dışına tıklayınca kapatma (UI üzerinden - history'yi de senkron tutar)
window.closeImageLightboxUI = function () {
    doCloseLightbox();
    popBackState();
};

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

// ------------------------------------------
// GÖRSEL GÖNDERME
// Storage kullanmadan, avatar ile aynı yöntemle base64 olarak
// doğrudan Firestore mesaj dokümanına gömülür.
// Hedef: ~200-300KB - önce boyutu küçültür, olmazsa kaliteyi düşürür,
// yine olmazsa boyutu daha da küçültüp tekrar dener.
// ------------------------------------------
function compressImageToDataUrl(file, targetBytes = 300 * 1024) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const dimensionSteps = [900, 700, 500];
                const qualitySteps = [0.7, 0.55, 0.4, 0.3];
                let bestResult = null;

                outer:
                for (const maxDim of dimensionSteps) {
                    let { width, height } = img;
                    if (width > maxDim || height > maxDim) {
                        if (width > height) {
                            height = Math.round(height * (maxDim / width));
                            width = maxDim;
                        } else {
                            width = Math.round(width * (maxDim / height));
                            height = maxDim;
                        }
                    } else if (maxDim !== dimensionSteps[0]) {
                        // Görsel zaten bu boyuttan küçük, daha fazla küçültmenin anlamı yok
                        break;
                    }

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);

                    for (const q of qualitySteps) {
                        const dataUrl = canvas.toDataURL('image/jpeg', q);
                        bestResult = dataUrl; // elimizdeki en küçük denemeyi sakla
                        const approxBytes = dataUrl.length * 0.75; // base64 -> yaklaşık byte
                        if (approxBytes <= targetBytes) {
                            resolve(dataUrl);
                            break outer;
                        }
                    }
                }

                if (bestResult) resolve(bestResult);
                else reject(new Error('Görsel sıkıştırılamadı'));
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

if (attachBtn && imageInput) {
    attachBtn.addEventListener('click', () => imageInput.click());

    imageInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file || !currentUser || !currentChatId) return;
        imageInput.value = ''; // aynı dosyayı tekrar seçebilmek için sıfırla

        if (!file.type.startsWith('image/')) {
            alert("Lütfen bir görsel dosyası seç kanka!");
            return;
        }

        attachBtn.classList.add('opacity-40', 'pointer-events-none');
        const originalIcon = attachBtn.className;
        attachBtn.className = attachBtn.className.replace('fa-plus', 'fa-spinner fa-spin');

        try {
            const dataUrl = await compressImageToDataUrl(file);

            // Firestore doküman limiti 1MB - güvenli pay bırak
            if (dataUrl.length * 0.75 > 900 * 1024) {
                alert("Bu görsel çok büyük kanka, daha düşük çözünürlüklü bir fotoğraf dene.");
                return;
            }

            await addDoc(collection(db, "chats", currentChatId, "messages"), {
                type: 'image',
                imageUrl: dataUrl,
                text: '',
                senderUid: currentUser.uid,
                senderName: currentUser.name,
                senderAvatar: currentUser.avatar || '',
                createdAt: serverTimestamp(),
                read: false
            });

            scrollToBottom();
        } catch (err) {
            console.error("Görsel gönderilemedi:", err);
            alert("Görsel gönderilirken hata oluştu!");
        } finally {
            attachBtn.className = originalIcon;
            attachBtn.classList.remove('opacity-40', 'pointer-events-none');
        }
    });
}
