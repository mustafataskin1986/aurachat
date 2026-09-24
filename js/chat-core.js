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
    collection, addDoc as rawAddDoc, onSnapshot, query, orderBy, limitToLast, limit, startAfter, where, getDocs,
    serverTimestamp, doc, setDoc, updateDoc, deleteDoc, arrayUnion, arrayRemove, getDoc, increment, Timestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getChatId, getUserColor, getInitials, escapeHtml } from "./ui-helpers.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { pushBackState, popBackState } from "./back-handler.js";
import { watchCallForChat, startCall } from "./video-call.js";
import { watchVoiceCallForChat, startVoiceCall } from "./voice-call.js";
import { watchGroupCallForChat } from "./group-call.js";
import "./image-viewer.js";

// DOM elementleri
const messageContainer = document.getElementById('message-container');
const messageInput = setupChatInput();
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

// Mesaj kutusunu <textarea> yapar. İkinci satıra geçince kutu boydan boya yayılır,
// + ve gönder/mikrofon butonları kutunun altına iner. Mesaj gidince tek satıra döner.
function setupChatInput() {
    const old = document.getElementById('message-input');
    if (!old) return old;

    const SINGLE_H = 46;    // tek satır yüksekliği (px)
    const WRAP_LIMIT = 56;  // scrollHeight bunu geçerse ikinci satır var demektir
    const MAX_H = 160;      // çok uzun yazıda en fazla bu kadar uzar

    const style = document.createElement('style');
    style.textContent = `
.aura-input-row{display:grid !important;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;column-gap:8px;row-gap:6px}
.aura-input-row[style*="display: none"]{display:none !important}
.aura-input-row > *{margin:0 !important}
.aura-input-row > #attach-btn{grid-column:1;grid-row:1}
.aura-input-row > #message-input{grid-column:2;grid-row:1}
.aura-input-row > #send-btn,.aura-input-row > #mic-btn{grid-column:3;grid-row:1}
.aura-input-row > :not(#attach-btn):not(#message-input):not(#send-btn):not(#mic-btn){grid-column:1 / 3;grid-row:1}
.aura-input-row.aura-multi > #message-input{grid-column:1 / -1;grid-row:1}
.aura-input-row.aura-multi > #attach-btn{grid-column:1;grid-row:2;justify-self:start}
.aura-input-row.aura-multi > #send-btn,.aura-input-row.aura-multi > #mic-btn{grid-column:3;grid-row:2;justify-self:end}
textarea#message-input{box-sizing:border-box !important;display:block;width:100% !important;min-height:${SINGLE_H}px;padding:10px 16px !important;line-height:24px !important;border-radius:23px !important;resize:none !important;overflow-x:hidden;white-space:pre-wrap;word-wrap:break-word;scrollbar-width:none;touch-action:manipulation}
textarea#message-input::-webkit-scrollbar{display:none}`;
    document.head.appendChild(style);

    // <input> ise aynı id ve class'larla <textarea>'ya çevir
    let ta = old;
    const valueDesc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (old.tagName !== 'TEXTAREA') {
        ta = document.createElement('textarea');
        Array.from(old.attributes).forEach((a) => {
            if (a.name === 'type' || a.name === 'value') return;
            ta.setAttribute(a.name, a.value);
        });
        valueDesc.set.call(ta, old.value || '');
        old.replaceWith(ta);
    }
    ta.rows = 1;
    ta.setAttribute('enterkeyhint', 'send');
    ta.setAttribute('autocomplete', 'off');

    // + ve gönder butonu kutuyla aynı satırdaysa grid düzenini aç
    const row = ta.parentElement;
    const layoutOk = !!(row && row.querySelector('#attach-btn') && row.querySelector('#send-btn'));
    if (layoutOk) row.classList.add('aura-input-row');

    function resize() {
        if (!ta.isConnected) return;
        if (layoutOk) row.classList.remove('aura-multi');
        ta.style.height = SINGLE_H + 'px';
        ta.style.overflowY = 'hidden';

        if (ta.scrollHeight > WRAP_LIMIT) {
            if (layoutOk) row.classList.add('aura-multi');
            ta.style.height = 'auto';
            const border = ta.offsetHeight - ta.clientHeight;
            const h = ta.scrollHeight + border;
            ta.style.height = Math.min(h, MAX_H) + 'px';
            ta.style.overflowY = h > MAX_H ? 'auto' : 'hidden';
        }
    }

    // "messageInput.value = ''" yazılınca da yükseklik sıfırlansın
    Object.defineProperty(ta, 'value', {
        configurable: true,
        get() { return valueDesc.get.call(this); },
        set(v) { valueDesc.set.call(this, v); resize(); }
    });

    ta.addEventListener('input', resize);
    window.addEventListener('resize', resize);
    resize();
    return ta;
}

// Modül durumu
let currentUser = null;
let currentChatId = null;
let currentChatName = '';
let currentOtherUid = null;
let currentOtherAvatar = '';
let currentIsGroup = false;
let typingTimeout = null;

let selectionMode = false;
const selectedMessageIds = new Set();
const messageElementsById = new Map();
let recentOpenScrollLock = false;
let unreadDivider = null; // { chatId, msgId, count }

// Son eklenen mesajın kimliğini tutar: bildirime mesaja özel tag vermek için
let lastAddedMsg = null;
async function addDoc(colRef, data) {
    const ref = await rawAddDoc(colRef, data);
    try {
        const parts = colRef.path.split('/'); // chats/{chatId}/messages
        lastAddedMsg = { chatId: parts[1], id: ref.id };
    } catch (e) {}
    return ref;
}

// ------------------------------------------
// GELEN ARAMA (uygulama açıkken her ekranda)
// Arayan, aranan kişinin incomingCalls/{uid} belgesine yazar. Burası o tek
// belgeyi dinler, ilgili sohbetin arama dinleyicisini açıp "Gelen arama" ekranını çıkarır.
// ------------------------------------------
let unsubIncomingCall = null;
let incomingWatchUid = null;

function startIncomingCallWatcher() {
    if (!currentUser || !currentUser.uid) {
        if (unsubIncomingCall) { unsubIncomingCall(); unsubIncomingCall = null; }
        incomingWatchUid = null;
        return;
    }
    if (unsubIncomingCall && incomingWatchUid === currentUser.uid) return;
    if (unsubIncomingCall) { unsubIncomingCall(); unsubIncomingCall = null; }
    incomingWatchUid = currentUser.uid;

    unsubIncomingCall = onSnapshot(doc(db, "incomingCalls", currentUser.uid), (snap) => {
        if (!snap.exists()) return;
        const d = snap.data();
        if (!d || !d.chatId || !d.at) return;
        if (Math.abs(Date.now() - d.at) > 90000) return; // eski arama
        if (window.__aurachatCallActive) return;          // zaten aramadayım
        if (d.isGroup) {
            window.__aurachatGroupIds = window.__aurachatGroupIds || new Set();
            window.__aurachatGroupIds.add(d.chatId);
            watchGroupCallForChat(d.chatId);
        } else {
            watchCallForChat(d.chatId);
            watchVoiceCallForChat(d.chatId);
        }
    }, () => {});
}

export function setCurrentUser(user) {
    setTimeout(() => { try { startIncomingCallWatcher(); } catch (e) {} }, 0);
    currentUser = user;
    // Başka uygulamadan (galeri vb.) "Paylaş" ile gelen resim varsa yakala
    try { checkPendingShare(); } catch (e) {}
}

// Basit, engellemeyen bildirim balonu - alert() yerine
export function showToast(message, durationMs = 2200) {
    try {
        const toast = document.createElement('div');
        toast.textContent = message;
        toast.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:rgba(32,44,51,0.95);color:#fff;padding:10px 18px;border-radius:9999px;font-size:13px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:80%;text-align:center;';
        document.body.appendChild(toast);
        setTimeout(() => { toast.remove(); }, durationMs);
    } catch (e) {}
}

function updateMyActiveChatId(chatId) {
    if (!currentUser) return;
    setDoc(doc(db, "users", currentUser.uid), { activeChatId: chatId || null }, { merge: true }).catch(() => {});
}

export function getCurrentChatId() {
    return currentChatId;
}

export function getCurrentUser() {
    return currentUser;
}


// ------------------------------------------
// ÇEVRİMİÇİ / SON GÖRÜLME (presence/{uid})
// Uygulama açıkken 45 sn'de bir lastSeen güncellenir; arka plana
// atınca/kapatınca online:false yazılır. Uygulama zorla kapanırsa
// online:true takılı kalır, o yüzden 2 dk'dan eski lastSeen çevrimdışı sayılır.
// ------------------------------------------
const PRESENCE_HEARTBEAT_MS = 30000;
const PRESENCE_STALE_MS = 75000;
let presenceTimer = null;
let unsubscribePresence = null;
let otherPresence = null; // { online, lastSeenMs } - açık sohbetteki karşı taraf
let presenceStatusTimer = null;

function writePresence(online) {
    if (!currentUser || !currentUser.uid) return;
    setDoc(doc(db, "presence", currentUser.uid), {
        online: online,
        lastSeen: serverTimestamp()
    }, { merge: true }).catch(() => {});
}

export function startPresence() {
    if (presenceTimer) return;
    writePresence(document.visibilityState === 'visible');
    presenceTimer = setInterval(() => {
        if (document.visibilityState === 'visible') writePresence(true);
    }, PRESENCE_HEARTBEAT_MS);
}

document.addEventListener('visibilitychange', () => {
    if (!presenceTimer) return;
    writePresence(document.visibilityState === 'visible');
});

window.addEventListener('pagehide', () => {
    if (presenceTimer) writePresence(false);
});

function formatLastSeen(ms) {
    const d = new Date(ms);
    const now = new Date();
    const timeStr = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= startOfToday) return `son görülme bugün ${timeStr}`;
    if (ms >= startOfToday - 86400000) return `son görülme dün ${timeStr}`;
    return `son görülme ${d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' })}`;
}

// Başlıktaki durum satırı: önce "yazıyor...", sonra çevrimiçi, sonra son görülme
function renderChatStatus() {
    if (!currentChatId || currentChatId === 'global') return;

if (currentIsGroup) {
        const gs = chatSessions.get(currentChatId);
        if (gs && gs.typingNames && gs.typingNames.length) {
            const label = gs.typingNames.length <= 2 ? gs.typingNames.join(', ') + ' yazıyor...' : gs.typingNames.length + ' kişi yazıyor...';
            activeChatStatus.innerHTML = `<span class="text-emerald-400 font-medium animate-pulse">${escapeHtml(label)}</span>`;
            return;
        }
        const memberUids = gs && gs.groupData && Array.isArray(gs.groupData.members) ? gs.groupData.members : [];
        const usersMap = window.__aurachatUsers;
        const names = memberUids.map((uid) => {
            if (currentUser && uid === currentUser.uid) return 'Sen';
            const u = usersMap && usersMap.get(uid);
            return u && u.name ? u.name : '';
        }).filter(Boolean);
        activeChatStatus.innerHTML = `<span class="text-gray-400 font-medium">${escapeHtml(names.join(', '))}</span>`;
        return;
    }

    if (presenceStatusTimer) { clearTimeout(presenceStatusTimer); presenceStatusTimer = null; }

    const session = chatSessions.get(currentChatId);
    if (session && session.otherTyping) {
        activeChatStatus.innerHTML = `<span class="text-emerald-400 font-medium animate-pulse">yazıyor...</span>`;
        return;
    }

    if (!otherPresence || !otherPresence.lastSeenMs) {
        activeChatStatus.textContent = '';
        return;
    }

    const age = Date.now() - otherPresence.lastSeenMs;
    if (otherPresence.online && age < PRESENCE_STALE_MS) {
        activeChatStatus.innerHTML = `<span class="text-emerald-400 font-medium">çevrimiçi</span>`;
        // Karşı taraf sessizce kaybolursa (app öldürüldü) süre dolunca kendiliğinden düşsün
        presenceStatusTimer = setTimeout(renderChatStatus, PRESENCE_STALE_MS - age + 500);
    } else {
        activeChatStatus.innerHTML = `<span class="text-gray-400 font-medium">${formatLastSeen(otherPresence.lastSeenMs)}</span>`;
    }
}

function stopWatchingPresence() {
    if (unsubscribePresence) { unsubscribePresence(); unsubscribePresence = null; }
    if (presenceStatusTimer) { clearTimeout(presenceStatusTimer); presenceStatusTimer = null; }
    otherPresence = null;
}

function watchOtherPresence(chatId, otherUid) {
    stopWatchingPresence();
    if (!otherUid) return;
    unsubscribePresence = onSnapshot(doc(db, "presence", otherUid), (snap) => {
        if (currentChatId !== chatId) return;
        if (snap.exists()) {
            const d = snap.data();
            otherPresence = {
                online: !!d.online,
                lastSeenMs: d.lastSeen ? d.lastSeen.toMillis() : 0
            };
        } else {
            otherPresence = null;
        }
        renderChatStatus();
    }, () => {});
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
        if (s.unsubscribeGroupDoc) s.unsubscribeGroupDoc();
        chatSessions.delete(lruId);
    }
}

