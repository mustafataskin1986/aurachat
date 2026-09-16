// ==========================================
// CHAT CORE
//
// GÜNCELLEME (WhatsApp mantığı - disk önbellek + ön ısıtma): Mesajlar
// artık sadece Firestore'un kendi (tembel/lazy) önbelleğine değil,
// cihazın kendi diskine de (Capacitor Filesystem, msg_cache/{chatId}.json)
// yazılıyor. Bir sohbet açıldığında ÖNCE diskten anında okunup ekrana
// basılıyor - Firestore'un cevap vermesi hiç beklenmiyor. Firestore
// arkadan sessizce gelip veriyi güncel tutuyor (onSnapshot), yani ağ
// sadece gerçekten senkronizasyon gerektiğinde devrede. Bu sayede
// uygulama kapatılıp açılsa bile, daha önce görülmüş bir sohbet anında
// (disk hızında) açılıyor.
//
// Ayrıca contacts.js, liste yüklenir yüklenmez (kullanıcı hiçbir yere
// dokunmadan) en son konuşulan 3 sohbetin oturumunu prewarmChatSession
// ile arka planda otomatik ısıtıyor - kullanıcı tıkladığında oturum
// zaten hazır oluyor.
//
// Son görüntülenen en fazla 3 sohbetin (global oda dahil) Firestore
// dinleyicileri sohbetten çıkınca KAPANMIYOR, arka planda açık kalıp
// mesajları sessizce bir "oturum" (chatSessions) önbelleğinde
// güncelliyor. 3'ten fazla sohbete girilirse en uzun süredir
// kullanılmayan (LRU) oturum otomatik kapatılıp temizleniyor (disk
// önbelleği silinmiyor, sadece canlı dinleyici kapatılıyor).
//
// Mesaj içindeki resimler WhatsApp mantığıyla cihaza yerel dosya
// olarak önbelleğe alınıyor (Capacitor Filesystem), spinner olmadan
// önce base64 ile anında gösterilip arka planda yerel kaynağa
// geçiriliyor.
//
// Sohbet silme kalıcı (Firestore'da clearedAt alanı ile, cihaz değişse
// de kaybolmaz) ve o tarihten önceki mesajlar bir daha hiç yüklenmiyor;
// silme anında o sohbetin disk önbellek dosyası da temizleniyor.
// Mesaj listesi varsayılan olarak son 50 mesajı hızlıca gösteriyor,
// "Eski mesajları yükle" düğmesiyle geçmişe istendiği kadar gidilebiliyor.
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
// MESAJLARIN DİSK ÖNBELLEĞİ (WhatsApp'ın kendi SQLite'ı gibi -
// Firestore'dan bağımsız, cihazın kendi diskinde)
// ------------------------------------------
const MSG_DISK_CACHE_DIR = 'msg_cache';
const DISK_CACHE_MESSAGE_LIMIT = 50;

function getFilesystemPlugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) || null;
}

