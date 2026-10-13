// ==========================================
// AYARLAR SAYFASI + PROFİL PANELİ
// Üç nokta menüsündeki "Ayarlar" önce sade bir ayarlar sayfası açar:
// büyük avatar + isim, altında sadece "Gizlilik" satırı.
// Avatara dokununca profil paneli (isim, durum, avatar düzenleme, çıkış yap) açılır.
// "Gizlilik" satırı son görülme ve okundu bilgisi anahtarlarını gösterir.
// ==========================================

import { db, auth } from "./firebase-init.js";
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getCurrentUser, setCurrentUser, getPresenceHidden, setPresenceHidden, getReadReceiptsHidden, setReadReceiptsHidden } from "./chat-core.js";
import { getUserColor, getInitials } from "./ui-helpers.js";
import { pushBackState, popBackState } from "./back-handler.js";
import { openImageCropper } from "./image-cropper.js";

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

// Avatar da chat resimleri gibi sıkıştırılmalı - Firestore'un tek
// doküman için 1MiB sert sınırı var, ham base64 onu kolayca aşıyor
// ve kayıt sessizce/hatayla başarısız oluyordu.
function compressAvatarToDataUrl(file, targetBytes = 200 * 1024) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const dimensionSteps = [500, 400, 300];
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
                else reject(new Error('Avatar sıkıştırılamadı'));
            };
            img.onerror = reject;
            img.src = e.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

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
// Gizlilik anahtarları: açık = paylaş, kapalı = gizle
const privacySwitches = [];

function updatePrivacyLabel() {
    privacySwitches.forEach((sw) => {
        const on = sw.getOn();
        sw.el.setAttribute('aria-checked', on ? 'true' : 'false');
        sw.el.style.background = on ? 'var(--aura-btn,#22c55e)' : '#4b5563';
        sw.el.firstElementChild.style.transform = on ? 'translateX(20px)' : 'translateX(0)';
    });
}

function addPrivacySwitchRow(container, icon, label, desc, getOn, setOn) {
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'w-full px-5 py-3.5 flex items-center justify-between';
    row.innerHTML = `
        <span class="flex items-center space-x-4 min-w-0">
            <i class="fa-solid ${icon} text-gray-400 w-5 text-center"></i>
            <span class="min-w-0">
                <span class="block text-white text-[15px]">${label}</span>
                <span class="block text-gray-400 text-xs mt-0.5">${desc}</span>
            </span>
        </span>
        <button type="button" role="switch" aria-checked="true" class="flex-shrink-0 ml-3" style="width:44px;height:24px;border-radius:9999px;padding:2px;transition:background .15s;">
            <span style="display:block;width:20px;height:20px;border-radius:9999px;background:#fff;transition:transform .15s;"></span>
        </button>
    `;
    const el = row.querySelector('button');
    el.addEventListener('click', () => {
        setOn(!getOn());
        updatePrivacyLabel();
    });
    privacySwitches.push({ el, getOn });
    container.appendChild(row);
    updatePrivacyLabel();
}

// ---------- Ayarlar sayfası (avatar + isim + Gizlilik) ----------
let settingsEl = null;
let settingsOpen = false;
let privacyEl = null;
let privacyOpen = false;

function renderAvatarInto(el, user) {
    if (!el) return;
    if (user.avatar) {
        el.style.backgroundColor = '';
        el.innerHTML = `<img src="${user.avatar}" class="w-full h-full object-cover">`;
    } else {
        el.style.backgroundColor = getUserColor(user.name || '');
        el.innerHTML = `<span>${getInitials(user.name || '')}</span>`;
    }
}

function refreshSettingsHeader() {
    if (!settingsEl) return;
    const user = getCurrentUser();
    if (!user) return;
    renderAvatarInto(settingsEl.querySelector('#settings-avatar'), user);
    const nameEl = settingsEl.querySelector('#settings-name');
    const subEl = settingsEl.querySelector('#settings-sub');
    if (nameEl) nameEl.textContent = user.name || '';
    if (subEl) {
        subEl.textContent = user.about || 'Neler oluyor?';
        subEl.className = user.about ? 'text-gray-300 text-base' : 'text-gray-500 text-base';
    }
}

function closeSettingsFromBack() {
    if (settingsEl) {
        settingsEl.classList.add('hidden');
        settingsEl.classList.remove('flex');
    }
    settingsOpen = false;
}

function closePrivacyFromBack() {
    if (privacyEl) {
        privacyEl.classList.add('hidden');
        privacyEl.classList.remove('flex');
    }
    privacyOpen = false;
}