async function ensureChatSession(chatId, otherUid) {
    const isGroup = isGroupChat(chatId);
    if (isGroup) otherUid = null;
    const existing = chatSessions.get(chatId);
    if (existing && isGroup) existing.isGroup = true;
    if (existing) {
        existing.lastUsed = ++sessionTick;
        return existing;
    }

    const session = {
        chatId,
        otherUid,
        isGroup,
        groupData: null,
        unsubscribeGroupDoc: null,
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

    if (isGroup) {
        try {
            const gSnap = await getDoc(doc(db, "groups", chatId));
            if (gSnap.exists()) session.groupData = gSnap.data();
        } catch (e) {}
    }

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
            // Sohbet yeni açıldıysa ve ilk veride okunmamış mesaj geldiyse çizgiyi şimdi kur
            if (recentOpenScrollLock && (!unreadDivider || unreadDivider.chatId !== chatId)) {
                unreadDivider = findUnreadDivider(session);
            }
            const keepPosition = !!(unreadDivider && unreadDivider.chatId === chatId) && !isNearBottom();
            const prevScrollTop = messageContainer.scrollTop;

            renderSession(session);
            markVisibleMessagesRead(session);

            if (keepPosition) {
                messageContainer.scrollTop = prevScrollTop;
            } else if (unreadDivider && unreadDivider.chatId === chatId && recentOpenScrollLock) {
                scrollToUnreadOrBottom();
            } else {
                scrollToBottom();
            }
        }
    }, (error) => {
        console.error("Mesajlar yüklenirken hata:", error);
    });

 if (isGroup) {
        session.unsubscribeGroupDoc = onSnapshot(doc(db, "groups", chatId), (gSnap) => {
            if (!gSnap.exists()) return;
            session.groupData = gSnap.data();
            if (currentChatId === chatId) {
                activeChatName.textContent = session.groupData.name || currentChatName;
                setGroupHeaderAvatar(session.groupData.photo);
                renderChatStatus();
            }
        }, () => {});
    }

 if (chatId !== 'global') {
        session.unsubscribeChatDoc = onSnapshot(doc(db, "chats", chatId), (docSnap) => {
            if (!docSnap.exists()) return;
            const data = docSnap.data();
            if (isGroup) {
                const usersMapT = window.__aurachatUsers;
                session.typingNames = Object.keys(data)
                    .filter((k) => k.startsWith('typing_') && data[k] === true && k !== `typing_${currentUser ? currentUser.uid : ''}`)
                    .map((k) => {
                        const u = usersMapT && usersMapT.get(k.slice(7));
                        return u && u.name ? u.name : 'Biri';
                    });
            } else {
                session.otherTyping = !!(otherUid && data[`typing_${otherUid}`]);
            }
            if (currentChatId === chatId) renderChatStatus();
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
if (session.isGroup) {
        if (!currentUser || document.visibilityState !== 'visible') return;

        let markedAny = false;
        session.messages.forEach(({ id, data: msg }) => {
            if (msg.senderUid === currentUser.uid || msg.type === 'system') return;
            const readBy = Array.isArray(msg.readBy) ? msg.readBy : [];
            if (!readBy.includes(currentUser.uid)) {
                updateDoc(doc(db, "chats", session.chatId, "messages", id), { readBy: arrayUnion(currentUser.uid) }).catch(() => {});
                markedAny = true;
            }
        });

        if (markedAny) {
            updateDoc(doc(db, "users", currentUser.uid, "chats", session.chatId), { unreadCount: 0 }).catch(() => {});

            // Son mesajı herkes okuduysa gönderenin listesinde tik maviye dönsün
            const lastEntry = session.messages[session.messages.length - 1];
            const members = session.groupData && Array.isArray(session.groupData.members) ? session.groupData.members : [];
            if (lastEntry && lastEntry.data.senderUid !== currentUser.uid && lastEntry.data.type !== 'system' && members.length) {
                const readSoFar = (Array.isArray(lastEntry.data.readBy) ? lastEntry.data.readBy : []).concat([currentUser.uid]);
                const allRead = members.filter((uid) => uid !== lastEntry.data.senderUid).every((uid) => readSoFar.includes(uid));
                if (allRead) {
                    updateDoc(doc(db, "users", lastEntry.data.senderUid, "chats", session.chatId), { lastMessageRead: true }).catch(() => {});
                }
            }
        }
        return;
    }
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
    // Her mesajın bildirimine mesaja özel tag veriyoruz: mesaj silinince
    // aynı tag'li yeni bildirim eskisinin yerine geçebilsin diye
    const pushTag = (extraData && extraData.tag)
        ? extraData.tag
        : ((lastAddedMsg && extraData && lastAddedMsg.chatId === extraData.chatId) ? `msg-${lastAddedMsg.id}` : undefined);

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

     // Alıcı bu sohbeti GERÇEKTEN açık tutuyorsa bildirim atma. activeChatId
        // uygulama aniden kapanınca Firestore'da takılı kalabiliyor, o yüzden
        // alıcının presence kaydı da taze ve çevrimiçi olmalı.
        if (userData?.activeChatId && extraData && extraData.chatId && userData.activeChatId === extraData.chatId) {
            let receiverReallyHere = false;
            try {
                const presSnap = await getDoc(doc(db, "presence", receiverUid));
                if (presSnap.exists()) {
                    const p = presSnap.data();
                    const ageMs = p.lastSeen ? Date.now() - p.lastSeen.toMillis() : Infinity;
                    receiverReallyHere = !!p.online && ageMs < PRESENCE_STALE_MS;
                }
            } catch (e) {}
            if (receiverReallyHere) return;
        }

        // Sunucu kimliğimi (giriş jetonu) doğrular, alıcının bildirim jetonunu kendisi okur
        const idToken = await getAuth().currentUser.getIdToken();

        const response = await fetch('https://aurachat-amber.vercel.app/api/send-notification', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${idToken}`
            },
            body: JSON.stringify({
                receiverUid: receiverUid,
                title: title,
                body: body,
                data: extraData,
                tag: pushTag
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
// CEVAPSIZ GÖRÜNTÜLÜ ARAMA KAYDI (video-call.js çağırır)
// Hem sohbet içine bir mesaj yazar hem de iki tarafın liste
// özetini (son mesaj) günceller.
// ------------------------------------------
export async function logMissedCall(chatId, callerUid, callerName, calleeUid, callType = 'video') {
    const label = callType === 'audio' ? "📞 Cevapsız sesli arama" : "📹 Cevapsız görüntülü arama";
    try {
        await addDoc(collection(db, "chats", chatId, "messages"), {
            type: 'missed_call',
            callType: callType,
            text: '',
            senderUid: callerUid,
            senderName: callerName,
            createdAt: serverTimestamp(),
            read: false
        });

        await setDoc(doc(db, "users", callerUid, "chats", chatId), {
            lastMessage: label,
            lastMessageTime: serverTimestamp(),
            lastSenderUid: callerUid,
            lastMessageRead: false,
            updatedAt: serverTimestamp()
        }, { merge: true });

        await setDoc(doc(db, "users", calleeUid, "chats", chatId), {
            lastMessage: label,
            lastMessageTime: serverTimestamp(),
            lastSenderUid: callerUid,
            lastMessageRead: false,
            unreadCount: increment(1),
            updatedAt: serverTimestamp()
        }, { merge: true });
    } catch (err) {
        console.error("Cevapsız arama kaydedilemedi:", err);
    }
}

// ------------------------------------------
// REDDEDİLEN GÖRÜNTÜLÜ ARAMA KAYDI (video-call.js, decline anında çağırır)
// ------------------------------------------
export async function logDeclinedCall(chatId, callerUid, callerName, calleeUid, callType = 'video') {
    const label = callType === 'audio' ? "📞 Reddedilen sesli arama" : "📹 Reddedilen görüntülü arama";
    try {
        await addDoc(collection(db, "chats", chatId, "messages"), {
            type: 'declined_call',
            callType: callType,
            text: '',
            senderUid: callerUid,
            senderName: callerName,
            createdAt: serverTimestamp(),
            read: false
        });

        await setDoc(doc(db, "users", callerUid, "chats", chatId), {
            lastMessage: label,
            lastMessageTime: serverTimestamp(),
            lastSenderUid: callerUid,
            lastMessageRead: false,
            updatedAt: serverTimestamp()
        }, { merge: true });

        await setDoc(doc(db, "users", calleeUid, "chats", chatId), {
            lastMessage: label,
            lastMessageTime: serverTimestamp(),
            lastSenderUid: callerUid,
            lastMessageRead: false,
            unreadCount: increment(1),
            updatedAt: serverTimestamp()
        }, { merge: true });
    } catch (err) {
        console.error("Reddedilen arama kaydedilemedi:", err);
    }
}

// ------------------------------------------
// KONUŞMA SÜRESİ KAYDI (aramayı kapatan taraf çağırır)
// Sohbete süre mesajı yazar, iki tarafın liste özetini günceller.
// Sessiz kayıt: okunmamış sayacı artmaz.
// ------------------------------------------
function formatCallDuration(totalSec) {
    const s = Math.max(0, Math.round(Number(totalSec) || 0));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m === 0) return `${rem} sn`;
    return rem ? `${m} dk ${rem} sn` : `${m} dk`;
}

export async function logCallDuration(chatId, myUid, myName, otherUid, callType = 'video', durationSec = 0) {
    const label = `${callType === 'audio' ? '📞 Sesli arama' : '📹 Görüntülü arama'} • ${formatCallDuration(durationSec)}`;
    try {
        await addDoc(collection(db, "chats", chatId, "messages"), {
            type: 'call_duration',
            callType: callType,
            duration: durationSec,
            text: '',
            senderUid: myUid,
            senderName: myName,
            createdAt: serverTimestamp(),
            read: true
        });

        await setDoc(doc(db, "users", myUid, "chats", chatId), {
            lastMessage: label,
            lastMessageTime: serverTimestamp(),
            lastSenderUid: myUid,
            lastMessageRead: true,
            updatedAt: serverTimestamp()
        }, { merge: true });

        await setDoc(doc(db, "users", otherUid, "chats", chatId), {
            lastMessage: label,
            lastMessageTime: serverTimestamp(),
            lastSenderUid: myUid,
            lastMessageRead: true,
            updatedAt: serverTimestamp()
        }, { merge: true });
    } catch (err) {
        console.error("Konuşma süresi kaydedilemedi:", err);
    }
}

// ------------------------------------------
// ÖZET DOKÜMANI (users/{uid}/chats/{chatId}) GÜNCELLEME
// ------------------------------------------
async function updateChatSummaries(lastMessageText) {
if (currentIsGroup || isGroupChat(currentChatId)) {
        return updateGroupSummaries(lastMessageText);
    }
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
            if (session.unsubscribeGroupDoc) session.unsubscribeGroupDoc();
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
// Grup sohbet başlığındaki avatar: fotoğraf varsa onu, yoksa grup simgesini göster
function setGroupHeaderAvatar(photo) {
    if (photo) {
        activeChatAvatar.style.backgroundColor = '';
        activeChatAvatar.className = "w-10 h-10 rounded-full overflow-hidden shadow flex-shrink-0";
        activeChatAvatar.innerHTML = `<img src="${photo}" class="w-full h-full object-cover">`;
    } else {
        activeChatAvatar.innerHTML = `<i class="fa-solid fa-user-group text-sm"></i>`;
    }
}

// ------------------------------------------
// KİŞİ ENGELLEME
// Engel listesi users/{uid}.blockedUids dizisinde tutulur (herkes
// okuyabilir, sadece sahibi yazabilir - mevcut kural zaten izin veriyor).
// Engel varsa (iki yönden de) mesaj kutusu ve arama düğmeleri gizlenir.
// ------------------------------------------
let blockedBannerEl = null;

function isBlockedRelationship(otherUid) {
    if (!currentUser || !otherUid) return { blockedByMe: false, blockedByThem: false };
    const usersMap = window.__aurachatUsers;
    const me = usersMap && usersMap.get(currentUser.uid);
    const them = usersMap && usersMap.get(otherUid);
    return {
        blockedByMe: !!(me && Array.isArray(me.blockedUids) && me.blockedUids.includes(otherUid)),
        blockedByThem: !!(them && Array.isArray(them.blockedUids) && them.blockedUids.includes(currentUser.uid))
    };
}

function ensureBlockedBanner() {
    if (blockedBannerEl) return blockedBannerEl;
    const el = document.createElement('div');
    el.className = 'hidden items-center justify-center px-4 py-3 bg-[#202c33] text-gray-400 text-xs text-center';
    messageInput.parentElement.insertAdjacentElement('beforebegin', el);
    blockedBannerEl = el;
    return el;
}

function updateBlockedUI() {
    const row = messageInput.parentElement;
    const banner = ensureBlockedBanner();

    if (!currentOtherUid || currentChatId === 'global' || currentIsGroup) {
        banner.classList.add('hidden');
        banner.classList.remove('flex');
        row.style.display = '';
        ['voice-call-btn', 'video-call-btn'].forEach((id) => {
            const b = document.getElementById(id);
            if (b) b.style.display = '';
        });
        return;
    }

    const { blockedByMe, blockedByThem } = isBlockedRelationship(currentOtherUid);

    if (blockedByMe || blockedByThem) {
        banner.innerHTML = blockedByMe
            ? `Bu kişiyi engellediniz. <button type="button" id="unblock-from-chat" class="text-emerald-400 font-semibold">Engeli kaldır</button>`
            : `Bu kişiyle mesajlaşamazsınız.`;
        banner.classList.remove('hidden');
        banner.classList.add('flex');
        row.style.display = 'none';
        ['voice-call-btn', 'video-call-btn'].forEach((id) => {
            const b = document.getElementById(id);
            if (b) b.style.display = 'none';
        });
        if (blockedByMe) {
            const btn = document.getElementById('unblock-from-chat');
            if (btn) btn.addEventListener('click', () => toggleBlockUser(currentOtherUid));
        }
    } else {
        banner.classList.add('hidden');
        banner.classList.remove('flex');
        row.style.display = '';
        ['voice-call-btn', 'video-call-btn'].forEach((id) => {
            const b = document.getElementById(id);
            if (b) b.style.display = '';
        });
    }
}

export async function toggleBlockUser(otherUid) {
    if (!currentUser || !otherUid) return;
    try {
        const usersMap = window.__aurachatUsers;
        const me = usersMap && usersMap.get(currentUser.uid);
        const alreadyBlocked = !!(me && Array.isArray(me.blockedUids) && me.blockedUids.includes(otherUid));
        await updateDoc(doc(db, "users", currentUser.uid), {
            blockedUids: alreadyBlocked ? arrayRemove(otherUid) : arrayUnion(otherUid)
        });
        showToast(alreadyBlocked ? 'Engel kaldırıldı' : 'Kişi engellendi');
        updateBlockedUI();
    } catch (err) {
        showToast('İşlem yapılamadı: ' + err.message, 3500);
    }
}

export async function selectChat(otherUser) {
    exitSelectionMode();
    cancelReply();
    currentIsGroup = false;
    toggleCallButtonsForGroup(false);

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
    } else if (otherUser && otherUser.isGroup) {
        chatId = otherUser.groupId;
        chatName = otherUser.name || 'Grup';
        otherUid = null;
        otherAvatar = '';
        currentIsGroup = true;
        toggleCallButtonsForGroup(true);
        window.__aurachatGroupIds = window.__aurachatGroupIds || new Set();
        window.__aurachatGroupIds.add(chatId);

        activeChatName.textContent = chatName;
        activeChatStatus.textContent = '';
        activeChatAvatar.style.backgroundColor = getUserColor(chatName);
        activeChatAvatar.className = "w-10 h-10 rounded-full flex items-center text-white font-bold justify-center shadow flex-shrink-0";
        activeChatAvatar.innerHTML = `<i class="fa-solid fa-user-group text-sm"></i>`;
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
    updateMyActiveChatId(chatId);
    watchOtherPresence(chatId, otherUid);
    renderChatStatus();

    if (window.innerWidth < 1024) {
        sidebar.classList.add('-translate-x-full');
        chatArea.classList.remove('translate-x-full');
        pushBackState(doCloseChatView);
    }

    const session = await ensureChatSession(chatId, otherUid);

    if (currentChatId !== chatId) return;

    session.lastUsed = ++sessionTick;
if (currentIsGroup && session.groupData) setGroupHeaderAvatar(session.groupData.photo);
    updateMicToggle();
    updateBlockedUI();
    unreadDivider = findUnreadDivider(session);
    renderSession(session);
    markVisibleMessagesRead(session);
    scrollToUnreadOrBottom();

    recentOpenScrollLock = true;
    setTimeout(() => { recentOpenScrollLock = false; }, 1500);

  if (!currentIsGroup) {
        watchGroupCallForChat(null);
        watchCallForChat(chatId);
        watchVoiceCallForChat(chatId);
    } else {
        watchGroupCallForChat(chatId);
    }
}
 
function doCloseChatView() {
closeAttachMenu();
cancelReply();
unreadDivider = null;
    updateMyActiveChatId(null);
    currentChatId = null;
    currentChatName = '';
    currentOtherUid = null;
    currentOtherAvatar = '';
    stopWatchingPresence();
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
        updateMyActiveChatId(currentChatId);
    } else if (document.visibilityState === 'hidden') {
        updateMyActiveChatId(null);
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
        const everyoneDeletedIds = new Set();

        try {
            for (const id of ids) {
                const el = messageElementsById.get(id);
                const isMine = el && el.dataset.mine === 'true';

                if (deleteForEveryone && isMine) {
                    const sessionForDelete = chatSessions.get(chatIdAtDeleteTime);
                    const delEntry = sessionForDelete && (
                        sessionForDelete.messages.find((m) => m.id === id) ||
                        sessionForDelete.olderMessagesPrepended.find((m) => m.id === id)
                    );
                    const wasUnread = !!(delEntry && delEntry.data.read === false);

                    await updateDoc(doc(db, "chats", chatIdAtDeleteTime, "messages", id), {
                        type: 'deleted',
                        deleted: true,
                        text: '',
                        imageUrl: null,
                        images: null,
                        imagesCount: 0,
                        lat: null,
                        lng: null,
                        audio: null,
                        audioDuration: null
                    });
                    everyoneDeletedIds.add(id);
// Grup: mesajı henüz okumamış üyelerin bildirimini "silindi" ile değiştir
                    if (currentIsGroup && delEntry && sessionForDelete && sessionForDelete.groupData) {
                        const gdDel = sessionForDelete.groupData;
                        const readByDel = Array.isArray(delEntry.data.readBy) ? delEntry.data.readBy : [];
                        (gdDel.members || []).forEach((memberUid) => {
                            if (memberUid === currentUser.uid || readByDel.includes(memberUid)) return;
                            sendPushToUser(memberUid, gdDel.name || 'Grup', "🚫 Bu mesaj silindi", {
                                chatId: chatIdAtDeleteTime,
                                otherUid: chatIdAtDeleteTime,
                                otherName: gdDel.name || 'Grup',
                                tag: `msg-${id}`
                            });
                        });
                    }

                    // Karşı taraf mesajı henüz okumadıysa bildirimi "silindi" ile değiştir
                    if (wasUnread && chatIdAtDeleteTime !== 'global' && currentOtherUid) {
                        sendPushToUser(currentOtherUid, `${currentUser.name}`, "🚫 Bu mesaj silindi", {
                            chatId: chatIdAtDeleteTime,
                            otherUid: currentUser.uid,
                            otherName: currentUser.name,
                            tag: `msg-${id}`
                        });
                    }
                } else {
                    await updateDoc(doc(db, "chats", chatIdAtDeleteTime, "messages", id), {
                        deletedFor: arrayUnion(currentUser.uid)
                    });
                }
            }
        } catch (err) {
            alert("Mesajlar silinemedi: " + err.message);
        }

        // Silinen mesaj sohbetin SON mesajıysa sohbet listesindeki önizlemeyi de güncelle
        try {
            const sessForSummary = chatSessions.get(chatIdAtDeleteTime);
            const lastEntry = sessForSummary && sessForSummary.messages[sessForSummary.messages.length - 1];
        if (lastEntry && everyoneDeletedIds.has(lastEntry.id) && currentIsGroup && sessForSummary.groupData) {
                await Promise.allSettled((sessForSummary.groupData.members || []).map((memberUid) =>
                    setDoc(doc(db, "users", memberUid, "chats", chatIdAtDeleteTime), { lastMessage: '🚫 Bu mesaj silindi' }, { merge: true })
                ));
            }
            if (lastEntry && everyoneDeletedIds.has(lastEntry.id) && chatIdAtDeleteTime !== 'global' && currentOtherUid) {
                await setDoc(doc(db, "users", currentUser.uid, "chats", chatIdAtDeleteTime), { lastMessage: '🚫 Bu mesaj silindi' }, { merge: true });
                await setDoc(doc(db, "users", currentOtherUid, "chats", chatIdAtDeleteTime), { lastMessage: '🚫 Bu mesaj silindi' }, { merge: true });
            }
        } catch (err) {}

        const session = chatSessions.get(chatIdAtDeleteTime);
        if (session) {
            const removeLocally = ids.filter((x) => !everyoneDeletedIds.has(x));
            session.olderMessagesPrepended = session.olderMessagesPrepended.filter(
                (m) => !removeLocally.includes(m.id)
            );
            session.messages = session.messages.filter((m) => !removeLocally.includes(m.id));
            everyoneDeletedIds.forEach((x) => {
                const e = session.messages.find((m) => m.id === x) || session.olderMessagesPrepended.find((m) => m.id === x);
                if (e) Object.assign(e.data, { type: 'deleted', deleted: true, text: '', imageUrl: null, images: null, imagesCount: 0, lat: null, lng: null });
            });
          everyoneDeletedIds.forEach((x) => {
                const e = session.messages.find((m) => m.id === x) || session.olderMessagesPrepended.find((m) => m.id === x);
                if (e) Object.assign(e.data, { type: 'deleted', deleted: true, text: '', imageUrl: null, images: null, imagesCount: 0, lat: null, lng: null });
            });
            if (currentChatId === chatIdAtDeleteTime) {
                renderSession(session);
            }
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
    const all = session.olderMessagesPrepended.concat(session.messages);
    let lastDayKey = null;

    all.forEach(({ id, data: msg }) => {
        if (currentUser && Array.isArray(msg.deletedFor) && msg.deletedFor.includes(currentUser.uid)) return;

        // Gün değişince tarih etiketi
        const msgDate = msg.createdAt ? msg.createdAt.toDate() : new Date();
        const dayKey = dayKeyOf(msgDate);
        if (dayKey !== lastDayKey) {
            fragment.appendChild(buildDateChipElement(msgDate));
            lastDayKey = dayKey;
        }

        // İlk okunmamış mesajın üstüne "N okunmamış mesaj" çizgisi
        if (unreadDivider && unreadDivider.chatId === session.chatId && unreadDivider.msgId === id) {
            fragment.appendChild(buildUnreadDividerElement(unreadDivider.count));
        }

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


// ------------------------------------------
// GALERİ DOSYA ADLARI
// Resim yalnızca galeriye (Pictures/AuraChat) yazılır, başka kopya yok.
// Ad: AuraChat_TARİH_SAAT_<mesajId>[_sıra].jpg - mesaj kimliği adın
// içinde olduğu için ayrı indekse gerek yok; klasör taranarak her
// resim kendi mesajına geri bağlanır.
// ------------------------------------------
const GALLERY_DIR = 'Pictures/AuraChat';
const GALLERY_NAME_RE = /^AuraChat_\d{8}_\d{6}_([A-Za-z0-9]{20})(?:_(\d+))?\.jpg$/;
let galleryFileMap = null; // "msgId" veya "msgId_idx" -> dosya adı
let galleryFileMapPromise = null;

function galleryKey(msgId, idx) {
    return (idx === null || idx === undefined) ? msgId : `${msgId}_${idx}`;
}

let galleryMapScannedAt = 0;
function loadGalleryFileMap() {
    if (galleryFileMapPromise) return galleryFileMapPromise;
    galleryMapScannedAt = Date.now();
    galleryFileMapPromise = (async () => {
        galleryFileMap = new Map();
        const Filesystem = getFilesystemPlugin();
        if (!Filesystem) return galleryFileMap;
        try {
            const dir = await Filesystem.readdir({ path: GALLERY_DIR, directory: 'EXTERNAL_STORAGE' });
            for (const f of (dir.files || [])) {
                const name = typeof f === 'string' ? f : f.name;
                const m = name && name.match(GALLERY_NAME_RE);
                if (m) {
                    const idx = m[2] ? parseInt(m[2], 10) - 1 : null;
                    galleryFileMap.set(galleryKey(m[1], idx), name);
                }
            }
        } catch (e) {
            // klasör henüz yok, ilk resim yazılınca oluşur
        }
        return galleryFileMap;
    })();
    return galleryFileMapPromise;
}

function getMessageTimeMs(chatId, msgId) {
    const s = chatSessions.get(chatId);
    if (s) {
        const m = s.messages.find((x) => x.id === msgId) || s.olderMessagesPrepended.find((x) => x.id === msgId);
        if (m && m.data.createdAt) return m.data.createdAt.toMillis();
    }
    return Date.now();
}

function buildGalleryFileName(timeMs, msgId, idx) {
    const d = new Date(timeMs);
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const idxPart = (idx === null || idx === undefined) ? '' : `_${idx + 1}`;
    return `AuraChat_${stamp}_${msgId}${idxPart}.jpg`;
}

const toImageSrc = (raw) => (typeof raw === 'string' && raw.startsWith('data:')) ? raw : `data:image/jpeg;base64,${raw}`;

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
            let map = await loadGalleryFileMap();
            // İzin verilmeden önce taranıp boş kaldıysa (ilk açılış) yeniden tara (en fazla 5 sn'de bir)
            if (map.size === 0 && Date.now() - galleryMapScannedAt > 5000) galleryFileMapPromise = null;
            map = await loadGalleryFileMap();
            const key = galleryKey(msgId, idx);
            const knownName = map.get(key);

            // 1. Galeride bu mesajın resmi varsa oradan oku
            if (knownName) {
                try {
                    const found = await Filesystem.readFile({
                        path: `${GALLERY_DIR}/${knownName}`,
                        directory: 'EXTERNAL_STORAGE'
                    });
                    const src = toImageSrc(found.data);
                    mediaUriCache.set(cacheKey, src);
                    return src;
                } catch (e) {
                    map.delete(key); // galeriden silinmiş
                }
            }

            // 2. Galeride yok, sunucudan gelen veri de yoksa gösterilecek bir şey kalmadı
            if (!base64Data) return null;

            // 3. Yeni kayıt: sadece galeriye yaz
            try {
                const pureBase64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
                const fileName = buildGalleryFileName(getMessageTimeMs(chatId, msgId), msgId, idx);

                await Filesystem.writeFile({
                    path: `${GALLERY_DIR}/${fileName}`,
                    data: pureBase64,
                    directory: 'EXTERNAL_STORAGE',
                    recursive: true
                });
                map.set(key, fileName);

                const src = `data:image/jpeg;base64,${pureBase64}`;
                mediaUriCache.set(cacheKey, src);
                return src;
            } catch (err) {
                console.warn("Medya galeriye yazılamadı:", err);
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

        const src = toImageSrc(base64Data);
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
    if (chatId === 'global' || isGroupChat(chatId)) return;
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
    if (chatId === 'global' || isGroupChat(chatId)) return;
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

    return `<div class="grid grid-cols-2 gap-0.5 rounded-lg overflow-hidden" style="width:280px;max-width:100%;">${tiles}</div>`;
}

function buildMessageElement(msg, isMine, msgId) {
   // Konuşma süresi mesajı: iki tarafta da ortada küçük etiket
    if (msg.type === 'call_duration') {
        const cdDiv = document.createElement('div');
        cdDiv.dataset.msgId = msgId;
        cdDiv.dataset.mine = 'false';
        cdDiv.className = 'flex justify-center';
        const cdAudio = msg.callType === 'audio';
        cdDiv.innerHTML = `<span class="bg-[#182229] text-gray-300 text-xs px-3 py-1 rounded-lg shadow"><i class="fa-solid ${cdAudio ? 'fa-phone' : 'fa-video'} mr-1.5"></i>${cdAudio ? 'Sesli arama' : 'Görüntülü arama'} • ${formatCallDuration(msg.duration)}</span>`;
        messageElementsById.set(msgId, cdDiv);
        return cdDiv;
    }

    // Sistem mesajı (örn. "X gruptan ayrıldı"): ortada küçük etiket
    if (msg.type === 'system') {
        const sysDiv = document.createElement('div');
        sysDiv.dataset.msgId = msgId;
        sysDiv.dataset.mine = 'false';
        sysDiv.className = 'flex justify-center';
        sysDiv.innerHTML = `<span class="bg-[#182229] text-gray-300 text-xs px-3 py-1 rounded-lg shadow">${escapeHtml(msg.text || '')}</span>`;
        messageElementsById.set(msgId, sysDiv);
        return sysDiv;
    }
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
} else if (msg.type === 'location') {
        bodyHtml = `<div class="cursor-pointer" style="min-width:200px;" onclick="openLocation(${Number(msg.lat)},${Number(msg.lng)})">
            <div class="rounded-lg bg-black/25 flex items-center justify-center" style="height:90px;"><i class="fa-solid fa-location-dot text-rose-500 text-4xl"></i></div>
            <p class="mt-1.5 font-medium text-sm">📍 Konum</p>
            <p class="text-[11px] text-gray-300">${Number(msg.lat).toFixed(5)}, ${Number(msg.lng).toFixed(5)}</p>
            <p class="text-[11px] text-sky-300 mt-0.5">Haritada aç</p>
        </div>`;
  } else if (msg.type === 'deleted') {
        bodyHtml = `<p class="break-words flex items-center gap-2 text-gray-400 italic text-[13px]"><i class="fa-solid fa-ban text-xs"></i> ${isMine ? 'Bu mesajı sildin' : 'Bu mesaj silindi'}</p>`;
} else if (msg.type === 'missed_call') {
        const missedIsVideo = msg.callType !== 'audio';
        const missedLabel = missedIsVideo ? 'Cevapsız görüntülü arama' : 'Cevapsız sesli arama';
        bodyHtml = `<p class="break-words flex items-center gap-2 text-rose-300 italic cursor-pointer" onclick="callBackFromBubble('${missedIsVideo ? 'video' : 'audio'}')"><i class="fa-solid ${missedIsVideo ? 'fa-video-slash' : 'fa-phone-slash'}"></i> ${missedLabel}</p>`;
    } else if (msg.type === 'declined_call') {
        const declinedIsVideo = msg.callType !== 'audio';
        const declinedLabel = declinedIsVideo ? 'Reddedilen görüntülü arama' : 'Reddedilen sesli arama';
        bodyHtml = `<p class="break-words flex items-center gap-2 text-rose-300 italic cursor-pointer" onclick="callBackFromBubble('${declinedIsVideo ? 'video' : 'audio'}')"><i class="fa-solid ${declinedIsVideo ? 'fa-video-slash' : 'fa-phone-slash'}"></i> ${declinedLabel}</p>`;
} else if (msg.type === 'audio') {
        bodyHtml = buildAudioBubbleHtml(msgId, msg);
    } else {
        bodyHtml = `<p class="break-words">${escapeHtml(msg.text)}</p>`;
    }

  const forwardedLabel = msg.forwarded
        ? `<div class="text-[11px] text-gray-300 italic px-2 pt-1 pb-0.5"><i class="fa-solid fa-share mr-1"></i>İletildi</div>`
        : '';

    const isReplyable = !['deleted', 'system', 'call_duration', 'missed_call', 'declined_call'].includes(msg.type);
    const replyQuoteHtml = buildReplyQuoteHtml(msg.replyTo);

    const actionButtonsHtml = isImage
        ? `<button type="button" class="flex-shrink-0 self-center w-8 h-8 rounded-full bg-black/30 hover:bg-black/50 text-gray-300 flex items-center justify-center ${isMine ? 'mr-2' : 'ml-2'}" onclick="forwardImageMessage('${msgId}')"><i class="fa-solid fa-share text-xs"></i></button>`
        : '';

    if (isMine) {
        const isReadByAll = currentIsGroup ? groupMessageReadByAll(msg) : !!msg.read;
        const tickColor = isReadByAll ? 'text-[#53bdeb]' : 'text-gray-400';
        const timeHtml = isImage
            ? `<div class="absolute bottom-2 right-2 flex items-center space-x-1 bg-black/45 rounded-full px-1.5 py-0.5">
                    <span class="text-[10px] text-white">${timeStr}</span>
                <i class="fa-solid fa-check-double text-[10px] ${isReadByAll ? 'text-[#53bdeb]' : 'text-gray-200'}"></i>
               </div>`
            : `<div class="flex items-center justify-end space-x-1 mt-1">
                    <span class="text-[10px] text-emerald-200">${timeStr}</span>
                    <i class="fa-solid fa-check-double text-[10px] ${tickColor}"></i>
               </div>`;

        msgDiv.className = "flex justify-end rounded-lg transition-colors";
        msgDiv.innerHTML = `
            ${actionButtonsHtml}
            <div class="bg-[#005c4b] text-white ${isImage ? 'p-1' : 'px-4 py-2'} rounded-xl max-w-[80%] md:max-w-md text-sm shadow relative">
                ${forwardedLabel}
                ${replyQuoteHtml}
                ${bodyHtml}
                ${timeHtml}
            </div>
        `;
    } else {
        const timeHtml = isImage
            ? `<div class="absolute bottom-2 right-2 bg-black/45 rounded-full px-1.5 py-0.5"><span class="text-[10px] text-white">${timeStr}</span></div>`
            : `<span class="text-[10px] text-gray-400 float-right ml-3 mt-1">${timeStr}</span>`;

        msgDiv.className = "flex justify-start rounded-lg transition-colors";
        msgDiv.innerHTML = `
            <div class="bg-[#202c33] text-gray-100 ${isImage ? 'p-1' : 'px-4 py-2'} rounded-xl max-w-[80%] md:max-w-md text-sm shadow relative">
              ${(currentChatId === 'global' || currentIsGroup) ? `<span class="text-[11px] font-bold text-amber-400 block mb-0.5 ${isImage ? 'px-2 pt-1' : ''}">${escapeHtml(msg.senderName)}</span>` : ''}
                ${forwardedLabel}
                ${replyQuoteHtml}
                ${bodyHtml}
                ${timeHtml}
            </div>
            ${actionButtonsHtml}
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

if (msg.type === 'audio') bindAudioPlayer(msgDiv, msgId, msg);

    if (selectedMessageIds.has(msgId)) {
        msgDiv.classList.add('bg-emerald-900/40');
    }

    attachSelectionHandlers(msgDiv, msgId, isReplyable, msg, isMine);
    messageElementsById.set(msgId, msgDiv);
    return msgDiv;
}

function attachSelectionHandlers(el, msgId, replyable, msg, isMine) {
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

    // Sağa kaydırıp bırakınca yanıtla (WhatsApp tarzı): parmakla birlikte hareket
    // eder, solda beliren ok belirli bir noktada durur, balon kaymaya devam eder.
    if (replyable) {
        el.style.touchAction = 'pan-y'; // dikey kaydırma tarayıcıda kalsın, yatayı biz yönetelim
        el.style.position = 'relative';

        const replyIcon = document.createElement('div');
        replyIcon.className = 'absolute top-1/2 left-1 text-emerald-400 opacity-0 pointer-events-none';
        replyIcon.style.transform = 'translateY(-50%)';
        replyIcon.innerHTML = '<i class="fa-solid fa-reply"></i>';
        el.insertBefore(replyIcon, el.firstChild);

        const SWIPE_TRIGGER = 10;
        const SWIPE_MAX = 80;
        const ICON_MAX = 28;

        let swipeStartX = null;
        let swipeStartY = null;
        let swiping = false;
        let swipeDecided = false;

        el.addEventListener('pointerdown', (e) => {
            if (selectionMode) return;
            swipeStartX = e.clientX;
            swipeStartY = e.clientY;
            swiping = false;
            swipeDecided = false;
            try { el.setPointerCapture(e.pointerId); } catch (err) {}
        });

        el.addEventListener('pointermove', (e) => {
            if (swipeStartX === null || selectionMode) return;
            const dx = e.clientX - swipeStartX;
            const dy = e.clientY - swipeStartY;

            if (!swipeDecided) {
                if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
                swipeDecided = true;
                if (dx > 0 && dx > Math.abs(dy)) {
                    swiping = true;
                    cancelPress();
                    el.style.transition = 'none';
                    replyIcon.style.transition = 'none';
                }
            }
         if (!swiping) return;
            e.preventDefault();
            const move = Math.max(0, Math.min(dx, SWIPE_MAX));
            el.style.transform = `translateX(${move}px)`;
            // İkon, el'in içinde olduğu için el kayınca o da kayar; ICON_MAX'tan
            // sonra net konumu sabit kalsın diye el'in kendi kaymasını geri çıkarıyoruz.
            const iconNet = Math.min(move, ICON_MAX);
            replyIcon.style.transform = `translateY(-50%) translateX(${iconNet - move}px)`;
            replyIcon.style.opacity = String(Math.min(1, move / SWIPE_TRIGGER));
        });

        const endSwipe = () => {
            if (swiping) {
                const applied = parseFloat((el.style.transform || '').replace(/[^0-9.]/g, '')) || 0;
                el.style.transition = 'transform 0.15s ease-out';
                el.style.transform = '';
                replyIcon.style.transition = 'opacity 0.15s ease-out';
                replyIcon.style.opacity = '0';
                replyIcon.style.transform = 'translateY(-50%)';
                if (applied >= SWIPE_TRIGGER) {
                    startReply(msgId, msg, isMine);
                    if (navigator.vibrate) navigator.vibrate(15);
                }
            }
            swipeStartX = null;
            swiping = false;
            swipeDecided = false;
        };

        el.addEventListener('pointerup', endSwipe);
        el.addEventListener('pointercancel', endSwipe);
    }

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

// ------------------------------------------
// "+" MENÜSÜ (WhatsApp tarzı: input'un altında açılır)
// Input çubuğuyla aynı renk, köşe yok, boşluk yok: input'un devamı gibi durur.
// Aşağı sürüklenince ya da geri tuşuyla kapanır.
// ------------------------------------------
let attachMenuEl = null;
let attachMenuOpen = false;
let attachDragStartY = null;

function ensureAttachMenu() {
    if (attachMenuEl) return attachMenuEl;
    const el = document.createElement('div');
    el.className = 'hidden flex-shrink-0 bg-[#202c33] px-4 pt-2 pb-6';
    el.innerHTML = `
        <div class="w-10 h-1 bg-gray-600 rounded-full mx-auto mb-4"></div>
        <div class="grid grid-cols-4 gap-y-4">
            <button type="button" data-attach="gallery" class="flex flex-col items-center space-y-1.5">
                <span class="w-16 h-11 rounded-full border border-gray-700 flex items-center justify-center text-sky-400 text-xl"><i class="fa-solid fa-images"></i></span>
                <span class="text-gray-300 text-xs">Galeri</span>
            </button>
            <button type="button" data-attach="camera" class="flex flex-col items-center space-y-1.5">
                <span class="w-16 h-11 rounded-full border border-gray-700 flex items-center justify-center text-pink-500 text-xl"><i class="fa-solid fa-camera"></i></span>
              <span class="text-gray-300 text-xs">Kamera</span>
            </button>
            <button type="button" data-attach="location" class="flex flex-col items-center space-y-1.5">
                <span class="w-16 h-11 rounded-full border border-gray-700 flex items-center justify-center text-emerald-400 text-xl"><i class="fa-solid fa-location-dot"></i></span>
                <span class="text-gray-300 text-xs">Konum</span>
            </button>
        </div>
    `;
    messageInput.parentElement.insertAdjacentElement('afterend', el);

    el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-attach]');
        if (btn) handleAttachChoice(btn.dataset.attach);
    });

    // Aşağı sürükleyerek kapatma
    el.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        attachDragStartY = e.touches[0].clientY;
        el.style.transition = 'none';
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
        if (attachDragStartY === null) return;
        const dy = e.touches[0].clientY - attachDragStartY;
        el.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
    }, { passive: true });

    el.addEventListener('touchend', (e) => {
        if (attachDragStartY === null) return;
        const dy = e.changedTouches[0].clientY - attachDragStartY;
        attachDragStartY = null;
        if (dy > 60) {
            closeAttachMenu();
        } else {
            el.style.transition = 'transform 0.15s ease-out';
            el.style.transform = '';
        }
    });

    el.addEventListener('touchcancel', () => {
        attachDragStartY = null;
        el.style.transition = 'transform 0.15s ease-out';
        el.style.transform = '';
    });

    attachMenuEl = el;
    return el;
}

