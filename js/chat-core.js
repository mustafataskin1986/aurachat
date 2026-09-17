// ==========================================
// CHAT CORE
//
// GÜNCELLEME (Firebase = sadece kurye/postacı mantığı): Bir resim
// mesajı karşı tarafın cihazına GERÇEKTEN diske yazıldığında (base64
// gösterimi değil, gerçek dosya yazımı başarılı olduğunda), alıcının
// cihazı Firestore'daki imageUrl alanını null yapıp temizliyor.
// Sadece ALICI tetikliyor (gönderen değil) - gönderenin kendi cihazında
// zaten kendi gönderdiği anda bir kopya oluşuyor, ikisi de kendi
// telefonunda tuttuğu için Firestore'daki kopyaya gerek kalmıyor.
// Firebase artık kalıcı depo değil, sadece "bu telefondan o telefona
// veriyi taşı, sonra elini çek" rolünde. Genel Kanka Odası'nda bu
// temizlik YAPILMIYOR (paylaşımlı arşiv - kaç kişi olduğu belirsiz,
// herkesin indirmesini beklemek pratik değil).
//
// GÜNCELLEME (artımlı senkronizasyon): Bir sohbet oturumu kurulurken
// diskte önbelleklenmiş mesaj varsa, Firestore sorgusu "son 50 mesajın
// tamamı" yerine "disk önbelleğindeki en son mesajdan SONRAKİ
// mesajlar" olarak kuruluyor. Cihazda zaten duran mesajlar (resimleri
// dahil) soğuk başlangıçta bir daha hiç ağdan çekilmiyor.
//
// Mesajlar cihazın kendi diskine de (Capacitor Filesystem,
// msg_cache/{chatId}.json) yazılıyor. Bir sohbet açıldığında ÖNCE
// diskten anında okunup ekrana basılıyor.
//
// contacts.js, liste yüklenir yüklenmez en son konuşulan 3 sohbetin
// oturumunu prewarmChatSession ile arka planda otomatik ısıtıyor.
//
// Son görüntülenen en fazla 3 sohbetin (global oda dahil) Firestore
// dinleyicileri sohbetten çıkınca KAPANMIYOR, arka planda açık kalıp
// mesajları sessizce bir "oturum" (chatSessions) önbelleğinde
// güncelliyor. 3'ten fazla sohbete girilirse LRU oturum kapatılıyor.
//
// Mesaj içindeki resimler cihaza yerel dosya olarak önbelleğe
// alınıyor (Capacitor Filesystem), data: URI (base64) ile veriliyor -
// uygulama Vercel'den canlı yüklendiği için Capacitor'ın dosya şeması
// sayfa köküyle uyuşmuyordu, bu yüzden doğrudan disk okuması kullanılıyor.
//
// Sohbet silme kalıcı (Firestore'da clearedAt alanı ile) ve o
// tarihten önceki mesajlar bir daha hiç yüklenmiyor; silme anında o
// sohbetin disk önbellek dosyası da temizleniyor.
//
// GÜNCELLEME (çoklu resim / albüm): Birden fazla resim tek seferde
// seçilirse hepsi TEK mesaj olarak (images: [...] dizisi,
// imagesCount alanı) gönderiliyor ve sohbette WhatsApp'taki gibi 2
// sütunlu ızgara halinde gösteriliyor (4'ten fazlaysa son karede
// "+N" yazıyor). Tek resim seçilirse eskisi gibi tek mesaj / tam
// boyut olarak gidiyor (imageUrl alanı). Albümdeki her resim kendi
// disk/IndexedDB dosyasına ayrı ayrı önbelleğe alınıyor
// (chat_media/{chatId}/{msgId}_{index}.jpg) ve alıcı tarafında
// TÜMÜ yerel diske yazıldığında Firestore'daki images dizisi
// (imageUrl'deki kurye mantığının aynısıyla) temizleniyor.
// ==========================================

import { db } from "./firebase-init.js";
import {
    collection, addDoc, onSnapshot, query, orderBy, limitToLast, limit, startAfter, where, getDocs,
    serverTimestamp, doc, setDoc, updateDoc, deleteDoc, arrayUnion, getDoc, increment, Timestamp
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
let currentUser = null;
let currentChatId = null;
let currentChatName = '';
let currentOtherUid = null;
let currentOtherAvatar = '';
let typingTimeout = null;

let selectionMode = false;
const selectedMessageIds = new Set();
const messageElementsById = new Map();
let recentOpenScrollLock = false;

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
// MESAJLARIN DİSK ÖNBELLEĞİ (Firestore'dan bağımsız, cihazın kendi diskinde)
// ------------------------------------------
const MSG_DISK_CACHE_DIR = 'msg_cache';
const DISK_CACHE_MESSAGE_LIMIT = 50;

function getFilesystemPlugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) || null;
}

const ensuredDirs = new Set();

async function ensureDirOnce(Filesystem, path) {
    if (!Filesystem || !path || ensuredDirs.has(path)) return;

    try {
        // 1. Önce klasör var mı diye kontrol et (Sessiz kontrol)
        await Filesystem.stat({
            path: path,
            directory: 'DATA'
        });
    } catch (e) {
        // 2. Klasör yoksa stat hata verir, burada güvenle oluştururuz
        try {
            await Filesystem.mkdir({
                path: path,
                directory: 'DATA',
                recursive: true
            });
        } catch (err) {
            // Olası ufacık bir çakışmayı da sessizce yut
        }
    } finally {
        // Hafızaya al ki aynı oturumda tekrar disk kontrolü yapmasın
        ensuredDirs.add(path);
    }
}


