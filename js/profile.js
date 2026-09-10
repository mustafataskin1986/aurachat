// ==========================================
// PROFİL PANELİ
// Üç nokta ikonuna tıklayınca açılır, kullanıcının kendi
// bilgilerini gösterir. İsim, avatar ve durum düzenlenebilir.
// Çıkış yap burada.
// ==========================================

import { db } from "./firebase-init.js";
import { doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getCurrentUser, setCurrentUser } from "./chat-core.js";
import { getUserColor, getInitials } from "./ui-helpers.js";

const profileBtn = document.getElementById('profile-btn');
const profilePanel = document.getElementById('profile-panel');
const profileBackBtn = document.getElementById('profile-back-btn');
const profileAvatar = document.getElementById('profile-avatar');
const profileAvatarInput = document.getElementById('profile-avatar-input');
const profileName = document.getElementById('profile-name');
const profileAbout = document.getElementById('profile-about');
const profileEmail = document.getElementById('profile-email');
const profilePhone = document.getElementById('profile-phone');
const profileSaveBtn = document.getElementById('profile-save-btn');
const profileLogoutBtn = document.getElementById('profile-logout-btn');

let pendingAvatarBase64 = null;

function renderAvatar(user) {
    if (!profileAvatar) return;
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

function openProfilePanel() {
    const user = getCurrentUser();
    if (!user || !profilePanel) return;

    pendingAvatarBase64 = null;

    if (profileName) profileName.value = user.name || '';
    if (profileAbout) profileAbout.value = user.about || '';
    if (profileEmail) profileEmail.textContent = user.email || '-';
    if (profilePhone) profilePhone.textContent = user.phone || '-';
    renderAvatar(user);

    profilePanel.classList.remove('hidden');
    profilePanel.classList.add('flex');
}

function closeProfilePanel() {
    if (!profilePanel) return;
    profilePanel.classList.add('hidden');
    profilePanel.classList.remove('flex');
}

if (profileBtn) profileBtn.addEventListener('click', openProfilePanel);
if (profileBackBtn) profileBackBtn.addEventListener('click', closeProfilePanel);

// Avatara tıklayınca yeni fotoğraf seç - sadece önizleme, kaydet'e basınca yazılır
if (profileAvatarInput) {
    profileAvatarInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
            pendingAvatarBase64 = ev.target.result;
            if (profileAvatar) {
                profileAvatar.style.backgroundColor = '';
                profileAvatar.innerHTML = `<img src="${pendingAvatarBase64}" class="w-full h-full object-cover">`;
            }
        };
        reader.readAsDataURL(file);
    });
}

// İsim + durum + (varsa) yeni avatarı Firestore'a ve localStorage'a kaydeder
if (profileSaveBtn) {
    profileSaveBtn.addEventListener('click', async () => {
        const user = getCurrentUser();
        if (!user) return;

        const newName = profileName ? profileName.value.trim() : user.name;
        const newAbout = profileAbout ? profileAbout.value.trim() : (user.about || '');

        if (!newName) {
            alert("İsim boş olamaz kanka!");
            return;
        }

        const originalContent = profileSaveBtn.innerHTML;
        profileSaveBtn.disabled = true;
        profileSaveBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Kaydediliyor...</span>`;

        try {
            const updates = { name: newName, about: newAbout };
            if (pendingAvatarBase64) updates.avatar = pendingAvatarBase64;

            await updateDoc(doc(db, "users", user.uid), updates);

            const updatedUser = {
                ...user,
                name: newName,
                about: newAbout,
                avatar: pendingAvatarBase64 || user.avatar
            };
            localStorage.setItem('aurachat_user', JSON.stringify(updatedUser));
            setCurrentUser(updatedUser);
            pendingAvatarBase64 = null;

            alert("Profilin güncellendi kanka!");
        } catch (err) {
            alert("Profil güncellenemedi: " + err.message);
        } finally {
            profileSaveBtn.disabled = false;
            profileSaveBtn.innerHTML = originalContent;
        }
    });
}

if (profileLogoutBtn) {
    profileLogoutBtn.addEventListener('click', () => {
        localStorage.removeItem('aurachat_user');
        localStorage.removeItem('aurachat_contacts_cache');
        location.reload();
    });
}