function closeAttachMenuFromBack() {
    if (attachMenuEl) {
        attachMenuEl.classList.add('hidden');
        attachMenuEl.style.transition = '';
        attachMenuEl.style.transform = '';
    }
    attachMenuOpen = false;
}

function openAttachMenu() {
    if (attachMenuOpen) return;
    const menu = ensureAttachMenu();
    messageInput.blur();
    menu.style.transition = '';
    menu.style.transform = '';
    menu.classList.remove('hidden');
    attachMenuOpen = true;
    pushBackState(closeAttachMenuFromBack);
    scrollToBottom();
}

function closeAttachMenu() {
    if (!attachMenuOpen) return;
    closeAttachMenuFromBack();
    popBackState();
}

function handleAttachChoice(kind) {
    closeAttachMenu();
    if (kind === 'location') {
        sendCurrentLocation();
        return;
    }
    if (!imageInput) return;
    if (kind === 'camera') {
        imageInput.multiple = false;
        imageInput.setAttribute('capture', 'environment');
    } else {
        imageInput.multiple = true;
        imageInput.removeAttribute('capture');
    }
    imageInput.click();
}

// ------------------------------------------
// İLET (resim mesajını başka bir kişiye gönder)
// ------------------------------------------
let forwardPickerEl = null;
let forwardPickerOpen = false;
let forwardSource = null; // { chatId, msgId }

