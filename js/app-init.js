// ==========================================
// APP INIT
// index.html tarafından tek modül olarak import edilir.
// giris.js başarılı girişten sonra window.initApp()'i çağırır.
//
// GÜNCELLEME: Bildirimden gelen "şu sohbeti aç" bilgisi artık listeyi
// göstermeye karar vermeden ÖNCE kontrol ediliyor - soğuk açılışta
// önce listenin görünüp sonra sohbete sıçraması bu şekilde önleniyor.
// window.__aurachatReady bayrağı, uygulamanın açılış sürecini bitirip
// bitirmediğini index.html'deki bildirim dinleyicisine bildiriyor.
//
// Bildirime tıklandığında ilgili sohbeti açan
// window.openChatFromNotification() burada tanımlanıyor. PWA
// tarafında sw.js'ten gelen mesajı ve cold-start URL parametresini
// de burada karşılıyoruz.
// ==========================================

import { db } from "./firebase-init.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { setCurrentUser, selectChat, startPresence } from "./chat-core.js";
import { loadContacts, initAdminPanel } from "./contacts.js";

const sidebar = document.getElementById('sidebar');
const chatArea = document.getElementById('chat-area');

window.__aurachatReady = false;

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
window.openChatFromNotification = function (otherUser) {
    if (!otherUser || !otherUser.uid) return;
    selectChat(otherUser);
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

window.initApp = async function () {
    let currentUser = JSON.parse(localStorage.getItem('aurachat_user'));
    if (!currentUser) return;

    currentUser = await ensureUid(currentUser);

    setCurrentUser(currentUser);
    initAdminPanel();
    startPresence();
    await loadContacts();

    if (window.initPushForUser) {
        window.initPushForUser({ uid: currentUser.uid, email: currentUser.email });
    }

    // Bekleyen bir bildirim hedefi varsa (soğuk açılış, bildirimden
    // geldiyse) ÖNCE onu kontrol et - varsayılan liste görünümüne hiç
    // geçmeden direkt sohbete gidelim, "önce liste sonra sohbet"
    // sıçramasını böyle önlüyoruz.
    if (window.pendingOpenChat) {
        selectChat(window.pendingOpenChat);
        window.pendingOpenChat = null;
    } else if (window.innerWidth >= 1024) {
        selectChat('global');
    } else {
        sidebar.classList.remove('-translate-x-full');
        chatArea.classList.add('translate-x-full');
    }

    window.__aurachatReady = true;
};

const existingUser = JSON.parse(localStorage.getItem('aurachat_user'));
if (existingUser) {
    window.initApp();
}