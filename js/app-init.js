// ==========================================
// APP INIT
// index.html tarafından tek modül olarak import edilir.
// giris.js başarılı girişten sonra window.initApp()'i çağırır.
// ==========================================

import { db } from "./firebase-init.js";
import { collection, query, where, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { setCurrentUser, selectChat, startPresence, getCurrentChatId, showTempIncomingBubble, showToast } from "./chat-core.js";
import { watchCallForChat } from "./video-call.js";
import { watchVoiceCallForChat } from "./voice-call.js";
import { watchGroupCallForChat } from "./group-call.js";
import { loadContacts, initAdminPanel } from "./contacts.js";

// ÖLÇÜM: sayfa açılışından bu dosyanın çalışmaya başladığı ana kadar geçen süre (ms)
const T_MODULE = Math.round(performance.now());

const sidebar = document.getElementById('sidebar');
const chatArea = document.getElementById('chat-area');

window.__aurachatReady = false;

// chat-core.js, diskteki mesajları çizince (ya da disk boşsa) bunu çağırır
let firstPaintResolve = null;
const firstPaintPromise = new Promise((resolve) => { firstPaintResolve = resolve; });
window.__auraOnFirstPaint = function () {
    if (firstPaintResolve) { firstPaintResolve(); firstPaintResolve = null; }
};

// Splash ekranını yumuşakça kapatan yardımcı fonksiyon (js/splash.js tanımlar)
async function hideNativeSplash() {
    if (window.hideAuraSplash) window.hideAuraSplash();
}

async function ensureUid(user) {
    if (user.uid) return user;

    try {
        const q = query(collection(db, "users"), where("email", "==", user.email));
        const snap = await getDocs(q);
        if (!snap.empty) {
            user.uid = snap.docs[0].id;
            localStorage.setItem('aurachat_user', JSON.stringify(user));
        } else {
            console.warn("ensureUid: bu email için Firestore'da kullanıcı bulunamadı:", user.email);
        }
    } catch (err) {
        console.warn("ensureUid: uid onarılamadı:", err);
    }

    return user;
}

// Bildirimdeki metni, gerçek mesaj sunucudan gelene kadar geçici balon olarak göster
function showTempFromNotification(otherUser) {
    try {
        const nBody = String(otherUser.body || '');
        const nTag = String(otherUser.tag || '');
        if (otherUser.msgType === 'text' && nBody && nBody.length < 400 && nTag.indexOf('msg-') === 0 && otherUser.chatId && otherUser.chatId !== otherUser.uid) {
            showTempIncomingBubble(otherUser.chatId, nTag.slice(4), nBody, Date.now(), Number(otherUser.pending || 99) <= 1);
        }
    } catch (e) {}
}

// Bildirime tıklanınca (Capacitor native veya PWA) çağrılır
window.openChatFromNotification = async function (otherUser) {
    if (!otherUser || !otherUser.uid) return;

    // Grup mu kişi mi, ağ sorgusu OLMADAN bildirimdeki chatId'den anlaşılır:
    // grupta chatId = grup kimliği (= otherUid), 1'e 1 sohbette chatId ayrı bir değerdir.
    const hasChatId = !!otherUser.chatId;
    const isGroupByChatId = hasChatId && otherUser.chatId === otherUser.uid;
    const isPersonByChatId = hasChatId && otherUser.chatId !== otherUser.uid;

    if (isGroupByChatId || (window.__aurachatGroupIds && window.__aurachatGroupIds.has(otherUser.uid))) {
        await selectChat({ isGroup: true, groupId: otherUser.uid, name: otherUser.name || 'Grup' });
        return;
    }

    const um0 = window.__aurachatUsers;
    const isKnownPerson = isPersonByChatId || !!(um0 && Array.from(um0.values()).some((u) => u.uid === otherUser.uid));
    try {
        const groupSnap = isKnownPerson ? null : await getDoc(doc(db, "groups", otherUser.uid));
        if (groupSnap && groupSnap.exists()) {
            await selectChat({ isGroup: true, groupId: groupSnap.id, name: groupSnap.data().name || 'Grup' });
            return;
        }
    } catch (e) {}

    let target = otherUser;
    try {
        const usersMap = window.__aurachatUsers;
        if (usersMap) {
            const known = Array.from(usersMap.values()).find((u) => u.uid === otherUser.uid);
            if (known) {
                target = {
                    ...otherUser,
                    name: known.name || otherUser.name,
                    avatar: known.avatar || otherUser.avatar || ''
                };
            }
        }
    } catch (e) {}

    await selectChat(target);
};
// Kişi listesi yüklendikten sonra, açık sohbetin başlık avatarını güncelle
// (bildirimden açılışta avatar bilgisi gelmediği için ilk anda baş harfler görünür)
function refreshOpenChatAvatar(uid, chatId) {
    try {
        if (!uid || !chatId || getCurrentChatId() !== chatId) return;
        const users = window.__aurachatUsers;
        const u = users && Array.from(users.values()).find((x) => x.uid === uid);
        const el = document.getElementById('active-chat-avatar');
        if (u && u.avatar && el) {
            el.style.backgroundColor = '';
            el.className = 'w-10 h-10 rounded-full overflow-hidden shadow flex-shrink-0';
            el.innerHTML = `<img src="${u.avatar}" class="w-full h-full object-cover">`;
        }
    } catch (e) {}
}

// PWA - uygulama zaten açıkken sw.js'ten gelen "bildirime tıklandı" mesajı
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'OPEN_CHAT' && event.data.otherUid) {
            const target = {
                uid: event.data.otherUid,
                name: event.data.otherName || 'Sohbet',
                avatar: event.data.otherAvatar || ''
            };
            if (window.__aurachatReady) {
                window.openChatFromNotification(target);
            } else {
                window.pendingOpenChat = target;
            }
        }
    });
}