function openPrivacyPage() {
    if (!privacyEl) {
        const el = document.createElement('div');
        el.className = 'fixed inset-0 bg-[#0b141a] hidden flex-col';
        el.style.zIndex = '47';
        el.innerHTML = `
            <div class="bg-[#202c33] px-4 py-3.5 flex items-center space-x-4 border-b border-gray-800 flex-shrink-0">
                <button type="button" id="privacy-back-btn" class="text-gray-400 hover:text-white transition text-lg px-1"><i class="fa-solid fa-arrow-left"></i></button>
                <h2 class="text-white font-medium text-base">Gizlilik</h2>
            </div>
            <div id="privacy-list" class="flex-1 overflow-y-auto pt-2"></div>
        `;
        document.body.appendChild(el);
        el.querySelector('#privacy-back-btn').addEventListener('click', () => {
            closePrivacyFromBack();
            popBackState();
        });
        const list = el.querySelector('#privacy-list');
        addPrivacySwitchRow(list, 'fa-eye', 'Son görülme', 'Kapalıyken kimse son görülmeni görmez', () => !getPresenceHidden(), (on) => setPresenceHidden(!on));
        addPrivacySwitchRow(list, 'fa-check-double', 'Okundu bilgisi', 'Kapalıyken okundu tikini ne sen gönderirsin ne de görürsün', () => !getReadReceiptsHidden(), (on) => setReadReceiptsHidden(!on));
        privacyEl = el;
    }
    updatePrivacyLabel();
    if (privacyOpen) return;
    privacyEl.classList.remove('hidden');
    privacyEl.classList.add('flex');
    privacyOpen = true;
    pushBackState(closePrivacyFromBack);
}

// ---------- Hakkımda sayfası (Neler oluyor?) ----------
let aboutEl = null;
let aboutOpen = false;
const ABOUT_SUGGESTIONS = [
    { icon: '', text: 'Bir varmış, bir yokmuş' },
    { icon: '🌙', text: 'Uzakta, mesaj bırak' },
    { icon: '😴', text: 'Uyuyorum' },
    { icon: '💼', text: 'İşyerinde' },
    { icon: '✈️', text: 'Seyahat ediyorum' },
    { icon: '💪', text: 'Spor Salonunda' }
];

function closeAboutFromBack() {
    if (aboutEl) {
        aboutEl.classList.add('hidden');
        aboutEl.classList.remove('flex');
    }
    aboutOpen = false;
}