async function readChatDiskCache(chatId) {
    const Filesystem = getFilesystemPlugin();
    if (!Filesystem) return null;
    try {
        const result = await Filesystem.readFile({
            path: `${MSG_DISK_CACHE_DIR}/${chatId}.json`,
            directory: 'DATA',
            encoding: 'utf8'
        });
        const parsed = JSON.parse(result.data);
        return {
            clearedAtMillis: parsed.clearedAtMillis ?? null,
            messages: (parsed.messages || []).map(({ id, data }) => ({
                id,
                data: { ...data, createdAt: data.createdAt != null ? Timestamp.fromMillis(data.createdAt) : null }
            }))
        };
    } catch (e) {
        return null;
    }
}

function writeChatDiskCache(chatId, session) {
    const Filesystem = getFilesystemPlugin();
    if (!Filesystem) return;

    const messagesToSave = session.messages.slice(-DISK_CACHE_MESSAGE_LIMIT).map(({ id, data }) => ({
        id,
        data: { ...data, createdAt: data.createdAt ? data.createdAt.toMillis() : null }
    }));
    const payload = {
        clearedAtMillis: session.clearedAt ? session.clearedAt.toMillis() : null,
        messages: messagesToSave
    };

    ensureDirOnce(Filesystem, MSG_DISK_CACHE_DIR).finally(() => {
        Filesystem.writeFile({
            path: `${MSG_DISK_CACHE_DIR}/${chatId}.json`,
            directory: 'DATA',
            data: JSON.stringify(payload),
            encoding: 'utf8'
        }).catch((err) => console.warn("Mesaj diskcache yazılamadı:", err));
    });
}

async function deleteChatDiskCache(chatId) {
    const Filesystem = getFilesystemPlugin();
    if (!Filesystem) return;
    try {
        await Filesystem.deleteFile({ path: `${MSG_DISK_CACHE_DIR}/${chatId}.json`, directory: 'DATA' });
    } catch (e) {
        // dosya zaten yoksa sorun değil
    }
}

// ------------------------------------------
// SOHBET OTURUMLARI (canlı dinleyici havuzu)
// ------------------------------------------
const MAX_WARM_SESSIONS = 3;
const chatSessions = new Map();
let sessionTick = 0;

function evictLruSession(protectedChatId) {
    if (chatSessions.size <= MAX_WARM_SESSIONS) return;

    let lruId = null;
    let lruVal = Infinity;
    for (const [id, s] of chatSessions) {
        if (id === protectedChatId) continue;
        if (s.lastUsed < lruVal) {
            lruVal = s.lastUsed;
            lruId = id;
        }
    }
    if (lruId) {
        const s = chatSessions.get(lruId);
        if (s.unsubscribeMessages) s.unsubscribeMessages();
        if (s.unsubscribeChatDoc) s.unsubscribeChatDoc();
        chatSessions.delete(lruId);
    }
}