// PWA - uygulama kapalıyken bildirime tıklanıp yeni pencere açıldıysa
const urlParams = new URLSearchParams(window.location.search);
const pendingOpenChatUid = urlParams.get('openChat');
if (pendingOpenChatUid) {
    window.pendingOpenChat = {
        uid: pendingOpenChatUid,
        name: urlParams.get('otherName') || 'Sohbet',
        avatar: urlParams.get('otherAvatar') || '',
        chatId: urlParams.get('chatId') || ''
    };
}

async function checkIncomingCallFast(uid) {
    try {
        const snap = await getDoc(doc(db, "incomingCalls", uid));
        if (!snap.exists()) return;
        const d = snap.data();
        if (!d || !d.chatId || !d.at) return;
        if (Math.abs(Date.now() - d.at) > 90000) return;

        if (d.isGroup) {
            window.__aurachatGroupIds = window.__aurachatGroupIds || new Set();
            window.__aurachatGroupIds.add(d.chatId);
            watchGroupCallForChat(d.chatId);
        } else {
            watchCallForChat(d.chatId);
            watchVoiceCallForChat(d.chatId);
        }
    } catch (e) {}
}

// Bildirimle soğuk açılış bilgisini native köprüden al. Sayfa ilk yüklenirken köprü henüz yoksa burada yakalanır.
function readLaunchChatFromNative() {
    if (window.pendingOpenChat) return;
    try {
        if (window.AuraLaunch && window.AuraLaunch.consume) {
            const raw = window.AuraLaunch.consume();
            if (raw) {
                const lt = JSON.parse(raw);
                if (lt && lt.uid) {
                    window.pendingOpenChat = lt;
                    window.__auraLaunchUid = lt.uid;
                    window.__auraLaunchAt = Date.now();
                    document.documentElement.setAttribute('data-aura-launch', '1');
                    setTimeout(() => document.documentElement.removeAttribute('data-aura-launch'), 8000);
                }
            }
        }
    } catch (e) {}
}

window.initApp = async function () {
    let currentUser = JSON.parse(localStorage.getItem('aurachat_user'));

    // Oturum kapalıysa (Giriş ekranı açılacaksa) doğrudan koyu Splash'i kaldır
    if (!currentUser) {
        await hideNativeSplash();
        return;
    }

    currentUser = await ensureUid(currentUser);

    setCurrentUser(currentUser);
    initAdminPanel();
    startPresence();
    checkIncomingCallFast(currentUser.uid);

    readLaunchChatFromNative();

    // Bildirimle açıldıysa: sohbet diskteki mesajlarla çizilince splash kapanır (ağı beklemez).
    // Sohbetin kalanı, liste, rehber ve bildirim izni arkada yüklenir.
    if (window.pendingOpenChat) {
        const pendingTarget = window.pendingOpenChat;
        window.pendingOpenChat = null;

        const chatPromise = window.openChatFromNotification(pendingTarget).catch(() => {});
        await Promise.race([
            firstPaintPromise,
            chatPromise,
            new Promise((resolve) => setTimeout(resolve, 4000))
        ]);
        
        document.documentElement.removeAttribute('data-aura-launch');
        window.__aurachatReady = true;
        const tPaint = Math.round(performance.now());
        await hideNativeSplash();
        const tHide = Math.round(performance.now());

        // GEÇİCİ ÖLÇÜM satırı - sonuçları gördükten sonra silinecek
        setTimeout(() => {
            try { showToast('ÖLÇÜM: modüller ' + T_MODULE + ' | sohbet açılışı ' + (window.__auraTBuild || '-') + ' | ilk sunucu cevabı ' + (window.__auraTSnap || 'hâlâ yok') + ' | çizildi ' + tPaint + ' | splash kapandı ' + tHide + ' (ms)', 9000); } catch (e) {}
        }, 3000);

        await chatPromise;
        try { await loadContacts(); } catch (e) {}
        refreshOpenChatAvatar(pendingTarget.uid, pendingTarget.chatId);
        if (window.initPushForUser) {
            window.initPushForUser({ uid: currentUser.uid, email: currentUser.email });
        }
        return;
    }

    try { await loadContacts(); } catch (e) {}
    if (window.initPushForUser) {
        window.initPushForUser({ uid: currentUser.uid, email: currentUser.email });
    }

    // Sohbet zaten açıksa listeye döndürme
    if (!getCurrentChatId()) {
        sidebar.classList.remove('-translate-x-full');
        chatArea.classList.add('translate-x-full');
    }

    window.__aurachatReady = true;

    // Arayüz tam olarak yüklendi, kişilerin çekilmesi vs. bitti!
    // Splash ekranını şimdi yumuşak bir animasyonla kaldırıyoruz:
    await hideNativeSplash();
};

const existingUser = JSON.parse(localStorage.getItem('aurachat_user'));
if (existingUser) {
    window.initApp();
} else {
    // Oturum yoksa açılış ekranında kalmasın diye hemen kaldır
    hideNativeSplash();
}