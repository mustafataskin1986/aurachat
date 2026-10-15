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
import { appIconAvailable, openAppIconPanel } from "./app-icon.js";

const profileBtn = document.getElementById('profile-btn');
const profilePanel = document.getElementById('profile-panel');
// Profil paneli: WhatsApp tarzı yeni tasarım (içerik dinamik kurulur, id'ler korunur)
if (profilePanel) {
    profilePanel.innerHTML = `
        <div class="px-4 py-3.5 flex items-center space-x-4 flex-shrink-0">
            <button id="profile-back-btn" class="text-white text-lg px-1"><i class="fa-solid fa-arrow-left"></i></button>
            <h2 class="text-white font-medium text-xl">Profil</h2>
        </div>
        <div class="flex-1 overflow-y-auto pb-8">
            <div class="flex justify-center pt-4 pb-8">
                <div class="relative" style="width:180px;height:180px;">
                    <button type="button" id="profile-avatar-btn" class="block rounded-full overflow-hidden" style="width:180px;height:180px;" aria-label="Profil resmini göster">
                        <div id="profile-avatar" class="w-full h-full rounded-full flex items-center justify-center text-white font-bold overflow-hidden" style="font-size:64px;"></div>
                    </button>
                    <button type="button" id="profile-cam-btn" class="absolute flex items-center justify-center text-white shadow-lg active:scale-95 transition" style="right:2px;bottom:2px;width:48px;height:48px;border-radius:9999px;background:var(--aura-btn,#22c55e);border:3px solid #0b141a;" aria-label="Profil resmini düzenle"><i class="fa-solid fa-camera"></i></button>
                </div>
            </div>
            <input type="file" id="profile-avatar-input" accept="image/*" class="hidden">
            <input type="file" id="profile-camera-input" accept="image/*" capture="user" class="hidden">
            <button type="button" id="prow-name" class="w-full px-5 py-3 flex items-start space-x-5 text-left active:bg-white/5 transition">
                <i class="fa-regular fa-user text-gray-400 text-xl w-6 text-center mt-1"></i>
                <span class="flex-1 min-w-0"><span class="block text-gray-400 text-sm">Ad</span><span id="prow-name-v" class="block text-white text-[17px] break-words"></span></span>
                <i class="fa-solid fa-pencil text-green-500 mt-2"></i>
            </button>
            <div class="px-5 pb-2 pl-16 text-gray-500 text-sm">Bu, kullanıcı adınız veya PIN'iniz değil. Bu ad AuraChat kişilerinize görünür olacaktır.</div>
            <button type="button" id="prow-about" class="w-full px-5 py-3 flex items-start space-x-5 text-left active:bg-white/5 transition">
                <i class="fa-solid fa-circle-info text-gray-400 text-xl w-6 text-center mt-1"></i>
                <span class="flex-1 min-w-0"><span class="block text-gray-400 text-sm">Hakkımda</span><span id="prow-about-v" class="block text-[17px] break-words"></span></span>
                <i class="fa-solid fa-pencil text-green-500 mt-2"></i>
            </button>
            <div class="w-full px-5 py-3 flex items-start space-x-5">
                <i class="fa-solid fa-at text-gray-400 text-xl w-6 text-center mt-1"></i>
                <span class="flex-1 min-w-0"><span class="block text-gray-400 text-sm">Kullanıcı adı</span><span id="prow-user-v" class="block text-white text-[17px] break-all"></span></span>
            </div>
            <div class="w-full px-5 py-3 flex items-start space-x-5">
                <i class="fa-solid fa-phone text-gray-400 text-xl w-6 text-center mt-1"></i>
                <span class="flex-1 min-w-0"><span class="block text-gray-400 text-sm">Telefon</span><span id="profile-phone" class="block text-white text-[17px] break-words"></span></span>
            </div>
            <div class="w-full px-5 py-3 flex items-start space-x-5">
                <i class="fa-regular fa-envelope text-gray-400 text-xl w-6 text-center mt-1"></i>
                <span class="flex-1 min-w-0"><span class="block text-gray-400 text-sm">E-posta</span><span id="profile-email" class="block text-white text-[17px] break-all"></span></span>
            </div>
            <div class="px-5 mt-6">
                <button id="profile-logout-btn" class="w-full bg-rose-600/10 hover:bg-rose-600/20 text-rose-400 font-medium py-3 rounded-xl transition flex items-center justify-center space-x-2 border border-rose-600/20">
                    <i class="fa-solid fa-right-from-bracket"></i><span>Çıkış Yap</span>
                </button>
            </div>
        </div>`;
}
const profileBackBtn = document.getElementById('profile-back-btn');
const profileAvatar = document.getElementById('profile-avatar');
const profileAvatarInput = document.getElementById('profile-avatar-input');
const profileCameraInput = document.getElementById('profile-camera-input');
const profileName = null;
const profileAbout = null;
const profileEmail = document.getElementById('profile-email');
const profilePhone = document.getElementById('profile-phone');
const profileSaveBtn = null;
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
    const barT = settingsEl.querySelector('#settings-bar-title');
    if (barT) barT.textContent = user.name || '';
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
        el.style.zIndex = '52';
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
                refreshSettingsHeader();
                refreshProfileView();
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
            <div id="settings-bar" class="absolute top-0 left-0 right-0 px-4 py-3.5 flex items-center justify-between" style="z-index:2;background:rgba(11,20,26,0);">
                <button type="button" id="settings-back-btn" class="text-white text-lg px-1 w-10 text-left"><i class="fa-solid fa-arrow-left"></i></button>
                <h2 id="settings-bar-title" class="flex-1 min-w-0 truncate text-white text-xl ml-2" style="opacity:0;"></h2>
                <button type="button" id="settings-edit-btn" class="text-white text-lg px-1 w-10 text-right" aria-label="Profili düzenle"><i class="fa-solid fa-pencil"></i></button>
            </div>
            <div id="settings-scroll" class="flex-1 overflow-y-auto">
                <div id="settings-head" class="flex flex-col items-center pt-16 pb-8 px-6">
                    <button type="button" id="settings-about-btn" class="relative mb-3 px-5 py-2.5 rounded-full text-center max-w-full" style="background:#1f2c33;">
                        <span id="settings-sub" class="text-base break-words"></span>
                        <span style="position:absolute;left:50%;bottom:-6px;width:12px;height:12px;background:#1f2c33;transform:translateX(-50%) rotate(45deg);"></span>
                    </button>
                    <button type="button" id="settings-avatar-btn" class="relative" aria-label="Profili aç">
                        <div id="settings-avatar" class="rounded-full flex items-center justify-center text-white font-bold text-5xl shadow-lg overflow-hidden" style="width:136px;height:136px;"></div>
                    </button>
                    <h2 id="settings-name" class="text-white text-2xl mt-5 text-center break-words max-w-full"></h2>
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
        el.querySelector('#settings-edit-btn').addEventListener('click', () => openProfilePanel());
        const scroller = el.querySelector('#settings-scroll');
        const bar = el.querySelector('#settings-bar');
        const barTitle = el.querySelector('#settings-bar-title');
        const head = el.querySelector('#settings-head');
        scroller.addEventListener('scroll', () => {
            const t = Math.max(0, Math.min(1, (scroller.scrollTop - 120) / 120));
            bar.style.background = 'rgba(11,20,26,' + t + ')';
            barTitle.style.opacity = String(t);
            head.style.opacity = String(1 - Math.min(1, scroller.scrollTop / 260));
        }, { passive: true });
        el.querySelector('#settings-privacy-row').addEventListener('click', openPrivacyPage);
        // Uygulama ikonu: Gizlilik'in altında ayrı satır (yalnızca APK'da görünür)
        if (appIconAvailable()) {
            const iconRow = document.createElement('button');
            iconRow.type = 'button';
            iconRow.className = 'w-full px-5 py-4 flex items-center space-x-5 text-left active:bg-white/5 transition';
            iconRow.innerHTML = `
                <i class="fa-solid fa-palette text-gray-400 text-xl w-6 text-center"></i>
                <span class="min-w-0">
                    <span class="block text-white text-[17px]">Uygulama ikonu</span>
                    <span class="block text-gray-400 text-sm mt-0.5">Ana ekrandaki simgeyi değiştir</span>
                </span>`;
            iconRow.addEventListener('click', openAppIconPanel);
            el.querySelector('#settings-privacy-row').insertAdjacentElement('afterend', iconRow);
        }
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