const ensuredDirs = new Set(); // hangi klasörlerin zaten oluşturulduğunu tutar - tekrar mkdir denemesin
async function ensureDirOnce(Filesystem, path) {
    if (ensuredDirs.has(path)) return;
    try {
        await Filesystem.mkdir({ path, directory: 'DATA', recursive: true });
    } catch (e) {
        // klasör zaten varsa sorun değil
    }
    ensuredDirs.add(path);
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
        return null; // dosya yok / okunamadı - sorun değil, ilk kez açılıyordur
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
// SOHBET OTURUMLARI (canlı dinleyici havuzu - WhatsApp mantığı)
// ------------------------------------------
const MAX_WARM_SESSIONS = 3;
const chatSessions = new Map(); // chatId -> session
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

// Bir sohbetin oturumunu hazırlar. Zaten canlıysa anında döner.
// Değilse: (1) önce DİSKTEN anında okuyup session.messages'ı doldurur
// (Firestore'a hiç gitmeden), (2) arkasından Firestore dinleyicisini
// kurar - dinleyici geldiğinde veriyi hem ekrana hem tekrar diske yazar.
async function ensureChatSession(chatId, otherUid) {
    const existing = chatSessions.get(chatId);
    if (existing) {
        existing.lastUsed = ++sessionTick;
        return existing;
    }

    const session = {
        chatId,
        otherUid,
        messages: [],               // canlı pencere (son 50, onSnapshot ile güncel)
        olderMessagesPrepended: [], // "eski mesajları yükle" ile eklenenler
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

    // 1) ÖNCE DİSKTEN oku - ağa hiç gitmeden ilk görüntüyü hazırla
    const diskCache = await readChatDiskCache(chatId);
    if (diskCache) {
        session.messages = diskCache.messages;
        if (diskCache.clearedAtMillis != null) {
            session.clearedAt = Timestamp.fromMillis(diskCache.clearedAtMillis);
        }
    }

    // Bu sırada oturum evict edilmiş olabilir (çok hızlı art arda sohbet
    // açılmışsa) - o durumda devam etmenin anlamı yok.
    if (!chatSessions.has(chatId)) return session;

    // 2) clearedAt diskte yoksa (bu cihazda ilk kez açılan bir sohbet)
    // Firestore'dan al - bu tek network isteği kaçınılmaz, ilk açılışta olur.
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

    const q = session.clearedAt
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
        );

    session.unsubscribeMessages = onSnapshot(q, (snapshot) => {
        const docs = [];
        let firstDocCreatedAt = null;
        snapshot.forEach((docSnap) => {
            const msg = docSnap.data();
            if (!firstDocCreatedAt && msg.createdAt) firstDocCreatedAt = msg.createdAt;
            docs.push({ id: docSnap.id, data: msg });
        });

        session.messages = docs;
        session.oldestLoadedCreatedAt = firstDocCreatedAt;
        session.hasMoreOlderCandidate = snapshot.size >= 50;

        writeChatDiskCache(chatId, session); // arka planda diske de yaz (sessizce)

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

// contacts.js liste yüklenir yüklenmez (kullanıcı tıklamadan) çağırır -
// en son konuşulan sohbetlerin oturumunu arka planda ısıtır.
export function prewarmChatSession(chatId, otherUid) {
    ensureChatSession(chatId, otherUid).catch(() => {});
}

// Bildirim geldiğinde (uygulama arka planda canlıyken) çağrılır - sohbeti
// hiç açmadan, o sohbetteki resimleri sessizce cihaza indirip önbelleğe alır.
export async function prewarmChatMedia(chatId, otherUid) {
    const session = await ensureChatSession(chatId, otherUid);
    session.messages.forEach(({ id, data: msg }) => {
        if (msg.type === 'image' && msg.imageUrl) {
            resolveLocalMedia(chatId, id, msg.imageUrl).catch(() => {});
        }
    });
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
// contacts.js buradan çağırıyor. Sadece BENİM tarafımdaki geçmişi
// gizler; karşı tarafın verisine dokunmaz. Yeni mesaj gelirse sohbet
// tekrar listede görünür ama eski mesajlar bir daha hiç yüklenmez.
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

    // Oturum zaten canlıysa (ön ısıtılmış ya da önceden ziyaret edilmişse)
    // bu anında döner. Değilse, önce diskten okuyup az sonra Firestore'la
    // senkronize olur - kullanıcı network'ü hiç beklemez.
    const session = await ensureChatSession(chatId, otherUid);

    if (currentChatId !== chatId) return;

    session.lastUsed = ++sessionTick;
    renderSession(session);
    markVisibleMessagesRead(session);
    scrollToBottom();

    watchCallForChat(chatId);
}

function doCloseChatView() {
    // NOT: Dinleyicileri artık burada KAPATMIYORUZ - WhatsApp mantığı
    // gereği son görüntülenen sohbetler arka planda canlı kalıyor
    // (bkz. chatSessions / ensureChatSession).
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

        // Silinenler "eski mesajları yükle" ile gelmiş paginasyon dışı
        // öğelerse, canlı sorgu penceresinin dışında kaldıkları için
        // onSnapshot bunları otomatik güncellemez - elle temizleyelim.
        const session = chatSessions.get(chatIdAtDeleteTime);
        if (session) {
            session.olderMessagesPrepended = session.olderMessagesPrepended.filter(
                (m) => !ids.includes(m.id)
            );
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
// MESAJ MEDYASI YEREL DOSYA ÖNBELLEĞİ (WhatsApp mantığı)
// ------------------------------------------
const MEDIA_CACHE_DIR = 'chat_media';
const mediaUriCache = new Map(); // "chatId/msgId" -> yerel gösterilebilir src
const mediaResolveInFlight = new Map(); // "chatId/msgId" -> devam eden indirme Promise'i (çakışmayı önler)

async function resolveLocalMedia(chatId, msgId, base64Data) {
    if (!base64Data || !chatId || !msgId) return base64Data || null;

    const cacheKey = `${chatId}/${msgId}`;
    if (mediaUriCache.has(cacheKey)) return mediaUriCache.get(cacheKey);

    // Bu resim için zaten devam eden bir indirme/yazma varsa, ikinci bir
    // tane başlatmak yerine o işlemin bitmesini bekle - aynı dosyaya
    // çakışan eşzamanlı yazmalar dosyayı bozuyordu, bunu böyle engelliyoruz.
    if (mediaResolveInFlight.has(cacheKey)) {
        return mediaResolveInFlight.get(cacheKey);
    }

    const resolvePromise = (async () => {
        const Filesystem = getFilesystemPlugin();
        if (!Filesystem) {
            return base64Data;
        }

        const dirPath = `${MEDIA_CACHE_DIR}/${chatId}`;
        const filePath = `${dirPath}/${msgId}.jpg`;

        // NOT: convertFileSrc() kullanmıyoruz - uygulama Vercel'den canlı
        // yüklendiği için (server.url), Capacitor'ın yerel dosya şeması ile
        // sayfanın gerçek kökeni uyuşmuyor ve resim yüklenemiyordu. Bunun
        // yerine dosyayı doğrudan okuyup data: URI olarak veriyoruz - bu her
        // koşulda çalışır, köprüye (URL şemasına) hiç ihtiyaç duymaz.
        try {
            const existing = await Filesystem.readFile({ path: filePath, directory: 'DATA', encoding: 'base64' });
            const src = `data:image/jpeg;base64,${existing.data}`;
            mediaUriCache.set(cacheKey, src);
            return src;
        } catch (e) {
            // Dosya cihazda henüz yok, ilk kez yazılacak
        }

        try {
            const data = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
            await ensureDirOnce(Filesystem, dirPath);
            await Filesystem.writeFile({ path: filePath, data, directory: 'DATA' });
            const src = `data:image/jpeg;base64,${data}`;
            mediaUriCache.set(cacheKey, src);
            return src;
        } catch (err) {
            console.warn("Medya yerel diske yazılamadı:", err);
            return base64Data;
        }
    })();

    mediaResolveInFlight.set(cacheKey, resolvePromise);
    try {
        return await resolvePromise;
    } finally {
        mediaResolveInFlight.delete(cacheKey);
    }
}

function buildMessageElement(msg, isMine, msgId) {
    const msgDiv = document.createElement('div');
    msgDiv.dataset.msgId = msgId;
    msgDiv.dataset.mine = isMine ? 'true' : 'false';
    const timeStr = msg.createdAt ? new Date(msg.createdAt.toDate()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Şimdi';
    const isImage = msg.type === 'image' && msg.imageUrl;

    const bodyHtml = isImage
        ? `<img src="${msg.imageUrl}" class="rounded-lg max-w-full max-h-72 object-cover cursor-pointer" data-media-msg="${msgId}" onclick="openImageLightbox(this.src)">`
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

 if (isImage) {
        const mediaImgEl = msgDiv.querySelector(`[data-media-msg="${msgId}"]`);
        if (mediaImgEl) {
            // Yerel dosya yolu herhangi bir sebeple yüklenemezse (bozuk
            // sonuç verirse), orijinal base64'e geri dön - resim asla
            // bozuk görünmesin, en kötü ihtimalle önbellek devreye girmemiş olur.
            mediaImgEl.addEventListener('error', () => {
                if (mediaImgEl.src !== msg.imageUrl) {
                    mediaImgEl.src = msg.imageUrl;
                }
            });
        }
        resolveLocalMedia(currentChatId, msgId, msg.imageUrl).then((src) => {
            if (src && mediaImgEl && mediaImgEl.isConnected && src !== msg.imageUrl) {
                mediaImgEl.src = src;
            }
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
                createdAt: serverTimestamp(),
                read: false
            });


            await updateChatSummaries('📷 Fotoğraf');

        if (currentChatId !== 'global' && currentOtherUid) {
                sendPushToUser(currentOtherUid, `${currentUser.name}`, "📷 Bir fotoğraf gönderdi", {
                    chatId: currentChatId,
                    otherUid: currentUser.uid,
                    otherName: currentUser.name
                });
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
