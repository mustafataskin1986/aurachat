// ==========================================
// CHAT CORE
// Mesajlaşma mantığının tamamı burada.
// chatId artık İSİM değil UID bazlı üretiliyor (getChatId).
// contacts.js, kişi listesinden bir kullanıcıya tıklanınca
// selectChat({ uid, name, avatar }) çağıracak.
//
// PERFORMANS GÜNCELLEMESİ: Artık her mesajda, gönderen ve alıcının
// users/{uid}/chats/{chatId} altında bir "özet" dokümanı güncelleniyor
// (son mesaj, zaman, okundu durumu, okunmamış sayısı). contacts.js bu
// sayede kullanıcı başına ayrı onSnapshot açmak yerine tek bir
// koleksiyonu dinleyebiliyor.
// ==========================================

import { db } from "./firebase-init.js";
import {
    collection, addDoc, onSnapshot, query, orderBy, limitToLast,
    serverTimestamp, doc, setDoc, updateDoc, deleteDoc, arrayUnion, getDoc, increment
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getChatId, getUserColor, getInitials, escapeHtml } from "./ui-helpers.js";
import { pushBackState, popBackState } from "./back-handler.js";
import { watchCallForChat } from "./video-call.js";

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
const selectionToolbar = document.getElementById('selection-toolbar');
const selectionCancelBtn = document.getElementById('selection-cancel-btn');
const selectionCountEl = document.getElementById('selection-count');
const selectionDeleteBtn = document.getElementById('selection-delete-btn');

// Modül durumu
let currentUser = null;       // { uid, name, email, phone, avatar }
let currentChatId = null;
let currentChatName = '';
let currentOtherUid = null;   // 'global' sohbetinde null
let currentOtherAvatar = '';  // 'global' sohbetinde ''
let unsubscribeMessages = null;
let unsubscribeChatDoc = null;
let typingTimeout = null;

// Mesaj seçme (silme) modu
let selectionMode = false;
const selectedMessageIds = new Set();
const messageElementsById = new Map();

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
// BİLDİRİM GÖNDERME YARDIMCI FONKSİYONU
// ------------------------------------------
async function sendPushToUser(receiverUid, title, body) {
    if (!receiverUid) {
        console.warn("⚠️ sendPushToUser: receiverUid eksik.");
        return;
    }
    try {
        const userDoc = await getDoc(doc(db, "users", receiverUid));
        if (!userDoc.exists()) {
            console.warn(`⚠️ sendPushToUser: '${receiverUid}' ID'li kullanıcı dokümanı bulunamadı.`);
            return;
        }

        const userData = userDoc.data();
        const receiverToken = userData?.fcmToken || userData?.fcm_token || userData?.pushToken;

        if (!receiverToken) {
            console.warn("⚠️ sendPushToUser: Alıcının veritabanında fcmToken bilgisi yok.");
            return;
        }

        const response = await fetch('https://aurachat-amber.vercel.app/api/send-notification', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                token: receiverToken,
                title: title,
                body: body,
                platform: userData?.platform || ''
            })
        });

        const textResponse = await response.text();
        let resData;
        try {
            resData = JSON.parse(textResponse);
        } catch (e) {
            console.error("❌ Vercel backend JSON yerine metin/HTML döndürdü:", textResponse);
            return;
        }

        if (response.ok && resData.success) {
            console.log("🚀 Bildirim başarıyla fırlatıldı! Yanıt:", resData);
        } else {
            console.error("❌ Bildirim API hatası:", resData);
        }
    } catch (err) {
        console.error("❌ Bildirim fırlatma hatası:", err);
    }
}