function toastMsg(t) {
    const d = document.createElement('div');
    d.textContent = t;
    d.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#323b41;color:#fff;padding:10px 16px;border-radius:10px;font-size:14px;z-index:400;max-width:80%;text-align:center;';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 2200);
}

function refreshProfileView() {
    const user = getCurrentUser();
    if (!user || !profilePanel) return;
    renderAvatar(user);
    const n = document.getElementById('prow-name-v'); if (n) n.textContent = user.name || '';
    const a = document.getElementById('prow-about-v');
    if (a) {
        a.textContent = user.about || 'Hakkımda bilgisini ayarlayın';
        a.className = 'block text-[17px] break-words ' + (user.about ? 'text-white' : 'text-green-500');
    }
    const un = document.getElementById('prow-user-v');
    if (un) un.textContent = user.username || (user.email ? user.email.split('@')[0] : '-');
    if (profileEmail) profileEmail.textContent = user.email || '-';
    if (profilePhone) profilePhone.textContent = user.phone || '-';
}

async function saveUserFields(fields) {
    const user = getCurrentUser();
    if (!user) return false;
    try {
        await updateDoc(doc(db, "users", user.uid), fields);
        const updated = { ...user, ...fields };
        localStorage.setItem('aurachat_user', JSON.stringify(updated));
        setCurrentUser(updated);
        refreshProfileView();
        refreshSettingsHeader();
        refreshViewerPhoto();
        return true;
    } catch (err) {
        alert("Kaydedilemedi: " + err.message);
        return false;
    }
}