function closeForwardPickerFromBack() {
    if (forwardPickerEl) {
        forwardPickerEl.classList.add('hidden');
        forwardPickerEl.classList.remove('flex');
    }
    forwardPickerOpen = false;
    pendingShare = null;
}

function closeForwardPicker() {
    if (!forwardPickerOpen) return;
    closeForwardPickerFromBack();
    popBackState();
}

function ensureForwardPicker() {
    if (forwardPickerEl) return forwardPickerEl;
    const el = document.createElement('div');
    el.className = 'fixed inset-0 z-50 bg-[#0b141a] hidden flex-col';
    el.innerHTML = `
        <div class="bg-[#202c33] px-4 py-3.5 flex items-center space-x-4 border-b border-gray-800 flex-shrink-0">
            <button type="button" id="forward-back-btn" class="text-gray-400 hover:text-white transition text-lg px-1">
                <i class="fa-solid fa-arrow-left"></i>
            </button>
            <h2 class="text-white font-medium text-base">Şuna ilet</h2>
        </div>
        <div id="forward-list" class="flex-1 overflow-y-auto"></div>
    `;
    document.body.appendChild(el);
    el.querySelector('#forward-back-btn').addEventListener('click', closeForwardPicker);
    forwardPickerEl = el;
    return el;
}

