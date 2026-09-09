// ==========================================
// APP INIT
// index.html tarafından tek modül olarak import edilir.
// giris.js başarılı girişten sonra window.initApp()'i çağırır.
// ==========================================

import { db } from "./firebase-init.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { setCurrentUser, selectChat } from "./chat-core.js";
import { loadContacts, initAdminPanel } from "./contacts.js";

const sidebar = document.getElementById('sidebar');
const chatArea = document.getElementById('chat-area');
const logoutBtn = document.getElementById('logout-btn');

// Bu güncellemeden ÖNCE giriş yapmış hesaplarda localStorage'daki
// kullanıcı objesinde uid alanı yoktur (eski giris.js yazmıyordu).
// chatId artık uid bazlı üretildiği için uid eksikse eşleşme bozulur
// ve mesajlar karşı tarafa ulaşmaz. Burada otomatik onarıyoruz.
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

window.initApp = async function () {
    let currentUser = JSON.parse(localStorage.getItem('aurachat_user'));
    if (!currentUser) return;

    currentUser = await ensureUid(currentUser);

    setCurrentUser(currentUser);
    initAdminPanel();
    loadContacts();

    if (window.innerWidth >= 768) {
        selectChat('global');
    } else {
        sidebar.classList.remove('-translate-x-full');
        chatArea.classList.add('translate-x-full');
    }
};

// Sayfa ilk açıldığında oturum varsa direkt başlat
const existingUser = JSON.parse(localStorage.getItem('aurachat_user'));
if (existingUser) {
    window.initApp();
}

if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
        localStorage.removeItem('aurachat_user');
        localStorage.removeItem('aurachat_contacts_cache');
        location.reload();
    });
}