// ------------------------------------------
// ÖZET DOKÜMANI (users/{uid}/chats/{chatId}) GÜNCELLEME
// Hem gönderenin hem alıcının özet kaydını günceller.
// contacts.js kişi listesini bu koleksiyondan okuyor.
// ------------------------------------------
async function updateChatSummaries(lastMessageText) {
    if (currentChatId === 'global' || !currentOtherUid || !currentUser) return;

    try {
        const myChatRef = doc(db, "users", currentUser.uid, "chats", currentChatId);
        const otherChatRef = doc(db, "users", currentOtherUid, "chats", currentChatId);

        await setDoc(myChatRef, {
            otherUid: currentOtherUid,
            otherName: currentChatName,
            otherAvatar: currentOtherAvatar || '',
            lastMessage: lastMessageText,
            lastMessageTime: serverTimestamp(),
            lastSenderUid: currentUser.uid,
            lastMessageRead: false,
            unreadCount: 0,
            updatedAt: serverTimestamp()
        }, { merge: true });

        await setDoc(otherChatRef, {
            otherUid: currentUser.uid,
            otherName: currentUser.name,
            otherAvatar: currentUser.avatar || '',
            lastMessage: lastMessageText,
            lastMessageTime: serverTimestamp(),
            lastSenderUid: currentUser.uid,
            lastMessageRead: false,
            unreadCount: increment(1),
            updatedAt: serverTimestamp()
        }, { merge: true });
    } catch (err) {
        console.error("Özet dokümanları güncellenemedi:", err);
    }
}