async function ensureChatSession(chatId, otherUid) {
    const existing = chatSessions.get(chatId);
    if (existing) {
        existing.lastUsed = ++sessionTick;
        return existing;
    }

    const session = {
        chatId,
        otherUid,
        messages: [],
        olderMessagesPrepended: [],
        oldestLoadedCreatedAt: null,
        hasMoreOlderCandidate: false,
        noMoreOlderMessages: false,
        clearedAt: null,
        unsubscribeMessages: null,
        unsubscribeChatDoc: null,
        lastUsed: ++sessionTick
    };
    chatSessions.set(chatId, session);
    evictLruSession(chatId);
    if (!chatSessions.has(chatId)) return session;

    const diskCache = await readChatDiskCache(chatId);
    if (diskCache) {
        session.messages = diskCache.messages;
        if (diskCache.clearedAtMillis != null) {
            session.clearedAt = Timestamp.fromMillis(diskCache.clearedAtMillis);
        }
    }

    if (!chatSessions.has(chatId)) return session;

    if (chatId !== 'global' && currentUser && session.clearedAt === null) {
        try {
            const mySummarySnap = await getDoc(doc(db, "users", currentUser.uid, "chats", chatId));
            if (mySummarySnap.exists() && mySummarySnap.data().clearedAt) {
                session.clearedAt = mySummarySnap.data().clearedAt;
            }
        } catch (err) {
            console.warn("clearedAt okunamadı:", err);
        }
    }

    if (!chatSessions.has(chatId)) return session;

    const isIncremental = session.messages.length > 0;
    const lastCachedAt = isIncremental ? session.messages[session.messages.length - 1].data.createdAt : null;

    const q = isIncremental
        ? query(
            collection(db, "chats", chatId, "messages"),
            where("createdAt", ">", lastCachedAt),
            orderBy("createdAt", "asc")
        )
        : (session.clearedAt
            ? query(
                collection(db, "chats", chatId, "messages"),
                where("createdAt", ">", session.clearedAt),
                orderBy("createdAt", "asc"),
                limitToLast(50)
            )
            : query(
                collection(db, "chats", chatId, "messages"),
                orderBy("createdAt", "asc"),
                limitToLast(50)
            ));

    session.unsubscribeMessages = onSnapshot(q, (snapshot) => {
        if (isIncremental) {
            snapshot.docChanges().forEach((change) => {
                const entry = { id: change.doc.id, data: change.doc.data() };
                const idx = session.messages.findIndex((m) => m.id === entry.id);
                if (change.type === 'removed') {
                    if (idx !== -1) session.messages.splice(idx, 1);
                } else if (idx !== -1) {
                    session.messages[idx] = entry;
                } else {
                    session.messages.push(entry);
                }
            });
            session.messages.sort((a, b) => {
                const at = a.data.createdAt ? a.data.createdAt.toMillis() : 0;
                const bt = b.data.createdAt ? b.data.createdAt.toMillis() : 0;
                return at - bt;
            });
            if (session.messages.length > 50) {
                session.messages = session.messages.slice(-50);
            }
        } else {
            const docs = [];
            snapshot.forEach((docSnap) => {
                docs.push({ id: docSnap.id, data: docSnap.data() });
            });
            session.messages = docs;
        }

        session.oldestLoadedCreatedAt = session.messages.length ? session.messages[0].data.createdAt : null;
        session.hasMoreOlderCandidate = session.messages.length >= 50;

        writeChatDiskCache(chatId, session);

        if (currentChatId === chatId) {
            renderSession(session);
            markVisibleMessagesRead(session);
            scrollToBottom();
        }
    }, (error) => {
        console.error("Mesajlar yüklenirken hata:", error);
    });

    if (chatId !== 'global') {
        session.unsubscribeChatDoc = onSnapshot(doc(db, "chats", chatId), (docSnap) => {
            if (currentChatId !== chatId) return;
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

    return session;
}

export function prewarmChatSession(chatId, otherUid) {
    ensureChatSession(chatId, otherUid).catch(() => {});
}

export async function prewarmChatMedia(chatId, otherUid) {
    const session = await ensureChatSession(chatId, otherUid);
    for (const { id, data: msg } of session.messages) {
        if (msg.type !== 'image') continue;

        const imagesCount = msg.imagesCount || 0;
        if (imagesCount > 1) {
            const arr = Array.isArray(msg.images) ? msg.images : [];
            for (let i = 0; i < imagesCount; i++) {
                try {
                    await resolveLocalMedia(chatId, id, arr[i], i);
                } catch (e) {
                    console.warn("Prewarm albüm medya hatası:", e);
                }
            }
            maybeStripAlbumImages(chatId, id, msg, imagesCount);
        } else if (msg.imageUrl) {
            try {
                const localSrc = await resolveLocalMedia(chatId, id, msg.imageUrl);
                if (localSrc) {
                    maybeStripDeliveredImage(chatId, id, msg);
                }
            } catch (e) {
                console.warn("Prewarm media hatası:", e);
            }
        }
    }
}

function markVisibleMessagesRead(session) {
    if (session.chatId === 'global' || !currentUser || !session.otherUid) return;
    if (document.visibilityState !== 'visible') return;

    let markedAny = false;
    session.messages.forEach(({ id, data: msg }) => {
        const isMine = !!(currentUser.uid && msg.senderUid === currentUser.uid);
        if (!isMine && msg.read === false) {
            updateDoc(doc(db, "chats", session.chatId, "messages", id), { read: true });
            markedAny = true;
        }
    });

    if (markedAny) {
        updateDoc(doc(db, "users", currentUser.uid, "chats", session.chatId), {
            unreadCount: 0
        }).catch(() => {});
        updateDoc(doc(db, "users", session.otherUid, "chats", session.chatId), {
            lastMessageRead: true
        }).catch(() => {});
    }
}

// ------------------------------------------
// BİLDİRİM GÖNDERME YARDIMCI FONKSİYONU
// ------------------------------------------
export async function sendPushToUser(receiverUid, title, body, extraData = {}) {
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
                platform: userData?.platform || '',
                data: extraData
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
// ------------------------------------------
async function updateChatSummaries(lastMessageText) {
    if (currentChatId === 'global' || !currentOtherUid || !currentUser) return;

    try {
        const myChatRef = doc(db, "users", currentUser.uid, "chats", currentChatId);
        const otherChatRef = doc(db, "users", currentOtherUid, "chats", currentChatId);

        await setDoc(myChatRef, {
            otherUid: currentOtherUid,
            otherName: currentChatName,
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
// SOHBETİ KALICI OLARAK TEMİZLE (listeden "sil")
// ------------------------------------------
export async function clearChatForMe(chatId) {
    if (!currentUser || !chatId || chatId === 'global') return;
    try {
        await setDoc(doc(db, "users", currentUser.uid, "chats", chatId), {
            clearedAt: serverTimestamp()
        }, { merge: true });

        const session = chatSessions.get(chatId);
        if (session) {
            if (session.unsubscribeMessages) session.unsubscribeMessages();
            if (session.unsubscribeChatDoc) session.unsubscribeChatDoc();
            chatSessions.delete(chatId);
        }
        await deleteChatDiskCache(chatId);
    } catch (err) {
        console.error("Sohbet temizlenemedi:", err);
        throw err;
    }
}

// ------------------------------------------
// SOHBET SEÇİMİ
// ------------------------------------------
export async function selectChat(otherUser) {
    exitSelectionMode();

    let chatId, chatName, otherUid, otherAvatar;

    if (otherUser === 'global') {
        chatId = 'global';
        chatName = 'Genel Kanka Odası 🌍';
        otherUid = null;
        otherAvatar = '';

        activeChatName.textContent = chatName;
        activeChatAvatar.style.backgroundColor = '';
        activeChatAvatar.className = "w-10 h-10 bg-gradient-to-tr from-emerald-600 to-cyan-600 rounded-full flex items-center text-white font-bold justify-center shadow flex-shrink-0";
        activeChatAvatar.innerHTML = `<i class="fa-solid fa-globe text-sm"></i>`;
        activeChatStatus.textContent = "Herkes çevrimiçi";
    } else {
        if (!currentUser || !currentUser.uid) {
            console.warn("selectChat: currentUser.uid yok, önce setCurrentUser çağrılmalı");
            return;
        }
        otherUid = otherUser.uid || otherUser.id;
        otherAvatar = otherUser.avatar || '';
        chatId = getChatId(currentUser.uid, otherUid);
        chatName = otherUser.name;

        activeChatName.textContent = chatName;

        if (otherUser.avatar) {
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

        activeChatStatus.textContent = "";
    }

    currentChatId = chatId;
    currentChatName = chatName;
    currentOtherUid = otherUid;
    currentOtherAvatar = otherAvatar;

    if (window.innerWidth < 1024) {
        sidebar.classList.add('-translate-x-full');
        chatArea.classList.remove('translate-x-full');
        pushBackState(doCloseChatView);
    }

    const session = await ensureChatSession(chatId, otherUid);

    if (currentChatId !== chatId) return;

    session.lastUsed = ++sessionTick;
    renderSession(session);
    markVisibleMessagesRead(session);
    scrollToBottom();

    recentOpenScrollLock = true;
    setTimeout(() => { recentOpenScrollLock = false; }, 1500);

    watchCallForChat(chatId);
}

function doCloseChatView() {
    currentChatId = null;
    currentChatName = '';
    currentOtherUid = null;
    currentOtherAvatar = '';
    messageContainer.innerHTML = '';
    messageElementsById.clear();
    exitSelectionMode();

    if (window.innerWidth < 1024) {
        sidebar.classList.remove('-translate-x-full');
        chatArea.classList.add('translate-x-full');
    }
}

backBtn.addEventListener('click', () => {
    doCloseChatView();
    popBackState();
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentChatId) {
        const session = chatSessions.get(currentChatId);
        if (session) markVisibleMessagesRead(session);
    }
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

        const chatIdAtDeleteTime = currentChatId;

        try {
            for (const id of ids) {
                const el = messageElementsById.get(id);
                const isMine = el && el.dataset.mine === 'true';

                if (deleteForEveryone && isMine) {
                    await deleteDoc(doc(db, "chats", chatIdAtDeleteTime, "messages", id));
                } else {
                    await updateDoc(doc(db, "chats", chatIdAtDeleteTime, "messages", id), {
                        deletedFor: arrayUnion(currentUser.uid)
                    });
                }
            }
        } catch (err) {
            alert("Mesajlar silinemedi: " + err.message);
        }

        const session = chatSessions.get(chatIdAtDeleteTime);
        if (session) {
            session.olderMessagesPrepended = session.olderMessagesPrepended.filter(
                (m) => !ids.includes(m.id)
            );
            session.messages = session.messages.filter((m) => !ids.includes(m.id));
            if (currentChatId === chatIdAtDeleteTime) {
                renderSession(session);
            }
        }

        exitSelectionMode();
    });
}

// ------------------------------------------
// MESAJLARI EKRANA ÇİZME
// ------------------------------------------
function renderSession(session) {
    messageContainer.innerHTML = '';
    messageElementsById.clear();

    if (session.chatId !== 'global') {
        const olderBtn = buildLoadOlderButtonElement(session);
        if (olderBtn) messageContainer.appendChild(olderBtn);
    }

    const fragment = document.createDocumentFragment();

    session.olderMessagesPrepended.forEach(({ id, data: msg }) => {
        if (currentUser && Array.isArray(msg.deletedFor) && msg.deletedFor.includes(currentUser.uid)) return;
        const isMine = !!(currentUser && currentUser.uid && msg.senderUid === currentUser.uid);
        fragment.appendChild(buildMessageElement(msg, isMine, id));
    });

    session.messages.forEach(({ id, data: msg }) => {
        if (currentUser && Array.isArray(msg.deletedFor) && msg.deletedFor.includes(currentUser.uid)) return;
        const isMine = !!(currentUser && currentUser.uid && msg.senderUid === currentUser.uid);
        fragment.appendChild(buildMessageElement(msg, isMine, id));
    });

    messageContainer.appendChild(fragment);
}

// ------------------------------------------
// ESKİ MESAJLARI YÜKLE (pagination)
// ------------------------------------------
function buildLoadOlderButtonElement(session) {
    if (!session.hasMoreOlderCandidate || session.noMoreOlderMessages || !session.oldestLoadedCreatedAt) {
        return null;
    }

    const btnWrap = document.createElement('div');
    btnWrap.className = 'flex justify-center py-2';
    btnWrap.innerHTML = `
        <button class="bg-[#202c33] hover:bg-[#2a3942] text-emerald-400 text-xs font-medium px-4 py-2 rounded-full transition">
            Eski mesajları yükle
        </button>
    `;
    btnWrap.querySelector('button').addEventListener('click', () => loadOlderMessages(session, btnWrap));
    return btnWrap;
}

async function loadOlderMessages(session, btnWrapEl) {
    if (!session.oldestLoadedCreatedAt) return;

    const btn = btnWrapEl.querySelector('button');
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;

    try {
        const q = session.clearedAt
            ? query(
                collection(db, "chats", session.chatId, "messages"),
                where("createdAt", ">", session.clearedAt),
                orderBy("createdAt", "desc"),
                startAfter(session.oldestLoadedCreatedAt),
                limit(50)
            )
            : query(
                collection(db, "chats", session.chatId, "messages"),
                orderBy("createdAt", "desc"),
                startAfter(session.oldestLoadedCreatedAt),
                limit(50)
            );

        const snap = await getDocs(q);

        if (snap.empty) {
            session.noMoreOlderMessages = true;
            if (currentChatId === session.chatId) renderSession(session);
            return;
        }

        const docsAsc = snap.docs.slice().reverse().map((d) => ({ id: d.id, data: d.data() }));
        session.olderMessagesPrepended = docsAsc.concat(session.olderMessagesPrepended);
        session.oldestLoadedCreatedAt = docsAsc[0].data.createdAt;

        if (snap.size < 50) {
            session.noMoreOlderMessages = true;
        }

        if (currentChatId === session.chatId) renderSession(session);
    } catch (err) {
        console.error("Eski mesajlar yüklenemedi:", err);
        if (currentChatId === session.chatId) {
            btn.disabled = false;
            btn.textContent = "Eski mesajları yükle";
        }
    }
}

// ------------------------------------------
// MESAJ MEDYASI YEREL DOSYA ÖNBELLEĞİ + TESLİMAT SONRASI TEMİZLİK
// ------------------------------------------
const MEDIA_CACHE_DIR = 'chat_media';
const mediaUriCache = new Map(); // "chatId/msgId" veya "chatId/msgId_index" -> yerel gösterilebilir src (data: URI)
const mediaResolveInFlight = new Map();

// ------------------------------------------
// PWA/TARAYICI için kalıcı yerel depo (IndexedDB) - Capacitor
// Filesystem sadece Android APK'da var, tarayıcıda yok. Bu olmadan
// PWA tarafında hiçbir kalıcı kopya oluşmuyordu; karşı taraf resmi
// indirip Firestore'daki kopyayı temizleyince, PWA'da hiç yerel kopya
// kalmadığı için resim kalıcı olarak kayboluyordu. Android'deki
// Filesystem'in tam karşılığı burada IndexedDB ile sağlanıyor.
// ------------------------------------------
const PWA_DB_NAME = 'aurachat-media';
const PWA_DB_STORE = 'images';
let pwaDbPromise = null;

function openPwaDb() {
    if (pwaDbPromise) return pwaDbPromise;
    pwaDbPromise = new Promise((resolve) => {
        if (!('indexedDB' in window)) { resolve(null); return; }
        const req = indexedDB.open(PWA_DB_NAME, 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(PWA_DB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });
    return pwaDbPromise;
}

async function pwaDbGet(key) {
    const dbase = await openPwaDb();
    if (!dbase) return null;
    return new Promise((resolve) => {
        try {
            const tx = dbase.transaction(PWA_DB_STORE, 'readonly');
            const req = tx.objectStore(PWA_DB_STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        } catch (e) {
            resolve(null);
        }
    });
}

async function pwaDbSet(key, value) {
    const dbase = await openPwaDb();
    if (!dbase) return;
    return new Promise((resolve) => {
        try {
            const tx = dbase.transaction(PWA_DB_STORE, 'readwrite');
            tx.objectStore(PWA_DB_STORE).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        } catch (e) {
            resolve();
        }
    });
}

async function saveToNativeGallery(pureBase64) {
    try {
        const Filesystem = getFilesystemPlugin();
        if (!Filesystem) return;

        // Tarih ve saat formatı oluşturur: YYYYMMDD_HHMMSS (Örn: AuraChat_20260916_175430.jpg)
        const now = new Date();
        const timestamp = now.getFullYear().toString() +
            String(now.getMonth() + 1).padStart(2, '0') +
            String(now.getDate()).padStart(2, '0') + '_' +
            String(now.getHours()).padStart(2, '0') +
            String(now.getMinutes()).padStart(2, '0') +
            String(now.getSeconds()).padStart(2, '0');

        const cleanFilename = `AuraChat_${timestamp}`;

        await Filesystem.writeFile({
            path: `Pictures/AuraChat/${cleanFilename}.jpg`,
            data: pureBase64,
            directory: 'EXTERNAL_STORAGE',
            recursive: true
        });
        console.log(`📷 Fotoğraf telefon galerisine kaydedildi: ${cleanFilename}.jpg`);
    } catch (e) {
        try {
            const Filesystem = getFilesystemPlugin();
            if (Filesystem) {
                const now = new Date();
                const timestamp = now.getTime();
                await Filesystem.writeFile({
                    path: `AuraChat_${timestamp}.jpg`,
                    data: pureBase64,
                    directory: 'DOCUMENTS'
                });
            }
        } catch (err) {
            console.warn("Galeritutucuya yazılamadı:", err);
        }
    }
}

// idx null/undefined ise eski tekil-resim davranışı (msgId.jpg), sayı verilirse
// albüm alt-resmi (msgId_idx.jpg) olarak ayrı önbelleklenir.
async function resolveLocalMedia(chatId, msgId, base64Data, idx = null) {
    if (!chatId || !msgId) return base64Data || null;

    const suffix = (idx === null || idx === undefined) ? '' : `_${idx}`;
    const cacheKey = `${chatId}/${msgId}${suffix}`;
    if (mediaUriCache.has(cacheKey)) return mediaUriCache.get(cacheKey);

    if (mediaResolveInFlight.has(cacheKey)) {
        return mediaResolveInFlight.get(cacheKey);
    }

    const resolvePromise = (async () => {
        const Filesystem = getFilesystemPlugin();

        if (Filesystem) {
            const dirPath = `${MEDIA_CACHE_DIR}/${chatId}`;
            const filePath = `${dirPath}/${msgId}${suffix}.jpg`;

            // 1. Önce dahili diski oku
            try {
                const existing = await Filesystem.readFile({ 
                    path: filePath, 
                    directory: 'DATA'
                });
                
                const rawData = typeof existing.data === 'string' ? existing.data : existing.data;
                const src = rawData.startsWith('data:') ? rawData : `data:image/jpeg;base64,${rawData}`;
                
                mediaUriCache.set(cacheKey, src);
                return src;
            } catch (e) {
                // Dosya henüz iç diskte yok, aşağıya devam et
            }

            if (!base64Data) return null;

            try {
                const pureBase64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
                
                // Klasörü güvenli şekilde oluştur (Var ise hatayı yutar)
                await ensureDirOnce(Filesystem, dirPath);
                
                // DATA klasörüne kaydet
                await Filesystem.writeFile({ 
                    path: filePath, 
                    data: pureBase64, 
                    directory: 'DATA'
                });

                // Galeriye de kopya at
                saveToNativeGallery(pureBase64);

                const src = `data:image/jpeg;base64,${pureBase64}`;
                mediaUriCache.set(cacheKey, src);
                return src;
            } catch (err) {
                console.warn("Medya yerel diske yazılamadı:", err);
                // Diske yazılamadıysa Firestore temizliğinin TETİKLENMEMESİ için null dön
                return null; 
            }
        }

        // Tarayıcı / PWA fallback (IndexedDB)
        const existing = await pwaDbGet(cacheKey);
        if (existing) {
            mediaUriCache.set(cacheKey, existing);
            return existing;
        }

        if (!base64Data) return null;

        const src = base64Data.startsWith('data:') ? base64Data : `data:image/jpeg;base64,${base64Data}`;
        await pwaDbSet(cacheKey, src);
        mediaUriCache.set(cacheKey, src);
        return src;
    })();

    mediaResolveInFlight.set(cacheKey, resolvePromise);
    try {
        return await resolvePromise;
    } finally {
        mediaResolveInFlight.delete(cacheKey);
    }
}


// Firebase = kurye. Resim gerçekten bu cihaza (diske) indiyse ve ben
// ALICIYSAM (gönderen değilsem), Firestore'daki kopyayı temizle.
// Global odada dokunmuyoruz (paylaşımlı arşiv).
function maybeStripDeliveredImage(chatId, msgId, msg) {
    if (chatId === 'global') return;
    if (!currentUser || !msg.imageUrl) return;
    if (msg.senderUid === currentUser.uid) return;

    const cacheKey = `${chatId}/${msgId}`;
    
    // GÜVENLİK SUBABI: Eğer resim yerel bellek kütüphanesine (mediaUriCache) 
    // başarıyla yazılmadıysa (Android Filesystem veya PWA IndexedDB patladıysa) 
    // sakın sunucudaki resmi silme!
    if (!mediaUriCache.has(cacheKey)) return; 

    updateDoc(doc(db, "chats", chatId, "messages", msgId), {
        imageUrl: null,
        imageDelivered: true
    }).catch((err) => console.warn("Teslim edilen resim Firestore'dan temizlenemedi:", err));
}

// Albüm (çoklu resim) versiyonu: ALICI tarafında albümdeki TÜM
// resimler yerel diske/IndexedDB'ye başarıyla yazıldıysa, Firestore'daki
// images dizisini temizler (imagesDelivered:true bırakır).
function maybeStripAlbumImages(chatId, msgId, msg, imagesCount) {
    if (chatId === 'global') return;
    if (!currentUser || msg.senderUid === currentUser.uid) return;
    if (!Array.isArray(msg.images) || !msg.images.length) return; // zaten temizlenmiş ya da hiç yoktu
    if (!imagesCount) return;

    for (let i = 0; i < imagesCount; i++) {
        if (!mediaUriCache.has(`${chatId}/${msgId}_${i}`)) return; // hepsi henüz diske yazılmadı
    }

    updateDoc(doc(db, "chats", chatId, "messages", msgId), {
        images: null,
        imagesDelivered: true
    }).catch((err) => console.warn("Albüm resimleri Firestore'dan temizlenemedi:", err));
}

// WhatsApp tarzı 2 sütunlu albüm ızgarası. 4'ten fazla resim varsa
// son görünen karede "+N" bindirmesi gösterilir.
function buildAlbumTilesHtml(chatId, msgId, imagesCount) {
    const maxTiles = Math.min(imagesCount, 4);
    const extra = imagesCount - maxTiles;
    let tiles = '';

    for (let i = 0; i < maxTiles; i++) {
        const cachedSrc = mediaUriCache.get(`${chatId}/${msgId}_${i}`);
        const showOverlay = i === maxTiles - 1 && extra > 0;
        const inner = cachedSrc
            ? `<img src="${cachedSrc}" class="w-full h-full object-cover" data-media-msg="${msgId}" data-media-idx="${i}" onclick="openAlbumLightbox('${chatId}','${msgId}',${imagesCount},${i})">`
            : `<div class="w-full h-full flex items-center justify-center bg-black/20" data-media-msg="${msgId}" data-media-idx="${i}" onclick="openAlbumLightbox('${chatId}','${msgId}',${imagesCount},${i})"><i class="fa-solid fa-image text-gray-500"></i></div>`;
        tiles += `
            <div class="relative overflow-hidden" style="aspect-ratio:1/1;">
                ${inner}
                ${showOverlay ? `<div class="absolute inset-0 bg-black/50 flex items-center justify-center text-white text-lg font-bold pointer-events-none">+${extra}</div>` : ''}
            </div>`;
    }

    return `<div class="grid grid-cols-2 gap-0.5 rounded-lg overflow-hidden" style="width:280px;">${tiles}</div>`;
}

function buildMessageElement(msg, isMine, msgId) {
    const msgDiv = document.createElement('div');
    msgDiv.dataset.msgId = msgId;
    msgDiv.dataset.mine = isMine ? 'true' : 'false';
    const timeStr = msg.createdAt ? new Date(msg.createdAt.toDate()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Şimdi';

    const imagesCount = msg.imagesCount || 0;
    const isAlbum = msg.type === 'image' && imagesCount > 1;
    const isSingleImage = msg.type === 'image' && !isAlbum && (msg.imageUrl || msg.imageDelivered);
    const isImage = isAlbum || isSingleImage;

    const localCachedSrc = isSingleImage ? mediaUriCache.get(`${currentChatId}/${msgId}`) : null;
    const initialImgSrc = localCachedSrc || msg.imageUrl || '';

    let bodyHtml;
    if (isAlbum) {
        bodyHtml = buildAlbumTilesHtml(currentChatId, msgId, imagesCount);
    } else if (isSingleImage) {
        bodyHtml = initialImgSrc
            ? `<img src="${initialImgSrc}" class="rounded-lg cursor-pointer block" style="max-width:280px;max-height:380px;width:auto;height:auto;" data-media-msg="${msgId}" onclick="openImageLightbox(this.src)">`
            : `<div class="rounded-lg bg-black/20 flex items-center justify-center" data-media-msg="${msgId}" style="width:220px;height:220px;max-width:100%;"><i class="fa-solid fa-image text-gray-500"></i></div>`;
    } else {
        bodyHtml = `<p class="break-words">${escapeHtml(msg.text)}</p>`;
    }

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

    if (isAlbum) {
        const arr = Array.isArray(msg.images) ? msg.images : [];
        const maxTiles = Math.min(imagesCount, 4);

        // Zaten önbellekte olup senkron çizilen karelere de yükleme sonrası kaydırma bağla
        for (let i = 0; i < maxTiles; i++) {
            const tileImg = msgDiv.querySelector(`img[data-media-idx="${i}"]`);
            if (tileImg) {
                tileImg.addEventListener('load', () => {
                    if (recentOpenScrollLock || isNearBottom()) scrollToBottom();
                });
            }
        }

        let resolvedCount = 0;
        for (let i = 0; i < imagesCount; i++) {
            resolveLocalMedia(currentChatId, msgId, arr[i], i).then((src) => {
                resolvedCount++;

                if (src && i < maxTiles) {
                    const tileEl = msgDiv.querySelector(`[data-media-msg="${msgId}"][data-media-idx="${i}"]`);
                    if (tileEl && tileEl.isConnected) {
                        if (tileEl.tagName === 'IMG') {
                            if (src !== tileEl.src) tileEl.src = src;
                       } else {
                            tileEl.outerHTML = `<img src="${src}" class="w-full h-full object-cover" data-media-msg="${msgId}" data-media-idx="${i}" onclick="openAlbumLightbox('${currentChatId}','${msgId}',${imagesCount},${i})">`;
                            const newTile = msgDiv.querySelector(`img[data-media-idx="${i}"]`);
                            if (newTile) {
                                newTile.addEventListener('load', () => {
                                    if (recentOpenScrollLock || isNearBottom()) scrollToBottom();
                                });
                            }
                        }
                    }
                }

                if (resolvedCount === imagesCount) {
                    maybeStripAlbumImages(currentChatId, msgId, msg, imagesCount);
                }
            });
        }
    } else if (isSingleImage) {
        const mediaEl = msgDiv.querySelector(`[data-media-msg="${msgId}"]`);
        if (mediaEl && mediaEl.tagName === 'IMG') {
            mediaEl.addEventListener('error', () => {
                if (msg.imageUrl && mediaEl.src !== msg.imageUrl) mediaEl.src = msg.imageUrl;
            });
            mediaEl.addEventListener('load', () => {
                if (recentOpenScrollLock || isNearBottom()) scrollToBottom();
            });
        }
        resolveLocalMedia(currentChatId, msgId, msg.imageUrl).then((src) => {
            if (!src) return; // ne yerelde ne sunucuda kaldı - gösterecek bir şey yok
            const el = msgDiv.querySelector(`[data-media-msg="${msgId}"]`);
            if (el && el.isConnected) {
                if (el.tagName === 'IMG') {
                    if (src !== el.src) el.src = src;
                } else {
                    el.outerHTML = `<img src="${src}" class="rounded-lg cursor-pointer block" style="max-width:280px;max-height:380px;width:auto;height:auto;" data-media-msg="${msgId}" onclick="openImageLightbox(this.src)">`;
                    const newEl = msgDiv.querySelector(`[data-media-msg="${msgId}"]`);
                    if (newEl) {
                        newEl.addEventListener('load', () => {
                            if (recentOpenScrollLock || isNearBottom()) scrollToBottom();
                        });
                    }
                }
            }
            maybeStripDeliveredImage(currentChatId, msgId, msg);
        });
    }

    if (selectedMessageIds.has(msgId)) {
        msgDiv.classList.add('bg-emerald-900/40');
    }

    attachSelectionHandlers(msgDiv, msgId);
    messageElementsById.set(msgId, msgDiv);
    return msgDiv;
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
    requestAnimationFrame(() => {
        messageContainer.scrollTop = messageContainer.scrollHeight;
    });
}

function isNearBottom() {
    return (messageContainer.scrollHeight - messageContainer.scrollTop - messageContainer.clientHeight) < 150;
}

window.openImageLightbox = function (src) {
    const lightbox = document.getElementById('image-lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    if (!lightbox || !lightboxImg) return;
    albumViewerState = null;
    hideAlbumViewerControls();
    lightboxImg.src = src;
    lightbox.classList.remove('hidden');
    lightbox.classList.add('flex');
    pushBackState(doCloseLightbox);
};

// ------------------------------------------
// ALBÜM GÖRÜNTÜLEYİCİ (4'ten fazla resimde "+N" karesine dokununca
// açılır, ok tuşlarıyla albümdeki TÜM resimler gezilebilir)
// ------------------------------------------
let albumViewerState = null;

function updateAlbumViewerCounter() {
    if (!albumViewerState) return;
    const counterEl = document.getElementById('lightbox-album-counter');
    if (counterEl) counterEl.textContent = `${albumViewerState.index + 1} / ${albumViewerState.imagesCount}`;
}

async function renderAlbumViewerImage() {
    if (!albumViewerState) return;
    const { chatId, msgId, index } = albumViewerState;
    const lightboxImg = document.getElementById('lightbox-img');
    if (!lightboxImg) return;

    const cacheKey = `${chatId}/${msgId}_${index}`;
    let src = mediaUriCache.get(cacheKey);
    if (!src) {
        src = await resolveLocalMedia(chatId, msgId, null, index);
    }
    if (albumViewerState && albumViewerState.chatId === chatId && albumViewerState.msgId === msgId && albumViewerState.index === index && src) {
        lightboxImg.src = src;
    }
    updateAlbumViewerCounter();
}

function albumViewerStep(delta) {
    if (!albumViewerState) return;
    const newIndex = albumViewerState.index + delta;
    if (newIndex < 0 || newIndex >= albumViewerState.imagesCount) return;
    albumViewerState.index = newIndex;
    renderAlbumViewerImage();
}

function ensureAlbumViewerControls() {
    const lightbox = document.getElementById('image-lightbox');
    if (!lightbox || document.getElementById('lightbox-album-prev')) return;

    const prevBtn = document.createElement('button');
    prevBtn.id = 'lightbox-album-prev';
    prevBtn.innerHTML = '<i class="fa-solid fa-chevron-left"></i>';
    prevBtn.className = 'absolute left-2 top-1/2 -translate-y-1/2 bg-black/50 text-white w-10 h-10 rounded-full flex items-center justify-center z-10';
    prevBtn.addEventListener('click', (e) => { e.stopPropagation(); albumViewerStep(-1); });

    const nextBtn = document.createElement('button');
    nextBtn.id = 'lightbox-album-next';
    nextBtn.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
    nextBtn.className = 'absolute right-2 top-1/2 -translate-y-1/2 bg-black/50 text-white w-10 h-10 rounded-full flex items-center justify-center z-10';
    nextBtn.addEventListener('click', (e) => { e.stopPropagation(); albumViewerStep(1); });

    const counter = document.createElement('div');
    counter.id = 'lightbox-album-counter';
    counter.className = 'absolute top-4 left-1/2 -translate-x-1/2 bg-black/50 text-white text-xs px-3 py-1 rounded-full z-10';

    lightbox.appendChild(prevBtn);
    lightbox.appendChild(nextBtn);
    lightbox.appendChild(counter);
}

function hideAlbumViewerControls() {
    ['lightbox-album-prev', 'lightbox-album-next', 'lightbox-album-counter'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.remove();
    });
}

window.openAlbumLightbox = function (chatId, msgId, imagesCount, startIndex) {
    const lightbox = document.getElementById('image-lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    if (!lightbox || !lightboxImg) return;

    albumViewerState = { chatId, msgId, imagesCount, index: startIndex };
    ensureAlbumViewerControls();

    const cacheKey = `${chatId}/${msgId}_${startIndex}`;
    const cachedSrc = mediaUriCache.get(cacheKey);
    lightboxImg.src = cachedSrc || '';
    updateAlbumViewerCounter();
    if (!cachedSrc) renderAlbumViewerImage();

    lightbox.classList.remove('hidden');
    lightbox.classList.add('flex');
    pushBackState(doCloseLightbox);
};

function doCloseLightbox() {
    const lightbox = document.getElementById('image-lightbox');
    if (!lightbox) return;
    lightbox.classList.add('hidden');
    lightbox.classList.remove('flex');
    albumViewerState = null;
    hideAlbumViewerControls();
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
            createdAt: serverTimestamp(),
            read: false
        });


        await updateChatSummaries(text);

        if (currentChatId !== 'global' && currentOtherUid) {
            sendPushToUser(currentOtherUid, `${currentUser.name}`, text, {
                chatId: currentChatId,
                otherUid: currentUser.uid,
                otherName: currentUser.name
            });
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
// GÖRSEL GÖNDERME (tek resim = tam boyut / birden fazla resim = tek albüm mesajı)
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
    imageInput.multiple = true;
    attachBtn.addEventListener('click', () => imageInput.click());

    imageInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length || !currentUser || !currentChatId) return;
        imageInput.value = '';

        const validFiles = files.filter((f) => f.type.startsWith('image/'));
        if (!validFiles.length) {
            alert("Lütfen bir görsel dosyası seç kanka!");
            return;
        }

        attachBtn.classList.add('opacity-40', 'pointer-events-none');
        const originalIcon = attachBtn.className;
        attachBtn.className = attachBtn.className.replace('fa-plus', 'fa-spinner fa-spin');

        // Birden fazla resim tek Firestore belgesine (max ~1MB) sığmalı,
        // o yüzden çoklu seçimde resim başına hedef boyutu düşürüyoruz.
        const perImageTarget = validFiles.length > 1 ? 150 * 1024 : 300 * 1024;
        const maxTotalBytes = 900 * 1024;

        try {
            const compressed = [];
            let totalBytes = 0;
            let skippedForSize = false;

            for (const file of validFiles) {
                try {
                    const dataUrl = await compressImageToDataUrl(file, perImageTarget);
                    const approxBytes = dataUrl.length * 0.75;

                    if (totalBytes + approxBytes > maxTotalBytes) {
                        skippedForSize = true;
                        break;
                    }

                    compressed.push(dataUrl);
                    totalBytes += approxBytes;
                } catch (innerErr) {
                    console.warn(`Görsel sıkıştırılamadı (${file.name}):`, innerErr);
                }
            }

            if (!compressed.length) {
                alert("Görseller gönderilemedi, dene tekrar kanka.");
                return;
            }

            if (compressed.length === 1) {
                await addDoc(collection(db, "chats", currentChatId, "messages"), {
                    type: 'image',
                    imageUrl: compressed[0],
                    text: '',
                    senderUid: currentUser.uid,
                    senderName: currentUser.name,
                    createdAt: serverTimestamp(),
                    read: false
                });
            } else {
                await addDoc(collection(db, "chats", currentChatId, "messages"), {
                    type: 'image',
                    images: compressed,
                    imagesCount: compressed.length,
                    imagesDelivered: false,
                    text: '',
                    senderUid: currentUser.uid,
                    senderName: currentUser.name,
                    createdAt: serverTimestamp(),
                    read: false
                });
            }

            await updateChatSummaries(compressed.length > 1 ? `📷 ${compressed.length} Fotoğraf` : '📷 Fotoğraf');

            if (currentChatId !== 'global' && currentOtherUid) {
                sendPushToUser(currentOtherUid, `${currentUser.name}`, compressed.length > 1 ? `📷 ${compressed.length} fotoğraf gönderdi` : "📷 Bir fotoğraf gönderdi", {
                    chatId: currentChatId,
                    otherUid: currentUser.uid,
                    otherName: currentUser.name
                });
            }

            if (skippedForSize) {
                alert(`Boyut sınırı yüzünden sadece ${compressed.length} fotoğraf gönderildi, kalanları ayrı bir mesajda gönder kanka.`);
            }

            scrollToBottom();
        } catch (err) {
            console.error("Görseller gönderilemedi:", err);
            alert("Görseller gönderilirken hata oluştu!");
        } finally {
            attachBtn.className = originalIcon;
            attachBtn.classList.remove('opacity-40', 'pointer-events-none');
        }
    });
}