function openAboutPage() {
    const user = getCurrentUser();
    if (!user) return;
    if (!aboutEl) {
        const el = document.createElement('div');
        el.className = 'fixed inset-0 bg-[#0b141a] hidden flex-col';
        el.style.zIndex = '48';
        el.innerHTML = `
            <div class="px-4 py-3.5 flex items-center space-x-4 flex-shrink-0">
                <button type="button" id="about-back-btn" class="text-white text-lg px-1"><i class="fa-solid fa-arrow-left"></i></button>
                <h2 class="text-white font-medium text-lg">Hakkımda</h2>
            </div>
            <div class="px-4 pt-3 flex-shrink-0">
                <div id="about-box" class="flex items-center rounded-xl border-2 border-gray-600 px-4 py-3 transition-colors">
                    <i class="fa-regular fa-face-smile text-green-500 text-2xl"></i>
                    <input id="about-input" type="text" maxlength="139" placeholder="Neler oluyor?" autocomplete="off"
                        class="flex-1 min-w-0 bg-transparent outline-none text-white text-lg mx-4 placeholder-gray-500">
                    <button type="button" id="about-clear" class="text-gray-400 text-2xl hidden" aria-label="Temizle"><i class="fa-regular fa-circle-xmark"></i></button>
                </div>
                <p class="text-gray-400 text-base mt-6 mb-2">Öneriler</p>
            </div>
            <div id="about-list" class="flex-1 overflow-y-auto px-4"></div>
            <div class="bg-[#202c33] rounded-t-3xl px-5 py-4 flex items-center justify-between flex-shrink-0">
                <span class="text-gray-400 text-lg">Önizleme <i class="fa-solid fa-chevron-up text-sm ml-2"></i></span>
                <button type="button" id="about-save" class="w-14 h-14 rounded-full bg-green-500 text-white text-xl flex items-center justify-center shadow-lg active:scale-95 transition"><i class="fa-solid fa-check"></i></button>
            </div>
        `;
        document.body.appendChild(el);
        const input = el.querySelector('#about-input');
        const box = el.querySelector('#about-box');
        const clearBtn = el.querySelector('#about-clear');
        const list = el.querySelector('#about-list');

        const sync = () => {
            clearBtn.classList.toggle('hidden', !input.value);
            const cur = input.value.trim();
            list.querySelectorAll('[data-sug]').forEach(r => {
                r.querySelector('.sug-check').style.visibility = (r.dataset.sug === cur) ? 'visible' : 'hidden';
            });
        };
        ABOUT_SUGGESTIONS.forEach(sug => {
            const r = document.createElement('button');
            r.type = 'button';
            r.dataset.sug = sug.text;
            r.className = 'w-full flex items-center py-4 text-left active:bg-white/5 transition';
            r.innerHTML = `
                <span class="w-9 text-2xl text-center flex-shrink-0">${sug.icon}</span>
                <span class="flex-1 text-white text-lg ml-3">${sug.text}</span>
                <i class="fa-solid fa-check text-green-500 text-lg sug-check mr-2" style="visibility:hidden"></i>
            `;
            r.addEventListener('click', () => { input.value = sug.text; sync(); });
            list.appendChild(r);
        });
        input.addEventListener('input', sync);
        input.addEventListener('focus', () => { box.style.borderColor = '#22c55e'; });
        input.addEventListener('blur', () => { box.style.borderColor = ''; });
        clearBtn.addEventListener('click', () => { input.value = ''; sync(); input.focus(); });
        el.querySelector('#about-back-btn').addEventListener('click', () => {
            closeAboutFromBack();
            popBackState();
        });
        el.querySelector('#about-save').addEventListener('click', async () => {
            const u = getCurrentUser();
            if (!u) return;
            const newAbout = input.value.trim();
            const btn = el.querySelector('#about-save');
            btn.disabled = true;
            try {
                await updateDoc(doc(db, "users", u.uid), { about: newAbout });
                const updatedUser = { ...u, about: newAbout };
                localStorage.setItem('aurachat_user', JSON.stringify(updatedUser));
                setCurrentUser(updatedUser);
                if (profileAbout) profileAbout.value = newAbout;
                refreshSettingsHeader();
                closeAboutFromBack();
                popBackState();
            } catch (err) {
                alert("Kaydedilemedi: " + err.message);
            } finally {
                btn.disabled = false;
            }
        });
        aboutEl = el;
        el._sync = sync;
    }
    const inp = aboutEl.querySelector('#about-input');
    inp.value = user.about || '';
    aboutEl._sync();
    if (aboutOpen) return;
    aboutEl.classList.remove('hidden');
    aboutEl.classList.add('flex');
    aboutOpen = true;
    pushBackState(closeAboutFromBack);
}

function openSettingsPage() {
    const user = getCurrentUser();
    if (!user) return;
    if (!settingsEl) {
        const el = document.createElement('div');
        el.className = 'fixed inset-0 bg-[#0b141a] hidden flex-col';
        el.style.zIndex = '45';
        el.innerHTML = `
            <div class="bg-[#0b141a] px-4 py-3.5 flex items-center space-x-4 flex-shrink-0">
                <button type="button" id="settings-back-btn" class="text-white text-lg px-1"><i class="fa-solid fa-arrow-left"></i></button>
                <h2 class="text-white font-medium text-base">Ayarlar</h2>
            </div>
            <div class="flex-1 overflow-y-auto">
                <div class="flex flex-col items-center pt-6 pb-8 px-6">
                    <button type="button" id="settings-avatar-btn" class="relative" aria-label="Profili aç">
                        <div id="settings-avatar" class="rounded-full flex items-center justify-center text-white font-bold text-5xl shadow-lg overflow-hidden" style="width:136px;height:136px;"></div>
                    </button>
                    <h2 id="settings-name" class="text-white text-2xl mt-5 text-center break-words max-w-full"></h2>
                    <button type="button" id="settings-about-btn" class="mt-2 px-4 py-1.5 rounded-full text-center break-words max-w-full active:bg-white/5 transition">
                        <span id="settings-sub" class="text-base"></span>
                    </button>
                </div>
                <button type="button" id="settings-privacy-row" class="w-full px-5 py-4 flex items-center space-x-5 text-left active:bg-white/5 transition">
                    <i class="fa-solid fa-lock text-gray-400 text-xl w-6 text-center"></i>
                    <span class="min-w-0">
                        <span class="block text-white text-[17px]">Gizlilik</span>
                        <span class="block text-gray-400 text-sm mt-0.5">Son görülme, okundu bilgisi</span>
                    </span>
                </button>
            </div>
        `;
        document.body.appendChild(el);
        el.querySelector('#settings-back-btn').addEventListener('click', () => {
            closeSettingsFromBack();
            popBackState();
        });
        el.querySelector('#settings-avatar-btn').addEventListener('click', () => openProfilePanel());
        el.querySelector('#settings-privacy-row').addEventListener('click', openPrivacyPage);
        el.querySelector('#settings-about-btn').addEventListener('click', openAboutPage);
        settingsEl = el;
    }
    refreshSettingsHeader();
    if (settingsOpen) return;
    settingsEl.classList.remove('hidden');
    settingsEl.classList.add('flex');
    settingsOpen = true;
    pushBackState(closeSettingsFromBack);
}