// ---------- Tam ekran profil resmi + alttan menü ----------
let viewerEl = null, viewerOpen = false;
let sheetEl = null, sheetOpen = false;

function refreshViewerPhoto() {
    if (!viewerEl) return;
    const user = getCurrentUser() || {};
    const box = viewerEl.querySelector('#pv-photo');
    if (user.avatar) {
        box.innerHTML = `<img src="${user.avatar}" style="width:100%;max-height:100%;object-fit:contain;">`;
        box.style.backgroundColor = '';
    } else {
        box.innerHTML = `<div style="width:100%;aspect-ratio:1/1;max-height:100%;display:flex;align-items:center;justify-content:center;background:${getUserColor(user.name || '')};color:#fff;font-size:96px;font-weight:700;">${getInitials(user.name || '')}</div>`;
    }
}

function closeViewerFromBack() {
    if (viewerEl) { viewerEl.classList.add('hidden'); viewerEl.classList.remove('flex'); }
    viewerOpen = false;
}
function closeSheetFromBack() {
    const el = sheetEl;
    sheetOpen = false;
    if (!el) return;
    sheetEl = null;
    const panel = el.firstElementChild;
    el.style.pointerEvents = 'none';
    el.style.transition = 'background-color 220ms ease';
    el.style.backgroundColor = 'rgba(0,0,0,0)';
    panel.style.transition = 'transform 240ms cubic-bezier(0.4,0,1,1)';
    panel.style.transform = 'translateY(100%)';
    setTimeout(() => el.remove(), 260);
}
function closeSheet() {
    if (!sheetOpen) return;
    closeSheetFromBack();
    popBackState();
}

async function deleteAvatar() {
    const user = getCurrentUser();
    if (!user || !user.avatar) { toastMsg('Silinecek profil resmi yok'); return; }
    closeSheet();
    if (await saveUserFields({ avatar: null })) toastMsg('Profil resmi silindi');
}

function hasGoogleAccount() {
    try {
        const u = auth && auth.currentUser;
        return !!(u && u.providerData && u.providerData.some(p => p.providerId === 'google.com' && p.photoURL));
    } catch (e) { return false; }
}

async function importGooglePhoto() {
    closeSheet();
    try {
        const pd = auth.currentUser.providerData.find(p => p.providerId === 'google.com');
        let url = pd && pd.photoURL;
        if (!url) { toastMsg('Google profil resmi bulunamadı'); return; }
        url = url.replace(/=s\d+(-c)?$/, '=s400-c').replace(/\?sz=\d+$/, '?sz=400');
        const res = await fetch(url);
        const blob = await res.blob();
        const file = new File([blob], 'google.jpg', { type: blob.type || 'image/jpeg' });
        const cropped = await openImageCropper(file, { size: 400, quality: 0.75 });
        if (!cropped) return;
        if (await saveUserFields({ avatar: cropped })) toastMsg('Profil resmi güncellendi');
    } catch (e) {
        toastMsg("Google'dan resim alınamadı");
    }
}

