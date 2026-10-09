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
import { setupMentions, resetMentions, collectMentions, clearChosenMentions, highlightMentions } from "./chat-mentions.js";
import { mountGallery, openGallery, closeGallery, setGalleryExpanded, galleryAvailable, gallerySelectedCount } from "./chat-gallery.js";

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
// ------------------------------------------
// GRUPTA MESAJ YANINDA AVATAR
// Avatar verisi zaten bellekte (window.__aurachatUsers, profildeki avatarla aynı kayıt):
// ek Firestore okuması YOK. Her kişi için bir kez blob adresi üretilir, tüm mesajlar aynı adresi paylaşır.
// ------------------------------------------
const GAV_SIZE = 28;
const gavBlobByUid = new Map(); // uid -> { key, url }

function groupAvatarSrc(uid, avatar) {
    if (!avatar || typeof avatar !== 'string') return '';
    if (/^https?:\/\//i.test(avatar)) return avatar;
    if (avatar.indexOf('data:') !== 0) return '';
    const key = avatar.length + ':' + avatar.slice(-32);
    const hit = gavBlobByUid.get(uid);
    if (hit && hit.key === key) return hit.url;
    try {
        const comma = avatar.indexOf(',');
        const mime = (avatar.slice(5, comma).split(';')[0]) || 'image/jpeg';
        const bin = atob(avatar.slice(comma + 1).replace(/\s/g, ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        if (hit) { try { URL.revokeObjectURL(hit.url); } catch (e) {} }
        gavBlobByUid.set(uid, { key, url });
        return url;
    } catch (e) {
        return '';
    }
}

// mode: 'space' = aynı kişinin arka arkaya mesajlarında boşluk bırak, diğerlerinde avatar göster
function groupAvatarHtml(msg, mode) {
    if (!currentIsGroup) return '';
    if (mode === 'space') return `<div class="aura-gav" style="width:${GAV_SIZE}px;flex-shrink:0;margin-right:6px;"></div>`;
    const um = window.__aurachatUsers;
    const u = um && msg.senderUid ? um.get(msg.senderUid) : null;
    const src = u && u.avatar ? groupAvatarSrc(msg.senderUid, u.avatar) : '';
    const nm = String(msg.senderName || (u && u.name) || '?').trim();
    const initial = escapeHtml((nm.charAt(0) || '?').toUpperCase());
    const inner = src
        ? `<img src="${src}" draggable="false" style="width:${GAV_SIZE}px;height:${GAV_SIZE}px;border-radius:9999px;object-fit:cover;display:block;">`
        : `<div style="width:${GAV_SIZE}px;height:${GAV_SIZE}px;border-radius:9999px;background:${senderColor(msg, 38)};color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;">${initial}</div>`;
    return `<div class="aura-gav" data-uid="${escapeHtml(String(msg.senderUid || ''))}" data-name="${escapeHtml(nm)}" style="width:${GAV_SIZE}px;height:${GAV_SIZE}px;flex-shrink:0;margin-right:6px;align-self:flex-start;cursor:pointer;">${inner}</div>`;
}

// ------------------------------------------
// AVATARA BASINCA PROFİL KARTI (alttan açılır): resim, isim, Mesaj / Sesli / Görüntülü / Kaydet
// ------------------------------------------
let memberSheetEl = null;

// Aşağı kayarak kapanma animasyonu (anında kaldırmak için instant=true)
function closeMemberSheetFromBack(instant) {
    const el = memberSheetEl;
    if (!el) return;
    memberSheetEl = null;
    const panel = el.firstElementChild;
    if (instant === true || !panel) { el.remove(); return; }
    el.style.pointerEvents = 'none';
    el.style.transition = 'background-color 220ms ease';
    el.style.backgroundColor = 'rgba(0,0,0,0)';
    panel.style.transition = 'transform 240ms cubic-bezier(0.4,0,1,1)';
    panel.style.transform = 'translateY(100%)';
    setTimeout(() => el.remove(), 260);
}

function closeMemberSheet() {
    if (!memberSheetEl) return;
    closeMemberSheetFromBack();
    popBackState();
}

function isUnsavedNumber(phone) {
    const local = window.__aurachatLocalPhones;
    if (!phone || !local || local.size === 0) return false;
    const l10 = getPhoneLast10(phone);
    return !!l10 && !local.has(l10);
}

function openMemberSheet(uid, fallbackName) {
    if (!uid || !currentUser || uid === currentUser.uid) return;
    if (memberSheetEl) { memberSheetEl.remove(); memberSheetEl = null; }
    const um = window.__aurachatUsers;
    const u = um ? um.get(uid) : null;
    const name = (u && u.name) || fallbackName || 'Kullanıcı';
    const avatar = (u && u.avatar) || '';
    const phone = (u && u.phone) ? String(u.phone) : '';
    const src = avatar ? groupAvatarSrc(uid, avatar) : '';
    const showSave = isUnsavedNumber(phone);

    const bigAvatar = src
        ? `<img src="${src}" data-big-avatar="1" class="w-24 h-24 rounded-full object-cover mx-auto cursor-pointer">`
        : `<div class="w-24 h-24 rounded-full flex items-center justify-center text-white text-3xl font-bold mx-auto" style="background-color:${getUserColor(name)};">${escapeHtml(getInitials(name))}</div>`;
    const btn = (act, icon, label) => `<button type="button" data-act="${act}" class="flex flex-col items-center justify-center flex-1 py-3 rounded-xl bg-[#111b21] active:bg-[#0b141a]"><i class="fa-solid ${icon} text-emerald-400 text-xl"></i><span class="text-[12px] text-gray-200 mt-1.5">${label}</span></button>`;

    const el = document.createElement('div');
    el.className = 'fixed inset-0 z-[70] flex items-end';
    el.style.backgroundColor = 'rgba(0,0,0,0)';
    el.style.transition = 'background-color 240ms ease';
    el.innerHTML = `
        <div class="w-full bg-[#202c33] rounded-t-2xl pb-6 px-4 pt-5 text-center" style="transform:translateY(100%);will-change:transform;touch-action:none;">
            <div class="w-10 h-1 bg-gray-600 rounded-full mx-auto mb-4"></div>
            ${bigAvatar}
            <p class="text-white text-lg font-semibold mt-3 truncate">${escapeHtml(name)}</p>
            ${phone && showSave ? `<p class="text-gray-400 text-xs mt-0.5">${escapeHtml(phone)}</p>` : ''}
            <div class="flex gap-2 mt-5">
                ${btn('msg', 'fa-message', 'Mesaj')}
                ${btn('voice', 'fa-phone', 'Sesli')}
                ${btn('video', 'fa-video', 'Görüntülü')}
                ${showSave ? btn('save', 'fa-user-plus', 'Kaydet') : ''}
            </div>
        </div>
    `;
    document.body.appendChild(el);
    el.addEventListener('click', async (e) => {
        if (e.target === el) { closeMemberSheet(); return; }
        const big = e.target.closest('[data-big-avatar]');
        if (big) { window.openImageLightbox(big.src); return; }
        const b = e.target.closest('button[data-act]');
        if (!b) return;
        const act = b.dataset.act;
        if (act === 'save') {
            closeMemberSheet();
            try {
                if (window.AuraContact && window.AuraContact.add) {
                    window.AuraContact.add(name, phone);
                    return;
                }
            } catch (err) {}
            try { await navigator.clipboard.writeText(phone); } catch (err) {}
            showToast('Numara kopyalandı: ' + phone);
            return;
        }
        closeMemberSheet();
        try {
            await selectChat({ uid, name, avatar });
            if (act === 'voice') startVoiceCall(currentChatId, uid);
            else if (act === 'video') startCall(currentChatId, uid);
        } catch (err) {
            showToast('Açılamadı');
        }
    });
    memberSheetEl = el;
    pushBackState(closeMemberSheetFromBack);

    // Alttan kayarak açılış
    const panel = el.firstElementChild;
    requestAnimationFrame(() => requestAnimationFrame(() => {
        el.style.backgroundColor = 'rgba(0,0,0,0.6)';
        panel.style.transition = 'transform 280ms cubic-bezier(0.2,0.9,0.3,1)';
        panel.style.transform = 'translateY(0)';
    }));

    // Parmakla aşağı çekerek kapatma
    let dragY0 = null;
    let dragDy = 0;
    let dragT0 = 0;
    panel.addEventListener('touchstart', (ev) => {
        if (ev.touches.length !== 1) return;
        dragY0 = ev.touches[0].clientY;
        dragDy = 0;
        dragT0 = Date.now();
        panel.style.transition = 'none';
    }, { passive: true });
    panel.addEventListener('touchmove', (ev) => {
        if (dragY0 === null) return;
        dragDy = Math.max(0, ev.touches[0].clientY - dragY0);
        panel.style.transform = `translateY(${dragDy}px)`;
        el.style.backgroundColor = `rgba(0,0,0,${Math.max(0, 0.6 - dragDy / 600)})`;
    }, { passive: true });
    const endDrag = () => {
        if (dragY0 === null) return;
        const dy = dragDy;
        const fast = dy / Math.max(1, Date.now() - dragT0) > 0.6;
        dragY0 = null;
        dragDy = 0;
        if (dy > 90 || (fast && dy > 25)) {
            closeMemberSheet();
        } else {
            panel.style.transition = 'transform 200ms ease';
            panel.style.transform = 'translateY(0)';
            el.style.backgroundColor = 'rgba(0,0,0,0.6)';
        }
    };
    panel.addEventListener('touchend', endDrag);
    panel.addEventListener('touchcancel', endDrag);
}

// Avatara dokunma: seçim modunda değilken profil kartını aç (mesaj seçimini tetiklemesin)
messageContainer.addEventListener('click', (e) => {
    const av = e.target.closest ? e.target.closest('.aura-gav[data-uid]') : null;
    if (!av || selectionMode) return;
    e.stopPropagation();
    openMemberSheet(av.dataset.uid, av.dataset.name);
}, true);

let recentOpenScrollLock = false;
let unreadDivider = null; // { chatId, msgId, count }
let tempIncoming = null; // bildirimden çizilen geçici balon: { chatId, msgId, at }

// Son eklenen mesajın kimliğini tutar: bildirime mesaja özel tag vermek için
let lastAddedMsg = null;
async function addDoc(colRef, data) {
    // Süreli mesaj açıksa yeni mesaja bitiş zamanı yaz (sistem mesajları hariç)
    try {
        const p = colRef.path.split('/');
        if (p[0] === 'chats' && p[2] === 'messages' && data && data.type !== 'system' && !data.expiresAtMs) {
            const sess = chatSessions.get(p[1]);
            if (sess && sess.disappearAfter > 0) data = Object.assign({}, data, { expiresAtMs: Date.now() + sess.disappearAfter });
        }
    } catch (e) {}
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
        if (snap.exists() && (Number(snap.data().unreadCount || 0) > 0 || snap.data().hasMention)) {
            updateDoc(snap.ref, { unreadCount: 0, hasMention: false }).catch(() => {});
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

    // Bu cihazda saklanan temizleme zamanı Firestore'dan okunandan yeniyse onu kullan
    const localClr = getLocalClearedMs(chatId);
    if (localClr && (!session.clearedAt || session.clearedAt.toMillis() < localClr)) {
        session.clearedAt = Timestamp.fromMillis(localClr);
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
            // Yalnızca var olan mesaj değiştiyse (tepki, düzenleme, okundu...) yukarıdaki konum korunur
            const changesNow = snapshot.docChanges();
            const modifyOnly = changesNow.length > 0 && changesNow.every((c) => c.type === 'modified') && !dividerRebuilt && !openedRecently && !isNearBottom();

            renderSession(session);
            markVisibleMessagesRead(session);

            if (keepPosition || stayAway || modifyOnly) {
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
            // Süreli mesaj ayarı değiştiyse kaydet
            const nextDisappear = Number(data.disappearAfter) || 0;
            if (nextDisappear !== (session.disappearAfter || 0)) session.disappearAfter = nextDisappear;
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
        if (msg.type !== 'image' || msg.viewOnce) continue;

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
            updateDoc(doc(db, "users", currentUser.uid, "chats", session.chatId), { unreadCount: 0, hasMention: false }).catch(() => {});
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
            unreadCount: 0,
            hasMention: false
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
async function updateChatSummaries(lastMessageText, mentionedUids) {
if (currentIsGroup || isGroupChat(currentChatId)) {
        return updateGroupSummaries(lastMessageText, mentionedUids);
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
// Temizleme zamanı bu cihazda da saklanır: önbellek/ağ okuması gecikse bile eski mesajlar geri gelmesin
function clearedKey(chatId) {
    return 'aura_clr_' + (currentUser ? currentUser.uid : '') + '_' + chatId;
}
function getLocalClearedMs(chatId) {
    try { return Number(localStorage.getItem(clearedKey(chatId))) || 0; } catch (e) { return 0; }
}

export async function clearChatForMe(chatId) {
    if (!currentUser || !chatId || chatId === 'global') return;
    try {
        await setDoc(doc(db, "users", currentUser.uid, "chats", chatId), {
            clearedAt: serverTimestamp()
        }, { merge: true });
        let clearedMs = Date.now();
        try {
            const snapC = await getDoc(doc(db, "users", currentUser.uid, "chats", chatId));
            const ca = snapC.exists() ? snapC.data().clearedAt : null;
            if (ca && ca.toMillis) clearedMs = ca.toMillis();
        } catch (e) {}
        try { localStorage.setItem(clearedKey(chatId), String(clearedMs)); } catch (e) {}

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

// Sohbet içinden "Sohbeti temizle": bende kalıcı olarak temizle, herkes temizlediyse Firestore'dan da sil
export async function wipeChat(chatId) {
    if (!currentUser || !chatId || chatId === 'global') return;
    const me = currentUser.uid;
    const isGrp = isGroupChat(chatId);
    await clearChatForMe(chatId);
    try {
        await setDoc(doc(db, "users", me, "chats", chatId), { lastMessage: '', unreadCount: 0, hasMention: false }, { merge: true });
    } catch (e) {}

    // Herkes sohbeti temizlediyse, hepsinin temizlediği zamana kadarki mesajlar sunucudan da silinir
    try {
        await setDoc(doc(db, "chats", chatId), { [`clearedAt_${me}`]: serverTimestamp() }, { merge: true });
        const chatSnap = await getDoc(doc(db, "chats", chatId));
        const cd = chatSnap.exists() ? chatSnap.data() : {};
        let others = [];
        if (isGrp) {
            const gd = await getGroupData(chatId);
            others = ((gd && gd.members) || []).filter((u) => u !== me);
        } else {
            others = chatId.split('_').filter((u) => u && u !== me);
        }
        let threshold = cd[`clearedAt_${me}`];
        if (!threshold || !threshold.toMillis) return;
        for (const u of others) {
            const c = cd[`clearedAt_${u}`];
            if (!c || !c.toMillis) return; // biri henüz temizlemedi: sunucudan silme
            if (c.toMillis() < threshold.toMillis()) threshold = c;
        }
        for (let guard = 0; guard < 30; guard++) {
            const snap = await getDocs(query(
                collection(db, "chats", chatId, "messages"),
                where("createdAt", "<=", threshold),
                orderBy("createdAt", "asc"),
                limit(100)
            ));
            if (snap.empty) break;
            const res = await Promise.allSettled(snap.docs.map((d) => deleteDoc(d.ref)));
            if (res.every((r) => r.status === 'rejected')) break;
        }
    } catch (err) {
        console.warn("Sohbet sunucudan tam temizlenemedi:", err);
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
    resetMentions(chatId);
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
    // Yerelde hemen güncelle (eski yüklenen / önbellekteki mesajlar canlı dinlenmediği için şart)
    const reactUid = currentUser.uid;
    const setLocalReaction = (val) => {
        if (!entry) return;
        const r = Object.assign({}, entry.data.reactions || {});
        if (val) r[reactUid] = val; else delete r[reactUid];
        entry.data.reactions = r;
        const sess = chatSessions.get(reactChatId);
        if (sess && currentChatId === reactChatId) {
            const top = messageContainer.scrollTop;
            const nearBottom = isNearBottom();
            renderSession(sess);
            if (nearBottom) scrollToBottom(); else messageContainer.scrollTop = top;
        }
    };
    setLocalReaction(current === emoji ? null : emoji);
    try {
        await updateDoc(doc(db, "chats", reactChatId, "messages", msgId), {
            [`reactions.${reactUid}`]: current === emoji ? deleteField() : emoji
        });
    } catch (e) {
        setLocalReaction(current || null);
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
        .sort((a, b) => (b.msgTime || 0) - (a.msgTime || 0));
    if (!items.length) {
        list.innerHTML = '<div style="padding:40px 24px;text-align:center;color:#8696a0;font-size:15px;">Yıldızlı mesaj yok.<br>Bir mesajı seçip üstteki yıldıza dokun.</div>';
        return;
    }
    list.innerHTML = items.map((d) => {
        const mine = currentUser && d.senderUid === currentUser.uid;
        const whoName = mine ? 'Sen' : (d.senderName || d.chatName || 'Kullanıcı');
        const who = (d.chatName && d.chatName !== whoName) ? `${whoName} ▸ ${d.chatName}` : whoName;
        const dt = new Date(d.msgTime || 0);
        const when = dt.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + dt.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        return `<div data-msg="${escapeHtml(d.msgId)}" data-chat="${escapeHtml(d.chatId)}" style="display:flex;align-items:flex-start;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);cursor:pointer;">
            <div style="flex:1;min-width:0;">
                <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;"><span style="color:#34d399;">${escapeHtml(who)}</span><span style="color:#8696a0;">${escapeHtml(when)}</span></div>
                <div style="color:#e9edef;font-size:15px;margin-top:4px;white-space:pre-wrap;overflow-wrap:anywhere;">${escapeHtml(d.preview || '')}</div>
            </div>
            <button type="button" data-unstar="${escapeHtml(d.chatId)}__${escapeHtml(d.msgId)}" style="color:#fbbf24;font-size:18px;padding:4px 6px;"><i class="fa-solid fa-star"></i></button>
        </div>`;
    }).join('');
}

// Yıldızlı mesaja tıklayınca o sohbete gider ve mesajı gösterir (alıntıya dokunmak gibi)
async function goToStarredMessage(chatId, msgId) {
    closeStarredPanel();
    // Sohbet açılırken önce en alta, sonra mesaja kaymasın: mesaj yerine gelene kadar alan gizli kalır
    const reveal = () => { messageContainer.style.visibility = ''; };
    messageContainer.style.visibility = 'hidden';
    const safety = setTimeout(reveal, 5000);
    try {
        if (currentChatId !== chatId) {
            let target = null;
            if (chatId === 'global') target = 'global';
            else target = resolveShareTarget(chatId);
            if (!target) { showToast('Sohbet bulunamadı'); return; }
            await selectChat(target);
        }
        await new Promise((resolve) => {
            let tries = 0;
            const wait = () => {
                if ((currentChatId === chatId && messageElementsById.size > 0) || tries++ > 40) { resolve(); return; }
                setTimeout(wait, 100);
            };
            setTimeout(wait, 100);
        });
        await scrollToOriginalMessage(msgId, true);
    } finally {
        clearTimeout(safety);
        reveal();
    }
}

export function openStarredPanel() {
    if (!currentUser) return;
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
            deleteDoc(doc(db, "users", currentUser.uid, "starred", un.getAttribute('data-unstar'))).catch(() => showToast('Kaldırılamadı'));
            return;
        }
        const row = ev.target.closest('[data-msg]');
        if (!row) return;
        goToStarredMessage(row.getAttribute('data-chat'), row.getAttribute('data-msg'));
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
          if (selectionForwardBtn) selectionForwardBtn.style.display = (onlyEntry && !onlyEntry.data.viewOnce && (onlyType === 'text' || onlyType === 'image')) ? '' : 'none';
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

        // "Herkesten sil" yalnızca gönderildikten sonraki 60 saat içinde mümkün
        const DELETE_ALL_WINDOW_MS = 60 * 60 * 60 * 1000;
        const withinDeleteWindow = ids.every((id) => {
            const en = findMessageEntry(id);
            const ca = en && en.data && en.data.createdAt;
            if (!ca) return true; // henüz sunucuya yazılmamış (yeni) mesaj
            const ms = ca.toMillis ? ca.toMillis() : (ca.toDate ? ca.toDate().getTime() : Number(ca));
            return Date.now() - ms <= DELETE_ALL_WINDOW_MS;
        });
        const canDeleteAll = allMine && withinDeleteWindow;

        const delChoice = await auraDialog({
                    accent: auraAccent(),
            title: ids.length > 1 ? `${ids.length} mesaj silinsin mi?` : 'Mesaj silinsin mi?',
            buttons: canDeleteAll
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
            const markDeletedForMe = (list) => list.forEach((m) => {
                if (!removeLocally.includes(m.id)) return;
                const prev = Array.isArray(m.data.deletedFor) ? m.data.deletedFor : [];
                if (!prev.includes(currentUser.uid)) m.data.deletedFor = prev.concat(currentUser.uid);
            });
            markDeletedForMe(session.olderMessagesPrepended);
            markDeletedForMe(session.messages);
            everyoneDeletedIds.forEach((x) => {
                const e = session.messages.find((m) => m.id === x) || session.olderMessagesPrepended.find((m) => m.id === x);
                if (e) Object.assign(e.data, { type: 'deleted', deleted: true, text: '', imageUrl: null, images: null, imagesCount: 0, lat: null, lng: null });
            });
            writeChatDiskCache(chatIdAtDeleteTime, session);
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
const expiredDeleted = new Set();
let expirySweepTimer = null;

// Süreli mesajlar: seçenekler (ms). 0 = kapalı
export function getDisappearAfter(chatId) {
    const s = chatSessions.get(chatId);
    return s && s.disappearAfter ? s.disappearAfter : 0;
}

export async function setDisappearAfter(chatId, ms) {
    if (!currentUser || !chatId || chatId === 'global') return;
    const s = chatSessions.get(chatId);
    await setDoc(doc(db, "chats", chatId), { disappearAfter: ms || 0 }, { merge: true });
    if (s) s.disappearAfter = ms || 0;
    const label = ms >= 7 * 24 * 3600 * 1000 ? '7 gün' : '24 saat';
    const text = ms ? `${currentUser.name} süreli mesajları açtı: yeni mesajlar ${label} sonra silinir` : `${currentUser.name} süreli mesajları kapattı`;
    try {
        await addDoc(collection(db, "chats", chatId, "messages"), {
            type: 'system',
            text,
            senderUid: currentUser.uid,
            senderName: currentUser.name,
            createdAt: serverTimestamp(),
            read: false
        });
    } catch (e) {}
}

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

    const nowMs = Date.now();
    let nextExpiry = 0;
    const visibleAll = all.filter(({ id: mid, data: m }) => {
        if (currentUser && Array.isArray(m.deletedFor) && m.deletedFor.includes(currentUser.uid)) return false;
        if (session.clearedAt && m.createdAt && m.createdAt.toMillis && m.createdAt.toMillis() <= session.clearedAt.toMillis()) return false;
        if (m.expiresAtMs) {
            if (m.expiresAtMs <= nowMs) {
                // Süresi dolan mesaj herkeste gizlenir; kendi mesajımızsa kaydı da sileriz
                if (currentUser && m.senderUid === currentUser.uid && !expiredDeleted.has(mid)) {
                    expiredDeleted.add(mid);
                    deleteDoc(doc(db, "chats", session.chatId, "messages", mid)).catch(() => {});
                }
                return false;
            }
            if (!nextExpiry || m.expiresAtMs < nextExpiry) nextExpiry = m.expiresAtMs;
        }
        return true;
    });
    if (expirySweepTimer) { clearTimeout(expirySweepTimer); expirySweepTimer = null; }
    if (nextExpiry) {
        const chatIdAtSchedule = session.chatId;
        expirySweepTimer = setTimeout(() => {
            expirySweepTimer = null;
            if (currentChatId !== chatIdAtSchedule) return;
            const s = chatSessions.get(chatIdAtSchedule);
            if (!s) return;
            const top = messageContainer.scrollTop;
            const nearBottom = isNearBottom();
            renderSession(s);
            if (nearBottom) scrollToBottom(); else messageContainer.scrollTop = top;
        }, Math.min(2147483000, Math.max(300, nextExpiry - nowMs + 250)));
    }
    const isBubble = (m) => m.type !== 'system' && m.type !== 'call_duration';
    visibleAll.forEach(({ id, data: msg }, vi) => {
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
        // Grup: aynı kişinin arka arkaya mesajlarında avatar yalnızca İLK mesajda görünür
        let avatarMode;
        if (session.isGroup && !isMine && isBubble(msg)) {
            const pv = visibleAll[vi - 1];
            const sameRun = !!(pv && isBubble(pv.data) && pv.data.senderUid === msg.senderUid
                && dayKeyOf(pv.data.createdAt ? pv.data.createdAt.toDate() : new Date()) === dayKey
                && !(unreadDivider && unreadDivider.chatId === session.chatId && unreadDivider.msgId === id));
            avatarMode = sameRun ? 'space' : 'show';
        }
        fragment.appendChild(buildMessageElement(msg, isMine, id, avatarMode));
    });

    messageContainer.appendChild(fragment);
    refreshSearchAfterRender(session);
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
     ? `<img src="${cachedSrc}" class="w-full h-full object-cover" data-media-msg="${msgId}" data-media-idx="${i}" oncontextmenu="return false" draggable="false" style="-webkit-user-drag:none;" onclick="openAlbumLightbox('${chatId}','${msgId}',${imagesCount},${i})">`
            : `<div class="w-full h-full flex items-center justify-center bg-black/20" data-media-msg="${msgId}" data-media-idx="${i}" onclick="openAlbumLightbox('${chatId}','${msgId}',${imagesCount},${i})"><i class="fa-solid fa-image text-gray-500"></i></div>`;
        tiles += `
            <div class="relative overflow-hidden" style="aspect-ratio:1/1;">
                ${inner}
                ${showOverlay ? `<div class="absolute inset-0 bg-black/50 flex items-center justify-center text-white text-lg font-bold pointer-events-none">+${extra}</div>` : ''}
            </div>`;
    }

    return `<div class="grid grid-cols-2 gap-0.5 rounded-lg overflow-hidden" style="width:280px;max-width:100%;">${tiles}</div>`;
}

function buildMessageElement(msg, isMine, msgId, avatarMode) {
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
    const isViewOnce = msg.type === 'image' && !!msg.viewOnce;
    const isSingleImage = !isViewOnce && msg.type === 'image' && !isAlbum && (msg.imageUrl || msg.imageDelivered);
    const isImage = isAlbum || isSingleImage;

    const localCachedSrc = isSingleImage ? mediaUriCache.get(`${currentChatId}/${msgId}`) : null;
    const initialImgSrc = localCachedSrc || msg.imageUrl || '';

let bodyHtml;
if (isViewOnce) {
        if (msg.viewOnceOpened || msg.imageDelivered) {
            bodyHtml = `<p class="break-words flex items-center gap-2 text-gray-400 italic text-[13px]"><i class="fa-regular fa-circle-check"></i> Fotoğraf açıldı</p>`;
        } else if (isMine) {
            bodyHtml = `<p class="break-words flex items-center gap-2 text-gray-200 text-[13px]"><span style="display:inline-flex;width:22px;height:22px;border:2px solid currentColor;border-radius:9999px;align-items:center;justify-content:center;font-weight:700;font-size:12px;">1</span> Fotoğraf · henüz açılmadı</p>`;
        } else {
            bodyHtml = `<p data-viewonce="${msgId}" class="break-words flex items-center gap-2 text-white text-[14px] cursor-pointer"><span style="display:inline-flex;width:26px;height:26px;border:2px solid var(--aura-btn,#22c55e);color:var(--aura-btn,#22c55e);border-radius:9999px;align-items:center;justify-content:center;font-weight:700;font-size:13px;">1</span> Fotoğraf · görmek için dokun</p>`;
        }
    } else if (msg.type === 'document') {
        const ext = (String(msg.fileName || '').split('.').pop() || '').toLowerCase();
        const col = ext === 'pdf' ? '#ef4444' : (/^docx?$/.test(ext) ? '#3b82f6' : (/^(xlsx?|csv)$/.test(ext) ? '#22c55e' : (/^pptx?$/.test(ext) ? '#f97316' : '#94a3b8')));
        const saved = !msg.imageUrl && msg.imageDelivered;
        const state = saved ? (isMine ? 'Teslim edildi' : 'Kaydedildi · İndirilenler/AuraChat') : 'Dokun ve kaydet';
        bodyHtml = `<div data-doc="${msgId}" class="flex items-center gap-3 cursor-pointer" style="min-width:200px;max-width:260px;">
            <span style="flex-shrink:0;width:42px;height:48px;border-radius:8px;background:${col};color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;">${escapeHtml((ext || 'dosya').slice(0, 4).toUpperCase())}</span>
            <span style="min-width:0;display:flex;flex-direction:column;">
                <span class="text-sm font-medium" style="overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all;">${escapeHtml(msg.fileName || 'Belge')}</span>
                <span class="text-[11px] text-gray-300">${escapeHtml(formatFileSize(msg.fileSize))} · ${state}</span>
            </span>
        </div>`;
    } else if (isAlbum) {
        bodyHtml = buildAlbumTilesHtml(currentChatId, msgId, imagesCount);
        if (msg.text) bodyHtml += `<p class="break-words whitespace-pre-wrap px-2 pt-1.5 pb-0.5">${escapeHtml(msg.text)}</p>`;
    } else if (isSingleImage) {
        bodyHtml = initialImgSrc
            ? `<img src="${initialImgSrc}" class="rounded-lg cursor-pointer block" style="max-width:280px;max-height:380px;width:auto;height:auto;-webkit-user-drag:none;" data-media-msg="${msgId}" oncontextmenu="return false" draggable="false" onclick="openImageLightbox(this.src)">`
            : `<div class="rounded-lg bg-black/20 flex items-center justify-center" data-media-msg="${msgId}" style="width:220px;height:220px;max-width:100%;"><i class="fa-solid fa-image text-gray-500"></i></div>`;
        if (msg.text) bodyHtml += `<p class="break-words whitespace-pre-wrap px-2 pt-1.5 pb-0.5">${escapeHtml(msg.text)}</p>`;
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
        const fullText = msg.text || '';
        const textLines = fullText.split('\n');
        const tooLong = fullText.length > 700 || textLines.length > 14;
        if (tooLong && !expandedMsgIds.has(msgId)) {
            let shown = textLines.slice(0, 14).join('\n');
            if (shown.length > 700) shown = shown.slice(0, 700);
            bodyHtml = `<p class="break-words whitespace-pre-wrap">${renderMsgText(shown.trimEnd(), msg)}…</p><button type="button" data-read-more="${msgId}" class="inline-block text-[12.5px] font-medium mt-1.5 px-3 py-1 rounded-full text-white" style="background:rgba(0,0,0,0.28);">Devamını okuyun</button>`;
        } else {
            bodyHtml = `<p class="break-words whitespace-pre-wrap">${renderMsgText(fullText, msg)}</p>${buildLinkPreviewHtml(msg.linkPreview)}`;
        }
    }

  const forwardedLabel = msg.forwarded
        ? `<div class="text-[11px] text-gray-300 italic px-2 pt-1 pb-0.5"><i class="fa-solid fa-share mr-1"></i>İletildi</div>`
        : '';

    const isReplyable = !['deleted', 'system', 'call_duration', 'missed_call', 'declined_call'].includes(msg.type);
        const replyQuoteHtml = buildReplyQuoteHtml(msg.replyTo, isMine);

        const reactionsHtml = buildReactionsHtml(msg, isMine);
    const editedLabel = (msg.edited && msg.type !== 'deleted') ? 'düzenlendi · ' : '';
    if (reactionsHtml) msgDiv.style.marginBottom = '14px';

    const actionButtonsHtml = isImage
        ? `<button type="button" class="flex-shrink-0 self-center w-8 h-8 rounded-full bg-black/30 hover:bg-black/50 text-gray-300 flex items-center justify-center ${isMine ? 'mr-2' : 'ml-2'}" onclick="forwardImageMessage('${msgId}')"><i class="fa-solid fa-share text-xs"></i></button>`
        : '';

    if (isMine) {
        const isReadByAll = currentIsGroup ? groupMessageReadByAll(msg) : !!msg.read;
        const tickColor = isReadByAll ? 'text-[#53bdeb]' : 'text-gray-400';
        const timeHtml = isAlbum
            ? `<div class="absolute bottom-2 right-2 flex items-center space-x-1">
                   <span class="aura-time text-[10px] text-white">${timeStr}</span>
                <i class="fa-solid fa-check-double text-[10px] ${isReadByAll ? 'text-[#53bdeb]' : 'text-gray-200'}"></i>
               </div>`
            : isImage
            ? `<div class="absolute bottom-2 right-2 flex items-center space-x-1 bg-black/45 rounded-full px-1.5 py-0.5">
                   <span class="aura-time text-[10px] text-white">${timeStr}</span>
                <i class="fa-solid fa-check-double text-[10px] ${isReadByAll ? 'text-[#53bdeb]' : 'text-gray-200'}"></i>
               </div>`
                : `<div class="flex items-center justify-end space-x-1 mt-1">
                   <span class="aura-time text-[10px] text-white">${editedLabel}${timeStr}</span>
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
                ${reactionsHtml}
            </div>
        `;
    } else {
        const timeHtml = isAlbum
            ? `<div class="absolute bottom-2 right-2"><span class="aura-time text-[10px] text-white">${timeStr}</span></div>`
            : isImage
            ? `<div class="absolute bottom-2 right-2 bg-black/45 rounded-full px-1.5 py-0.5"><span class="aura-time text-[10px] text-white">${timeStr}</span></div>`
                 : `<span class="aura-time text-[10px] text-white float-right ml-3 mt-1">${editedLabel}${timeStr}</span>`;
        msgDiv.className = "flex justify-start rounded-lg transition-colors";
        msgDiv.innerHTML = `
            ${groupAvatarHtml(msg, avatarMode)}
            <div class="bg-[#202c33] text-gray-100 ${isImage ? 'p-1' : 'px-4 py-2'} rounded-xl max-w-[80%] md:max-w-md text-sm shadow relative">
                           ${(currentChatId === 'global' || currentIsGroup) ? senderLineHtml(msg, isImage) : ''}
                ${forwardedLabel}
                ${replyQuoteHtml}
                ${bodyHtml}
                ${timeHtml}
                ${reactionsHtml}
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
                            tileEl.outerHTML = `<img src="${src}" class="w-full h-full object-cover" data-media-msg="${msgId}" data-media-idx="${i}" oncontextmenu="return false" draggable="false" style="-webkit-user-drag:none;" onclick="openAlbumLightbox('${currentChatId}','${msgId}',${imagesCount},${i})">`;
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
              el.outerHTML = `<img src="${src}" class="rounded-lg cursor-pointer block" style="max-width:280px;max-height:380px;width:auto;height:auto;-webkit-user-drag:none;" data-media-msg="${msgId}" oncontextmenu="return false" draggable="false" onclick="openImageLightbox(this.src)">`;
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

if (msg.type === 'document') {
        const docEl = msgDiv.querySelector('[data-doc]');
        if (docEl) docEl.addEventListener('click', (e) => {
            if (selectionMode) return;
            e.stopPropagation();
            saveDocument(msgId);
        });
    }
if (isViewOnce) {
        const voEl = msgDiv.querySelector('[data-viewonce]');
        if (voEl) voEl.addEventListener('click', (e) => {
            if (selectionMode) return;
            e.stopPropagation();
            openViewOnce(msgId);
        });
    }
if (msg.type === 'audio') bindAudioPlayer(msgDiv, msgId, msg);

    const readMoreBtn = msgDiv.querySelector('[data-read-more]');
    if (readMoreBtn) {
        readMoreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            expandedMsgIds.add(msgId);
            const p = readMoreBtn.previousElementSibling;
            if (p) p.textContent = msg.text || '';
            readMoreBtn.remove();
        });
    }

if (selectedMessageIds.has(msgId)) {
        msgDiv.classList.add('msg-selected');
    }

        attachSelectionHandlers(msgDiv, msgId, isReplyable, msg, isMine);
    if (isStarred(currentChatId, msgId)) msgDiv.classList.add('aura-starred');
    messageElementsById.set(msgId, msgDiv);
    return msgDiv;
}

function attachSelectionHandlers(el, msgId, replyable, msg, isMine) {
    let pressTimer = null;
    let longPressTriggered = false;

    const startPress = () => {
        longPressTriggered = false;
        if (document.activeElement === messageInput) window.__auraKeepFocusUntil = Date.now() + 1500;
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
let attachMenuTargetHeight = 0;
let attachComposerHeight = 0;
let composerWrap = null;

function ensureComposerWrap() {
    if (composerWrap) return composerWrap;
    const composerRow = messageInput.parentElement;
    const wrap = document.createElement('div');
    wrap.style.overflow = 'hidden';
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.justifyContent = 'flex-end';
    wrap.style.flexShrink = '0';
    composerRow.parentElement.insertBefore(wrap, composerRow);
    wrap.appendChild(composerRow);
    composerWrap = wrap;
    return wrap;
}

function ensureAttachMenu() {
    if (attachMenuEl) return attachMenuEl;
    const el = document.createElement('div');
    // min-h-[45vh] YOK: bu sınıf popup'ın JS'ten küçültülmesini CSS
    // seviyesinde engelliyordu (görsel olarak 45vh'nin altına asla
    // inmiyordu) - tüm önceki senkron sorunlarının asıl kaynağı buydu.
 el.className = 'hidden flex-shrink-0 pt-2 overflow-hidden ' + (galleryAvailable() ? 'pb-0' : 'pb-6');
el.innerHTML = `
        <div class="aura-attach-inner" style="display:flex;flex-direction:column;height:100%;">
        <div class="aura-attach-handle w-10 h-1 bg-white/25 rounded-full mx-auto mb-3 flex-shrink-0"></div>
        <div class="aura-attach-btns grid grid-cols-4 gap-x-3 px-3 pb-1 flex-shrink-0">
            <button type="button" data-attach="gallery" class="w-full flex flex-col items-center gap-2 active:scale-95 transition">
                <span class="w-full h-12 rounded-full border border-white/15 active:bg-white/10 flex items-center justify-center transition">
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#3b9eff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                </span>
                <span class="text-gray-300 text-[14px]">Galeri</span>
            </button>
            <button type="button" data-attach="camera" class="w-full flex flex-col items-center gap-2 active:scale-95 transition">
                <span class="w-full h-12 rounded-full border border-white/15 active:bg-white/10 flex items-center justify-center transition">
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#ff2d75" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>
                </span>
                <span class="text-gray-300 text-[14px]">Kamera</span>
            </button>
            <button type="button" data-attach="location" class="w-full flex flex-col items-center gap-2 active:scale-95 transition">
                <span class="w-full h-12 rounded-full border border-white/15 active:bg-white/10 flex items-center justify-center transition">
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#12c26b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s7-7.58 7-12a7 7 0 1 0-14 0c0 4.42 7 12 7 12z"></path><circle cx="12" cy="10" r="2.5"></circle></svg>
                </span>
                <span class="text-gray-300 text-[14px]">Konum</span>
            </button>
            <button type="button" data-attach="document" class="w-full flex flex-col items-center gap-2 active:scale-95 transition">
                <span class="w-full h-12 rounded-full border border-white/15 active:bg-white/10 flex items-center justify-center transition">
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="9" y1="13" x2="15" y2="13"></line><line x1="9" y1="17" x2="15" y2="17"></line></svg>
                </span>
                <span class="text-gray-300 text-[14px]">Belge</span>
            </button>
        </div>
        </div>
    `;
    messageInput.parentElement.insertAdjacentElement('afterend', el);
    if (galleryAvailable()) {
        mountGallery(el.querySelector('.aura-attach-inner'), (files) => {
            composer.addImages(files);
            closeAttachMenu(true);
            messageInput.focus();
        }, (count) => applySelectionLayout(count));
    }

    el.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-attach]');
        if (btn) handleAttachChoice(btn.dataset.attach);
    });

    // Sürükleme: yukarı = galeriyi tam ekran yap, aşağı = küçült / kapat
    el.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        attachDragStartY = e.touches[0].clientY;
        attachDragZone = (e.target.closest && e.target.closest('.aura-gal-grid')) ? 'grid' : 'top';
        attachGestureDone = false;
        if (!attachExpanded) el.style.transition = 'none';
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
        if (attachDragStartY === null || attachGestureDone) return;
        const raw = e.touches[0].clientY - attachDragStartY;
        if (attachDragZone === 'grid') {
            const g = el.querySelector('.aura-gal-grid');
            if (!attachExpanded && raw < -30) { attachGestureDone = true; el.style.transition = ''; expandAttachMenu(); }
            else if (!attachExpanded && raw > 0) {
                // Yarım boyda resimlerden aşağı çekince menü parmağı takip eder, bırakınca kapanır
                el.style.height = Math.max(0, attachRestHeight() - raw) + 'px';
            }
            else if (attachExpanded && raw > 50 && g && g.scrollTop <= 0) { attachGestureDone = true; collapseAttachMenu(); }
            return;
        }
        if (attachExpanded) {
            if (raw > 40) { attachGestureDone = true; collapseAttachMenu(); }
            return;
        }
        if (raw < -30 && galleryAvailable()) {
            attachGestureDone = true;
            el.style.transition = '';
            expandAttachMenu();
            return;
        }
        const dy = Math.max(0, raw);
        el.style.height = Math.max(0, attachRestHeight() - dy) + 'px';
    }, { passive: true });

    el.addEventListener('touchend', (e) => {
        if (attachDragStartY === null) return;
        const zone = attachDragZone;
        const done = attachGestureDone;
        const dy = Math.max(0, e.changedTouches[0].clientY - attachDragStartY);
        attachDragStartY = null;
        if (done || attachExpanded) return;
        if (dy > 60) {
            closeAttachMenu();
        } else {
            el.style.transition = 'height 0.15s ease-out';
            el.style.height = attachRestHeight() + 'px';
            setTimeout(() => { el.style.transition = ''; }, 160);
        }
    });

    el.addEventListener('touchcancel', () => {
        attachDragStartY = null;
        if (attachExpanded) return;
        el.style.transition = 'height 0.15s ease-out';
        el.style.height = attachRestHeight() + 'px';
    });

    attachMenuEl = el;
    return el;
}

let attachExpanded = false;
let attachDragZone = 'top';
let attachGestureDone = false;

// Menü büyürken / küçülürken arkadaki sohbet görsel olarak yerinde dursun
// (mesaj alanının iç boşluğu değişirken kaydırmayı telafi eder)
function pinChatBottom(ms) {
    const keep = messageContainer.scrollTop;
    const pad0 = parseFloat(getComputedStyle(messageContainer).paddingTop) || 0;
    const t0 = performance.now();
    const step = () => {
        const p = parseFloat(getComputedStyle(messageContainer).paddingTop) || 0;
        messageContainer.scrollTop = Math.max(0, keep + (p - pad0));
        if (performance.now() - t0 < ms) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

const ROW_PROPS = ['height', 'padding-top', 'padding-bottom', 'margin-top', 'margin-bottom', 'border-top-width', 'border-bottom-width'];
let composerRowHidden = false;

// Mesaj kutusunu yumuşakça küçülterek gizler (ani zıplama olmasın)
function hideComposerRow() {
    const row = messageInput.parentElement;
    if (composerRowHidden) return;
    composerRowHidden = true;
    const cs = getComputedStyle(row);
    row.__auraSaved = {};
    ROW_PROPS.forEach((p) => { row.__auraSaved[p] = p === 'height' ? row.offsetHeight + 'px' : cs.getPropertyValue(p); });
    row.style.setProperty('overflow', 'hidden', 'important');
    row.style.setProperty('min-height', '0px', 'important');
    row.style.setProperty('height', row.__auraSaved.height, 'important');
    void row.offsetHeight;
    row.style.setProperty('transition', 'height .2s ease-out, padding .2s ease-out, margin .2s ease-out, border-width .2s ease-out, opacity .15s', 'important');
    ROW_PROPS.forEach((p) => row.style.setProperty(p, '0px', 'important'));
    row.style.setProperty('opacity', '0', 'important');
    row.style.setProperty('pointer-events', 'none', 'important');
}

function clearComposerRowInline() {
    const row = messageInput.parentElement;
    ['overflow', 'min-height', 'transition', 'opacity', 'pointer-events'].concat(ROW_PROPS).forEach((p) => row.style.removeProperty(p));
    row.__auraSaved = null;
}

// instant: true ise animasyonsuz geri getirir
function showComposerRow(instant) {
    const row = messageInput.parentElement;
    if (!composerRowHidden) return;
    composerRowHidden = false;
    if (instant === true || !row.__auraSaved) { clearComposerRowInline(); return; }
    const saved = row.__auraSaved;
    ROW_PROPS.forEach((p) => row.style.setProperty(p, saved[p], 'important'));
    row.style.setProperty('opacity', '1', 'important');
    setTimeout(() => { if (!composerRowHidden) clearComposerRowInline(); }, 240);
}

// Resim seçilmediyse menü ilk boyunda, seçim başladıysa sayfanın ortasına kadar yükselir
function attachRestHeight() {
    if (galleryAvailable() && gallerySelectedCount() > 0) {
        const mid = Math.round((window.__auraMaxVV || window.innerHeight) * 0.55);
        return Math.max(attachMenuTargetHeight, mid);
    }
    return attachMenuTargetHeight;
}

function setAttachButtonsHidden(hide) {
    if (!attachMenuEl) return;
    const btns = attachMenuEl.querySelector('.aura-attach-btns');
    if (btns) btns.style.display = hide ? 'none' : '';
    // İkonlar yokken (seçim / tam ekran) üstteki boşluklar da kısalsın
    const handle = attachMenuEl.querySelector('.aura-attach-handle');
    const grid = attachMenuEl.querySelector('.aura-gal-grid');
    attachMenuEl.style.paddingTop = hide ? '6px' : '';
    if (handle) handle.style.marginBottom = hide ? '6px' : '';
    if (grid) grid.style.marginTop = hide ? '2px' : '';
}

function applySelectionLayout(count) {
    if (!attachMenuEl || !attachMenuOpen) return;
    setAttachButtonsHidden(count > 0 || attachExpanded);
    if (attachExpanded) return;
    if (count > 0) hideComposerRow(); else showComposerRow();
    pinChatBottom(260);
    attachMenuEl.style.transition = 'height 0.2s ease-out';
    attachMenuEl.style.height = attachRestHeight() + 'px';
    setTimeout(() => { if (attachMenuEl && !attachExpanded) attachMenuEl.style.transition = ''; }, 230);
}

function clearExpandedLayout() {
    showComposerRow(true);
    messageContainer.style.transition = '';
    messageContainer.style.paddingTop = '';
    messageContainer.style.paddingBottom = '';
    messageContainer.style.flex = '';
    messageContainer.style.minHeight = '';
    if (attachMenuEl) {
        attachMenuEl.style.flex = '';
        attachMenuEl.style.minHeight = '';
        attachMenuEl.style.paddingBottom = '';
    }
}

// Menüyü tam ekran yapar: mesaj kutusu gizlenir, galeri ekranı doldurur
function expandAttachMenu() {
    if (!attachMenuEl || attachExpanded || !galleryAvailable()) return;
    const row = messageInput.parentElement;
    let rowFull = 0;
    if (!composerRowHidden) {
        const rcs = getComputedStyle(row);
        rowFull = row.offsetHeight + (parseFloat(rcs.marginTop) || 0) + (parseFloat(rcs.marginBottom) || 0);
    }
    const total = messageContainer.clientHeight + attachMenuEl.offsetHeight + rowFull;
    attachExpanded = true;
    pinChatBottom(260);
    setAttachButtonsHidden(true);
    hideComposerRow();
    messageContainer.style.transition = 'padding .2s ease-out';
    messageContainer.style.paddingTop = '0px';
    messageContainer.style.paddingBottom = '0px';
    attachMenuEl.style.paddingBottom = '0px';
    attachMenuEl.style.transition = 'height 0.2s ease-out';
    attachMenuEl.style.height = Math.max(attachMenuTargetHeight, Math.round(total)) + 'px';
    setGalleryExpanded(true);
    // Animasyon bitince menü kalan tüm boşluğu tam doldursun (kenarlarda boşluk kalmasın)
    setTimeout(() => {
        if (!attachMenuEl || !attachExpanded) return;
        attachMenuEl.style.transition = '';
        messageContainer.style.transition = '';
        messageContainer.style.flex = '0 0 0px';
        messageContainer.style.minHeight = '0px';
        attachMenuEl.style.height = 'auto';
        attachMenuEl.style.flex = '1 1 0px';
        attachMenuEl.style.minHeight = '0px';
    }, 230);
    // Geri tuşu önce tam ekrandan yarım boya döndürsün
    attachExpandEntry = true;
    pushBackState(collapseFromBack);
}

let attachExpandEntry = false;
function collapseFromBack() {
    attachExpandEntry = false;
    collapseAttachMenu(true);
}

function collapseAttachMenu(fromBack) {
    if (!attachMenuEl || !attachExpanded) return;
    if (attachExpandEntry && fromBack !== true) {
        attachExpandEntry = false;
        popBackState();
    }
    attachExpanded = false;
    const curH = attachMenuEl.offsetHeight;
    const hasSel = gallerySelectedCount() > 0;
    // Dolgu modundan çık, ama görüntü yerinde kalsın
    attachMenuEl.style.transition = 'none';
    attachMenuEl.style.flex = '';
    attachMenuEl.style.minHeight = '';
    attachMenuEl.style.height = curH + 'px';
    messageContainer.style.flex = '';
    messageContainer.style.minHeight = '';
    messageContainer.style.transition = 'padding .2s ease-out';
    messageContainer.style.paddingTop = '';
    messageContainer.style.paddingBottom = '';
    void attachMenuEl.offsetHeight;
    setGalleryExpanded(false);
    setAttachButtonsHidden(hasSel);
    if (!hasSel) showComposerRow();
    pinChatBottom(260);
    requestAnimationFrame(() => {
        attachMenuEl.style.transition = 'height 0.2s ease-out, padding 0.2s ease-out';
        attachMenuEl.style.paddingBottom = '';
        attachMenuEl.style.height = attachRestHeight() + 'px';
    });
    setTimeout(() => {
        if (attachMenuEl && !attachExpanded) attachMenuEl.style.transition = '';
        if (!attachExpanded) messageContainer.style.transition = '';
    }, 260);
}

let attachMenuCloseTimer = null;
function closeAttachMenuFromBack(instant) {
    setAttachButtonsHidden(false);
    if (attachExpanded || composerRowHidden) {
        attachExpanded = false;
        clearExpandedLayout();
        instant = true;
    }
    try { closeGallery(); } catch (e) {}
    attachMenuOpen = false;
    clearTimeout(attachMenuCloseTimer);
    messageInput.parentElement.classList.remove('menu-open');
    const finish = () => {
        if (attachMenuEl) {
            attachMenuEl.classList.add('hidden');
            attachMenuEl.style.transition = '';
            attachMenuEl.style.transform = '';
            attachMenuEl.style.height = '';
            attachMenuEl.style.paddingTop = '';
            attachMenuEl.style.paddingBottom = '';
        }
        if (composerWrap) {
            composerWrap.style.transition = '';
            composerWrap.style.height = '';
        }
    };
    if (instant === true || !attachMenuEl || attachMenuEl.classList.contains('hidden')) {
        finish();
        return;
    }
    // Aşağı doğru küçülerek kapanır, mesaj kutusu ve sohbet de aşağı iner
    attachMenuEl.style.transition = 'height 0.22s ease-out, padding 0.22s ease-out';
    attachMenuEl.style.height = '0px';
    attachMenuEl.style.paddingTop = '0px';
    attachMenuEl.style.paddingBottom = '0px';
    attachMenuCloseTimer = setTimeout(finish, 240);
}

// Ekran yüksekliğinin en büyük değerini takip et (klavyesiz tam yükseklik)
window.__auraMaxVV = window.visualViewport ? window.visualViewport.height : window.innerHeight;
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (window.visualViewport.height > window.__auraMaxVV) window.__auraMaxVV = window.visualViewport.height;
        // Klavye yüksekliğini hafızaya al (klavye kapalıyken popup'ın boyu için)
        const kbNow = window.__auraMaxVV - window.visualViewport.height;
        if (kbNow > 100) window.__auraKbH = Math.round(kbNow);
    });
}

function openAttachMenu() {
  if (attachMenuOpen) return;
    const wasNearBottom = isNearBottom();
    const menu = ensureAttachMenu();
    clearTimeout(attachMenuCloseTimer);
    messageInput.parentElement.classList.add('menu-open');
    const hadFocus = document.activeElement === messageInput ||
        (!!window.visualViewport && (window.__auraMaxVV - window.visualViewport.height) > 100);

    // Klavye kapanmadan ÖNCE ne kadar yer kapladığını ölç - popup'ı tam o
    // boşluk kadar açacağız.
    if (hadFocus) {
        // Klavye açıkken popup anında geçiyor, ekran yüksekliği yumuşatılmasın
        document.body.style.transition = 'none';
        setTimeout(() => { document.body.style.transition = ''; }, 900);
    }
    const fullH = Math.max(window.__auraFullViewportHeight || 0, window.__auraMaxVV || 0, window.innerHeight);
    let kbHeight = 0;
    if (hadFocus && window.visualViewport && (fullH - window.visualViewport.height) > 100) {
        // Popup, mesaj kutusunun şu anki tabanından ekranın altına kadar olan boşluğu doldurur
        const rowBottom = messageInput.parentElement.getBoundingClientRect().bottom;
        kbHeight = Math.round(fullH - rowBottom);
    }

    messageInput.blur();

    if (hadFocus) {
        document.body.style.height = fullH + 'px';
        document.body.style.top = '0px';
    }

    // Popup rengini üst barla eşitle - tema değişip üst bar rengi
    // değişirse popup da otomatik takip etsin diye her açılışta canlı okunuyor
    const topBar = document.getElementById('chat-top-bar');
    if (topBar) menu.style.backgroundColor = getComputedStyle(topBar).backgroundColor;

if (kbHeight > 100) window.__auraPopupH = kbHeight;
    attachMenuTargetHeight = kbHeight > 100
        ? kbHeight
        : (window.__auraPopupH || window.__auraKbH || Math.round(fullH * 0.3));
    const slideUp = !(kbHeight > 100);
    menu.style.height = attachMenuTargetHeight + 'px';

    // Input çubuğunu, taşıyarak değil GERÇEK YÜKSEKLİĞİNİ sıfırlayarak
    // gizliyoruz - popup ile aynı sütunda normal akışta oldukları için
    // aralarında boşluk oluşması imkansız hale geliyor. Sürüklerken
    // ikisinin yüksekliğini ters orantılı, birebir aynı anda değiştireceğiz.
    menu.style.transform = '';
    menu.classList.remove('hidden');
    if (slideUp) {
        // Klavye kapalı: menü aşağıdan büyür, mesaj kutusu ve sohbet yukarı itilir
        menu.style.transition = 'none';
        menu.style.height = '0px';
        menu.style.paddingTop = '0px';
        menu.style.paddingBottom = '0px';
        void menu.offsetHeight;
        requestAnimationFrame(() => {
            menu.style.transition = 'height 0.22s ease-out, padding 0.22s ease-out';
            menu.style.height = attachMenuTargetHeight + 'px';
            menu.style.paddingTop = '';
            menu.style.paddingBottom = '';
            if (wasNearBottom) {
                const t0 = performance.now();
                const pin = () => {
                    messageContainer.scrollTop = messageContainer.scrollHeight;
                    if (performance.now() - t0 < 260) requestAnimationFrame(pin);
                };
                requestAnimationFrame(pin);
            }
        });
        setTimeout(() => { menu.style.transition = ''; }, 260);
    } else {
        // Klavye açık: mesaj kutusu sabit, menü klavyenin yerine anında geçer
        menu.style.transition = '';
    }
    attachMenuOpen = true;
    showComposerRow(true);
    setAttachButtonsHidden(false);
    try { openGallery(); } catch (e) {}
    pushBackState(closeAttachMenuFromBack);
    if (wasNearBottom) scrollToBottom();
}

function closeAttachMenu(instant) {
    if (!attachMenuOpen) return;
    const hadExpandEntry = attachExpandEntry;
    closeAttachMenuFromBack(instant);
    if (hadExpandEntry) { attachExpandEntry = false; popBackState(); }
    popBackState();
}

function handleAttachChoice(kind) {
    closeAttachMenu();
    if (kind === 'location') {
        sendCurrentLocation();
        return;
    }
    if (kind === 'document') {
        pickDocument();
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
const forwardTargets = new Map(); // seçilen kişiler: uid -> kullanıcı
let multiForward = false;
function closeForwardPickerFromBack() {
    if (forwardPickerEl) {
        forwardPickerEl.classList.add('hidden');
        forwardPickerEl.classList.remove('flex');
    }
    forwardPickerOpen = false;
    pendingShare = null;
    forwardTargets.clear();
    refreshForwardBar();
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
        <div id="forward-send-bar" class="hidden items-center px-4 py-3 bg-[#202c33] flex-shrink-0">
            <p id="forward-send-names" class="flex-1 min-w-0 text-gray-300 text-sm truncate"></p>
            <button type="button" id="forward-send-btn" class="ml-3 w-12 h-12 rounded-full bg-emerald-600 text-white flex items-center justify-center flex-shrink-0"><i class="fa-solid fa-paper-plane"></i></button>
        </div>
    `;
    document.body.appendChild(el);
    el.querySelector('#forward-back-btn').addEventListener('click', closeForwardPicker);
        el.querySelector('#forward-send-btn').addEventListener('click', () => sendToTargets(Array.from(forwardTargets.values())));
    forwardPickerEl = el;
    return el;
}

function openForwardPicker() {
    const el = ensureForwardPicker();
    const titleEl = el.querySelector('h2');
    if (titleEl) titleEl.textContent = pendingShare ? 'Şuna gönder' : 'Şuna ilet';
    const listEl = el.querySelector('#forward-list');
    listEl.innerHTML = '';
        forwardTargets.clear();
    refreshForwardBar();

    const usersMap = window.__aurachatUsers;
    const users = usersMap
        ? Array.from(usersMap.values()).filter((u) => u.uid !== currentUser.uid)
        : [];
    users.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'tr'));

    // Üyesi olduğun gruplar (liste özetlerinden)
    const groupTargets = [];
    if (window.__aurachatMyChats) {
        window.__aurachatMyChats.forEach((d, id) => {
            if (d && d.isGroup && id) groupTargets.push({ uid: id, name: d.groupName || 'Grup', isGroup: true, groupPhoto: d.groupPhoto || '' });
        });
        groupTargets.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'tr'));
    }

    if (!users.length && !groupTargets.length) {
        listEl.innerHTML = `<p class="text-center text-gray-500 text-xs py-8">İletilecek kişi bulunamadı.</p>`;
    }

    const addSectionTitle = (label) => {
        const h = document.createElement('div');
        h.className = 'px-4 py-2 text-xs font-semibold text-emerald-400 bg-[#0b141a]';
        h.textContent = label;
        listEl.appendChild(h);
    };

    if (groupTargets.length) addSectionTitle('Gruplar');
    groupTargets.forEach((g) => {
        const row = document.createElement('div');
        row.className = 'flex items-center px-4 py-3 hover:bg-[#202c33]/60 cursor-pointer border-b border-gray-800/30';
        const avatarHtml = g.groupPhoto
            ? `<img src="${g.groupPhoto}" class="w-11 h-11 rounded-full object-cover shadow flex-shrink-0">`
            : `<div class="w-11 h-11 rounded-full flex items-center justify-center text-white font-bold text-sm shadow flex-shrink-0" style="background-color:${getUserColor(g.name || '?')};">${getInitials(g.name || '?')}</div>`;
        row.innerHTML = `${avatarHtml}<span class="text-white text-sm font-medium ml-3 truncate">${escapeHtml(g.name || '')}</span><span class="fwd-check ml-auto w-6 h-6 rounded-full border-2 border-gray-500 flex items-center justify-center flex-shrink-0"></span>`;
        row.addEventListener('click', () => toggleForwardTarget(g, row));
        listEl.appendChild(row);
    });

    if (groupTargets.length && users.length) addSectionTitle('Kişiler');

    users.forEach((u) => {
        const row = document.createElement('div');
        row.className = 'flex items-center px-4 py-3 hover:bg-[#202c33]/60 cursor-pointer border-b border-gray-800/30';
        const avatarHtml = u.avatar
            ? `<img src="${u.avatar}" class="w-11 h-11 rounded-full object-cover shadow flex-shrink-0">`
            : `<div class="w-11 h-11 rounded-full flex items-center justify-center text-white font-bold text-sm shadow flex-shrink-0" style="background-color:${getUserColor(u.name || '?')};">${getInitials(u.name || '?')}</div>`;
         row.innerHTML = `${avatarHtml}<span class="text-white text-sm font-medium ml-3 truncate">${escapeHtml(u.name || '')}</span><span class="fwd-check ml-auto w-6 h-6 rounded-full border-2 border-gray-500 flex items-center justify-center flex-shrink-0"></span>`;
                row.addEventListener('click', () => toggleForwardTarget(u, row));
        listEl.appendChild(row);
    });

    el.classList.remove('hidden');
    el.classList.add('flex');
    forwardPickerOpen = true;
    pushBackState(closeForwardPickerFromBack);
}
function toggleForwardTarget(u, row) {
    const on = !forwardTargets.has(u.uid);
    if (on) forwardTargets.set(u.uid, u); else forwardTargets.delete(u.uid);
    const chk = row.querySelector('.fwd-check');
    if (chk) {
        chk.classList.toggle('bg-emerald-500', on);
        chk.classList.toggle('border-emerald-500', on);
        chk.classList.toggle('border-gray-500', !on);
        chk.innerHTML = on ? '<i class="fa-solid fa-check text-white text-xs"></i>' : '';
    }
    refreshForwardBar();
}

function refreshForwardBar() {
    if (!forwardPickerEl) return;
    const bar = forwardPickerEl.querySelector('#forward-send-bar');
    if (!bar) return;
    bar.classList.toggle('hidden', forwardTargets.size === 0);
    bar.classList.toggle('flex', forwardTargets.size > 0);
    forwardPickerEl.querySelector('#forward-send-names').textContent = Array.from(forwardTargets.values()).map((x) => x.name || '').join(', ');
}

async function sendToTargets(targets) {
    if (!targets.length) return;
    const files = pendingShare;
    closeForwardPicker();
    multiForward = targets.length > 1;
    try {
        for (const u of targets) {
            if (files) pendingShare = files;
            await forwardImageTo(u);
        }
    } finally {
        multiForward = false;
        pendingShare = null;
    }
}
// Belirli bir gruba (açık sohbetten bağımsız) mesaj yazıldığında üyelerin liste özetlerini günceller
async function updateGroupSummariesFor(groupId, lastMessageText) {
    const gd = await getGroupData(groupId);
    if (!gd) throw new Error('Grup bulunamadı');
    await Promise.allSettled((gd.members || []).map((memberUid) => setDoc(doc(db, "users", memberUid, "chats", groupId), {
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
    return gd;
}

function pushToGroupMembersFor(gd, groupId, bodyText) {
    (gd.members || []).forEach((memberUid) => {
        if (memberUid === currentUser.uid) return;
        sendPushToUser(memberUid, gd.name || 'Grup', `${currentUser.name}: ${bodyText}`, {
            chatId: groupId,
            otherUid: groupId,
            otherName: gd.name || 'Grup'
        });
    });
}

// Hedef kişi de olsa grup da olsa mesajı yazar, listeyi günceller, bildirimi yollar. chatId döner.
async function postToTarget(targetUser, payload, summaryText, pushBody, msgType) {
    if (targetUser.isGroup) {
        const groupId = targetUser.uid;
        await addDoc(collection(db, "chats", groupId, "messages"), payload);
        const gd = await updateGroupSummariesFor(groupId, summaryText);
        pushToGroupMembersFor(gd, groupId, pushBody);
        return groupId;
    }
    const targetChatId = getChatId(currentUser.uid, targetUser.uid);
    await addDoc(collection(db, "chats", targetChatId, "messages"), payload);
    await updateSummariesForTarget(targetChatId, targetUser.uid, targetUser.name, summaryText);
    sendPushToUser(targetUser.uid, `${currentUser.name}`, pushBody, {
        chatId: targetChatId,
        otherUid: currentUser.uid,
        otherName: currentUser.name,
        ...(msgType ? { msgType: msgType } : {})
    });
    return targetChatId;
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
            typing: false,
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
        const entry = forwardSource.entry || (session && (
        session.messages.find((m) => m.id === msgId) ||
        session.olderMessagesPrepended.find((m) => m.id === msgId)
    ));
    if (!entry) { showToast('Mesaj bulunamadı'); return; }
    const msg = entry.data;

    closeForwardPicker();
    showToast('İletiliyor...');

    try {
            if (!msg.type || msg.type === 'text') {
            await postToTarget(targetUser, {
                type: 'text',
                text: msg.text || '',
                senderUid: currentUser.uid,
                senderName: currentUser.name,
                createdAt: serverTimestamp(),
                read: false,
                forwarded: true
            }, (msg.text || '').slice(0, 100), (msg.text || '').slice(0, 200), 'text');
            showToast(targetUser.isGroup ? `${targetUser.name} grubuna iletildi` : `${targetUser.name} kişisine iletildi`);
            return;
        }
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

        const isAlbum = payload.imagesCount > 1;
        await postToTarget(
            targetUser,
            payload,
            isAlbum ? `📷 ${payload.imagesCount} Fotoğraf` : '📷 Fotoğraf',
            isAlbum ? `📷 ${payload.imagesCount} fotoğraf gönderdi` : "📷 Bir fotoğraf gönderdi"
        );

        showToast(targetUser.isGroup ? `${targetUser.name} grubuna iletildi` : `${targetUser.name} kişisine iletildi`);
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
let pendingShareTarget = ''; // Paylaş menüsünde doğrudan seçilen sohbetin kimliği
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
        let target = '';
        try { target = (window.AuraShare.target && window.AuraShare.target()) || ''; } catch (e) {}
        return { state: 'ok', files: list.map((d, i) => dataUrlToFile(d, `shared_${i}.jpg`)), target: target };
    } catch (e) {
        return { state: 'none' };
    }
}

// Paylaş menüsünde doğrudan bir sohbete dokunulduysa o sohbetin hedef nesnesi
function resolveShareTarget(chatId) {
    if (!chatId || !currentUser) return null;
    if (window.__aurachatGroupIds && window.__aurachatGroupIds.has(chatId)) {
        const d = window.__aurachatMyChats && window.__aurachatMyChats.get(chatId);
        return { isGroup: true, groupId: chatId, name: (d && d.groupName) || 'Grup' };
    }
    const otherUid = chatId.split('_').find((p) => p !== currentUser.uid);
    const um = window.__aurachatUsers;
    if (!otherUid || !um) return null;
    return Array.from(um.values()).find((u) => u.uid === otherUid) || null;
}

// Sohbeti açar, paylaşılan resimleri yazı kutusunun üstüne koyar; kullanıcı istersen not yazıp gönderir
async function openChatWithSharedImages(target) {
    const files = pendingShare;
    pendingShare = null;
    if (!files || !files.length) return;
    await selectChat(target);
    composer.addImages(files);
    showToast('Resimler hazır, göndermek için yeşil düğmeye bas', 3000);
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
            pendingShareTarget = res.target || '';
        }
        // Kişi listesi yüklenene kadar bekle
        if (!window.__aurachatUsers || window.__aurachatUsers.size === 0) return;
        stopShareCheck();
        const directTarget = resolveShareTarget(pendingShareTarget);
        pendingShareTarget = '';
        if (directTarget) { openChatWithSharedImages(directTarget); return; }
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
        const isAlbum = compressed.length > 1;
        const targetChatId = await postToTarget(
            targetUser,
            payload,
            isAlbum ? `📷 ${compressed.length} Fotoğraf` : '📷 Fotoğraf',
            isAlbum ? `📷 ${compressed.length} fotoğraf gönderdi` : "📷 Bir fotoğraf gönderdi"
        );

        if (!multiForward && currentChatId !== targetChatId) {
            selectChat(targetUser.isGroup ? { isGroup: true, groupId: targetUser.uid, name: targetUser.name } : targetUser);
        }
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
    const vsrc = findMessageEntry(msgId);
    if (vsrc && vsrc.data && vsrc.data.viewOnce) { showToast('Bir kez görüntülenen fotoğraf iletilemez'); return; }
        forwardSource = { chatId: currentChatId, msgId: msgId, entry: findMessageEntry(msgId) };
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
    if (msg.type === 'document') return '📄 ' + (msg.fileName || 'Belge');
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
        senderUid: msg.senderUid || null,
        previewText: replyPreviewTextFor(msg)
    };
    const el = ensureReplyBar();
    const replyColor = senderColor({ senderUid: msg.senderUid, senderName: msg.senderName }, 78);
    el.style.borderLeftColor = replyColor;
    el.querySelector('#reply-bar-name').style.color = replyColor;
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
        return { msgId: r.msgId, senderName: r.senderName, senderUid: r.senderUid || null, previewText: r.previewText };
}
// ------------------------------------------
// MESAJ DÜZENLEME (gönderdikten sonra 15 dakika)
// ------------------------------------------
const EDIT_WINDOW_MS = 15 * 60 * 1000;
let editingMsg = null; // { chatId, msgId, originalText, createdMs }
let editBarEl = null;
let moreMenuEl = null;
const selectionMoreBtn = document.getElementById('selection-more-btn');

let editTopEl = null;

function ensureEditBar() {
    if (editBarEl) return editBarEl;

    // Yazma kutusunun İÇİNDE, üstte çıkan "Mesaj düzenleniyor" çubuğu
    if (!document.getElementById('aura-editbar-css')) {
        const st = document.createElement('style');
        st.id = 'aura-editbar-css';
        st.textContent = `
#chat-area .aura-composer.aura-composer > .aura-editbar.aura-editbar { display: none !important; }
#chat-area .aura-composer.aura-composer.aura-editing.aura-editing > .aura-editbar.aura-editbar {
    display: flex !important;
    grid-row: 1 !important;
    grid-column: 1 !important;
    align-self: stretch !important;
    align-items: center;
    justify-content: space-between;
        margin: 0 0 4px 0 !important;
    padding: 6px 10px;
    border-radius: 10px;
    background: rgba(255,255,255,0.08) !important;
}
#chat-area .aura-composer.aura-composer.aura-editing.aura-editing { max-height: 230px !important; }
#chat-area .aura-composer.aura-editing #attach-btn { display: none !important; }`;
        document.head.appendChild(st);
    }
    const el = document.createElement('div');
    el.className = 'aura-editbar';
    el.innerHTML = `
        <div class="flex items-center gap-3 min-w-0">
                     <i class="fa-solid fa-pencil text-gray-300 text-sm"></i>
            <span class="text-gray-200 text-sm truncate">Mesaj düzenleniyor</span>
        </div>
             <button type="button" id="edit-bar-cancel" class="text-gray-300 hover:text-white px-2 flex-shrink-0 text-base"><i class="fa-solid fa-xmark"></i></button>
    `;
    const row = messageInput.parentElement;
    row.insertBefore(el, row.firstChild);
    el.querySelector('#edit-bar-cancel').addEventListener('click', () => cancelEdit(true));
    editBarEl = el;

    // Sohbetin üst çubuğunun üstüne binen "Mesaj düzenleniyor" çubuğu (mesaj seçme çubuğu gibi)
    if (selectionToolbar) {
        const t = document.createElement('div');
        t.className = 'hidden absolute top-0 left-0 right-0 bg-black px-4 h-[65px] items-center flex-shrink-0 z-20';
        t.innerHTML = `
            <div class="flex items-center space-x-4">
                <button type="button" id="edit-top-cancel" class="text-white text-lg px-1"><i class="fa-solid fa-arrow-left"></i></button>
                <span class="text-white font-medium text-base">Mesaj düzenleniyor</span>
            </div>
        `;
        selectionToolbar.insertAdjacentElement('afterend', t);
        t.querySelector('#edit-top-cancel').addEventListener('click', () => cancelEdit(true));
        editTopEl = t;
    }
    return el;
}

function setEditUI(on) {
    const row = messageInput.parentElement;
    if (row) row.classList.toggle('aura-editing', on);
    if (editTopEl) {
        editTopEl.classList.toggle('hidden', !on);
        editTopEl.classList.toggle('flex', on);
    }
}

function cancelEdit(clearInput) {
    if (!editingMsg) return;
    editingMsg = null;
    setEditUI(false);
    if (clearInput) {
        messageInput.value = '';
        updateMicToggle();
    }
}

function editEligibility(msgId) {
    const entry = findMessageEntry(msgId);
    if (!entry || !currentUser || entry.data.senderUid !== currentUser.uid || (entry.data.type && entry.data.type !== 'text')) {
        return { ok: false, reason: 'Sadece kendi yazı mesajlarını düzenleyebilirsin' };
    }
    if (!entry.data.createdAt) return { ok: false, reason: 'Mesaj henüz gönderiliyor' };
    const ms = entry.data.createdAt.toMillis ? entry.data.createdAt.toMillis() : entry.data.createdAt.toDate().getTime();
    if (Date.now() - ms > EDIT_WINDOW_MS) return { ok: false, reason: 'Düzenleme süresi (15 dk) doldu' };
    return { ok: true, entry, createdMs: ms };
}

function closeMoreMenu() {
    if (moreMenuEl) moreMenuEl.style.display = 'none';
}

function startEdit(msgId) {
    const el = editEligibility(msgId);
    if (!el.ok) { showToast(el.reason); return; }
    cancelReply();
    editingMsg = { chatId: currentChatId, msgId, originalText: el.entry.data.text || '', createdMs: el.createdMs };
        ensureEditBar();
    setEditUI(true);
    messageInput.value = editingMsg.originalText;
    updateMicToggle();
    messageInput.focus();
    try { messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length); } catch (e) {}
}

async function submitEdit() {
    const ed = editingMsg;
    if (!ed) return;
    const text = messageInput.value.trim();
    if (!text) { showToast('Mesaj boş olamaz'); return; }
    if (text === ed.originalText.trim()) { cancelEdit(true); return; }
    if (Date.now() - ed.createdMs > EDIT_WINDOW_MS) {
        showToast('Düzenleme süresi (15 dk) doldu');
        cancelEdit(true);
        return;
    }
    try {
        await updateDoc(doc(db, "chats", ed.chatId, "messages", ed.msgId), {
            text: text,
            edited: true,
            editedAt: serverTimestamp()
        });
    } catch (e) {
        showToast('Mesaj düzenlenemedi');
        return;
    }
    // Düzenlenen mesaj sohbetin son mesajıysa liste özetini de güncelle (birebir sohbetler)
    try {
        const session = chatSessions.get(ed.chatId);
        const last = session && session.messages.length ? session.messages[session.messages.length - 1] : null;
        if (last && last.id === ed.msgId && !isGroupChat(ed.chatId) && currentOtherUid && currentUser) {
            await setDoc(doc(db, "users", currentUser.uid, "chats", ed.chatId), { lastMessage: text }, { merge: true });
            await setDoc(doc(db, "users", currentOtherUid, "chats", ed.chatId), { lastMessage: text }, { merge: true });
        }
    } catch (e) {}
    cancelEdit(true);
}

if (selectionMoreBtn) {
    // Üç noktaya basınca yazma kutusu odağı (klavye) kaybetmesin
    selectionMoreBtn.addEventListener('mousedown', (e) => e.preventDefault());
    selectionMoreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
        if (selectedMessageIds.size !== 1) { showToast('Düzenlemek için tek mesaj seç'); return; }
        const id = Array.from(selectedMessageIds)[0];
        const el = editEligibility(id);
        if (!el.ok) { showToast(el.reason); return; }
        if (!moreMenuEl) {
            moreMenuEl = document.createElement('div');
            moreMenuEl.style.cssText = 'position:fixed;top:58px;right:8px;z-index:60;min-width:160px;background:#233138;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.5);padding:4px 0;display:none;';
            moreMenuEl.innerHTML = `<button type="button" data-more="edit" class="w-full flex items-center space-x-3 px-4 py-3 text-sm text-gray-100 text-left"><i class="fa-solid fa-pen w-4"></i><span>Düzenle</span></button>`;
                     moreMenuEl.addEventListener('mousedown', (ev) => ev.preventDefault());
            moreMenuEl.addEventListener('click', (ev) => {
                const b = ev.target.closest('[data-more]');
                if (!b) return;
                ev.stopPropagation();
                const mid = Array.from(selectedMessageIds)[0];
                closeMoreMenu();
                if (b.dataset.more === 'edit') {
                    exitSelectionMode();
                    startEdit(mid);
                }
            });
            document.body.appendChild(moreMenuEl);
            document.addEventListener('click', closeMoreMenu);
        }
        moreMenuEl.style.display = moreMenuEl.style.display === 'block' ? 'none' : 'block';
    });
}
async function scrollToOriginalMessage(msgId, instant) {
    let el = messageElementsById.get(msgId);
    if (!el && currentChatId) {
        // Mesaj henüz yüklenmemiş eski bir mesaj: bulunana kadar eskileri yükle
        const session = chatSessions.get(currentChatId);
        if (session) {
            showToast('Mesaj aranıyor...');
            let guard = 0;
            while (!el && guard < 60 && !session.noMoreOlderMessages && session.oldestLoadedCreatedAt) {
                guard++;
                const before = session.oldestLoadedCreatedAt;
                const dummy = document.createElement('div');
                dummy.innerHTML = '<button type="button"></button>';
                await loadOlderMessages(session, dummy);
                el = messageElementsById.get(msgId);
                if (session.oldestLoadedCreatedAt === before && !session.noMoreOlderMessages) break;
            }
        }
    }
    if (!el) { showToast('Orijinal mesaj bulunamadı'); return; }
    el.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center' });
// Kaydırma bitince şerit belirir, sonra kendiliğinden solar
    setTimeout(() => {
        el.classList.remove('msg-flash');
        void el.offsetWidth;
        el.classList.add('msg-flash');
        setTimeout(() => el.classList.remove('msg-flash'), 1900);
    }, instant ? 80 : 350);
}

function buildReplyQuoteHtml(replyTo, isMine) {
    if (!replyTo) return '';
    const qColor = senderColor({ senderUid: replyTo.senderUid, senderName: replyTo.senderName }, 78);
    const qBg = isMine ? 'rgba(0,0,0,0.20)' : 'rgba(255,255,255,0.10)';
    return `<div class="reply-quote rounded-md px-2 py-1.5 mb-1.5 cursor-pointer" style="background:${qBg};border-left:3px solid ${qColor}" onclick="jumpToReply('${replyTo.msgId}', event)">
        <p class="text-[11px] font-semibold truncate" style="color:${qColor}">${escapeHtml(replyTo.senderName || '')}</p>
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
// Geçici balonlar için: gün değiştiyse (ya da hiç etiket yoksa) tarih etiketi üret
function tempDayChipFor(timeMs, prevLabel) {
    const d = new Date(timeMs || Date.now());
    const label = formatDayLabel(d);
    let last = prevLabel;
    if (last === undefined) {
        const chips = messageContainer.querySelectorAll('[data-date-chip]');
        last = chips.length ? chips[chips.length - 1].dataset.label : null;
    }
    if (last === label) return { el: null, label };
    return { el: buildDateChipElement(d), label };
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
             const seenWhileHidden = (() => { const t = msgCreatedMs(msg); return t > 0 && t <= getChatLastReadMs(session.chatId); })();
        if (!isMine && unreadForMe && !seenWhileHidden) {
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
// "AŞAĞI GİT" DÜĞMESİ (yukarı kaydırınca sağ altta çıkar)
// ------------------------------------------
let jumpBottomBtn = null;
let jumpBottomBadge = null;
let jumpBottomUnread = 0;
let jumpBottomChatId = null;

function updateJumpBottomBtn() {
    if (jumpBottomChatId !== currentChatId) { jumpBottomChatId = currentChatId; jumpBottomUnread = 0; }
    if (!jumpBottomBtn) {
        jumpBottomBtn = document.createElement('button');
        jumpBottomBtn.type = 'button';
        jumpBottomBtn.setAttribute('aria-label', 'En alta git');
                jumpBottomBtn.style.cssText = 'position:fixed;z-index:40;display:none;width:36px;height:36px;border-radius:9999px;background:#202c33;color:#d1d7db;border:1px solid rgba(255,255,255,0.12);box-shadow:0 2px 8px rgba(0,0,0,0.5);align-items:center;justify-content:center;font-size:14px;';
        jumpBottomBtn.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
        jumpBottomBadge = document.createElement('span');
        jumpBottomBadge.style.cssText = 'position:absolute;top:-11px;left:50%;transform:translateX(-50%);min-width:20px;height:20px;padding:0 6px;border-radius:9999px;background:#22c55e;color:#04210f;font-size:12px;font-weight:700;line-height:20px;text-align:center;display:none;box-shadow:0 1px 4px rgba(0,0,0,0.5);';
        jumpBottomBtn.appendChild(jumpBottomBadge);
        jumpBottomBtn.addEventListener('mousedown', (e) => e.preventDefault());
        jumpBottomBtn.addEventListener('click', () => {
            jumpBottomUnread = 0;
            messageContainer.scrollTop = messageContainer.scrollHeight;
        });
        document.body.appendChild(jumpBottomBtn);
    }
    const away = messageContainer.scrollHeight - messageContainer.scrollTop - messageContainer.clientHeight;
    if (away < 150) jumpBottomUnread = 0;
    const show = !!currentChatId && messageContainer.clientHeight > 0 && (away > 400 || (jumpBottomUnread > 0 && away > 150)) && !selectionMode;
    if (!show) { jumpBottomBtn.style.display = 'none'; return; }
    jumpBottomBadge.textContent = jumpBottomUnread > 99 ? '99+' : String(jumpBottomUnread);
    jumpBottomBadge.style.display = jumpBottomUnread > 0 ? 'block' : 'none';
    const r = messageContainer.getBoundingClientRect();
    jumpBottomBtn.style.right = Math.max(8, window.innerWidth - r.right + 14) + 'px';
    jumpBottomBtn.style.bottom = Math.max(8, window.innerHeight - r.bottom + 14) + 'px';
    jumpBottomBtn.style.display = 'flex';
}

messageContainer.addEventListener('scroll', updateJumpBottomBtn, { passive: true });
window.addEventListener('resize', updateJumpBottomBtn);
if (window.visualViewport) window.visualViewport.addEventListener('resize', updateJumpBottomBtn);
try {
    new MutationObserver(updateJumpBottomBtn).observe(messageContainer, { childList: true });
    if (window.ResizeObserver) new ResizeObserver(updateJumpBottomBtn).observe(messageContainer);
} catch (e) {}
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

function viewOnceAllowed() {
    return !!(currentChatId && currentChatId !== 'global' && !currentIsGroup);
}
window.__auraViewOnceAllowed = viewOnceAllowed;

// Bir kez görüntülenen fotoğraf: galeriye/diske hiç yazılmaz, kapatınca sunucudan da silinir
function openViewOnce(msgId) {
    const entry = findMessageEntry(msgId);
    const d = entry && entry.data;
    if (!d || !d.viewOnce || !currentUser) return;
    if (d.viewOnceOpened || d.imageDelivered || !d.imageUrl) { showToast('Bu fotoğraf zaten açıldı'); return; }
    if (d.senderUid === currentUser.uid) return;
    const chatId = currentChatId;
    const src = toImageSrc(d.imageUrl);
    viewerBackActive = true;
    pushBackState(() => { viewerBackActive = false; window.closeImageViewer(); });
    window.openImageViewer({
        items: [makeViewerItem(entry, msgId, src)],
        index: 0,
        album: false,
        viewOnce: true,
        onClose: () => {
            if (viewerBackActive) { viewerBackActive = false; popBackState(); }
            consumeViewOnce(chatId, msgId);
        }
    });
}

function consumeViewOnce(chatId, msgId) {
    const en = findMsgEntry(chatId, msgId);
    if (en) { en.data.imageDelivered = true; en.data.imageUrl = null; }
    updateDoc(doc(db, "chats", chatId, "messages", msgId), {
        imageUrl: null,
        imageDelivered: true
    }).catch(() => showToast('Fotoğraf durumu kaydedilemedi'));
    const sess = chatSessions.get(chatId);
    if (sess && currentChatId === chatId) {
        const top = messageContainer.scrollTop;
        const nearBottom = isNearBottom();
        renderSession(sess);
        if (nearBottom) scrollToBottom(); else messageContainer.scrollTop = top;
    }
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
// ------------------------------------------
// LİNKLER + LİNK ÖNİZLEME KARTI
// Mesajdaki link tıklanabilir olur; gönderen, ilk linkin başlık/resim bilgisini bir kez alıp mesaja yazar.
// ------------------------------------------
const URL_RE = /https?:\/\/[^\s<>"']+/i;

function extractFirstUrl(text) {
    const m = String(text || '').match(URL_RE);
    if (!m) return '';
    return m[0].replace(/[.,;:!?)\]]+$/, '');
}

function linkifyText(text) {
    return escapeHtml(text).replace(/https?:\/\/[^\s<]+/gi, (raw) => {
        const trail = (raw.match(/[.,;:!?)\]]+$/) || [''])[0];
        const url = trail ? raw.slice(0, raw.length - trail.length) : raw;
        return `<a href="${url}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="color:#7dd3fc;text-decoration:underline;word-break:break-all;">${url}</a>${trail}`;
    });
}

function renderMsgText(text, msg) {
    return highlightMentions(linkifyText(text), msg, currentUser && currentUser.uid, currentUser && currentUser.name);
}

function buildLinkPreviewHtml(lp) {
    if (!lp || !lp.url || (!lp.title && !lp.image && !lp.description)) return '';
    let host = '';
    try { host = new URL(lp.url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
    const safeUrl = escapeHtml(lp.url).replace(/"/g, '&quot;');
    const img = lp.image
        ? `<img src="${escapeHtml(lp.image).replace(/"/g, '&quot;')}" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" style="display:block;width:100%;max-height:150px;object-fit:cover;">`
        : '';
    const title = lp.title ? `<p style="font-size:13px;font-weight:600;line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${escapeHtml(lp.title)}</p>` : '';
    const desc = lp.description ? `<p style="font-size:11.5px;color:#d1d7db;margin-top:2px;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${escapeHtml(lp.description)}</p>` : '';
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" style="display:block;margin-top:6px;border-radius:10px;overflow:hidden;background:rgba(0,0,0,0.25);color:inherit;text-decoration:none;min-width:200px;max-width:100%;">${img}<div style="padding:8px 10px;">${title}${desc}<p style="font-size:10.5px;color:#9aa5ab;margin-top:3px;">${escapeHtml(host)}</p></div></a>`;
}

async function attachLinkPreview(msgRef, text) {
    const url = extractFirstUrl(text);
    if (!url || !msgRef) return;
    try {
        const idToken = await getAuth().currentUser.getIdToken();
        const resp = await fetch('https://aurachat-amber.vercel.app/api/link-preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body: JSON.stringify({ url })
        });
        const data = await resp.json();
        if (data && data.success && data.preview) {
            await updateDoc(msgRef, { linkPreview: data.preview });
        }
    } catch (e) {}
}

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

        // Grupta @ ile etiketlenenler
        let mentionInfo = { uids: [], names: [] };
        if (isGroupChat(currentChatId)) {
            try {
                const gdM = await getGroupData(currentChatId);
                const others = ((gdM && gdM.members) || []).filter((u) => u !== currentUser.uid);
                mentionInfo = collectMentions(text, others);
            } catch (e) {}
        }
        clearChosenMentions();

        const sentRef = await addDoc(collection(db, "chats", currentChatId, "messages"), {
            text: text,
            senderUid: currentUser.uid,
            senderName: currentUser.name,
            createdAt: serverTimestamp(),
            read: false,
            ...(mentionInfo.uids.length ? { mentions: mentionInfo.uids, mentionNames: mentionInfo.names } : {}),
            ...(replyPayload ? { replyTo: replyPayload } : {})
        });
        attachLinkPreview(sentRef, text);

        await updateChatSummaries(text, mentionInfo.uids);
        pushToGroupMembers(text, mentionInfo.uids, sentRef.id);

        if (currentChatId !== 'global' && currentOtherUid) {
            sendPushToUser(currentOtherUid, `${currentUser.name}`, text, {
                chatId: currentChatId,
                otherUid: currentUser.uid,
                otherName: currentUser.name,
                msgType: 'text'
            });
        }

        scrollToBottom();
    } catch (e) {
        console.error("Mesaj gönderilemedi: ", e);
        alert("Mesaj gönderilirken hata oluştu!");
    }
}

// Önce bekleyen resimler, sonra yazı gider
async function sendFromComposer() {
    if (editingMsg) { await submitEdit(); return; }
    const wantViewOnce = !!(composer.isViewOnce && composer.isViewOnce()) && viewOnceAllowed();
    const files = composer.takeImages();
    if (files.length) {
        const caption = wantViewOnce ? '' : messageInput.value.trim();
        if (!wantViewOnce) messageInput.value = '';
        await sendPendingImages(files, caption, wantViewOnce && files.length === 1);
    } else if (messageInput.value.trim()) {
        await sendMessage();
    }
    updateMicToggle();
}

// Grupta @ ile etiketleme: üye adları (kişi listesinde yoksa kullanıcı belgesinden okunur)
const memberNameCache = new Map();
async function resolveMemberName(uid) {
    const um = window.__aurachatUsers;
    const fromList = um && Array.from(um.values()).find((u) => u.uid === uid);
    if (fromList && fromList.name) return fromList.name;
    if (memberNameCache.has(uid)) return memberNameCache.get(uid);
    let name = '';
    try {
        const snap = await getDoc(doc(db, "users", uid));
        if (snap.exists()) name = snap.data().name || snap.data().displayName || '';
    } catch (e) {}
    memberNameCache.set(uid, name);
    return name;
}
setupMentions({
    input: messageInput,
    isActive: () => !!currentChatId && currentChatId !== 'global' && isGroupChat(currentChatId),
    getMembers: async () => {
        const gd = await getGroupData(currentChatId);
        const uids = ((gd && gd.members) || []).filter((u) => currentUser && u !== currentUser.uid);
        const named = await Promise.all(uids.map(async (uid) => ({ uid, name: await resolveMemberName(uid) })));
        return named.filter((m) => m.name);
    }
});

sendBtn.addEventListener('click', sendFromComposer);
messageInput.addEventListener('keydown', (e) => {
    // Telefonda Enter alt satıra geçer, gönderme sadece butonla.
    // Bilgisayarda (fare varsa) Enter gönderir, Shift+Enter alt satıra geçer.
    if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer: fine)').matches) {
        e.preventDefault();
        sendFromComposer();
    }
});
// Birebir sohbette "yazıyor..." bilgisini karşı tarafın sohbet listesi satırına da yaz
function writeTypingSummary(typing) {
    if (!currentUser || !currentChatId || currentChatId === 'global' || currentIsGroup || !currentOtherUid) return;
    updateDoc(doc(db, "users", currentOtherUid, "chats", currentChatId), { typing: typing, typingAt: Date.now() }).catch(() => {});
}
messageInput.addEventListener('input', () => {
if (!currentChatId || currentChatId === 'global' || !currentUser) return;

    if (Date.now() - lastTypingWriteAt > 1500) {
        lastTypingWriteAt = Date.now();
                setDoc(doc(db, "chats", currentChatId), {
            [`typing_${currentUser.uid}`]: true
        }, { merge: true });
        writeTypingSummary(true);
    }

    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        if (currentChatId && currentChatId !== 'global') {
                setDoc(doc(db, "chats", currentChatId), {
                [`typing_${currentUser.uid}`]: false
            }, { merge: true });
            writeTypingSummary(false);
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
 ensureAttachMenu(); // menüyü önceden hazırla, ilk açılış takılmasın
    // Düğmeye basınca mesaj kutusu odağı (klavye) kaybetmesin
    attachBtn.addEventListener('mousedown', (e) => e.preventDefault());
    attachBtn.addEventListener('click', () => {
        if (attachMenuOpen) closeAttachMenu(); else openAttachMenu();
    });
    // Input'a dokununca popup, klavye gerçekten açılana kadar yerinde kalır; klavye gelince anında kalkar
    messageInput.addEventListener('focus', () => {
        if (!attachMenuOpen) return;
        // Popup'tan klavyeye geçerken de ekran yüksekliği yumuşatılmasın
        document.body.style.transition = 'none';
        setTimeout(() => { document.body.style.transition = ''; }, 900);
        const vv = window.visualViewport;
        if (!vv) { closeAttachMenu(true); return; }
        let done = false;
        let fallbackTimer = null;
        const finish = () => {
            if (done) return;
            done = true;
            vv.removeEventListener('resize', onResize);
            clearTimeout(fallbackTimer);
            closeAttachMenu(true);
        };
        const onResize = () => {
            const kb = window.__auraMaxVV - vv.height;
            const need = window.__auraKbH ? window.__auraKbH - 30 : 100;
            if (kb > need) finish();
        };
        vv.addEventListener('resize', onResize);
        fallbackTimer = setTimeout(finish, 700);
    });
    messageContainer.addEventListener('click', closeAttachMenu);

    // Seçilen resimler hemen gitmez: kutunun üstünde önizleme olarak bekler, gönder tuşuyla gider
    imageInput.addEventListener('change', (e) => {
        const picked = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
        imageInput.value = '';
        if (!picked.length) {
            alert("Lütfen bir görsel dosyası seç kanka!");
            return;
        }
        composer.addImages(picked);
        messageInput.focus();
    });

    sendPendingImages = async (files, caption = '', viewOnce = false) => {
        if (!files.length || !currentUser || !currentChatId) return;
        const replyPayload = consumeReplyPayload();
        if (currentChatId !== 'global') {
            setDoc(doc(db, "chats", currentChatId), { [`typing_${currentUser.uid}`]: false }, { merge: true }).catch(() => {});
        }

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
                    ...(viewOnce ? { viewOnce: true } : {}),
                    text: caption,
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
                    text: caption,
                    senderUid: currentUser.uid,
                    senderName: currentUser.name,
                    createdAt: serverTimestamp(),
                    read: false,
                    ...(replyPayload ? { replyTo: replyPayload } : {})
                });
            }

            const photoLabel = compressed.length > 1 ? `📷 ${compressed.length} Fotoğraf` : '📷 Fotoğraf';
            const summaryText = viewOnce ? '📷 Bir kez görüntülenebilir fotoğraf' : (caption ? `${photoLabel} ${caption}` : photoLabel);
            await updateChatSummaries(summaryText);
            pushToGroupMembers(summaryText);

            if (currentChatId !== 'global' && currentOtherUid) {
                sendPushToUser(currentOtherUid, `${currentUser.name}`, summaryText, {
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
};
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
    const hasText = messageInput.value.trim().length > 0 || composer.hasImages();
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
    composer.onChange(updateMicToggle);
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
// Boşluğa ya da sağ üstteki üç noktaya dokununca klavye kapanmasın
// (klavye geri tuşuyla kapandıysa kutunun odağı da bırakılır, boşluğa dokununca tekrar açılmaz)
(function keepKeyboardOpen() {
    const vv = window.visualViewport;
    let maxH = vv ? vv.height : window.innerHeight;
    const keyboardOpen = () => (vv ? (maxH - vv.height) > 120 : true);

    // Uygulama arka plana gidip dönerken ekran boyutu geçici oynar, bu sırada kutuyu bırakma
    document.addEventListener('visibilitychange', () => {
        window.__auraIgnoreResizeUntil = Date.now() + 2000;
    });
    

    // Mesaja basılı tutulurken odak kaybolmaya çalışırsa hemen geri ver (klavye kapanıp açılmasın)
    let refocusing = false;
    messageInput.addEventListener('blur', () => {
        if (refocusing) return;
        if ((window.__auraKeepFocusUntil || 0) > Date.now()) {
            refocusing = true;
            messageInput.focus({ preventScroll: true });
            setTimeout(() => { refocusing = false; }, 400);
        }
    });

    if (vv) {
        vv.addEventListener('resize', () => {
            if (vv.height > maxH) maxH = vv.height;
         if ((window.__auraKeepFocusUntil || 0) > Date.now()) return;
       if (Date.now() < (window.__auraIgnoreResizeUntil || 0)) return;
            if (!keyboardOpen() && document.activeElement === messageInput) messageInput.blur();
        });
    }

    const keepFocus = (e) => {
        if (document.activeElement === messageInput && keyboardOpen()) e.preventDefault();
    };
    messageContainer.addEventListener('mousedown', keepFocus);
    const menuBtn = document.getElementById('chat-menu-btn');
    if (menuBtn) menuBtn.addEventListener('mousedown', keepFocus);
})();
// İşaretleme editörü geri tuşunu bizim sistemle paylaşsın, kapanınca klavye geri gelsin
window.isrtPushBack = pushBackState;
window.isrtPopBack = popBackState;


window.openLocation = function (lat, lng) {
    window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank');
};

// ------------------------------------------
// BELGE GÖNDERME (PDF, Word, Excel...)
// Firestore belge sınırı (1 MB) yüzünden en fazla ~700 KB. Veri base64 olarak imageUrl alanında gider:
// alıcı kaydedince (birebir sohbette) sunucudaki kopya silinir, kota harcanmaz.
// ------------------------------------------
const DOC_MAX_BYTES = 700 * 1024;
let docInputEl = null;

function formatFileSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function pickDocument() {
    if (!currentUser || !currentChatId) return;
    if (!docInputEl) {
        docInputEl = document.createElement('input');
        docInputEl.type = 'file';
        docInputEl.accept = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.rtf,.zip,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain';
        docInputEl.style.display = 'none';
        document.body.appendChild(docInputEl);
        docInputEl.addEventListener('change', () => {
            const f = docInputEl.files && docInputEl.files[0];
            docInputEl.value = '';
            if (f) sendDocument(f);
        });
    }
    docInputEl.click();
}

async function sendDocument(file) {
    if (!currentUser || !currentChatId) return;
    if (file.size > DOC_MAX_BYTES) {
        showToast('Belge çok büyük (en fazla 700 KB). Küçültüp tekrar dene.', 3800);
        return;
    }
    const chatIdAtStart = currentChatId;
    const replyPayload = consumeReplyPayload();
    showToast('Belge gönderiliyor...', 4000);
    try {
        const dataUrl = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result));
            r.onerror = () => reject(new Error('Dosya okunamadı'));
            r.readAsDataURL(file);
        });
        await addDoc(collection(db, "chats", chatIdAtStart, "messages"), {
            type: 'document',
            fileName: String(file.name || 'belge').slice(0, 120),
            fileSize: file.size,
            fileMime: file.type || 'application/octet-stream',
            imageUrl: dataUrl,
            text: '',
            senderUid: currentUser.uid,
            senderName: currentUser.name,
            createdAt: serverTimestamp(),
            read: false,
            ...(replyPayload ? { replyTo: replyPayload } : {})
        });
        const label = '📄 ' + (file.name || 'Belge');
        await updateChatSummaries(label);
        pushToGroupMembers('📄 Belge gönderdi');
        if (chatIdAtStart !== 'global' && currentOtherUid) {
            sendPushToUser(currentOtherUid, `${currentUser.name}`, '📄 Belge gönderdi', {
                chatId: chatIdAtStart,
                otherUid: currentUser.uid,
                otherName: currentUser.name
            });
        }
        scrollToBottom();
    } catch (err) {
        showToast('Belge gönderilemedi: ' + ((err && err.message) || ''), 3500);
    }
}

async function saveDocument(msgId) {
    const entry = findMessageEntry(msgId);
    const d = entry && entry.data;
    if (!d || d.type !== 'document') return;
    if (!d.imageUrl) {
        showToast(d.senderUid === (currentUser && currentUser.uid) ? 'Belge alıcıya teslim edildi' : 'Belge zaten kaydedildi: İndirilenler/AuraChat', 3200);
        return;
    }
    const chatId = currentChatId;
    const safeName = String(d.fileName || 'belge').replace(/[\\/:*?"<>|]+/g, '_');
    const dot = safeName.lastIndexOf('.');
    const uniq = String(msgId).slice(0, 4);
    const fname = dot > 0 ? `${safeName.slice(0, dot)} (${uniq})${safeName.slice(dot)}` : `${safeName} (${uniq})`;
    const b64 = d.imageUrl.includes(',') ? d.imageUrl.split(',')[1] : d.imageUrl;
    const Filesystem = getFilesystemPlugin();
    try {
        if (Filesystem) {
            await Filesystem.writeFile({ path: `Download/AuraChat/${fname}`, data: b64, directory: 'EXTERNAL_STORAGE', recursive: true });
            showToast('Kaydedildi: İndirilenler/AuraChat/' + fname, 3800);
        } else {
            const a = document.createElement('a');
            a.href = d.imageUrl;
            a.download = d.fileName || 'belge';
            document.body.appendChild(a);
            a.click();
            a.remove();
        }
    } catch (err) {
        showToast('Belge kaydedilemedi', 3200);
        return;
    }
    // Birebir sohbette alıcı kaydettiyse sunucudaki kopyayı temizle
    if (currentUser && d.senderUid !== currentUser.uid && chatId !== 'global' && !isGroupChat(chatId)) {
        updateDoc(doc(db, "chats", chatId, "messages", msgId), { imageUrl: null, imageDelivered: true }).catch(() => {});
        d.imageUrl = null;
        d.imageDelivered = true;
        const sess = chatSessions.get(chatId);
        if (sess && currentChatId === chatId) {
            const top = messageContainer.scrollTop;
            const nearBottom = isNearBottom();
            renderSession(sess);
            if (nearBottom) scrollToBottom(); else messageContainer.scrollTop = top;
        }
    }
}

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
async function updateGroupSummaries(lastMessageText, mentionedUids) {
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
        ...((mentionedUids || []).includes(memberUid) ? { hasMention: true } : {}),
        updatedAt: serverTimestamp()
    }, { merge: true })));

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) {
        const reason = failed[0].reason;
        showToast(`Liste güncellenemedi (${failed.length} üye): ` + ((reason && reason.message) || reason), 6000);
    }
}

// Grup mesajında gönderen hariç herkese bildirim
async function pushToGroupMembers(bodyText, mentionedUids, msgId) {
if (!currentChatId || !isGroupChat(currentChatId) || !currentUser) return;
    const groupId = currentChatId;
    const mentioned = new Set(mentionedUids || []);
    try {
        const gd = await getGroupData(groupId);
        if (!gd) return;
        (gd.members || []).forEach((memberUid) => {
            if (memberUid === currentUser.uid) return;
            if (mentioned.has(memberUid) && msgId) {
                sendPushToUser(memberUid, gd.name || 'Grup', `${currentUser.name}: 🔔 Seni etiketledi: ${bodyText}`, {
                    chatId: groupId,
                    otherUid: groupId,
                    otherName: gd.name || 'Grup',
                    msgType: 'mention',
                    msgId: msgId
                });
                return;
            }
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
        if (session.unsubscribeChatDoc) session.unsubscribeChatDoc();
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