// ------------------------------------------
// SOHBET SEÇİMİ
// otherUser: 'global' ya da { uid, name, avatar }
// ------------------------------------------
export function selectChat(otherUser) {
    if (unsubscribeChatDoc) { unsubscribeChatDoc(); unsubscribeChatDoc = null; }
    exitSelectionMode();

    if (otherUser === 'global') {
        currentChatId = 'global';
        currentChatName = 'Genel Kanka Odası 🌍';
        currentOtherUid = null;
        currentOtherAvatar = '';

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
        currentOtherUid = otherUser.uid || otherUser.id;
        currentOtherAvatar = otherUser.avatar || '';
        currentChatId = getChatId(currentUser.uid, currentOtherUid);
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
    watchCallForChat(currentChatId);
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
function doCloseChatView() {
    if (unsubscribeMessages) { unsubscribeMessages(); unsubscribeMessages = null; }
    if (unsubscribeChatDoc) { unsubscribeChatDoc(); unsubscribeChatDoc = null; }

    currentChatId = null;
    currentChatName = '';
    currentOtherUid = null;
    currentOtherAvatar = '';
    messageContainer.innerHTML = '';
    exitSelectionMode();

    if (window.innerWidth < 768) {
        sidebar.classList.remove('-translate-x-full');
        chatArea.classList.add('translate-x-full');
    }
}

// Mobilde "geri" butonu
backBtn.addEventListener('click', () => {
    doCloseChatView();
    popBackState();
});

// ------------------------------------------
// MESAJ SEÇME MODU (silmek için)
// ------------------------------------------
function enterSelectionMode(firstMsgId) {
    selectionMode = true;
    selectedMessageIds.clear();
    if (firstMsgId) toggleMessageSelectionInternal(firstMsgId);
    updateSelectionUI();
    pushBackState(exitSelectionModeFromBack);
}

function exitSelectionModeFromBack() {
    selectionMode = false;
    selectedMessageIds.clear();
    messageElementsById.forEach((el) => el.classList.remove('bg-emerald-900/40'));
    updateSelectionUI();
}

function exitSelectionMode() {
    if (!selectionMode) return;
    exitSelectionModeFromBack();
    popBackState();
}

function toggleMessageSelectionInternal(msgId) {
    if (selectedMessageIds.has(msgId)) {
        selectedMessageIds.delete(msgId);
    } else {
        selectedMessageIds.add(msgId);
    }
    const el = messageElementsById.get(msgId);
    if (el) el.classList.toggle('bg-emerald-900/40', selectedMessageIds.has(msgId));
}

function toggleMessageSelection(msgId) {
    toggleMessageSelectionInternal(msgId);
    if (selectedMessageIds.size === 0) {
        exitSelectionMode();
    } else {
        updateSelectionUI();
    }
}

function updateSelectionUI() {
    if (!selectionToolbar) return;
    if (selectionMode) {
        selectionToolbar.classList.remove('hidden');
        selectionToolbar.classList.add('flex');
        if (selectionCountEl) selectionCountEl.textContent = `${selectedMessageIds.size} seçildi`;
    } else {
        selectionToolbar.classList.add('hidden');
        selectionToolbar.classList.remove('flex');
    }
}

if (selectionCancelBtn) {
    selectionCancelBtn.addEventListener('click', () => exitSelectionMode());
}

if (selectionDeleteBtn) {
    selectionDeleteBtn.addEventListener('click', async () => {
        if (selectedMessageIds.size === 0 || !currentChatId || !currentUser) return;

        const ids = Array.from(selectedMessageIds);
        const allMine = ids.every((id) => {
            const el = messageElementsById.get(id);
            return el && el.dataset.mine === 'true';
        });

        let deleteForEveryone = false;

        if (allMine) {
            deleteForEveryone = confirm(
                `${ids.length} mesajı herkesten mi silmek istiyorsun?\n\nTamam = Herkesten Sil\nİptal = Sadece Kendimden Sil`
            );
        } else {
            const proceed = confirm(`${ids.length} mesaj sohbetinden (sadece senden) silinsin mi?`);
            if (!proceed) return;
        }

        try {
            for (const id of ids) {
                const el = messageElementsById.get(id);
                const isMine = el && el.dataset.mine === 'true';

                if (deleteForEveryone && isMine) {
                    await deleteDoc(doc(db, "chats", currentChatId, "messages", id));
                } else {
                    await updateDoc(doc(db, "chats", currentChatId, "messages", id), {
                        deletedFor: arrayUnion(currentUser.uid)
                    });
                }
            }
        } catch (err) {
            alert("Mesajlar silinemedi: " + err.message);
        }

        exitSelectionMode();
    });
}

// ------------------------------------------
// MESAJ YÜKLEME / DİNLEME
// ------------------------------------------
function loadMessages(chatId) {
    if (unsubscribeMessages) unsubscribeMessages();

    messageContainer.innerHTML = `
        <div class="flex items-center justify-center h-full">
            <i class="fa-solid fa-spinner fa-spin text-2xl text-gray-600"></i>
        </div>
    `;

    const q = query(collection(db, "chats", chatId, "messages"), orderBy("createdAt", "asc"), limitToLast(50));

    unsubscribeMessages = onSnapshot(q, (snapshot) => {
        messageContainer.innerHTML = '';
        messageElementsById.clear();

        let markedAnyRead = false;
        const isAppVisible = document.visibilityState === 'visible';

        snapshot.forEach((docSnap) => {
            const msg = docSnap.data();

            if (currentUser && Array.isArray(msg.deletedFor) && msg.deletedFor.includes(currentUser.uid)) {
                return;
            }

            const isMine = !!(currentUser && currentUser.uid && msg.senderUid && msg.senderUid === currentUser.uid);

            if (currentUser && currentUser.uid && currentChatId === chatId && chatId !== 'global' && !isMine && msg.read === false && isAppVisible) {
                updateDoc(doc(db, "chats", chatId, "messages", docSnap.id), { read: true });
                markedAnyRead = true;
            }

            renderMessage(msg, isMine, docSnap.id);
        });

        // Bu sohbeti gerçekten okuduysak (en az bir mesaj okundu işaretlendiyse),
        // özet dokümanlarını da güncelle: benim okunmamış sayım sıfırlansın,
        // karşı tarafın "okundu" çift tiki görünsün.
        if (markedAnyRead && currentUser && chatId !== 'global' && currentOtherUid) {
            updateDoc(doc(db, "users", currentUser.uid, "chats", chatId), {
                unreadCount: 0
            }).catch(() => {});
            updateDoc(doc(db, "users", currentOtherUid, "chats", chatId), {
                lastMessageRead: true
            }).catch(() => {});
        }

        scrollToBottom();
    }, (error) => {
        console.error("Mesajlar yüklenirken hata:", error);
    });
}

// Kullanıcı arka plandan uygulamaya tekrar odaklandığında okunmamış mesajları okundu yap
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentChatId && currentChatId !== 'global') {
        loadMessages(currentChatId);
    }
});