function openAvatarSheet() {
    if (sheetOpen) return;
    const google = hasGoogleAccount();
    const card = (id, icon, color, label) => `
        <button type="button" id="${id}" class="flex-1 flex flex-col items-center py-4 rounded-2xl active:bg-white/10 transition" style="border:1px solid #33434c;">
            <i class="${icon} text-2xl" style="color:${color}"></i><span class="text-gray-200 text-sm mt-2 text-center">${label}</span></button>`;
    const el = document.createElement('div');
    el.className = 'fixed inset-0 flex items-end';
    el.style.cssText = 'z-index:70;background-color:rgba(0,0,0,0);transition:background-color 240ms ease;';
    el.innerHTML = `
        <div class="w-full" style="background:#202c33;border-radius:16px 16px 0 0;padding:20px 16px calc(env(safe-area-inset-bottom,0px) + 20px);transform:translateY(100%);will-change:transform;touch-action:none;">
            <div class="w-10 h-1 bg-gray-600 rounded-full mx-auto mb-4"></div>
            <div class="flex items-center pb-3">
                <button type="button" id="ps-close" class="text-gray-300 text-xl w-10 text-left" aria-label="Kapat"><i class="fa-solid fa-xmark"></i></button>
                <h3 class="flex-1 text-center text-white text-lg font-medium">Profil resmi</h3>
                <button type="button" id="ps-del" class="text-gray-300 text-xl w-10 text-right" aria-label="Sil"><i class="fa-regular fa-trash-can"></i></button>
            </div>
            <div class="flex pt-2" style="gap:12px;">
                ${card('ps-cam', 'fa-solid fa-camera', 'var(--aura-btn,#22c55e)', 'Kamera')}
                ${card('ps-gal', 'fa-solid fa-image', 'var(--aura-btn,#22c55e)', 'Galeri')}
                ${google ? card('ps-gg', 'fa-brands fa-google', '#ea4335', "Google'dan içe aktar") : ''}
            </div>
        </div>`;
    document.body.appendChild(el);
    const panel = el.firstElementChild;
    el.addEventListener('click', (e) => { if (e.target === el) closeSheet(); });
    el.querySelector('#ps-close').addEventListener('click', closeSheet);
    el.querySelector('#ps-del').addEventListener('click', deleteAvatar);
    el.querySelector('#ps-cam').addEventListener('click', () => { closeSheet(); profileCameraInput && profileCameraInput.click(); });
    el.querySelector('#ps-gal').addEventListener('click', () => { closeSheet(); profileAvatarInput && profileAvatarInput.click(); });
    const gg = el.querySelector('#ps-gg');
    if (gg) gg.addEventListener('click', importGooglePhoto);
    sheetEl = el;
    sheetOpen = true;
    pushBackState(closeSheetFromBack);
    requestAnimationFrame(() => requestAnimationFrame(() => {
        el.style.backgroundColor = 'rgba(0,0,0,0.6)';
        panel.style.transition = 'transform 280ms cubic-bezier(0.2,0.9,0.3,1)';
        panel.style.transform = 'translateY(0)';
    }));
    // Parmakla aşağı çekerek kapatma
    let y0 = null, dy = 0;
    panel.addEventListener('touchstart', (ev) => { if (ev.touches.length !== 1) return; y0 = ev.touches[0].clientY; dy = 0; panel.style.transition = 'none'; }, { passive: true });
    panel.addEventListener('touchmove', (ev) => {
        if (y0 === null) return;
        dy = Math.max(0, ev.touches[0].clientY - y0);
        panel.style.transform = `translateY(${dy}px)`;
        el.style.backgroundColor = `rgba(0,0,0,${Math.max(0, 0.6 - dy / 600)})`;
    }, { passive: true });
    panel.addEventListener('touchend', () => {
        if (y0 === null) return;
        y0 = null;
        if (dy > 90) { closeSheet(); return; }
        panel.style.transition = 'transform 200ms ease';
        panel.style.transform = 'translateY(0)';
        el.style.backgroundColor = 'rgba(0,0,0,0.6)';
    });
}

async function shareAvatar() {
    const user = getCurrentUser();
    if (!user || !user.avatar) { toastMsg('Paylaşılacak profil resmi yok'); return; }
    try {
        const blob = await (await fetch(user.avatar)).blob();
        const file = new File([blob], 'profil.jpg', { type: blob.type || 'image/jpeg' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: user.name || 'Profil resmi' });
        } else if (navigator.share) {
            await navigator.share({ title: user.name || 'Profil resmi', text: user.name || '' });
        } else {
            toastMsg('Bu cihazda paylaşım desteklenmiyor');
        }
    } catch (e) { /* kullanıcı iptal etti */ }
}