function openForwardPicker() {
    const el = ensureForwardPicker();
    const titleEl = el.querySelector('h2');
    if (titleEl) titleEl.textContent = pendingShare ? 'Şuna gönder' : 'Şuna ilet';
    const listEl = el.querySelector('#forward-list');
    listEl.innerHTML = '';

    const usersMap = window.__aurachatUsers;
    const users = usersMap
        ? Array.from(usersMap.values()).filter((u) => u.uid !== currentUser.uid)
        : [];
    users.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'tr'));

    if (!users.length) {
        listEl.innerHTML = `<p class="text-center text-gray-500 text-xs py-8">İletilecek kişi bulunamadı.</p>`;
    }

    users.forEach((u) => {
        const row = document.createElement('div');
        row.className = 'flex items-center px-4 py-3 hover:bg-[#202c33]/60 cursor-pointer border-b border-gray-800/30';
        const avatarHtml = u.avatar
            ? `<img src="${u.avatar}" class="w-11 h-11 rounded-full object-cover shadow flex-shrink-0">`
            : `<div class="w-11 h-11 rounded-full flex items-center justify-center text-white font-bold text-sm shadow flex-shrink-0" style="background-color:${getUserColor(u.name || '?')};">${getInitials(u.name || '?')}</div>`;
        row.innerHTML = `${avatarHtml}<span class="text-white text-sm font-medium ml-3 truncate">${escapeHtml(u.name || '')}</span>`;
        row.addEventListener('click', () => forwardImageTo(u));
        listEl.appendChild(row);
    });

    el.classList.remove('hidden');
    el.classList.add('flex');
    forwardPickerOpen = true;
    pushBackState(closeForwardPickerFromBack);
}