function renderMessage(msg, isMine, msgId) {
    const msgDiv = document.createElement('div');
    msgDiv.dataset.msgId = msgId;
    msgDiv.dataset.mine = isMine ? 'true' : 'false';
    const timeStr = msg.createdAt ? new Date(msg.createdAt.toDate()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Şimdi';
    const isImage = msg.type === 'image' && msg.imageUrl;

    const bodyHtml = isImage
        ? `<img src="${msg.imageUrl}" class="rounded-lg max-w-full max-h-72 object-cover cursor-pointer" onclick="openImageLightbox(this.src)">`
        : `<p class="break-words">${escapeHtml(msg.text)}</p>`;

    if (isMine) {
        const tickColor = msg.read ? 'text-[#53bdeb]' : 'text-gray-400';
        msgDiv.className = "flex justify-end rounded-lg transition-colors";
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
        msgDiv.className = "flex justify-start rounded-lg transition-colors";
        msgDiv.innerHTML = `
            <div class="bg-[#202c33] text-gray-100 ${isImage ? 'p-1' : 'px-4 py-2'} rounded-xl max-w-[80%] md:max-w-md text-sm shadow relative">
                ${currentChatId === 'global' ? `<span class="text-[11px] font-bold text-amber-400 block mb-0.5 ${isImage ? 'px-2 pt-1' : ''}">${escapeHtml(msg.senderName)}</span>` : ''}
                ${bodyHtml}
                <span class="text-[10px] text-gray-400 ${isImage ? 'block text-right px-2 pb-1' : 'float-right ml-3 mt-1'}">${timeStr}</span>
            </div>
        `;
    }

    if (selectedMessageIds.has(msgId)) {
        msgDiv.classList.add('bg-emerald-900/40');
    }

    attachSelectionHandlers(msgDiv, msgId);
    messageElementsById.set(msgId, msgDiv);
    messageContainer.appendChild(msgDiv);
}

function attachSelectionHandlers(el, msgId) {
    let pressTimer = null;
    let longPressTriggered = false;

    const startPress = () => {
        longPressTriggered = false;
        pressTimer = setTimeout(() => {
            longPressTriggered = true;
            if (!selectionMode) {
                enterSelectionMode(msgId);
            } else {
                toggleMessageSelection(msgId);
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
        if (selectionMode) {
            e.stopPropagation();
            toggleMessageSelection(msgId);
        }
    }, true);
}

function scrollToBottom() {
    setTimeout(() => {
        messageContainer.scrollTop = messageContainer.scrollHeight;
    }, 50);
}

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

        await updateChatSummaries(text);

        if (currentChatId !== 'global' && currentOtherUid) {
            sendPushToUser(currentOtherUid, `${currentUser.name}`, text);
        }

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
                        break;
                    }

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);

                    for (const q of qualitySteps) {
                        const dataUrl = canvas.toDataURL('image/jpeg', q);
                        bestResult = dataUrl;
                        const approxBytes = dataUrl.length * 0.75;
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
        imageInput.value = '';

        if (!file.type.startsWith('image/')) {
            alert("Lütfen bir görsel dosyası seç kanka!");
            return;
        }

        attachBtn.classList.add('opacity-40', 'pointer-events-none');
        const originalIcon = attachBtn.className;
        attachBtn.className = attachBtn.className.replace('fa-plus', 'fa-spinner fa-spin');

        try {
            const dataUrl = await compressImageToDataUrl(file);

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

            await updateChatSummaries('📷 Fotoğraf');

            if (currentChatId !== 'global' && currentOtherUid) {
                sendPushToUser(currentOtherUid, `${currentUser.name}`, "📷 Bir fotoğraf gönderdi");
            }

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