async function openProfilePanel() {
        let user = getCurrentUser();
    if (!user || !profilePanel) return;
    updatePrivacyLabel();

    pendingAvatarBase64 = null;

    // 1. Önce geçici verileri temiz bir şekilde göster
    if (profileName) profileName.value = user.name || '';
    if (profileAbout) profileAbout.value = user.about || '';
    if (profileEmail) profileEmail.textContent = user.email || '-';
    if (profilePhone) profilePhone.textContent = user.phone || '-';
    renderAvatar(user);

    profilePanel.classList.remove('hidden');
    profilePanel.classList.add('flex');
    pushBackState(closeProfilePanel);

    // 2. Firestore'dan güncel ve taze kullanıcı dokümanını çek
    try {
        const userDocRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userDocRef);

        if (userSnap.exists()) {
            const freshData = userSnap.data();

            // Güncel bilgileri objeye ve ekrana yansıt
            user = {
                ...user,
                name: freshData.name || user.name || '',
                about: freshData.about || user.about || '',
                email: freshData.email || user.email || '',
                phone: freshData.phone || user.phone || '',
                avatar: freshData.avatar || user.avatar || null
            };

            // Önbellekleri ve state'i tazele
            localStorage.setItem('aurachat_user', JSON.stringify(user));
            setCurrentUser(user);

            // Arayüz elemanlarını taze veriyle doldur
            if (profileName) profileName.value = user.name;
            if (profileAbout) profileAbout.value = user.about;
            if (profileEmail) profileEmail.textContent = user.email || '-';
            if (profilePhone) profilePhone.textContent = user.phone || '-';
            renderAvatar(user);
        }
    } catch (err) {
        console.error("Taze profil verisi alınamadı:", err);
    }
}

function closeProfilePanel() {
    if (!profilePanel) return;
    profilePanel.classList.add('hidden');
    profilePanel.classList.remove('flex');
}

// Menüdeki "Ayarlar" bunu çağırır: önce sade ayarlar sayfası; avatara dokununca profil paneli açılır
window.openProfilePanel = openSettingsPage;
window.openProfileEditPanel = openProfilePanel;
if (profileBackBtn) {
    profileBackBtn.addEventListener('click', () => {
        closeProfilePanel();
        popBackState();
        refreshSettingsHeader();
    });
}

// Avatara tıklayınca yeni fotoğraf seç - sadece önizleme, kaydet'e basınca yazılır
if (profileAvatarInput) {
    profileAvatarInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        profileAvatarInput.value = '';
        if (!file) return;

        // WhatsApp tarzı kırpma ekranı
        const cropped = await openImageCropper(file, { size: 400, quality: 0.75 });
        if (!cropped) return; // İptal

        if (profileAvatar) {
            profileAvatar.innerHTML = `<div class="w-full h-full flex items-center justify-center"><i class="fa-solid fa-spinner fa-spin text-white"></i></div>`;
        }

        try {
            pendingAvatarBase64 = cropped;
            if (profileAvatar) {
                profileAvatar.style.backgroundColor = '';
                profileAvatar.innerHTML = `<img src="${pendingAvatarBase64}" class="w-full h-full object-cover">`;
            }
        } catch (err) {
            alert("Fotoğraf işlenemedi kanka, başka bir tane dene: " + err.message);
            const user = getCurrentUser();
            if (user) renderAvatar(user);
        }
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

// Çıkış yaparken hem Firebase oturumunu hem tüm önbelleği temizle
if (profileLogoutBtn) {
    profileLogoutBtn.addEventListener('click', async () => {
        try {
                try { if (window.AuraNotif && window.AuraNotif.clearSession) window.AuraNotif.clearSession(); } catch (e) {}
            if (auth) await signOut(auth);
            localStorage.clear();
            sessionStorage.clear();
            location.reload();
        } catch (err) {
            console.error("Çıkış yapılırken hata oluştu:", err);
            localStorage.clear();
            sessionStorage.clear();
            location.reload();
        }
    });
}