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
        serverTimestamp, doc, setDoc, updateDoc, deleteDoc, arrayUnion, arrayRemove, getDoc, getDocFromCache, increment, Timestamp, deleteField
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getChatId, getUserColor, getInitials, escapeHtml, getPhoneLast10 } from "./ui-helpers.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { pushBackState, popBackState } from "./back-handler.js";
import { auraDialog, auraAccent } from "./aura-dialog.js";
import { watchCallForChat, startCall } from "./video-call.js";
import { watchVoiceCallForChat, startVoiceCall } from "./voice-call.js";
import { watchGroupCallForChat } from "./group-call.js";
import "./image-viewer.js";
import { setupComposer } from "./chat-composer.js";

// DOM elementleri
const messageContainer = document.getElementById('message-container');
const composer = setupComposer();
const messageInput = composer.input;
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
const selectionReplyBtn = document.getElementById('selection-reply-btn');
const selectionStarBtn = document.getElementById('selection-star-btn');
const selectionCopyBtn = document.getElementById('selection-copy-btn');
const selectionForwardBtn = document.getElementById('selection-forward-btn');

// Modül durumu
let currentUser = null;
let currentChatId = null;
let currentChatName = '';
let currentOtherUid = null;
let currentOtherAvatar = '';
let currentIsGroup = false;
let typingTimeout = null;
let lastTypingWriteAt = 0;
let sendPendingImages = async () => {};

let selectionMode = false;
const selectedMessageIds = new Set();
const messageElementsById = new Map();
const expandedMsgIds = new Set(); // "Devamını okuyun" ile açılmış mesajlar

// Her göndericiye sabit, okunaklı bir renk (kimlikten hesaplanır)
function senderColor(msg, light) {
    const key = String(msg.senderUid || msg.senderName || '?');
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return `hsl(${(h % 12) * 30 + 8}, 68%, ${light || 66}%)`;
}

// Grupta, rehberinde kayıtlı olmayan kişinin numarası (rehber okunamadıysa boş döner)
function unsavedSenderPhone(msg) {
    if (!currentIsGroup || !msg.senderUid) return '';
    const local = window.__aurachatLocalPhones;
    if (!local || local.size === 0) return '';
    const u = window.__aurachatUsers && window.__aurachatUsers.get(msg.senderUid);
    if (!u || !u.phone) return '';
    const l10 = getPhoneLast10(u.phone);
    if (!l10 || local.has(l10)) return '';
    return String(u.phone);
}

function senderLineHtml(msg, isImage) {
    const phone = unsavedSenderPhone(msg);
    return `<div class="flex items-baseline justify-between gap-3 mb-0.5 ${isImage ? 'px-2 pt-1' : ''}"><span class="text-[11px] font-bold truncate" style="color:${senderColor(msg)}">${phone ? '~ ' : ''}${escapeHtml(msg.senderName)}</span>${phone ? `<span class="text-[11px] flex-shrink-0 text-gray-400">${escapeHtml(phone)}</span>` : ''}</div>`;
}
let recentOpenScrollLock = false;
let unreadDivider = null; // { chatId, msgId, count }
let tempIncoming = null; // bildirimden çizilen geçici balon: { chatId, msgId, at }

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
    try { syncNativeNotifSession(); } catch (e) {}
        try { startStarredWatch(); } catch (e) {}
}

