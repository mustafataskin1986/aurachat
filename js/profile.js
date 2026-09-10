// ==========================================
// PROFİL PANELİ
// Üç nokta ikonuna tıklayınca açılır, kullanıcının kendi
// bilgilerini (avatar, isim, email, telefon) gösterir.
// Çıkış yap artık burada.
// ==========================================

import { getCurrentUser } from "./chat-core.js";
import { getUserColor, getInitials } from "./ui-helpers.js";

const profileBtn = document.getElementById('profile-btn');
const profilePanel = document.getElementById('profile-panel');
const profileBackBtn = document.getElementById('profile-back-btn');
const profileAvatar = document.getElementById('profile-avatar');
const profileName = document.getElementById('profile-name');
const profileEmail = document.getElementById('profile-email');
const profilePhone = document.getElementById('profile-phone');
const profileLogoutBtn = document.getElementById('profile-logout-btn');

function openProfilePanel() {
    const user = getCurrentUser();
    if (!user || !profilePanel) return;

    if (profileName) profileName.textContent = user.name || '-';
    if (profileEmail) profileEmail.textContent = user.email || '-';
    if (profilePhone) profilePhone.textContent = user.phone || '-';

    if (profileAvatar) {
        if (user.avatar) {
            profileAvatar.style.backgroundColor = '';
            profileAvatar.innerHTML = `<img src="${user.avatar}" class="w-full h-full object-cover">`;
        } else {
            const initials = getInitials(user.name);
            const color = getUserColor(user.name);
            profileAvatar.style.backgroundColor = color;
            profileAvatar.innerHTML = `<span>${initials}</span>`;
        }
    }

    profilePanel.classList.remove('hidden');
    profilePanel.classList.add('flex');
}

function closeProfilePanel() {
    if (!profilePanel) return;
    profilePanel.classList.add('hidden');
    profilePanel.classList.remove('flex');
}

if (profileBtn) {
    profileBtn.addEventListener('click', openProfilePanel);
}

if (profileBackBtn) {
    profileBackBtn.addEventListener('click', closeProfilePanel);
}

if (profileLogoutBtn) {
    profileLogoutBtn.addEventListener('click', () => {
        localStorage.removeItem('aurachat_user');
        localStorage.removeItem('aurachat_contacts_cache');
        location.reload();
    });
}
