// ==========================================
// APP INIT
// index.html tarafından tek modül olarak import edilir.
// giris.js başarılı girişten sonra window.initApp()'i çağırır.
// ==========================================

import { setCurrentUser, selectChat } from "./chat-core.js";
import { loadContacts, initAdminPanel } from "./contacts.js";

const sidebar = document.getElementById('sidebar');
const chatArea = document.getElementById('chat-area');
const logoutBtn = document.getElementById('logout-btn');

window.initApp = function () {
    const currentUser = JSON.parse(localStorage.getItem('aurachat_user'));
    if (!currentUser) return;

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