// Android uygulaması: bildirimdeki "Cevapla" / "Okundu" düğmelerinin çalışması için oturum bilgisini telefona verir
async function syncNativeNotifSession() {
    if (!window.AuraNotif || !window.AuraNotif.setSession) return;
    try {
        const a = getAuth();
        if (a.authStateReady) await Promise.race([a.authStateReady(), new Promise((r) => setTimeout(r, 5000))]);
        const u = a.currentUser;
        if (!u || !u.refreshToken || !currentUser) return;
        window.AuraNotif.setSession(u.uid, u.refreshToken);
        await setDoc(doc(db, "users", currentUser.uid), { nativeMsgStyle: true }, { merge: true });
    } catch (e) {}
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
        try { if (chatId && window.AuraNotif && window.AuraNotif.clearChat) window.AuraNotif.clearChat(String(chatId)); } catch (e) {}
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
const PRESENCE_HEARTBEAT_MS = 10000;
const PRESENCE_STALE_MS = 25000;
let presenceTimer = null;
let unsubscribePresence = null;
let otherPresence = null; // { online, lastSeenMs } - açık sohbetteki karşı taraf
let presenceHidden = false; // true = son görülme/çevrimiçi gizli (karşılıklı: ben de başkalarınınkini görmem)
try { presenceHidden = localStorage.getItem('aura_presence_hidden') === '1'; } catch (e) {}

export function getPresenceHidden() {
    return presenceHidden;
}
// Okundu bilgisi (mavi tik) kapalıysa: ben mesajı okusam da gönderen görmez (ben başkalarınınkini görmeye devam ederim)
let readReceiptsHidden = false;
try { readReceiptsHidden = localStorage.getItem('aura_receipts_hidden') === '1'; } catch (e) {}

export function getReadReceiptsHidden() {
    return readReceiptsHidden;
}

export function setReadReceiptsHidden(hidden) {
    readReceiptsHidden = !!hidden;
    try { localStorage.setItem('aura_receipts_hidden', readReceiptsHidden ? '1' : '0'); } catch (e) {}
    if (currentUser && currentUser.uid) {
        setDoc(doc(db, "presence", currentUser.uid), { hideReceipts: readReceiptsHidden }, { merge: true }).catch(() => {});
    }
}

// Okundu bilgisi kapalıyken okuduğum mesajları bu cihazda hatırla (okunmamış çizgisi tekrar çıkmasın, sonradan "okundu" gitmesin)
function getChatLastReadMs(chatId) {
    try { return Number(localStorage.getItem('aura_lastread_' + chatId)) || 0; } catch (e) { return 0; }
}

function setChatLastReadMs(chatId, ms) {
    try { if (ms > getChatLastReadMs(chatId)) localStorage.setItem('aura_lastread_' + chatId, String(ms)); } catch (e) {}
}

function msgCreatedMs(msg) {
    return msg && msg.createdAt && typeof msg.createdAt.toMillis === 'function' ? msg.createdAt.toMillis() : 0;
}
export function setPresenceHidden(hidden) {
    presenceHidden = !!hidden;
    try { localStorage.setItem('aura_presence_hidden', presenceHidden ? '1' : '0'); } catch (e) {}
    if (currentUser && currentUser.uid) {
        if (presenceHidden) {
            setDoc(doc(db, "presence", currentUser.uid), { hidden: true, online: false, lastSeen: deleteField() }, { merge: true }).catch(() => {});
        } else {
            setDoc(doc(db, "presence", currentUser.uid), { hidden: false }, { merge: true })
                .then(() => writePresence(document.visibilityState === 'visible'))
                .catch(() => {});
        }
    }
    renderChatStatus();
}

// Başka cihazda yapılan gizlilik seçimini sunucudan al
function syncPresenceHidden() {
    if (!currentUser || !currentUser.uid) return Promise.resolve();
    return getDoc(doc(db, "presence", currentUser.uid)).then((snap) => {
        if (!snap.exists()) return;
                const hr = !!snap.data().hideReceipts;
        if (hr !== readReceiptsHidden) {
            readReceiptsHidden = hr;
            try { localStorage.setItem('aura_receipts_hidden', hr ? '1' : '0'); } catch (e) {}
        }
        const h = !!snap.data().hidden;
        if (h !== presenceHidden) {
            presenceHidden = h;
            try { localStorage.setItem('aura_presence_hidden', h ? '1' : '0'); } catch (e) {}
            renderChatStatus();
        }
    }).catch(() => {});
}
let presenceStatusTimer = null;

function writePresence(online) {
    if (!currentUser || !currentUser.uid) return;
    if (presenceHidden) return;
    setDoc(doc(db, "presence", currentUser.uid), {
        online: online,
        lastSeen: serverTimestamp()
    }, { merge: true }).catch(() => {});
}

export function startPresence() {
    if (presenceTimer) return;
    presenceTimer = setInterval(() => {
        if (document.visibilityState === 'visible') writePresence(true);
    }, PRESENCE_HEARTBEAT_MS);
    syncPresenceHidden().then(() => writePresence(document.visibilityState === 'visible'));
}

document.addEventListener('visibilitychange', () => {
    if (!presenceTimer) return;
    writePresence(document.visibilityState === 'visible');
});

window.addEventListener('pagehide', () => {
    if (presenceTimer) writePresence(false);
    if (currentUser && currentChatId && currentChatId !== 'global') {
        setDoc(doc(db, "chats", currentChatId), { [`typing_${currentUser.uid}`]: false }, { merge: true }).catch(() => {});
    }
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

// Açık sohbette kendi okunmamış sayacımı sıfırda tut: gönderen sayacı, ben mesajı okundu yaptıktan SONRA artırabiliyor
let unsubscribeMyUnread = null;

function stopWatchingMyUnread() {
    if (unsubscribeMyUnread) { unsubscribeMyUnread(); unsubscribeMyUnread = null; }
}

// Sohbet açılınca o sohbetin bildirim çubuğundaki mesaj bildirimlerini temizle (WhatsApp gibi)
function clearDeliveredNotificationsForChat(chatId, chatName) {
    try {
        const PN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
        if (!PN || !PN.getDeliveredNotifications || !PN.removeDeliveredNotifications) return;
        PN.getDeliveredNotifications().then((res) => {
            const list = ((res && res.notifications) || []).filter((n) => {
                const d = n.data || {};
                return String(n.tag || '').indexOf('msg-') === 0 && (d.chatId === chatId || n.title === chatName);
            });
            if (list.length) PN.removeDeliveredNotifications({ notifications: list }).catch(() => {});
        }).catch(() => {});
    } catch (e) {}
}

function watchMyUnread(chatId) {
    stopWatchingMyUnread();
    if (!currentUser || !chatId || chatId === 'global') return;
    unsubscribeMyUnread = onSnapshot(doc(db, "users", currentUser.uid, "chats", chatId), (snap) => {
        if (currentChatId !== chatId || document.visibilityState !== 'visible') return;
        if (snap.exists() && Number(snap.data().unreadCount || 0) > 0) {
            updateDoc(snap.ref, { unreadCount: 0 }).catch(() => {});
        }
    }, () => {});
}

function watchOtherPresence(chatId, otherUid) {
    stopWatchingPresence();
    if (!otherUid) return;
    unsubscribePresence = onSnapshot(doc(db, "presence", otherUid), (snap) => {
        if (currentChatId !== chatId) return;
              if (snap.exists() && !snap.data().hidden) {
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
             if (id === protectedChatId || id === currentChatId) continue;
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

// Aynı sohbet için kurulum sürerken ikinci çağrı yarım oturumu değil, bitmiş oturumu alsın
const sessionBuilds = new Map();

function ensureChatSession(chatId, otherUid) {
    const existing = chatSessions.get(chatId);
    if (existing) {
        existing.lastUsed = ++sessionTick;
        if (isGroupChat(chatId)) existing.isGroup = true;
        const pending = sessionBuilds.get(chatId);
        return pending ? pending : Promise.resolve(existing);
    }
    const p = buildChatSession(chatId, otherUid).finally(() => sessionBuilds.delete(chatId));
    sessionBuilds.set(chatId, p);
    return p;
}

async function buildChatSession(chatId, otherUid) {
if (!window.__auraTBuild) window.__auraTBuild = Math.round(performance.now());
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

   // Disk önbelleğindeki mesajları ağ cevabını beklemeden hemen göster (sohbet boş görünmesin)
    if (diskCache && diskCache.messages.length && currentChatId === chatId) {
        unreadDivider = findUnreadDivider(session);
        renderSession(session);
        if (!appendLaunchTemps(session) && document.documentElement.hasAttribute('data-aura-launch') && !unreadDivider && Number(window.__auraLaunchPending) > 0) {
            messageContainer.appendChild(buildUnreadDividerElement(Number(window.__auraLaunchPending)));
        }
                        scrollToUnreadOrBottom();
        if (window.__auraOnFirstPaint) window.__auraOnFirstPaint();
    }
 if (chatId !== 'global' && currentUser && session.clearedAt === null && !(diskCache && diskCache.messages.length)) {
        try {
            let mySummarySnap;
            try {
                // Önce yerel önbellekten oku (ağ beklemeden), yoksa sunucudan
                mySummarySnap = await getDocFromCache(doc(db, "users", currentUser.uid, "chats", chatId));
            } catch (cacheErr) {
                mySummarySnap = await getDoc(doc(db, "users", currentUser.uid, "chats", chatId));
            }
            if (mySummarySnap.exists() && mySummarySnap.data().clearedAt) {
                session.clearedAt = mySummarySnap.data().clearedAt;
            }
        } catch (err) {
            console.warn("clearedAt okunamadı:", err);
        }
    }

    if (!chatSessions.has(chatId)) return session;

    // Diskte mesaj varsa "sohbet silindi mi" kontrolü arkada yapılır, sohbetin açılmasını bekletmez
    if (chatId !== 'global' && currentUser && session.clearedAt === null && diskCache && diskCache.messages.length) {
        getDoc(doc(db, "users", currentUser.uid, "chats", chatId)).then((s) => {
            if (s.exists() && s.data().clearedAt) session.clearedAt = s.data().clearedAt;
        }).catch(() => {});
    }

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
let firstSnapResolve = null;
    const firstSnap = new Promise((r) => { firstSnapResolve = r; });
    session.unsubscribeMessages = onSnapshot(q, (snapshot) => {
    const prevIdsForUnread = new Set(session.messages.map((m) => m.id));
    if (firstSnapResolve) { firstSnapResolve(); firstSnapResolve = null; }
        if (!window.__auraTSnap) window.__auraTSnap = Math.round(performance.now()) + (snapshot.metadata.fromCache ? ' önbellekten' : ' sunucudan');
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

if (currentChatId === chatId && !session.waitingFirst) {
            // Sohbet yeni açıldıysa ve ilk veride okunmamış mesaj geldiyse çizgiyi şimdi kur
         const openedRecently = Date.now() - (session.openedAt || 0) < 6000;
            let dividerRebuilt = false;
          if (tempIncoming && tempIncoming.chatId === chatId) {
                // Bildirimden geçici balon çizildiyse: gerçek mesaj gelene kadar bekle, sonra çizgiyi gerçek sayıyla yeniden kur
                const tempArrived = session.messages.some((m) => m.id === tempIncoming.msgId);
               if (!tempArrived && Date.now() - tempIncoming.at < 4000) return;
                                const keepDividerId = (unreadDivider && unreadDivider.chatId === chatId) ? unreadDivider.msgId : null;
                unreadDivider = findUnreadDivider(session);
                if (keepDividerId && session.messages.some((m) => m.id === keepDividerId)) {
                    const allForDivider = session.olderMessagesPrepended.concat(session.messages);
                    const keepIdx = allForDivider.findIndex((m) => m.id === keepDividerId);
                    const keepCount = allForDivider.slice(keepIdx).filter((m) => m.data.senderUid !== currentUser.uid && m.data.type !== 'system').length;
                    if (keepCount > 0) unreadDivider = { chatId: chatId, msgId: keepDividerId, count: keepCount };
                }
                tempIncoming = null;
                dividerRebuilt = true;
            } else if ((recentOpenScrollLock || openedRecently) && (!unreadDivider || unreadDivider.chatId !== chatId)) {
                unreadDivider = findUnreadDivider(session);
                dividerRebuilt = !!unreadDivider;
            }
            const keepPosition = !dividerRebuilt && !!(unreadDivider && unreadDivider.chatId === chatId) && !isNearBottom();
            const prevScrollTop = messageContainer.scrollTop;
            // Yukarıda eski mesajları okurken yeni mesaj gelirse sayfa aşağı atlamasın, düğmede sayı görünsün
            let freshIncoming = 0;
            let freshMine = 0;
            if (prevIdsForUnread.size > 0 && !openedRecently && !dividerRebuilt && currentUser) {
                session.messages.forEach((m) => {
                    if (prevIdsForUnread.has(m.id)) return;
                    if (m.data.senderUid === currentUser.uid) freshMine++;
                    else if (m.data.type !== 'system') freshIncoming++;
                });
            }
            const stayAway = freshIncoming > 0 && freshMine === 0 && !isNearBottom();
            if (stayAway) jumpBottomUnread += freshIncoming;

            renderSession(session);
            markVisibleMessagesRead(session);

            if (keepPosition || stayAway) {
                messageContainer.scrollTop = prevScrollTop;
                updateJumpBottomBtn();
          } else if (dividerRebuilt || (unreadDivider && unreadDivider.chatId === chatId && recentOpenScrollLock)) {
                scrollToUnreadOrBottom();
            } else {
                scrollToBottom();
            }
        }
    }, (error) => {
        console.error("Mesajlar yüklenirken hata:", error);
        if (firstSnapResolve) { firstSnapResolve(); firstSnapResolve = null; }
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
if (chatId !== 'global' && document.documentElement.hasAttribute('data-aura-launch')) {
        // Bildirimle açılış: sohbeti çizmeden önce yeni mesajların gelmesini bekle (en çok 2,5 sn)
        session.waitingFirst = true;
        try {
            await Promise.race([firstSnap, new Promise((r) => setTimeout(r, 2000))]);
        } finally {
            session.waitingFirst = false;
        }
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
        let newestSeenMs = 0;
        const lastReadMs = getChatLastReadMs(session.chatId);
        session.messages.forEach(({ id, data: msg }) => {
            if (msg.senderUid === currentUser.uid || msg.type === 'system') return;
            const readBy = Array.isArray(msg.readBy) ? msg.readBy : [];
            if (!readBy.includes(currentUser.uid)) {
                const t = msgCreatedMs(msg);
                if (readReceiptsHidden) {
                    if (t > lastReadMs) { newestSeenMs = Math.max(newestSeenMs, t); markedAny = true; }
                } else if (!(t > 0 && t <= lastReadMs)) {
                    updateDoc(doc(db, "chats", session.chatId, "messages", id), { readBy: arrayUnion(currentUser.uid) }).catch(() => {});
                    markedAny = true;
                }
            }
        });

        if (markedAny) {
            updateDoc(doc(db, "users", currentUser.uid, "chats", session.chatId), { unreadCount: 0 }).catch(() => {});
            if (readReceiptsHidden) {
                setChatLastReadMs(session.chatId, newestSeenMs);
                return;
            }

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
    let newestSeenMs = 0;
    const lastReadMs = getChatLastReadMs(session.chatId);
    session.messages.forEach(({ id, data: msg }) => {
        const isMine = !!(currentUser.uid && msg.senderUid === currentUser.uid);
        if (!isMine && msg.read === false) {
            const t = msgCreatedMs(msg);
            if (readReceiptsHidden) {
                if (t > lastReadMs) { newestSeenMs = Math.max(newestSeenMs, t); markedAny = true; }
            } else if (!(t > 0 && t <= lastReadMs)) {
                updateDoc(doc(db, "chats", session.chatId, "messages", id), { read: true }).catch(() => {});
                markedAny = true;
            }
        }
    });

    if (markedAny) {
        updateDoc(doc(db, "users", currentUser.uid, "chats", session.chatId), {
            unreadCount: 0
        }).catch(() => {});
        if (readReceiptsHidden) {
            setChatLastReadMs(session.chatId, newestSeenMs);
        } else {
            updateDoc(doc(db, "users", session.otherUid, "chats", session.chatId), {
                lastMessageRead: true
            }).catch(() => {});
        }
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
            typing: false,
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
    // Başka sohbete geçilirken önceki sohbetin "yazıyor..." bilgisini temizle
    if (currentUser && currentChatId && currentChatId !== 'global') {
        setDoc(doc(db, "chats", currentChatId), { [`typing_${currentUser.uid}`]: false }, { merge: true }).catch(() => {});
    }
        exitSelectionMode();
    cancelEdit(true);
    cancelReply();
    expandedMsgIds.clear();
    currentIsGroup = false;
    toggleCallButtonsForGroup(false);
composer.clearImages();
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
        try { if (otherUser.avatar) localStorage.setItem('aura_av_' + otherUid, otherUser.avatar); } catch (e) {}
        otherAvatar = otherUser.avatar || (function () { try { return localStorage.getItem('aura_av_' + otherUid) || ''; } catch (e) { return ''; } })();
        chatId = getChatId(currentUser.uid, otherUid);
        chatName = otherUser.name;

        activeChatName.textContent = chatName;

     if (otherUser.avatar) {
            activeChatAvatar.style.backgroundColor = '';
            activeChatAvatar.className = "w-10 h-10 rounded-full overflow-hidden shadow flex-shrink-0";
            activeChatAvatar.innerHTML = `<img src="${otherAvatar}" class="w-full h-full object-cover">`;
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
    watchMyUnread(chatId);
    clearDeliveredNotificationsForChat(chatId, chatName);
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
        const tempStillShown = !!(tempIncoming && tempIncoming.chatId === chatId && Date.now() - tempIncoming.at < 4000 && !session.messages.some((m) => m.id === tempIncoming.msgId));
    if (!tempStillShown) {
        unreadDivider = findUnreadDivider(session);
        renderSession(session);
        scrollToUnreadOrBottom();
    }
    markVisibleMessagesRead(session);
if (window.__auraOnFirstPaint) window.__auraOnFirstPaint();
    recentOpenScrollLock = true;
    session.openedAt = Date.now();
    setTimeout(() => { recentOpenScrollLock = false; }, 1500);

  if (!currentIsGroup) {
        watchGroupCallForChat(null);
        watchCallForChat(chatId);
        watchVoiceCallForChat(chatId);
    } else {
        watchGroupCallForChat(chatId);
    }
}
 
// Bildirimden açılışta: yeni mesaj sunucudan gelene kadar bildirimin içindeki metni geçici balon olarak göster.
// Gerçek mesaj gelince liste yeniden çizildiği için balon kendiliğinden gerçeğiyle değişir (çift görünmez).
function appendLaunchTemps(session) {
    try {
        if (currentIsGroup || unreadDivider) return false;
        if (!document.documentElement.hasAttribute('data-aura-launch')) return false;
        const L = window.__auraLaunch;
        if (!L) return false;
        const seen = new Set();
        const items = [];
        (Array.isArray(L.msgs) ? L.msgs.slice() : []).sort((a, b) => a.t - b.t).forEach((m) => {
            if (m.tag && !seen.has(m.tag)) {
                seen.add(m.tag);
                items.push({ id: String(m.tag).slice(4), text: String(m.text || ''), t: m.t });
            }
        });
        if (L.tag && L.body && !seen.has(L.tag)) {
            items.push({ id: String(L.tag).slice(4), text: String(L.body), t: Date.now() });
        }
        const have = new Set(session.messages.map((m) => m.id));
        const fresh = items.filter((i) => !have.has(i.id));
        if (!fresh.length) return false;
        if (fresh.some((i) => !i.text || i.text.length > 400 || /^(📷|🎤|📍|🚫)/.test(i.text))) return false;
                const fragment = document.createDocumentFragment();
        const firstChip = tempDayChipFor(fresh[0].t, undefined);
        if (firstChip.el) fragment.appendChild(firstChip.el);
        let tempLabel = firstChip.label;
        fragment.appendChild(buildUnreadDividerElement(fresh.length));
        fresh.forEach((i, idx) => {
            if (idx > 0) {
                const c = tempDayChipFor(i.t, tempLabel);
                if (c.el) fragment.appendChild(c.el);
                tempLabel = c.label;
            }
            fragment.appendChild(buildMessageElement({
                type: 'text',
                text: i.text,
                senderUid: currentOtherUid || 'other',
                senderName: currentChatName || '',
                createdAt: Timestamp.fromMillis(i.t || Date.now()),
                read: false
            }, false, i.id));
        });
        messageContainer.appendChild(fragment);
        unreadDivider = { chatId: session.chatId, msgId: fresh[0].id, count: fresh.length };
        tempIncoming = { chatId: session.chatId, msgId: fresh[fresh.length - 1].id, at: Date.now() };
        window.__auraTempShown = true;
        return true;
    } catch (e) {
        return false;
    }
}

export function showTempIncomingBubble(chatId, msgId, text, timeMs, withDivider) {
    if (!chatId || !msgId || !text || currentChatId !== chatId || currentIsGroup) return;
    if (messageElementsById.size === 0) return;
    if (messageElementsById.has(msgId)) return;
    const session = chatSessions.get(chatId);
    if (session && (session.messages.some((m) => m.id === msgId) || session.olderMessagesPrepended.some((m) => m.id === msgId))) return;
    try {
        const fake = {
            type: 'text',
            text: text,
            senderUid: currentOtherUid || 'other',
            senderName: currentChatName || '',
            createdAt: Timestamp.fromMillis(timeMs || Date.now()),
            read: false
        };
        // Okunmamış çizgisi de geçici balonla birlikte hemen çıksın (gerçek mesaj gelince aynı yerde kalır)
       tempIncoming = { chatId: chatId, msgId: msgId, at: Date.now() };
          const tempChip = tempDayChipFor(timeMs, undefined);
        if (tempChip.el) messageContainer.appendChild(tempChip.el);
        if (withDivider && (!unreadDivider || unreadDivider.chatId !== chatId)) {
            unreadDivider = { chatId: chatId, msgId: msgId, count: 1 };
            messageContainer.appendChild(buildUnreadDividerElement(1));
        }
        messageContainer.appendChild(buildMessageElement(fake, false, msgId));
        scrollToUnreadOrBottom();
    } catch (e) {}
}

function doCloseChatView() {
    // Sohbet kapanırken "yazıyor..." durumunu Firebase'de temizle
    if (currentUser && currentChatId && currentChatId !== 'global') {
        setDoc(doc(db, "chats", currentChatId), { [`typing_${currentUser.uid}`]: false }, { merge: true }).catch(() => {});
    }
    composer.clearImages();
        closeAttachMenu();
        closeChatSearch();
    cancelEdit(true);
    cancelReply();
    expandedMsgIds.clear();
    unreadDivider = null;
    tempIncoming = null;
    updateMyActiveChatId(null);
    currentChatId = null;
    currentChatName = '';
    currentOtherUid = null;
    currentOtherAvatar = '';
    stopWatchingPresence();
    stopWatchingMyUnread();
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
    if (typeof closeMoreMenu === 'function') closeMoreMenu();
    selectionMode = false;
    selectedMessageIds.clear();
    messageElementsById.forEach((el) => el.classList.remove('msg-selected'));
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
    if (el) el.classList.toggle('msg-selected', selectedMessageIds.has(msgId));
}

function toggleMessageSelection(msgId) {
    toggleMessageSelectionInternal(msgId);
    if (selectedMessageIds.size === 0) {
        exitSelectionMode();
    } else {
        updateSelectionUI();
    }
}
// ------------------------------------------
// SOHBET İÇİ ARAMA
// ------------------------------------------
let searchBarEl = null;
const searchState = { active: false, chatId: null, query: '', ids: [], index: -1 };

function normSearch(t) {
    return String(t || '').toLocaleLowerCase('tr');
}

function ensureSearchBar() {
    if (searchBarEl) return searchBarEl;
    const el = document.createElement('div');
    el.id = 'chat-search-bar';
    el.className = 'hidden absolute top-0 left-0 right-0 bg-black px-3 h-[65px] items-center flex-shrink-0 z-20';
    el.innerHTML = `
        <button type="button" data-search="close" class="text-white text-lg px-2"><i class="fa-solid fa-arrow-left"></i></button>
          <textarea rows="1" name="aura_chat_search_no_autofill" data-search="input" placeholder="Ara..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" data-lpignore="true" data-form-type="other" class="flex-1 min-w-0 bg-transparent text-white text-base outline-none px-2 resize-none overflow-hidden" style="color:#fff;height:28px;line-height:28px;"></textarea>
        <span data-search="count" class="text-gray-300 text-xs px-2 whitespace-nowrap"></span>
        <button type="button" data-search="up" class="text-white text-lg px-3"><i class="fa-solid fa-chevron-up"></i></button>
        <button type="button" data-search="down" class="text-white text-lg px-3"><i class="fa-solid fa-chevron-down"></i></button>
    `;
    (selectionToolbar && selectionToolbar.parentElement ? selectionToolbar.parentElement : chatArea).appendChild(el);
    const input = el.querySelector('[data-search="input"]');
    input.addEventListener('input', () => runChatSearch());
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); stepChatSearch(-1); }
    });
    el.querySelector('[data-search="close"]').addEventListener('click', () => closeChatSearch());
    el.querySelector('[data-search="up"]').addEventListener('click', () => stepChatSearch(-1));
    el.querySelector('[data-search="down"]').addEventListener('click', () => stepChatSearch(1));
    searchBarEl = el;
    return el;
}

function computeSearchMatches() {
    const session = chatSessions.get(searchState.chatId);
    const q = normSearch(searchState.query).trim();
    if (!session || !q) return [];
    const all = session.olderMessagesPrepended.concat(session.messages);
    const ids = [];
    all.forEach(({ id, data }) => {
        if (currentUser && Array.isArray(data.deletedFor) && data.deletedFor.includes(currentUser.uid)) return;
        if (data.type && data.type !== 'text' && data.type !== 'image') return;
        if (data.text && normSearch(data.text).includes(q)) ids.push(id);
    });
    return ids;
}

function clearSearchMarks() {
    messageContainer.querySelectorAll('mark[data-search-mark]').forEach((m) => {
        const parent = m.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(m.textContent), m);
        parent.normalize();
    });
    messageContainer.querySelectorAll('[data-search-current]').forEach((el) => {
        el.removeAttribute('data-search-current');
        el.style.background = '';
    });
}

function highlightInElement(el, q) {
    el.querySelectorAll('p.whitespace-pre-wrap').forEach((p) => {
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach((node) => {
            const data = node.data;
            const lower = normSearch(data);
            if (lower.length !== data.length) return;
            let from = 0;
            let idx = lower.indexOf(q, from);
            if (idx < 0) return;
            const frag = document.createDocumentFragment();
            while (idx >= 0) {
                if (idx > from) frag.appendChild(document.createTextNode(data.slice(from, idx)));
                const mk = document.createElement('mark');
                mk.setAttribute('data-search-mark', '1');
                mk.style.cssText = 'background:#f5c542;color:#000;border-radius:3px;padding:0 1px;';
                mk.textContent = data.slice(idx, idx + q.length);
                frag.appendChild(mk);
                from = idx + q.length;
                idx = lower.indexOf(q, from);
            }
            if (from < data.length) frag.appendChild(document.createTextNode(data.slice(from)));
            node.parentNode.replaceChild(frag, node);
        });
    });
}

function updateSearchCount() {
    if (!searchBarEl) return;
    const c = searchBarEl.querySelector('[data-search="count"]');
    if (!searchState.query.trim()) c.textContent = '';
    else if (!searchState.ids.length) c.textContent = 'Sonuç yok';
    else c.textContent = `${searchState.ids.length - searchState.index}/${searchState.ids.length}`;
}

function refreshSearchMarks(scroll) {
    clearSearchMarks();
    const q = normSearch(searchState.query).trim();
    if (!searchState.active || !q) return;
    searchState.ids.forEach((id) => {
        const el = messageElementsById.get(id);
        if (el) highlightInElement(el, q);
    });
    const cur = messageElementsById.get(searchState.ids[searchState.index]);
    if (cur) {
        cur.setAttribute('data-search-current', '1');
        cur.style.background = 'rgba(255,255,255,0.12)';
        if (scroll) cur.scrollIntoView({ block: 'center' });
    }
}

function runChatSearch() {
    const input = searchBarEl.querySelector('[data-search="input"]');
        searchState.query = input.value.replace(/\n/g, ' ');
    searchState.ids = computeSearchMatches();
    searchState.index = searchState.ids.length - 1;
    updateSearchCount();
    refreshSearchMarks(true);
}

function stepChatSearch(dir) {
    const n = searchState.ids.length;
    if (!n) return;
    searchState.index = (searchState.index + dir + n) % n;
    updateSearchCount();
    refreshSearchMarks(true);
}
function setComposerHiddenForSearch(hide) {
            const inp = document.getElementById('message-input');
    const row = inp ? inp.parentElement : null;
    if (!row) return;
    if (hide) row.style.setProperty('display', 'none', 'important');
    else row.style.removeProperty('display');
}
function closeChatSearchFromBack() {
    searchState.active = false;
    searchState.query = '';
    searchState.ids = [];
        searchState.index = -1;
    clearSearchMarks();
    setComposerHiddenForSearch(false);
    if (searchBarEl) {
        const input = searchBarEl.querySelector('[data-search="input"]');
        input.value = '';
        input.blur();
        searchBarEl.classList.add('hidden');
        searchBarEl.classList.remove('flex');
        updateSearchCount();
    }
}

function closeChatSearch() {
    if (!searchState.active) return;
    closeChatSearchFromBack();
    popBackState();
}

export function openChatSearch() {
    if (!currentChatId) return;
    const el = ensureSearchBar();
    if (searchState.active) {
        el.querySelector('[data-search="input"]').focus();
        return;
    }
    searchState.active = true;
    searchState.chatId = currentChatId;
    searchState.query = '';
    searchState.ids = [];
    searchState.index = -1;
        el.classList.remove('hidden');
    el.classList.add('flex');
    setComposerHiddenForSearch(true);
    updateSearchCount();
    pushBackState(closeChatSearchFromBack);
    setTimeout(() => el.querySelector('[data-search="input"]').focus(), 50);
}

// Mesajlar yeniden çizilince (yeni mesaj, okundu vb.) vurguları geri kur
function refreshSearchAfterRender(session) {
    if (!searchState.active) return;
    if (searchState.chatId !== session.chatId) return;
    const curId = searchState.ids[searchState.index];
    searchState.ids = computeSearchMatches();
    const i = searchState.ids.indexOf(curId);
    searchState.index = i >= 0 ? i : searchState.ids.length - 1;
    updateSearchCount();
    refreshSearchMarks(false);
}
// ------------------------------------------
// MESAJ TEPKİLERİ (emoji)
// ------------------------------------------
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const NO_REACT_TYPES = ['deleted', 'system', 'call_duration', 'missed_call', 'declined_call'];
let reactionBarEl = null;

function hideReactionBar() {
    if (reactionBarEl) reactionBarEl.style.display = 'none';
}

function positionReactionBar(msgId) {
    const el = messageElementsById.get(msgId);
    if (!el || !reactionBarEl) return;
    const bubble = el.firstElementChild && el.firstElementChild.classList.contains('relative') ? el.firstElementChild : (el.querySelector('.relative') || el);
    const r = bubble.getBoundingClientRect();
    const barH = 48;
    let top = r.top - barH - 6;
    if (top < 80) top = r.bottom + 6;
    if (top > window.innerHeight - barH - 10) top = window.innerHeight - barH - 10;
    reactionBarEl.style.top = top + 'px';
    const mine = el.dataset.mine === 'true';
    const w = reactionBarEl.offsetWidth || 270;
    let left = mine ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    reactionBarEl.style.left = left + 'px';
}

function showReactionBar(msgId, entry) {
    if (!reactionBarEl) {
        reactionBarEl = document.createElement('div');
        reactionBarEl.id = 'reaction-bar';
        reactionBarEl.style.cssText = 'position:fixed;z-index:55;display:none;gap:2px;padding:6px 8px;border-radius:9999px;background:#233138;box-shadow:0 4px 14px rgba(0,0,0,0.5);align-items:center;';
        document.body.appendChild(reactionBarEl);
        messageContainer.addEventListener('scroll', () => {
            if (selectionMode && selectedMessageIds.size === 1 && reactionBarEl.style.display !== 'none') {
                positionReactionBar(Array.from(selectedMessageIds)[0]);
            }
        }, { passive: true });
    }
    const myUid = currentUser && currentUser.uid;
    const mine = entry.data.reactions && myUid ? entry.data.reactions[myUid] : null;
    reactionBarEl.innerHTML = REACTION_EMOJIS.map((e) =>
        `<button type="button" data-react="${e}" style="font-size:26px;line-height:1;width:40px;height:36px;border-radius:9999px;background:${mine === e ? 'rgba(255,255,255,0.18)' : 'transparent'};">${e}</button>`
    ).join('');
    reactionBarEl.style.display = 'flex';
    reactionBarEl.querySelectorAll('button[data-react]').forEach((b) => {
        b.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const emoji = b.getAttribute('data-react');
            exitSelectionMode();
            applyReaction(msgId, emoji);
        });
    });
    positionReactionBar(msgId);
}

async function applyReaction(msgId, emoji) {
    if (!currentUser || !currentUser.uid || !currentChatId || !REACTION_EMOJIS.includes(emoji)) return;
    const entry = findMessageEntry(msgId);
    const current = entry && entry.data.reactions ? entry.data.reactions[currentUser.uid] : null;
    const reactChatId = currentChatId;
    try {
        await updateDoc(doc(db, "chats", reactChatId, "messages", msgId), {
            [`reactions.${currentUser.uid}`]: current === emoji ? deleteField() : emoji
        });
    } catch (e) {
        showToast('Tepki gönderilemedi');
        return;
    }
    // Yeni tepki (kaldırma değil) ve mesaj başkasınınsa: mesaj sahibine bildirim
    try {
        const ownerUid = entry && entry.data ? entry.data.senderUid : '';
        if (current !== emoji && ownerUid && ownerUid !== currentUser.uid && reactChatId !== 'global') {
            const isGrp = isGroupChat(reactChatId);
            const gd = isGrp ? await getGroupData(reactChatId) : null;
            const preview = replyPreviewTextFor(entry.data).slice(0, 80);
            sendPushToUser(
                ownerUid,
                isGrp ? ((gd && gd.name) || 'Grup') : `${currentUser.name}`,
                `${emoji} ${isGrp ? currentUser.name + ' ' : ''}mesajına tepki verdi: ${preview}`.trim(),
                {
                    chatId: reactChatId,
                    otherUid: isGrp ? reactChatId : currentUser.uid,
                    otherName: isGrp ? ((gd && gd.name) || 'Grup') : currentUser.name,
                    msgType: 'reaction',
                    tag: `react-${msgId}-${currentUser.uid}`
                }
            );
        }
    } catch (e) {}
}

function buildReactionsHtml(msg, isMine) {
    if (!msg.reactions || NO_REACT_TYPES.includes(msg.type)) return '';
    const vals = Object.values(msg.reactions).filter((e) => REACTION_EMOJIS.includes(e));
    if (!vals.length) return '';
    const uniq = Array.from(new Set(vals));
    const count = vals.length > 1 ? `<span style="font-size:11px;color:#d1d7db;margin-left:3px;">${vals.length}</span>` : '';
    return `<div data-reactions-chip="1" style="cursor:pointer;position:absolute;bottom:-14px;${isMine ? 'right:10px' : 'left:10px'};background:#233138;border:2px solid #0b141a;border-radius:9999px;padding:1px 6px;font-size:13px;line-height:18px;white-space:nowrap;z-index:2;">${uniq.map(escapeHtml).join('')}${count}</div>`;
}
// ------------------------------------------
// TEPKİ DETAYI (alttan açılan sayfa): kim hangi tepkiyi verdi
// Tepki balonuna dokununca açılır, aşağı çekince / dışına dokununca kapanır.
// ------------------------------------------
let reactSheetEl = null;
const userBriefCache = new Map();

async function getUserBrief(uid) {
    if (currentUser && uid === currentUser.uid) return { name: 'Siz', avatar: currentUser.avatar || '' };
    if (!currentIsGroup && uid === currentOtherUid) return { name: currentChatName || 'Kullanıcı', avatar: currentOtherAvatar || '' };
    if (userBriefCache.has(uid)) return userBriefCache.get(uid);
    let info = { name: 'Kullanıcı', avatar: '' };
    try {
        const snap = await getDoc(doc(db, "users", uid));
        if (snap.exists()) {
            const d = snap.data();
            info = { name: d.name || d.displayName || 'Kullanıcı', avatar: d.avatar || '' };
        }
    } catch (e) {}
    userBriefCache.set(uid, info);
    return info;
}

function closeReactSheetFromBack() {
    if (!reactSheetEl) return;
    const el = reactSheetEl;
    reactSheetEl = null;
    const panel = el.querySelector('[data-sheet]');
    if (panel) panel.style.transform = 'translateY(100%)';
    el.style.background = 'rgba(0,0,0,0)';
    setTimeout(() => el.remove(), 220);
}

function closeReactSheet() {
    if (!reactSheetEl) return;
    closeReactSheetFromBack();
    popBackState();
}

async function openReactionSheet(msgId) {
    const entry = findMessageEntry(msgId);
    if (!entry || !entry.data.reactions || !currentUser) return;
    if (reactSheetEl) closeReactSheet();

    const myUid = currentUser.uid;
    const pairs = Object.entries(entry.data.reactions).filter(([, e]) => REACTION_EMOJIS.includes(e));
    if (!pairs.length) return;
    const briefs = await Promise.all(pairs.map(([uid]) => getUserBrief(uid)));
    const people = pairs.map(([uid, emoji], i) => ({ uid, emoji, name: briefs[i].name, avatar: briefs[i].avatar }));
    // Kendi tepkin en üstte
    people.sort((a, b) => (a.uid === myUid ? -1 : 0) - (b.uid === myUid ? -1 : 0));

    const counts = new Map();
    people.forEach((p) => counts.set(p.emoji, (counts.get(p.emoji) || 0) + 1));
    let filter = 'all';

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:80;background:rgba(0,0,0,0);transition:background .2s;display:flex;align-items:flex-end;';
    wrap.innerHTML = `
        <div data-sheet style="width:100%;max-height:70vh;display:flex;flex-direction:column;background:#111b21;border-radius:24px 24px 0 0;transform:translateY(100%);transition:transform .22s ease;padding-bottom:env(safe-area-inset-bottom,0px);">
            <div data-grab style="padding:10px 0 4px;display:flex;justify-content:center;flex-shrink:0;"><div style="width:40px;height:4px;border-radius:9999px;background:#8696a0;"></div></div>
            <div style="padding:8px 20px 4px;color:#fff;font-size:18px;flex-shrink:0;">${people.length} ifade</div>
            <div data-chips style="display:flex;gap:8px;padding:10px 16px;overflow-x:auto;flex-shrink:0;"></div>
            <div data-list style="overflow-y:auto;overscroll-behavior:contain;padding:4px 0 12px;"></div>
        </div>`;
    document.body.appendChild(wrap);
    reactSheetEl = wrap;
    pushBackState(closeReactSheetFromBack);
    requestAnimationFrame(() => {
        wrap.style.background = 'rgba(0,0,0,0.55)';
        wrap.querySelector('[data-sheet]').style.transform = 'translateY(0)';
    });

    const chipsEl = wrap.querySelector('[data-chips]');
    const listEl = wrap.querySelector('[data-list]');

    function renderChips() {
        const items = [['all', `Tümü ${people.length}`]].concat(Array.from(counts.entries()).map(([e, c]) => [e, `${e} ${c}`]));
        chipsEl.innerHTML = items.map(([key, label]) => {
            const on = key === filter;
            return `<button type="button" data-chip="${key}" style="flex-shrink:0;padding:8px 16px;border-radius:9999px;font-size:15px;color:${on ? '#53bdeb' : '#d1d7db'};background:${on ? 'rgba(83,189,235,0.15)' : '#202c33'};">${escapeHtml(label)}</button>`;
        }).join('');
    }

    function renderList() {
        const shown = people.filter((p) => filter === 'all' || p.emoji === filter);
        listEl.innerHTML = shown.map((p) => {
            const mine = p.uid === myUid;
            const initial = escapeHtml((p.name || '?').trim().charAt(0).toUpperCase());
            const av = p.avatar
                ? `<img src="${escapeHtml(p.avatar)}" style="width:46px;height:46px;border-radius:9999px;object-fit:cover;flex-shrink:0;">`
                : `<div style="width:46px;height:46px;border-radius:9999px;background:#6b7c85;color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">${initial}</div>`;
            return `<div data-row="${escapeHtml(p.uid)}" style="display:flex;align-items:center;gap:14px;padding:10px 20px;${mine ? 'cursor:pointer;' : ''}">
                ${av}
                <div style="flex:1;min-width:0;">
                    <div style="color:#fff;font-size:16px;" class="truncate">${escapeHtml(p.name)}</div>
                    ${mine ? '<div style="color:#8696a0;font-size:13px;">Kaldırmak için dokunun</div>' : ''}
                </div>
                <div style="font-size:26px;line-height:1;">${escapeHtml(p.emoji)}</div>
            </div>`;
        }).join('');
    }

    renderChips();
    renderList();

    chipsEl.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-chip]');
        if (!b) return;
        filter = b.getAttribute('data-chip');
        renderChips();
        renderList();
    });

    // Kendi tepkine dokununca kaldırılır
    listEl.addEventListener('click', (ev) => {
        const row = ev.target.closest('[data-row]');
        if (!row || row.getAttribute('data-row') !== myUid) return;
        const mineP = people.find((p) => p.uid === myUid);
        closeReactSheet();
        if (mineP) applyReaction(msgId, mineP.emoji);
    });

    // Dışına dokununca kapat
    wrap.addEventListener('click', (ev) => { if (ev.target === wrap) closeReactSheet(); });

    // Aşağı çekince kapat
    const panel = wrap.querySelector('[data-sheet]');
    let startY = null;
    let dy = 0;
    panel.addEventListener('touchstart', (ev) => {
        if (listEl.contains(ev.target) && listEl.scrollTop > 0) { startY = null; return; }
        startY = ev.touches[0].clientY;
        dy = 0;
        panel.style.transition = 'none';
    }, { passive: true });
    panel.addEventListener('touchmove', (ev) => {
        if (startY === null) return;
        dy = Math.max(0, ev.touches[0].clientY - startY);
        panel.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    panel.addEventListener('touchend', () => {
        if (startY === null) return;
        startY = null;
        panel.style.transition = 'transform .22s ease';
        if (dy > 90) closeReactSheet();
        else panel.style.transform = 'translateY(0)';
    }, { passive: true });
}

messageContainer.addEventListener('click', (ev) => {
    const chip = ev.target.closest ? ev.target.closest('[data-reactions-chip]') : null;
    if (!chip || selectionMode) return;
    const row = chip.closest('[data-msg-id]');
    if (!row) return;
    ev.stopPropagation();
    ev.preventDefault();
    openReactionSheet(row.dataset.msgId);
}, true);
// ------------------------------------------
// YILDIZLI MESAJLAR
// Her kullanıcının kendi listesi: users/{uid}/starred/{chatId__msgId}
// Seçim çubuğundaki yıldıza basınca eklenir / kaldırılır, sohbet menüsünden listelenir.
// ------------------------------------------
const starredMap = new Map();
let starredUnsub = null;
let starredPanelEl = null;

function starKey(chatId, msgId) { return `${chatId}__${msgId}`; }
function isStarred(chatId, msgId) { return starredMap.has(starKey(chatId, msgId)); }

(function injectStarCss() {
    const st = document.createElement('style');
    st.id = 'aura-star-css';
    st.textContent = '.aura-starred .aura-time::before{content:"\\2605  ";color:#fbbf24;}';
    document.head.appendChild(st);
})();

async function startStarredWatch() {
    if (starredUnsub || !currentUser) return;
    try {
        const a = getAuth();
        if (a.authStateReady) await Promise.race([a.authStateReady(), new Promise((r) => setTimeout(r, 5000))]);
    } catch (e) {}
    if (starredUnsub || !currentUser) return;
    starredUnsub = onSnapshot(collection(db, "users", currentUser.uid, "starred"), (snap) => {
        starredMap.clear();
        snap.forEach((d) => starredMap.set(d.id, d.data()));
        messageElementsById.forEach((el, msgId) => el.classList.toggle('aura-starred', isStarred(currentChatId, msgId)));
        if (selectionMode) updateSelectionUI();
        if (starredPanelEl) renderStarredPanel();
    }, () => {});
}

function starEligibleIds() {
    return Array.from(selectedMessageIds).filter((id) => {
        const e = findMessageEntry(id);
        return e && !NO_REACT_TYPES.includes(e.data.type || 'text');
    });
}

async function toggleStarSelected() {
    if (!currentUser || !currentChatId) return;
    const ids = starEligibleIds();
    if (!ids.length) { showToast('Bu mesaj yıldızlanamaz'); return; }
    const chatId = currentChatId;
    const allStarred = ids.every((id) => isStarred(chatId, id));
    exitSelectionMode();
    try {
        for (const id of ids) {
            const ref = doc(db, "users", currentUser.uid, "starred", starKey(chatId, id));
            if (allStarred) {
                await deleteDoc(ref);
            } else if (!isStarred(chatId, id)) {
                const e = findMessageEntry(id);
                const m = e.data;
                const ms = m.createdAt && m.createdAt.toMillis ? m.createdAt.toMillis() : Date.now();
                await setDoc(ref, {
                    chatId: chatId,
                    msgId: id,
                    chatName: currentChatName || '',
                    preview: replyPreviewTextFor(m),
                    senderUid: m.senderUid || '',
                    senderName: m.senderName || '',
                    msgTime: ms,
                    starredAt: serverTimestamp()
                });
            }
        }
        showToast(allStarred ? 'Yıldız kaldırıldı' : 'Yıldızlandı');
    } catch (e) {
        showToast('Yıldız işlemi başarısız');
    }
}

if (selectionStarBtn) {
    // Yıldıza basınca yazma kutusu odağı (klavye) kaybetmesin
    selectionStarBtn.addEventListener('mousedown', (e) => e.preventDefault());
    selectionStarBtn.addEventListener('click', () => toggleStarSelected());
}

function closeStarredPanelFromBack() {
    if (!starredPanelEl) return;
    starredPanelEl.remove();
    starredPanelEl = null;
}

function closeStarredPanel() {
    if (!starredPanelEl) return;
    closeStarredPanelFromBack();
    popBackState();
}

function renderStarredPanel() {
    if (!starredPanelEl) return;
    const list = starredPanelEl.querySelector('[data-list]');
    const items = Array.from(starredMap.values())
        .filter((d) => d.chatId === currentChatId)
        .sort((a, b) => (b.msgTime || 0) - (a.msgTime || 0));
    if (!items.length) {
        list.innerHTML = '<div style="padding:40px 24px;text-align:center;color:#8696a0;font-size:15px;">Bu sohbette yıldızlı mesaj yok.<br>Bir mesajı seçip üstteki yıldıza dokun.</div>';
        return;
    }
    list.innerHTML = items.map((d) => {
        const mine = currentUser && d.senderUid === currentUser.uid;
        const who = mine ? 'Sen' : (d.senderName || d.chatName || 'Kullanıcı');
        const dt = new Date(d.msgTime || 0);
        const when = dt.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + dt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        return `<div data-msg="${escapeHtml(d.msgId)}" style="display:flex;align-items:flex-start;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);cursor:pointer;">
            <div style="flex:1;min-width:0;">
                <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;"><span style="color:#34d399;">${escapeHtml(who)}</span><span style="color:#8696a0;">${escapeHtml(when)}</span></div>
                <div style="color:#e9edef;font-size:15px;margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere;">${escapeHtml(d.preview || '')}</div>
            </div>
            <button type="button" data-unstar="${escapeHtml(d.msgId)}" style="color:#fbbf24;font-size:18px;padding:4px 6px;"><i class="fa-solid fa-star"></i></button>
        </div>`;
    }).join('');
}

export function openStarredPanel() {
    if (!currentChatId || !currentUser) return;
    if (starredPanelEl) closeStarredPanel();
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;z-index:75;background:#0b141a;display:flex;flex-direction:column;';
    el.innerHTML = `
        <div style="display:flex;align-items:center;gap:16px;padding:0 16px;height:65px;background:#000;flex-shrink:0;">
            <button type="button" data-back style="color:#fff;font-size:18px;padding:4px;"><i class="fa-solid fa-arrow-left"></i></button>
            <span style="color:#fff;font-size:17px;font-weight:500;">Yıldızlı mesajlar</span>
        </div>
        <div data-list style="flex:1;overflow-y:auto;"></div>`;
    document.body.appendChild(el);
    starredPanelEl = el;
    pushBackState(closeStarredPanelFromBack);
    renderStarredPanel();
    el.querySelector('[data-back]').addEventListener('click', () => closeStarredPanel());
    el.querySelector('[data-list]').addEventListener('click', (ev) => {
        const un = ev.target.closest('[data-unstar]');
        if (un) {
            ev.stopPropagation();
            deleteDoc(doc(db, "users", currentUser.uid, "starred", starKey(currentChatId, un.getAttribute('data-unstar')))).catch(() => showToast('Kaldırılamadı'));
            return;
        }
        const row = ev.target.closest('[data-msg]');
        if (!row) return;
        const mid = row.getAttribute('data-msg');
        closeStarredPanel();
        setTimeout(() => scrollToOriginalMessage(mid), 60);
    });
}
function updateSelectionUI() {
    if (!selectionToolbar) return;
    if (selectionMode) {
        selectionToolbar.classList.remove('hidden');
        selectionToolbar.classList.add('flex');
           if (selectionCountEl) selectionCountEl.textContent = String(selectedMessageIds.size);
        const onlyId = selectedMessageIds.size === 1 ? Array.from(selectedMessageIds)[0] : null;
        const onlyEntry = onlyId ? findMessageEntry(onlyId) : null;
        const onlyType = onlyEntry ? (onlyEntry.data.type || 'text') : '';
        if (selectionReplyBtn) selectionReplyBtn.style.display = (onlyEntry && !['deleted', 'system', 'call_duration', 'missed_call', 'declined_call'].includes(onlyType)) ? '' : 'none';
                if (selectionStarBtn) {
            const sIds = starEligibleIds();
            selectionStarBtn.style.display = sIds.length ? '' : 'none';
            const on = sIds.length > 0 && sIds.every((id) => isStarred(currentChatId, id));
            selectionStarBtn.innerHTML = on ? '<i class="fa-solid fa-star" style="color:#fbbf24"></i>' : '<i class="fa-regular fa-star"></i>';
        }
          if (selectionForwardBtn) selectionForwardBtn.style.display = (onlyEntry && (onlyType === 'text' || onlyType === 'image')) ? '' : 'none';
        if (onlyEntry && !NO_REACT_TYPES.includes(onlyType)) showReactionBar(onlyId, onlyEntry); else hideReactionBar();
    } else {
        selectionToolbar.classList.add('hidden');
        selectionToolbar.classList.remove('flex');
        hideReactionBar();
    }
}

if (selectionCancelBtn) {
    selectionCancelBtn.addEventListener('click', () => exitSelectionMode());
}
function findMessageEntry(msgId) {
    const session = chatSessions.get(currentChatId);
    return session ? (session.messages.find((m) => m.id === msgId) || session.olderMessagesPrepended.find((m) => m.id === msgId)) : null;
}

if (selectionReplyBtn) {
    selectionReplyBtn.addEventListener('click', () => {
        const id = Array.from(selectedMessageIds)[0];
        exitSelectionMode();
        if (id) window.replyToMessage(id);
    });
}

if (selectionForwardBtn) {
    selectionForwardBtn.addEventListener('click', () => {
        const id = Array.from(selectedMessageIds)[0];
        exitSelectionMode();
        if (id) window.forwardImageMessage(id);
    });
}

if (selectionCopyBtn) {
    selectionCopyBtn.addEventListener('click', async () => {
        const session = chatSessions.get(currentChatId);
        const all = session ? session.olderMessagesPrepended.concat(session.messages) : [];
        const lines = [];
        all.forEach(({ id, data }) => {
            if (selectedMessageIds.has(id) && (!data.type || data.type === 'text') && data.text) lines.push(data.text);
        });
        if (!lines.length) { showToast('Kopyalanacak metin yok'); return; }
        const text = lines.join('\n');
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (e2) {}
            ta.remove();
        }
        showToast('Kopyalandı');
        exitSelectionMode();
    });
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

        const delChoice = await auraDialog({
                    accent: auraAccent(),
            title: ids.length > 1 ? `${ids.length} mesaj silinsin mi?` : 'Mesaj silinsin mi?',
            buttons: allMine
                ? [{ id: 'all', label: 'Herkesten sil' }, { id: 'me', label: 'Benden sil' }, { id: 'cancel', label: 'İptal' }]
                : [{ id: 'me', label: 'Benden sil' }, { id: 'cancel', label: 'İptal' }]
        });
             if (delChoice.id === 'cancel') { exitSelectionMode(); return; }
        deleteForEveryone = delChoice.id === 'all';

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
            