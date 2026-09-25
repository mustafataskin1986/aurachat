// ==========================================
// APP INIT
// index.html tarafından tek modül olarak import edilir.
// giris.js başarılı girişten sonra window.initApp()'i çağırır.
// ==========================================

import { db } from "./firebase-init.js";
import { collection, query, where, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { setCurrentUser, selectChat, startPresence } from "./chat-core.js";
import { watchCallForChat } from "./video-call.js";
import { watchVoiceCallForChat } from "./voice-call.js";
import { watchGroupCallForChat } from "./group-call.js";
import { loadContacts, initAdminPanel } from "./contacts.js";

// CAPACITOR SPLASH SCREEN IMPORTO
import { SplashScreen } from 'https://cdn.jsdelivr.net/npm/@capacitor/splash-screen@5.0.0/+esm'; 
// NOT: Eğer projen npm / bundler kullanıyorsa üsttekini comment'leyip:
// import { SplashScreen } from '@capacitor/splash-screen'; yapabilirsin.

const sidebar = document.getElementById('sidebar');
const chatArea = document.getElementById('chat-area');

window.__aurachatReady = false;

// Splash ekranını yumuşakça kapatan yardımcı fonksiyon
async function hideNativeSplash() {
    try {
        if (window.Capacitor && window.Capacitor.isNativePlatform()) {
            await SplashScreen.hide({ fadeDuration: 250 });
        }
    } catch (e) {
        // Web ortamındaysa veya plugin yoksa pas geç
    }
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

// Bildirime tıklanınca (Capacitor native veya PWA) çağrılır
window.openChatFromNotification = async function (otherUser) {
    if (!otherUser || !otherUser.uid) return;

    try {
        const groupSnap = await getDoc(doc(db, "groups", otherUser.uid));
        if (groupSnap.exists()) {
            selectChat({ isGroup: true, groupId: groupSnap.id, name: groupSnap.data().name || 'Grup' });
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

    selectChat(target);
};

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
        avatar: urlParams.get('otherAvatar') || ''
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
    await checkIncomingCallFast(currentUser.uid);
    await loadContacts();

    if (window.initPushForUser) {
        window.initPushForUser({ uid: currentUser.uid, email: currentUser.email });
    }

    if (window.pendingOpenChat) {
        window.openChatFromNotification(window.pendingOpenChat);
        window.pendingOpenChat = null;
    } else {
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