async function updateSummariesForTarget(chatId, otherUid, otherName, lastMessageText) {
    if (!currentUser || !otherUid) return;
    try {
        await setDoc(doc(db, "users", currentUser.uid, "chats", chatId), {
            otherUid: otherUid,
            otherName: otherName,
            lastMessage: lastMessageText,
            lastMessageTime: serverTimestamp(),
            lastSenderUid: currentUser.uid,
            lastMessageRead: false,
            unreadCount: 0,
            updatedAt: serverTimestamp()
        }, { merge: true });

        await setDoc(doc(db, "users", otherUid, "chats", chatId), {
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
        console.error("İletilen mesajın özeti güncellenemedi:", err);
    }
}

async function forwardImageTo(targetUser) {
   if (pendingShare) { return sendSharedImagesTo(targetUser); }
    if (!forwardSource || !currentUser) return;
    const { chatId: srcChatId, msgId } = forwardSource;

    const session = chatSessions.get(srcChatId);
    const entry = session && (
        session.messages.find((m) => m.id === msgId) ||
        session.olderMessagesPrepended.find((m) => m.id === msgId)
    );
    if (!entry) { showToast('Mesaj bulunamadı'); return; }
    const msg = entry.data;

    closeForwardPicker();
    showToast('İletiliyor...');

    try {
        const payload = {
            type: 'image',
            text: '',
            senderUid: currentUser.uid,
            senderName: currentUser.name,
            createdAt: serverTimestamp(),
            read: false,
            forwarded: true
        };

        const imagesCount = msg.imagesCount || 0;
        if (imagesCount > 1) {
            const arr = Array.isArray(msg.images) ? msg.images : [];
            const images = [];
            for (let i = 0; i < imagesCount; i++) {
                const src = await resolveLocalMedia(srcChatId, msgId, arr[i], i);
                if (src) images.push(src);
            }
            if (!images.length) throw new Error('Resimler bulunamadı');
            payload.images = images;
            payload.imagesCount = images.length;
            payload.imagesDelivered = false;
        } else {
            const src = await resolveLocalMedia(srcChatId, msgId, msg.imageUrl);
            if (!src) throw new Error('Resim bulunamadı');
            payload.imageUrl = src;
        }

        const targetChatId = getChatId(currentUser.uid, targetUser.uid);
        await addDoc(collection(db, "chats", targetChatId, "messages"), payload);

        const isAlbum = payload.imagesCount > 1;
        await updateSummariesForTarget(targetChatId, targetUser.uid, targetUser.name, isAlbum ? `📷 ${payload.imagesCount} Fotoğraf` : '📷 Fotoğraf');

        sendPushToUser(targetUser.uid, `${currentUser.name}`, isAlbum ? `📷 ${payload.imagesCount} fotoğraf gönderdi` : "📷 Bir fotoğraf gönderdi", {
            chatId: targetChatId,
            otherUid: currentUser.uid,
            otherName: currentUser.name
        });

        showToast(`${targetUser.name} kişisine iletildi`);
    } catch (err) {
        console.error("İletme hatası:", err);
        showToast('İletilemedi');
    }
}

// ------------------------------------------
// BAŞKA UYGULAMADAN (galeri vb.) "Paylaş > AuraChat" İLE GELEN RESİMLER
// MainActivity.java resimleri hazırlar, window.AuraShare.consume() ile verir.
// Kişi seçme ekranı "ilet" ekranıyla aynı.
// ------------------------------------------
let pendingShare = null; // File[]
let shareCheckTimer = null;

function stopShareCheck() {
    if (shareCheckTimer) { clearInterval(shareCheckTimer); shareCheckTimer = null; }
}

function dataUrlToFile(dataUrl, name) {
    const bin = atob((dataUrl.split(',')[1]) || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: 'image/jpeg' });
}

// { state: 'none' | 'busy' | 'ok', files }
function consumeSharedImages() {
    try {
        if (!window.AuraShare || !window.AuraShare.consume) return { state: 'none' };
        const raw = window.AuraShare.consume();
        if (!raw) return { state: 'none' };
        if (raw === 'busy') return { state: 'busy' };
        const list = JSON.parse(raw);
        if (!Array.isArray(list) || !list.length) return { state: 'none' };
        return { state: 'ok', files: list.map((d, i) => dataUrlToFile(d, `shared_${i}.jpg`)) };
    } catch (e) {
        return { state: 'none' };
    }
}

function checkPendingShare() {
    if (shareCheckTimer) return;
    let tries = 0;
    shareCheckTimer = setInterval(() => {
        tries++;
        if (tries > 60) { stopShareCheck(); return; }
        if (!currentUser) return; // giriş yapılana kadar bekle (paylaşım native tarafta saklı kalır)
        if (!pendingShare) {
            const res = consumeSharedImages();
            if (res.state === 'none') { stopShareCheck(); return; }
            if (res.state === 'busy') return;
            pendingShare = res.files;
        }
        // Kişi listesi yüklenene kadar bekle
        if (!window.__aurachatUsers || window.__aurachatUsers.size === 0) return;
        stopShareCheck();
        openForwardPicker();
    }, 500);
}

window.addEventListener('aurachat-share', checkPendingShare);

async function sendSharedImagesTo(targetUser) {
    const files = pendingShare;
    pendingShare = null;
    if (!files || !files.length || !currentUser) return;

    closeForwardPicker();
    showToast('Gönderiliyor...', 3000);

    try {
        const perImageTarget = files.length > 1 ? 150 * 1024 : 300 * 1024;
        const maxTotalBytes = 900 * 1024;
        const compressed = [];
        let totalBytes = 0;

        for (const file of files) {
            try {
                const dataUrl = await compressImageToDataUrl(file, perImageTarget);
                const approxBytes = dataUrl.length * 0.75;
                if (totalBytes + approxBytes > maxTotalBytes) break;
                compressed.push(dataUrl);
                totalBytes += approxBytes;
            } catch (innerErr) {}
        }
        if (!compressed.length) throw new Error('Resim hazırlanamadı');

        const targetChatId = getChatId(currentUser.uid, targetUser.uid);
        const payload = {
            type: 'image',
            text: '',
            senderUid: currentUser.uid,
            senderName: currentUser.name,
            createdAt: serverTimestamp(),
            read: false
        };
        if (compressed.length === 1) {
            payload.imageUrl = compressed[0];
        } else {
            payload.images = compressed;
            payload.imagesCount = compressed.length;
            payload.imagesDelivered = false;
        }
        await addDoc(collection(db, "chats", targetChatId, "messages"), payload);

        const isAlbum = compressed.length > 1;
        await updateSummariesForTarget(targetChatId, targetUser.uid, targetUser.name, isAlbum ? `📷 ${compressed.length} Fotoğraf` : '📷 Fotoğraf');
        sendPushToUser(targetUser.uid, `${currentUser.name}`, isAlbum ? `📷 ${compressed.length} fotoğraf gönderdi` : "📷 Bir fotoğraf gönderdi", {
            chatId: targetChatId,
            otherUid: currentUser.uid,
            otherName: currentUser.name
        });

        if (currentChatId !== targetChatId) selectChat(targetUser);
        if (compressed.length < files.length) {
            showToast(`Boyut sınırı yüzünden ${compressed.length}/${files.length} fotoğraf gönderildi`, 4000);
        }
    } catch (err) {
        console.error("Paylaşılan resim gönderilemedi:", err);
        showToast('Gönderilemedi');
    }
}

window.forwardImageMessage = function (msgId) {
    if (!currentChatId || !currentUser) return;
    forwardSource = { chatId: currentChatId, msgId: msgId };
    openForwardPicker();
};

// ------------------------------------------
// MESAJA YANIT VERME (alıntı)
// Bir mesajın yanıt ikonuna basılınca composer'ın üstünde önizleme
// çubuğu açılır; gönderilen mesaja replyTo alanı eklenir (msgId,
// senderName, previewText). Balonda alıntı gösterilir, dokununca
// orijinal mesaja kaydırılır (hâlâ yüklüyse).
// ------------------------------------------
let replyingTo = null; // { msgId, senderName, previewText }
let replyBarEl = null;

function replyPreviewTextFor(msg) {
    if (msg.type === 'image') {
        const n = msg.imagesCount || 0;
        return n > 1 ? `📷 ${n} Fotoğraf` : '📷 Fotoğraf';
    }
    if (msg.type === 'audio') return `🎤 Sesli mesaj (${fmtAudioTime(msg.audioDuration)})`;
    if (msg.type === 'location') return '📍 Konum';
    return (msg.text || '').slice(0, 120);
}

function ensureReplyBar() {
    if (replyBarEl) return replyBarEl;
    const el = document.createElement('div');
    el.className = 'hidden items-start px-3 py-2 bg-[#202c33] border-l-4 border-emerald-500';
    el.innerHTML = `
        <div class="flex-1 min-w-0">
            <p id="reply-bar-name" class="text-emerald-400 text-xs font-semibold truncate"></p>
            <p id="reply-bar-text" class="text-gray-300 text-xs truncate"></p>
        </div>
        <button type="button" id="reply-bar-cancel" class="text-gray-400 hover:text-white px-2 flex-shrink-0"><i class="fa-solid fa-xmark"></i></button>
    `;
    messageInput.parentElement.insertAdjacentElement('beforebegin', el);
    el.querySelector('#reply-bar-cancel').addEventListener('click', cancelReply);
    replyBarEl = el;
    return el;
}

function startReply(msgId, msg, isMine) {
    replyingTo = {
        msgId: msgId,
        senderName: isMine ? 'Sen' : (msg.senderName || ''),
        previewText: replyPreviewTextFor(msg)
    };
    const el = ensureReplyBar();
    el.querySelector('#reply-bar-name').textContent = replyingTo.senderName;
    el.querySelector('#reply-bar-text').textContent = replyingTo.previewText;
    el.classList.remove('hidden');
    el.classList.add('flex');
    messageInput.focus();
}

function cancelReply() {
    replyingTo = null;
    if (replyBarEl) {
        replyBarEl.classList.add('hidden');
        replyBarEl.classList.remove('flex');
    }
}

function consumeReplyPayload() {
    if (!replyingTo) return null;
    const r = replyingTo;
    cancelReply();
    return { msgId: r.msgId, senderName: r.senderName, previewText: r.previewText };
}

function scrollToOriginalMessage(msgId) {
    const el = messageElementsById.get(msgId);
    if (!el) { showToast('Orijinal mesaj bulunamadı'); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('bg-emerald-900/30');
    setTimeout(() => el.classList.remove('bg-emerald-900/30'), 1000);
}

function buildReplyQuoteHtml(replyTo) {
    if (!replyTo) return '';
    return `<div class="reply-quote bg-black/20 rounded-md px-2 py-1.5 mb-1.5 border-l-2 border-emerald-400 cursor-pointer" onclick="jumpToReply('${replyTo.msgId}', event)">
        <p class="text-emerald-400 text-[11px] font-semibold truncate">${escapeHtml(replyTo.senderName || '')}</p>
        <p class="text-gray-300 text-[11px] truncate">${escapeHtml(replyTo.previewText || '')}</p>
    </div>`;
}

window.replyToMessage = function (msgId) {
    if (!currentChatId || !currentUser || selectionMode) return;
    const session = chatSessions.get(currentChatId);
    const entry = session && (
        session.messages.find((m) => m.id === msgId) ||
        session.olderMessagesPrepended.find((m) => m.id === msgId)
    );
    if (!entry) { showToast('Mesaj bulunamadı'); return; }
    const isMine = !!(currentUser && entry.data.senderUid === currentUser.uid);
    startReply(msgId, entry.data, isMine);
};

window.jumpToReply = function (msgId, event) {
    if (event) event.stopPropagation();
    if (selectionMode) return;
    scrollToOriginalMessage(msgId);
};

// ------------------------------------------
// GÜN ETİKETLERİ, "OKUNMAMIŞ MESAJ" ÇİZGİSİ VE KAYAN TARİH
// ------------------------------------------
function dayKeyOf(date) {
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatDayLabel(date) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const diffDays = Math.round((startOfToday - startOfDay) / 86400000);
    if (diffDays === 0) return 'Bugün';
if (diffDays === 1) return 'Dün';
    if (diffDays > 1 && diffDays <= 6) return date.toLocaleDateString('tr-TR', { weekday: 'long' });
    return date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function buildDateChipElement(date) {
    const el = document.createElement('div');
    el.dataset.dateChip = '1';
    el.dataset.label = formatDayLabel(date);
    el.className = 'flex justify-center';
    el.innerHTML = `<span class="bg-[#182229] text-gray-300 text-xs px-3 py-1 rounded-lg shadow">${el.dataset.label}</span>`;
    return el;
}

function buildUnreadDividerElement(count) {
    const el = document.createElement('div');
    el.dataset.unreadDivider = '1';
    el.className = 'flex justify-center';
    el.innerHTML = `<span class="bg-[#182229] text-emerald-300 text-xs font-medium px-3 py-1 rounded-lg shadow">${count} okunmamış mesaj</span>`;
    return el;
}

// Sohbet açılırken, karşı tarafın okunmamış mesajları varsa ilkinin
// kimliğini ve sayıyı döndürür. Okundu işaretlenmeden ÖNCE çağrılmalı.
function findUnreadDivider(session) {
if (session.chatId === 'global' || !currentUser) return null;
    const all = session.olderMessagesPrepended.concat(session.messages);
    let firstId = null;
    let count = 0;
    for (const { id, data: msg } of all) {
        if (Array.isArray(msg.deletedFor) && msg.deletedFor.includes(currentUser.uid)) continue;
        const isMine = msg.senderUid === currentUser.uid;
        const unreadForMe = session.isGroup
            ? (msg.type !== 'system' && !(Array.isArray(msg.readBy) && msg.readBy.includes(currentUser.uid)))
            : msg.read === false;
        if (!isMine && unreadForMe) {
            if (!firstId) firstId = id;
            count++;
        }
    }
    return firstId ? { chatId: session.chatId, msgId: firstId, count: count } : null;
}

function scrollToUnreadOrBottom() {
    requestAnimationFrame(() => {
        const divider = messageContainer.querySelector('[data-unread-divider]');
        if (divider) {
            const delta = divider.getBoundingClientRect().top - messageContainer.getBoundingClientRect().top;
            messageContainer.scrollTop += delta - 60;
        } else {
            messageContainer.scrollTop = messageContainer.scrollHeight;
        }
    });
}

// Kaydırırken üst barın altında beliren gün etiketi (kaydırma bitince kaybolur)
let floatingDateEl = null;
let floatingDateHideTimer = null;
let lastUserScrollInputAt = 0;

function ensureFloatingDate() {
    if (floatingDateEl) return floatingDateEl;
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;left:0;right:0;display:flex;justify-content:center;pointer-events:none;z-index:10;opacity:0;transition:opacity .2s;';
    el.innerHTML = '<span class="bg-[#182229] text-gray-300 text-xs px-3 py-1 rounded-lg shadow"></span>';
    messageContainer.parentElement.appendChild(el);
    floatingDateEl = el;
    return el;
}

['touchstart', 'touchmove', 'wheel'].forEach((evt) => {
    messageContainer.addEventListener(evt, () => { lastUserScrollInputAt = Date.now(); }, { passive: true });
});

messageContainer.addEventListener('scroll', () => {
    // Sohbet açılırken otomatik kaydırmada etiket görünmesin, sadece parmakla kaydırırken
    if (Date.now() - lastUserScrollInputAt > 2500) return;

    const chips = messageContainer.querySelectorAll('[data-date-chip]');
    if (!chips.length) return;

    const topEdge = messageContainer.getBoundingClientRect().top + 4;
    let label = chips[0].dataset.label;
    for (const chip of chips) {
        if (chip.getBoundingClientRect().top <= topEdge) label = chip.dataset.label;
        else break;
    }

    const el = ensureFloatingDate();
    el.style.top = (messageContainer.offsetTop + 8) + 'px';
    el.firstElementChild.textContent = label;
    el.style.opacity = '1';

    clearTimeout(floatingDateHideTimer);
    floatingDateHideTimer = setTimeout(() => { el.style.opacity = '0'; }, 1200);
}, { passive: true });

function scrollToBottom() {
    requestAnimationFrame(() => {
        messageContainer.scrollTop = messageContainer.scrollHeight;
    });
}

function isNearBottom() {
    return (messageContainer.scrollHeight - messageContainer.scrollTop - messageContainer.clientHeight) < 150;
}

// ------------------------------------------
// GERİ ARAMA ONAYI (cevapsız/reddedilen arama balonuna basınca çıkar)
// Doğrudan aramaz, isim + yeşil "Ara" düğmesiyle onay ister.
// ------------------------------------------
let callBackSheetEl = null;

function closeCallBackSheetFromBack() {
    if (callBackSheetEl) {
        callBackSheetEl.remove();
        callBackSheetEl = null;
    }
}

function closeCallBackSheet() {
    if (!callBackSheetEl) return;
    closeCallBackSheetFromBack();
    popBackState();
}

function openCallBackConfirm(callType) {
    closeCallBackSheetFromBack();
    const isVideo = callType === 'video';
    const name = currentChatName || '';
    const avatarHtml = currentOtherAvatar
        ? `<img src="${currentOtherAvatar}" class="w-16 h-16 rounded-full object-cover mx-auto">`
        : `<div class="w-16 h-16 rounded-full flex items-center justify-center text-white text-xl font-bold mx-auto" style="background-color:${getUserColor(name)};">${getInitials(name)}</div>`;

    const el = document.createElement('div');
    el.className = 'fixed inset-0 z-[70] bg-black/60 flex items-end';
    el.innerHTML = `
        <div class="w-full bg-[#202c33] rounded-t-2xl pb-6 px-5 pt-5 text-center">
            <div class="w-10 h-1 bg-gray-600 rounded-full mx-auto mb-4"></div>
            ${avatarHtml}
            <p class="text-white text-lg font-semibold mt-3">${escapeHtml(name)}</p>
            <button type="button" id="callback-confirm-btn" class="w-full mt-5 bg-emerald-500 hover:bg-emerald-400 text-black font-semibold py-3.5 rounded-full flex items-center justify-center space-x-2">
                <i class="fa-solid ${isVideo ? 'fa-video' : 'fa-phone'}"></i>
                <span>Ara</span>
            </button>
        </div>
    `;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
        if (e.target === el) closeCallBackSheet();
    });
    el.querySelector('#callback-confirm-btn').addEventListener('click', () => {
        const uid = currentOtherUid;
        const cid = currentChatId;
        closeCallBackSheet();
        if (isVideo) {
            startCall(cid, uid);
        } else {
            startVoiceCall(cid, uid);
        }
    });
    callBackSheetEl = el;
    pushBackState(closeCallBackSheetFromBack);
}

window.callBackFromBubble = function (callType) {
    if (!currentChatId || currentChatId === 'global' || !currentOtherUid) return;
    openCallBackConfirm(callType);
};

window.openImageLightbox = function (src) {
    const lightbox = document.getElementById('image-lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    if (!lightbox || !lightboxImg) return;
    albumViewerState = null;
    hideAlbumViewerControls();
    lightboxImg.style.transition = 'none';
    lightboxImg.style.transform = 'translateX(0)';
    lightboxImg.style.opacity = '1';
    lightboxImg.src = src;
    lightbox.classList.remove('hidden');
    lightbox.classList.add('flex');
    pushBackState(doCloseLightbox);
};

// ------------------------------------------
// ALBÜM GÖRÜNTÜLEYİCİ (WhatsApp tarzı: resimler alt alta akar)
// Albümdeki tüm resimler dikey bir listede alt alta dizilir, parmakla
// yukarı/aşağı kaydırılır. Üst ortada, ekranın ortasındaki resmin
// "kaçıncı / kaç" bilgisi görünür. Sol üstteki ok görüntüleyiciyi kapatır.
// ------------------------------------------
let albumViewerState = null;
let swipeStartX = null; // doCloseLightbox bunları sıfırlıyor, kalsınlar
let swipeStartY = null;

function findAlbumSourceImage(chatId, msgId, index) {
    const s = chatSessions.get(chatId);
    if (!s) return null;
    const entry = s.messages.find((m) => m.id === msgId) || s.olderMessagesPrepended.find((m) => m.id === msgId);
    return entry && Array.isArray(entry.data.images) ? (entry.data.images[index] || null) : null;
}

function updateAlbumViewerCounter() {
    if (!albumViewerState) return;
    const scrollEl = document.getElementById('lightbox-album-scroll');
    const counterEl = document.getElementById('lightbox-album-counter');
    if (!scrollEl || !counterEl) return;

    // Ekranın tam ortasındaki resmi bul
    const mid = scrollEl.scrollTop + scrollEl.clientHeight / 2;
    const slots = scrollEl.children;
    let current = 0;
    for (let i = 0; i < slots.length; i++) {
        if (slots[i].offsetTop <= mid) current = i;
        else break;
    }
    albumViewerState.index = current;
    counterEl.textContent = `${current + 1} / ${albumViewerState.imagesCount}`;
}

function ensureAlbumViewerControls() {
    const lightbox = document.getElementById('image-lightbox');
    if (!lightbox || document.getElementById('lightbox-album-counter')) return;

    const counter = document.createElement('div');
    counter.id = 'lightbox-album-counter';
    counter.className = 'absolute top-4 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-3 py-1 rounded-full z-20';

    const backBtn = document.createElement('button');
    backBtn.id = 'lightbox-album-back';
    backBtn.innerHTML = '<i class="fa-solid fa-arrow-left"></i>';
    backBtn.className = 'absolute top-3 left-3 bg-black/60 text-white w-9 h-9 rounded-full flex items-center justify-center z-20';
    backBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.closeImageLightboxUI();
    });

    lightbox.appendChild(counter);
    lightbox.appendChild(backBtn);
}

function hideAlbumViewerControls() {
    ['lightbox-album-counter', 'lightbox-album-back', 'lightbox-album-scroll'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.remove();
    });
    // Tek resim görüntüleyicisi bu elemanı kullanıyor, geri göster
    const lightboxImg = document.getElementById('lightbox-img');
    if (lightboxImg) lightboxImg.classList.remove('hidden');
}