function openAvatarViewer() {
    if (viewerOpen) return;
    if (!viewerEl) {
        const el = document.createElement('div');
        el.className = 'fixed inset-0 hidden flex-col';
        el.style.cssText = 'z-index:55;background:#0b141a;';
        el.innerHTML = `
            <div class="px-4 py-3.5 flex items-center flex-shrink-0">
                <button type="button" id="pv-back" class="text-white text-lg px-1 w-10 text-left"><i class="fa-solid fa-arrow-left"></i></button>
                <h2 class="flex-1 min-w-0 text-white text-xl ml-2">Profil resmi</h2>
                <button type="button" id="pv-edit" class="text-white text-lg w-10 text-center" aria-label="Düzenle"><i class="fa-solid fa-pencil"></i></button>
                <button type="button" id="pv-share" class="text-white text-lg w-10 text-center" aria-label="Paylaş"><i class="fa-solid fa-share-nodes"></i></button>
            </div>
            <div id="pv-photo" class="flex-1 flex items-center justify-center min-h-0 overflow-hidden"></div>`;
        document.body.appendChild(el);
        el.querySelector('#pv-back').addEventListener('click', () => { closeViewerFromBack(); popBackState(); });
        el.querySelector('#pv-edit').addEventListener('click', openAvatarSheet);
        el.querySelector('#pv-share').addEventListener('click', shareAvatar);
        viewerEl = el;
    }
    refreshViewerPhoto();
    viewerEl.classList.remove('hidden');
    viewerEl.classList.add('flex');
    viewerOpen = true;
    pushBackState(closeViewerFromBack);
}

// ---------- Ad düzenleme (alttan kutu) ----------
function openNameEditor() {
    const user = getCurrentUser();
    if (!user) return;
    const el = document.createElement('div');
    el.className = 'fixed inset-0';
    el.style.cssText = 'z-index:60;background:rgba(0,0,0,.6);';
    el.innerHTML = `
        <div style="position:absolute;left:0;right:0;bottom:0;background:#1f2c33;border-radius:24px 24px 0 0;padding:20px 20px calc(env(safe-area-inset-bottom,0px) + 16px);">
            <h3 class="text-white text-lg mb-4">Adınızı girin</h3>
            <input id="ne-input" type="text" maxlength="40" class="w-full bg-transparent text-white text-lg outline-none pb-2" style="border-bottom:2px solid var(--aura-btn,#22c55e);" autocomplete="off">
            <div class="flex justify-end mt-5" style="gap:24px;">
                <button type="button" id="ne-cancel" class="text-lg" style="color:var(--aura-btn,#22c55e)">İptal</button>
                <button type="button" id="ne-save" class="text-lg" style="color:var(--aura-btn,#22c55e)">Kaydet</button>
            </div>
        </div>`;
    document.body.appendChild(el);
    const inp = el.querySelector('#ne-input');
    inp.value = user.name || '';
    let done = false;
    const close = () => { if (done) return; done = true; el.remove(); popBackState(); };
    pushBackState(() => { if (!done) { done = true; el.remove(); } });
    setTimeout(() => inp.focus(), 50);
    el.addEventListener('click', (e) => { if (e.target === el) close(); });
    el.querySelector('#ne-cancel').addEventListener('click', close);
    el.querySelector('#ne-save').addEventListener('click', async () => {
        const v = inp.value.trim();
        if (!v) { alert("İsim boş olamaz kanka!"); return; }
        if (v !== user.name) await saveUserFields({ name: v });
        close();
    });
}

async function openProfilePanel() {
    let user = getCurrentUser();
    if (!user || !profilePanel) return;
    updatePrivacyLabel();
    refreshProfileView();
    profilePanel.classList.remove('hidden');
    profilePanel.classList.add('flex');
    pushBackState(closeProfilePanel);

    try {
        const userSnap = await getDoc(doc(db, "users", user.uid));
        if (userSnap.exists()) {
            const f = userSnap.data();
            user = {
                ...user,
                name: f.name || user.name || '',
                about: f.about || user.about || '',
                email: f.email || user.email || '',
                phone: f.phone || user.phone || '',
                username: f.username || user.username || '',
                avatar: f.avatar || user.avatar || null
            };
            localStorage.setItem('aurachat_user', JSON.stringify(user));
            setCurrentUser(user);
            refreshProfileView();
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
if (profilePanel) {
    profilePanel.querySelector('#profile-avatar-btn').addEventListener('click', openAvatarViewer);
    profilePanel.querySelector('#profile-cam-btn').addEventListener('click', openAvatarSheet);
    profilePanel.querySelector('#prow-name').addEventListener('click', openNameEditor);
    profilePanel.querySelector('#prow-about').addEventListener('click', openAboutPage);
}

// Kamera / galeriden seçilen resim: kırp, hemen kaydet
async function handleAvatarFile(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const cropped = await openImageCropper(file, { size: 400, quality: 0.75 });
    if (!cropped) return;
    if (await saveUserFields({ avatar: cropped })) toastMsg('Profil resmi güncellendi');
}
if (profileAvatarInput) profileAvatarInput.addEventListener('change', () => handleAvatarFile(profileAvatarInput));
if (profileCameraInput) profileCameraInput.addEventListener('change', () => handleAvatarFile(profileCameraInput));

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