window.openAlbumLightbox = async function (chatId, msgId, imagesCount, startIndex) {
    const lightbox = document.getElementById('image-lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    if (!lightbox || !lightboxImg) return;

    hideAlbumViewerControls();
    albumViewerState = { chatId, msgId, imagesCount, index: startIndex };
    lightboxImg.classList.add('hidden');

    const scrollEl = document.createElement('div');
    scrollEl.id = 'lightbox-album-scroll';
    scrollEl.className = 'absolute inset-0 overflow-y-auto';
    scrollEl.style.overscrollBehavior = 'contain';
    // Kaydırırken ya da resme dokunurken görüntüleyici kapanmasın
    scrollEl.addEventListener('click', (e) => e.stopPropagation());
    scrollEl.addEventListener('scroll', updateAlbumViewerCounter, { passive: true });

    // Resimler gelene kadar yer tutucular
    for (let i = 0; i < imagesCount; i++) {
        const slot = document.createElement('div');
        slot.className = 'flex items-center justify-center py-1';
        slot.style.minHeight = '40vh';
        slot.innerHTML = '<i class="fa-solid fa-image text-gray-600 text-2xl"></i>';
        scrollEl.appendChild(slot);
    }

    lightbox.appendChild(scrollEl);
    ensureAlbumViewerControls();
    updateAlbumViewerCounter();

    lightbox.classList.remove('hidden');
    lightbox.classList.add('flex');
    pushBackState(doCloseLightbox);

    const loads = [];
    for (let i = 0; i < imagesCount; i++) {
        const slot = scrollEl.children[i];
        loads.push((async () => {
            let src = mediaUriCache.get(`${chatId}/${msgId}_${i}`);
            if (!src) src = await resolveLocalMedia(chatId, msgId, findAlbumSourceImage(chatId, msgId, i), i);
            if (!src || !slot.isConnected) return;

            const img = new Image();
            img.className = 'w-full h-auto block mx-auto';
            img.style.maxWidth = '900px';
            img.src = src;
            try { await img.decode(); } catch (e) {}
            if (!slot.isConnected) return;

            slot.style.minHeight = '';
            slot.innerHTML = '';
            slot.appendChild(img);
        })());
    }
    await Promise.all(loads);

    // Dokunulan resmin olduğu yere kaydır
    if (!scrollEl.isConnected) return;
    if (startIndex > 0 && scrollEl.children[startIndex]) {
        scrollEl.scrollTop = scrollEl.children[startIndex].offsetTop;
    }
    updateAlbumViewerCounter();
};

function doCloseLightbox() {
    const lightbox = document.getElementById('image-lightbox');
    if (!lightbox) return;
    lightbox.classList.add('hidden');
    lightbox.classList.remove('flex');
    albumViewerState = null;
    swipeStartX = null;
    swipeStartY = null;
    hideAlbumViewerControls();
}

window.closeImageLightboxUI = function () {
    doCloseLightbox();
    popBackState();
};

// ------------------------------------------
// YENİ WHATSAPP TARZI GÖRÜNTÜLEYİCİ (image-viewer.js)
// Yukarıdaki eski lightbox fonksiyonlarını bu tanımlar geçersiz kılar.
// ------------------------------------------
let viewerBackActive = false;

function openViewer(o) {
    viewerBackActive = true;
    pushBackState(() => { viewerBackActive = false; window.closeImageViewer(); });
    o.onClose = () => {
        if (viewerBackActive) { viewerBackActive = false; popBackState(); }
    };
    o.onDownload = (it) => {
        if (getFilesystemPlugin()) { showToast('Resim galerine kaydedildi (Pictures/AuraChat)'); return; }
        const a = document.createElement('a');
        a.href = it.src;
        a.download = 'AuraChat_' + Date.now() + '.jpg';
        document.body.appendChild(a);
        a.click();
        a.remove();
    };
    o.onForward = (it) => {
        window.closeImageViewer();
        setTimeout(() => window.forwardImageMessage(it.id), 200);
    };
    o.onReply = (it) => {
        setTimeout(() => window.replyToMessage(it.id), 100);
    };
    window.openImageViewer(o);
}

function findMsgEntry(chatId, msgId) {
    const s = chatSessions.get(chatId);
    if (!s) return null;
    return s.messages.find((m) => m.id === msgId) || s.olderMessagesPrepended.find((m) => m.id === msgId) || null;
}

function makeViewerItem(entry, msgId, src) {
    const d = entry ? entry.data : null;
    const mine = !!(d && currentUser && d.senderUid === currentUser.uid);
    return {
        id: msgId,
        src: src,
        time: d && d.createdAt ? d.createdAt.toMillis() : Date.now(),
        senderName: mine ? 'Sen' : ((d && d.senderName) || currentChatName || '')
    };
}

window.openImageLightbox = function (src) {
    let msgId = null;
    try {
        const t = window.event && window.event.target;
        const row = t && t.closest ? t.closest('[data-msg-id]') : null;
        if (row) msgId = row.dataset.msgId;
    } catch (e) {}
    const entry = msgId ? findMsgEntry(currentChatId, msgId) : null;
    openViewer({ items: [makeViewerItem(entry, msgId, src)], index: 0, album: false });
};

window.openAlbumLightbox = async function (chatId, msgId, imagesCount, startIndex) {
    const entry = findMsgEntry(chatId, msgId);
    const srcs = await Promise.all(Array.from({ length: imagesCount }, async (_, i) => {
        let src = mediaUriCache.get(`${chatId}/${msgId}_${i}`);
        if (!src) src = await resolveLocalMedia(chatId, msgId, findAlbumSourceImage(chatId, msgId, i), i);
        return src || null;
    }));
    const items = [];
    let startPos = 0;
    srcs.forEach((src, i) => {
        if (!src) return;
        if (i <= startIndex) startPos = items.length;
        items.push(makeViewerItem(entry, msgId, src));
    });
    if (!items.length) return;
    openViewer({ items: items, index: startPos, album: items.length > 1 });
};

// ------------------------------------------
// MESAJ GÖNDERME
// ------------------------------------------
async function sendMessage() {
    const text = messageInput.value.trim();
    if (!text || !currentUser || !currentChatId) return;

    const replyPayload = consumeReplyPayload();

    try {
   if (currentChatId !== 'global') {
            await setDoc(doc(db, "chats", currentChatId), {
                [`typing_${currentUser.uid}`]: false
            }, { merge: true });
        }

        messageInput.value = '';
        updateMicToggle();

        await addDoc(collection(db, "chats", currentChatId, "messages"), {
            text: text,
            senderUid: currentUser.uid,
            senderName: currentUser.name,
            createdAt: serverTimestamp(),
            read: false,
            ...(replyPayload ? { replyTo: replyPayload } : {})
        });


        await updateChatSummaries(text);
        pushToGroupMembers(text);

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
    attachBtn.addEventListener('click', () => {
        if (attachMenuOpen) closeAttachMenu(); else openAttachMenu();
    });
    messageInput.addEventListener('focus', closeAttachMenu);
    messageContainer.addEventListener('click', closeAttachMenu);

    imageInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length || !currentUser || !currentChatId) return;
        imageInput.value = '';
        const replyPayload = consumeReplyPayload();

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

            let processedCount = 0;
            for (const file of validFiles) {
                processedCount++;
                if (activeChatStatus && validFiles.length > 1) {
                    activeChatStatus.innerHTML = `<span class="text-emerald-400">${processedCount}/${validFiles.length} fotoğraf hazırlanıyor...</span>`;
                }
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

            if (activeChatStatus && validFiles.length > 1) {
                activeChatStatus.innerHTML = `<span class="text-emerald-400">Gönderiliyor...</span>`;
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
                    read: false,
                    ...(replyPayload ? { replyTo: replyPayload } : {})
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
                    read: false,
                    ...(replyPayload ? { replyTo: replyPayload } : {})
                });
            }

            await updateChatSummaries(compressed.length > 1 ? `📷 ${compressed.length} Fotoğraf` : '📷 Fotoğraf');
            pushToGroupMembers(compressed.length > 1 ? `📷 ${compressed.length} fotoğraf gönderdi` : "📷 Bir fotoğraf gönderdi");

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
            if (activeChatStatus && validFiles.length > 1) {
                activeChatStatus.textContent = '';
            }
        }
    });
}

// ------------------------------------------
// SESLİ MESAJ
// Mikrofon düğmesine basılı tut, konuş, bırakınca gider. Sola kaydırıp bırakırsan iptal.
// Ses base64 olarak mesajın içinde gider (en fazla 2 dk: Firestore belge sınırı 1 MB).
// Yazı yazılmıyorken gönder düğmesinin yerinde mikrofon görünür.
// ------------------------------------------
const VOICE_MAX_SECONDS = 120;
const VOICE_MIN_SECONDS = 1;
let micBtn = null;
let recInfoEl = null;
let recState = null; // { recorder, stream, chunks, startMs, timerId, cancelled, released, startX, durationSec }

function fmtAudioTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Yazı varsa gönder, yoksa mikrofon düğmesi görünsün
function updateMicToggle() {
    if (!micBtn || !sendBtn || !messageInput) return;
    const hasText = messageInput.value.trim().length > 0;
    sendBtn.style.display = hasText ? '' : 'none';
    micBtn.style.display = hasText ? 'none' : '';
}

function pickVoiceMime() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (const m of candidates) {
        try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
    }
    return '';
}

function ensureRecInfo() {
    if (recInfoEl) return recInfoEl;
    const el = document.createElement('div');
    el.className = 'hidden flex-1 items-center px-4 py-2.5 rounded-full bg-[#202c33] text-white text-sm';
    el.innerHTML = `
        <span class="w-2.5 h-2.5 rounded-full bg-rose-500 animate-pulse mr-2 flex-shrink-0"></span>
        <span id="rec-time" class="font-mono">0:00</span>
        <span id="rec-hint" class="ml-auto pl-3 text-gray-400 text-xs truncate">‹ Sola kaydır: iptal</span>
    `;
    messageInput.insertAdjacentElement('beforebegin', el);
    recInfoEl = el;
    return el;
}

function setRecHint(cancelling) {
    const h = document.getElementById('rec-hint');
    if (!h) return;
    h.textContent = cancelling ? 'Bırakınca iptal edilir' : '‹ Sola kaydır: iptal';
    h.className = 'ml-auto pl-3 text-xs truncate ' + (cancelling ? 'text-rose-400' : 'text-gray-400');
}

function showRecordingUI() {
    const el = ensureRecInfo();
    el.classList.remove('hidden');
    el.classList.add('flex');
    messageInput.style.display = 'none';
    if (attachBtn) attachBtn.style.display = 'none';
    if (micBtn) micBtn.style.transform = 'scale(1.25)';
    const t = document.getElementById('rec-time');
    if (t) t.textContent = '0:00';
    setRecHint(false);
}

function hideRecordingUI() {
    if (recInfoEl) {
        recInfoEl.classList.add('hidden');
        recInfoEl.classList.remove('flex');
    }
    messageInput.style.display = '';
    if (attachBtn) attachBtn.style.display = '';
    if (micBtn) micBtn.style.transform = '';
}

async function startVoiceRecording(e) {
    if (recState || !currentUser || !currentChatId) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) {
        showToast('Bu cihaz ses kaydını desteklemiyor');
        return;
    }
    if (window.__aurachatCallActive) {
        showToast('Arama sırasında ses kaydedilemez');
        return;
    }
    try { micBtn.setPointerCapture(e.pointerId); } catch (err) {}

    const st = {
        recorder: null, stream: null, chunks: [], startMs: 0, timerId: null,
        cancelled: false, released: false, startX: e.clientX, durationSec: 0, mime: ''
    };
    recState = st;

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        recState = null;
        showToast('Mikrofon izni verilmedi');
        return;
    }

    // İzin penceresi açıkken parmak kalkmışsa kaydı başlatma
    if (st.released) {
        stream.getTracks().forEach((t) => t.stop());
        recState = null;
        return;
    }

    const mime = pickVoiceMime();
    let recorder;
    try {
        recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : { audioBitsPerSecond: 24000 });
    } catch (err) {
        stream.getTracks().forEach((t) => t.stop());
        recState = null;
        showToast('Ses kaydı başlatılamadı');
        return;
    }

    st.recorder = recorder;
    st.stream = stream;
    st.mime = mime || recorder.mimeType || 'audio/webm';
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) st.chunks.push(ev.data); };
    recorder.onstop = () => onVoiceStopped(st);
    recorder.start(1000);
    st.startMs = Date.now();

    showRecordingUI();
    st.timerId = setInterval(() => {
        const sec = (Date.now() - st.startMs) / 1000;
        const t = document.getElementById('rec-time');
        if (t) t.textContent = fmtAudioTime(sec);
        if (sec >= VOICE_MAX_SECONDS) finishVoiceRecording(false);
    }, 250);
    if (navigator.vibrate) navigator.vibrate(20);
}

function onVoiceMove(e) {
    if (!recState || !recState.recorder) return;
    const cancelling = (e.clientX - recState.startX) < -90;
    if (cancelling !== recState.cancelled) {
        recState.cancelled = cancelling;
        setRecHint(cancelling);
    }
}

function finishVoiceRecording(cancel) {
    const st = recState;
    if (!st) return;
    st.released = true;
    if (!st.recorder) return; // kayıt henüz başlamadı, başlatan taraf temizler
    if (cancel) st.cancelled = true;
    if (st.timerId) { clearInterval(st.timerId); st.timerId = null; }
    st.durationSec = Math.round((Date.now() - st.startMs) / 1000);
    hideRecordingUI();
    try {
        if (st.recorder.state !== 'inactive') st.recorder.stop();
        else onVoiceStopped(st);
    } catch (err) {
        onVoiceStopped(st);
    }
}

function onVoiceStopped(st) {
    if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
    st.stream = null;
    if (recState === st) recState = null;
    if (st.cancelled || st.done) return;
    st.done = true;
    if (st.durationSec < VOICE_MIN_SECONDS) {
        showToast('Konuşmak için basılı tut');
        return;
    }
    if (!st.chunks.length) return;

    const blob = new Blob(st.chunks, { type: st.mime });
    const reader = new FileReader();
    reader.onloadend = () => {
        if (typeof reader.result === 'string') sendVoiceMessage(reader.result, Math.min(st.durationSec, VOICE_MAX_SECONDS));
    };
    reader.readAsDataURL(blob);
}

async function sendVoiceMessage(dataUrl, durationSec) {
    if (!currentUser || !currentChatId) return;
    // Firestore belgesi 1 MB'ı geçemez
    if (dataUrl.length > 950000) {
        showToast('Ses çok uzun, daha kısa kaydet');
        return;
    }
    const replyPayload = consumeReplyPayload();
    try {
        await addDoc(collection(db, "chats", currentChatId, "messages"), {
            type: 'audio',
            audio: dataUrl,
            audioDuration: durationSec,
            text: '',
            senderUid: currentUser.uid,
            senderName: currentUser.name,
            createdAt: serverTimestamp(),
            read: false,
            ...(replyPayload ? { replyTo: replyPayload } : {})
        });

        await updateChatSummaries(`🎤 Sesli mesaj (${fmtAudioTime(durationSec)})`);
        pushToGroupMembers("🎤 Sesli mesaj gönderdi");

        if (currentChatId !== 'global' && currentOtherUid) {
            sendPushToUser(currentOtherUid, `${currentUser.name}`, "🎤 Sesli mesaj", {
                chatId: currentChatId,
                otherUid: currentUser.uid,
                otherName: currentUser.name
            });
        }
        scrollToBottom();
    } catch (err) {
        console.error("Sesli mesaj gönderilemedi:", err);
        showToast('Sesli mesaj gönderilemedi');
    }
}

(function setupMicButton() {
    if (!sendBtn || !sendBtn.parentElement || !messageInput) return;

    micBtn = sendBtn.cloneNode(false);
    micBtn.id = 'mic-btn';
    micBtn.type = 'button';
    const sendIcon = sendBtn.querySelector('i');
    const iconClass = sendIcon ? sendIcon.className.replace('fa-paper-plane', 'fa-microphone') : 'fa-solid fa-microphone';
    micBtn.innerHTML = `<i class="${iconClass}"></i>`;
    micBtn.style.touchAction = 'none';
    micBtn.style.userSelect = 'none';
    micBtn.style.webkitUserSelect = 'none';
    sendBtn.insertAdjacentElement('afterend', micBtn);

    micBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); startVoiceRecording(e); });
    micBtn.addEventListener('pointermove', onVoiceMove);
    micBtn.addEventListener('pointerup', () => finishVoiceRecording(false));
    micBtn.addEventListener('pointercancel', () => finishVoiceRecording(true));
    micBtn.addEventListener('contextmenu', (e) => e.preventDefault());

    messageInput.addEventListener('input', updateMicToggle);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && recState) finishVoiceRecording(true);
    });
    updateMicToggle();
})();

// ------------------------------------------
// SESLİ MESAJ BALONU (oynat / durdur + ilerleme çubuğu)
// ------------------------------------------
const audioPlayers = new Map(); // msgId -> { audio, ui }
let currentPlayingPlayer = null;

function buildAudioBubbleHtml(msgId, msg) {
    const dur = Math.max(0, Math.round(Number(msg.audioDuration) || 0));
    return `
        <div class="flex items-center space-x-2.5" style="min-width:190px;" data-audio-msg="${msgId}">
            <button type="button" class="audio-play-btn w-9 h-9 rounded-full bg-black/25 hover:bg-black/40 text-white flex items-center justify-center flex-shrink-0"><i class="fa-solid fa-play text-sm"></i></button>
            <div class="flex-1 min-w-0">
                <div class="h-1 rounded-full bg-white/25 overflow-hidden"><div class="audio-progress h-full bg-white/80" style="width:0%"></div></div>
                <p class="audio-time text-[11px] text-gray-300 mt-1">${fmtAudioTime(dur)}</p>
            </div>
            <i class="fa-solid fa-microphone text-gray-300 text-sm flex-shrink-0"></i>
        </div>`;
}

function paintAudio(player) {
    const ui = player.ui;
    if (!ui) return;
    const a = player.audio;
    const playing = !!(a && !a.paused);
    const t = a ? a.currentTime : 0;
    ui.icon.className = playing ? 'fa-solid fa-pause text-sm' : 'fa-solid fa-play text-sm';
    ui.bar.style.width = (ui.total > 0 && t > 0) ? Math.min(100, (t / ui.total) * 100) + '%' : '0%';
    ui.timeEl.textContent = fmtAudioTime(t > 0 ? t : ui.total);
}

function bindAudioPlayer(msgDiv, msgId, msg) {
    const wrap = msgDiv.querySelector(`[data-audio-msg="${msgId}"]`);
    if (!wrap) return;
    const btn = wrap.querySelector('.audio-play-btn');

    let player = audioPlayers.get(msgId);
    if (!player) {
        player = { audio: null, ui: null };
        audioPlayers.set(msgId, player);
    }
    // Liste yeniden çizilince arayüz elemanları değişir, çalan ses varsa yeni balona bağla
    player.ui = {
        icon: btn.querySelector('i'),
        bar: wrap.querySelector('.audio-progress'),
        timeEl: wrap.querySelector('.audio-time'),
        total: Math.max(0, Math.round(Number(msg.audioDuration) || 0))
    };
    paintAudio(player);

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (selectionMode) return;
        if (!msg.audio) { showToast('Sesli mesaj bulunamadı'); return; }

        if (currentPlayingPlayer && currentPlayingPlayer !== player && currentPlayingPlayer.audio) {
            currentPlayingPlayer.audio.pause();
        }

        if (!player.audio) {
            const a = new Audio(msg.audio);
            a.addEventListener('timeupdate', () => paintAudio(player));
            a.addEventListener('play', () => paintAudio(player));
            a.addEventListener('pause', () => paintAudio(player));
            a.addEventListener('ended', () => {
                a.currentTime = 0;
                paintAudio(player);
                if (currentPlayingPlayer === player) currentPlayingPlayer = null;
            });
            player.audio = a;
        }

        if (player.audio.paused) {
            player.audio.play().catch(() => showToast('Ses oynatılamadı'));
            currentPlayingPlayer = player;
        } else {
            player.audio.pause();
        }
    });
}

window.openLocation = function (lat, lng) {
    window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank');
};

async function sendCurrentLocation() {
    if (!currentUser || !currentChatId) return;
    const chatIdAtStart = currentChatId;
    const replyPayload = consumeReplyPayload();
    showToast('Konum alınıyor...', 4000);

    try {
        const Geo = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation;
        let pos;
        if (Geo) {
            pos = await Geo.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
        } else {
            pos = await new Promise((resolve, reject) => {
                if (!navigator.geolocation) { reject(new Error('Bu cihaz konumu desteklemiyor')); return; }
                navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000 });
            });
        }

        if (currentChatId !== chatIdAtStart) return;

        await addDoc(collection(db, "chats", chatIdAtStart, "messages"), {
            type: 'location',
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            text: '',
            senderUid: currentUser.uid,
            senderName: currentUser.name,
            createdAt: serverTimestamp(),
            read: false,
            ...(replyPayload ? { replyTo: replyPayload } : {})
        });

        await updateChatSummaries('📍 Konum');
        pushToGroupMembers("📍 Konum gönderdi");

        if (chatIdAtStart !== 'global' && currentOtherUid) {
            sendPushToUser(currentOtherUid, `${currentUser.name}`, "📍 Konum gönderdi", {
                chatId: chatIdAtStart,
                otherUid: currentUser.uid,
                otherName: currentUser.name
            });
        }

        scrollToBottom();
    } catch (err) {
        showToast('Konum alınamadı: ' + ((err && err.message) ? err.message : 'izni ve GPS\'i kontrol et'), 3500);
    }
}

// ------------------------------------------
// GRUP YARDIMCILARI
// ------------------------------------------
function toggleCallButtonsForGroup(isGroup) {
    ['voice-call-btn', 'video-call-btn'].forEach((id) => {
        const el = document.getElementById(id);
      if (el) el.style.display = ''; // grupta da sesli/görüntülü arama açık
    });
}

function isGroupChat(chatId) {
    if (window.__aurachatGroupIds && window.__aurachatGroupIds.has(chatId)) return true;
    const s = chatSessions.get(chatId);
    return !!(s && s.isGroup);
}

async function getGroupData(chatId) {
    const s = chatSessions.get(chatId);
    if (s && s.groupData) return s.groupData;
    const snap = await getDoc(doc(db, "groups", chatId));
    return snap.exists() ? snap.data() : null;
}

// Grupta her üyenin liste özetini günceller (son mesaj + okunmamış sayacı)
async function updateGroupSummaries(lastMessageText) {
    if (!currentUser || !currentChatId) return;
    const groupId = currentChatId;

    let gd = null;
    try {
        gd = await getGroupData(groupId);
    } catch (err) {
        showToast('Grup bilgisi okunamadı: ' + (err.message || err), 4000);
        return;
    }
    if (!gd) {
        showToast('Grup bulunamadı', 3000);
        return;
    }

    const results = await Promise.allSettled((gd.members || []).map((memberUid) => setDoc(doc(db, "users", memberUid, "chats", groupId), {
        isGroup: true,
        groupName: gd.name,
        lastMessage: lastMessageText,
        lastMessageTime: serverTimestamp(),
        lastSenderUid: currentUser.uid,
        lastSenderName: currentUser.name,
        lastMessageRead: false,
        unreadCount: memberUid === currentUser.uid ? 0 : increment(1),
        updatedAt: serverTimestamp()
    }, { merge: true })));

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
        const reason = failed[0].reason;
        showToast(`Liste güncellenemedi (${failed.length} üye): ` + ((reason && reason.message) || reason), 6000);
    }
}

// Grup mesajında gönderen hariç herkese bildirim
async function pushToGroupMembers(bodyText) {
if (!currentChatId || !isGroupChat(currentChatId) || !currentUser) return;
    const groupId = currentChatId;
    try {
        const gd = await getGroupData(groupId);
        if (!gd) return;
        (gd.members || []).forEach((memberUid) => {
            if (memberUid === currentUser.uid) return;
            sendPushToUser(memberUid, gd.name || 'Grup', `${currentUser.name}: ${bodyText}`, {
                chatId: groupId,
                otherUid: groupId,
                otherName: gd.name || 'Grup'
            });
        });
    } catch (err) {
        console.warn("Grup bildirimi gönderilemedi:", err);
    }
}

export async function leaveGroup(groupId) {
    if (!currentUser || !groupId) return;

    // Ayrılmadan ÖNCE (hâlâ üyeyken): gruba "ayrıldı" mesajı yaz, diğer üyelerin listesini ve bildirimini güncelle
    try {
        const gd = await getGroupData(groupId);
        if (gd) {
            const leaveText = `${currentUser.name} gruptan ayrıldı`;

            await addDoc(collection(db, "chats", groupId, "messages"), {
                type: 'system',
                text: leaveText,
                senderUid: currentUser.uid,
                senderName: currentUser.name,
                createdAt: serverTimestamp(),
                read: false
            });

            const others = (gd.members || []).filter((uid) => uid !== currentUser.uid);

            await Promise.allSettled(others.map((memberUid) => setDoc(doc(db, "users", memberUid, "chats", groupId), {
                isGroup: true,
                groupName: gd.name,
                lastMessage: leaveText,
                lastMessageTime: serverTimestamp(),
                lastSenderUid: currentUser.uid,
                lastSenderName: '',
                lastMessageRead: false,
                unreadCount: increment(1),
                updatedAt: serverTimestamp()
            }, { merge: true })));

            others.forEach((memberUid) => {
                sendPushToUser(memberUid, gd.name || 'Grup', leaveText, {
                    chatId: groupId,
                    otherUid: groupId,
                    otherName: gd.name || 'Grup'
                });
            });
        }
    } catch (err) {
        console.warn("Ayrılma mesajı yazılamadı:", err);
    }

    const session = chatSessions.get(groupId);
    if (session) {
        if (session.unsubscribeMessages) session.unsubscribeMessages();
        if (session.unsubscribeGroupDoc) session.unsubscribeGroupDoc();
        chatSessions.delete(groupId);
    }

    // Yönetici çıkıyorsa ve başka yönetici kalmıyorsa, kalan ilk üyeyi yönetici yap
    const groupUpdate = { members: arrayRemove(currentUser.uid) };
    try {
        const gd2 = await getGroupData(groupId);
        if (gd2) {
            const curAdmins = (Array.isArray(gd2.admins) && gd2.admins.length) ? gd2.admins : (gd2.createdBy ? [gd2.createdBy] : []);
            if (curAdmins.includes(currentUser.uid)) {
                const remainingMembers = (gd2.members || []).filter((u) => u !== currentUser.uid);
                let nextAdmins = curAdmins.filter((u) => u !== currentUser.uid && remainingMembers.includes(u));
                if (!nextAdmins.length && remainingMembers.length) nextAdmins = [remainingMembers[0]];
                groupUpdate.admins = nextAdmins;
            }
        }
    } catch (e) {}
    await updateDoc(doc(db, "groups", groupId), groupUpdate);
    await deleteDoc(doc(db, "users", currentUser.uid, "chats", groupId));
    await deleteChatDiskCache(groupId);
    if (window.__aurachatGroupIds) window.__aurachatGroupIds.delete(groupId);

    if (currentChatId === groupId) {
        const wasMobile = window.innerWidth < 1024;
        doCloseChatView();
        if (wasMobile) popBackState();
    }
}

function groupMessageReadByAll(msg) {
    const s = chatSessions.get(currentChatId);
    const members = s && s.groupData && Array.isArray(s.groupData.members) ? s.groupData.members : [];
    const readBy = Array.isArray(msg.readBy) ? msg.readBy : [];
    const others = members.filter((uid) => uid !== msg.senderUid);
    return others.length > 0 && others.every((uid) => readBy.includes(uid));
}