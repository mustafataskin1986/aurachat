// ==========================================
// KİŞİ BİLGİSİ SAYFASI (WhatsApp düzeni)
// - Şeffaf üst bar: solda geri oku, sağda üç nokta
// - Ortada büyük avatar, altında isim, telefon, Hakkımda yazısı
// - Sesli / Görüntülü / Ara düğmeleri (sohbet içindekilerle aynı)
// - Aşağı kaydırınca üst barda ok + küçük avatar + isim belirir
// - Avatara dokununca tam ekran resim (yukarı/aşağı çekince kapanır)
// - Sayfa açıkken ekran görüntüsü ve ekran kaydı engellenir (APK)
// ==========================================

import { db } from "./firebase-init.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getCurrentUser, getCurrentChatId, selectChat, showToast, openChatSearch, openStarredPanel, toggleBlockUser, wipeChat, setDisappearAfter } from "./chat-core.js";
import { openChatThemePicker } from "./chat-theme.js";
import { getUserColor, getInitials, escapeHtml, getChatId } from "./ui-helpers.js";
import { pushBackState, popBackState } from "./back-handler.js";
import { auraDialog, auraAccent } from "./aura-dialog.js";

let infoEl = null;
let infoOpen = false;
let curUser = null;
let curBefore = null;

function setSecure(on) {
    try { if (window.AuraSecure && window.AuraSecure.set) window.AuraSecure.set(!!on); } catch (e) {}
}

function closeFromBack() {
    if (infoEl) {
        infoEl.classList.add('hidden');
        infoEl.classList.remove('flex');
    }
    infoOpen = false;
    setSecure(false);
}

function closeInfo() {
    if (!infoOpen) return;
    closeFromBack();
    popBackState();
}

function avatarInner(u) {
    if (u.avatar) return `<img src="${u.avatar}" class="w-full h-full object-cover">`;
    return escapeHtml(getInitials(u.name || '?'));
}

function paintAvatar(box, u) {
    if (u.avatar) {
        box.style.background = '';
        box.innerHTML = `<img src="${u.avatar}" class="w-full h-full object-cover">`;
    } else {
        box.style.background = getUserColor(u.name || '?');
        box.textContent = getInitials(u.name || '?');
    }
}

// Bu kişiyle olan sohbet açık değilse önce onu açar
async function ensureChat() {
    const me = getCurrentUser();
    if (!me || !curUser) return false;
    const cid = getChatId(me.uid, curUser.uid);
    const u = curUser;
    closeInfo();
    if (getCurrentChatId() !== cid) {
        if (typeof curBefore === 'function') curBefore();
        await selectChat({ uid: u.uid, name: u.name, avatar: u.avatar || '' });
    }
    return true;
}

function rowHtml(id, icon, color, label, sub) {
    return `
        <button type="button" data-row="${id}" class="w-full px-5 py-4 flex items-center space-x-5 text-left active:bg-white/5 transition">
            <i class="fa-solid ${icon} ${color} text-lg w-6 text-center"></i>
            <span class="min-w-0 flex-1">
                <span data-label class="block text-[16px] ${id === 'wipe' || id === 'block' ? 'text-rose-400' : 'text-white'}">${label}</span>
                ${sub ? `<span class="block text-gray-400 text-xs mt-0.5">${sub}</span>` : ''}
            </span>
        </button>`;
}

function ensureEl() {
    if (infoEl) return infoEl;
    const el = document.createElement('div');
    el.className = 'fixed inset-0 bg-[#0b141a] hidden flex-col';
    el.style.zIndex = '65';
    el.innerHTML = `
        <div id="ci-bar" class="absolute top-0 left-0 right-0 px-4 flex items-center" style="z-index:3;height:60px;background:rgba(11,20,26,0);">
            <button type="button" id="ci-back" class="text-white text-lg px-1 w-9 text-left flex-shrink-0"><i class="fa-solid fa-arrow-left"></i></button>
            <div id="ci-bar-who" class="flex-1 min-w-0 flex items-center space-x-3 ml-1" style="opacity:0;">
                <div id="ci-bar-avatar" class="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-xs overflow-hidden flex-shrink-0"></div>
                <span id="ci-bar-name" class="text-white text-lg truncate"></span>
            </div>
            <div class="flex-1" id="ci-bar-spacer"></div>
            <button type="button" id="ci-dots" class="text-white text-lg px-2 w-9 text-right flex-shrink-0" aria-label="Menü"><i class="fa-solid fa-ellipsis-vertical"></i></button>
        </div>
        <div id="ci-scroll" class="flex-1 overflow-y-auto">
            <div id="ci-head" class="flex flex-col items-center px-6" style="padding-top:20px;">
                <button type="button" id="ci-avatar-btn" aria-label="Fotoğrafı aç">
                    <div id="ci-avatar" class="rounded-full flex items-center justify-center text-white font-bold text-5xl shadow-lg overflow-hidden" style="width:150px;height:150px;"></div>
                </button>
                <h2 id="ci-name" class="text-white text-2xl mt-4 text-center break-words max-w-full"></h2>
                <p id="ci-phone" class="text-gray-400 text-base mt-1 text-center"></p>
                <p id="ci-about" class="text-white text-base mt-3 text-center break-words max-w-full"></p>
                <div class="flex w-full max-w-sm space-x-3 mt-6">
                    <button type="button" data-act="voice" class="flex-1 rounded-2xl py-3 flex flex-col items-center space-y-1.5 active:scale-95 transition" style="background:#1f2c33;border:1px solid rgba(255,255,255,.06);">
                        <i class="fa-solid fa-phone text-emerald-400 text-lg"></i><span class="text-emerald-400 text-xs">Sesli</span>
                    </button>
                    <button type="button" data-act="video" class="flex-1 rounded-2xl py-3 flex flex-col items-center space-y-1.5 active:scale-95 transition" style="background:#1f2c33;border:1px solid rgba(255,255,255,.06);">
                        <i class="fa-solid fa-video text-emerald-400 text-lg"></i><span class="text-emerald-400 text-xs">Görüntülü</span>
                    </button>
                    <button type="button" data-act="search" class="flex-1 rounded-2xl py-3 flex flex-col items-center space-y-1.5 active:scale-95 transition" style="background:#1f2c33;border:1px solid rgba(255,255,255,.06);">
                        <i class="fa-solid fa-magnifying-glass text-emerald-400 text-lg"></i><span class="text-emerald-400 text-xs">Ara</span>
                    </button>
                </div>
            </div>
            <div class="mt-6 border-t border-gray-800/60" id="ci-rows">
                ${rowHtml('starred', 'fa-star', 'text-amber-400', 'Yıldızlı mesajlar', '')}
                ${rowHtml('mute', 'fa-bell-slash', 'text-amber-400', 'Sohbeti sessize al', '')}
                ${rowHtml('theme', 'fa-palette', 'text-pink-400', 'Sohbet teması', '')}
                ${rowHtml('disappear', 'fa-hourglass-half', 'text-sky-300', 'Süreli mesajlar', 'Yeni mesajlar için')}
                ${rowHtml('copy', 'fa-copy', 'text-gray-300', 'Numarayı kopyala', '')}
                ${rowHtml('dial', 'fa-mobile-screen', 'text-gray-300', 'Telefonla ara', '')}
                ${rowHtml('wipe', 'fa-trash-can', 'text-rose-400', 'Sohbeti temizle', '')}
                ${rowHtml('block', 'fa-ban', 'text-rose-400', 'Engelle', '')}
            </div>
            <div style="height:45vh;"></div>
        </div>
    `;
    document.body.appendChild(el);

    el.querySelector('#ci-back').addEventListener('click', closeInfo);

    // Kaydırınca üst bar katılaşır, ok yanında avatar + isim görünür
    const scroller = el.querySelector('#ci-scroll');
    const bar = el.querySelector('#ci-bar');
    const who = el.querySelector('#ci-bar-who');
    const spacer = el.querySelector('#ci-bar-spacer');
    const head = el.querySelector('#ci-head');
    scroller.addEventListener('scroll', () => {
        const st = scroller.scrollTop;
        const t = Math.max(0, Math.min(1, (st - 150) / 90));
        bar.style.background = 'rgba(32,44,51,' + t + ')';
        who.style.opacity = String(t);
        spacer.style.display = t > 0.05 ? 'none' : '';
        head.style.opacity = String(1 - Math.min(1, st / 320));
    }, { passive: true });

    el.querySelector('#ci-avatar-btn').addEventListener('click', openPhotoViewer);

    el.querySelector('#ci-dots').addEventListener('click', (e) => {
        e.stopPropagation();
        openDotsMenu();
    });

    // Sesli / Görüntülü / Ara
    el.querySelectorAll('[data-act]').forEach((b) => {
        b.addEventListener('click', async () => {
            const act = b.dataset.act;
            const ok = await ensureChat();
            if (!ok) return;
            setTimeout(() => {
                if (act === 'search') { openChatSearch(); return; }
                const btn = document.getElementById(act === 'voice' ? 'voice-call-btn' : 'video-call-btn');
                if (btn) btn.click();
            }, 150);
        });
    });

    // Alt satırlar
    el.querySelector('#ci-rows').addEventListener('click', (e) => {
        const r = e.target.closest('[data-row]');
        if (r) onRow(r.dataset.row);
    });

    infoEl = el;
    return el;
}

async function onRow(id) {
    const me = getCurrentUser();
    const u = curUser;
    if (!me || !u) return;
    const cid = getChatId(me.uid, u.uid);

    if (id === 'starred') { openStarredPanel(); return; }

    if (id === 'theme') {
        if (!(await ensureChat())) return;
        setTimeout(() => openChatThemePicker(cid), 150);
        return;
    }

    if (id === 'mute') {
        try {
            const ref = doc(db, "users", me.uid, "chats", cid);
            const snap = await getDoc(ref);
            const muted = snap.exists() && !!snap.data().muted;
            await setDoc(ref, { muted: !muted }, { merge: true });
            showToast(!muted ? 'Sohbet sessize alındı' : 'Sohbetin sesi açıldı');
            refreshMuteLabel();
        } catch (err) {
            showToast('İşlem yapılamadı: ' + err.message, 3500);
        }
        return;
    }

    if (id === 'disappear') {
        const pick = await auraDialog({
            accent: auraAccent(),
            title: 'Süreli mesajlar (yeni mesajlar için)',
            buttons: [
                { id: 'off', label: 'Kapalı' },
                { id: 'd1', label: '24 saat' },
                { id: 'd7', label: '7 gün' },
                { id: 'cancel', label: 'İptal' }
            ]
        });
        const map = { off: 0, d1: 24 * 3600 * 1000, d7: 7 * 24 * 3600 * 1000 };
        if (!(pick.id in map)) return;
        try {
            await setDisappearAfter(cid, map[pick.id]);
            showToast(map[pick.id] ? 'Süreli mesajlar açıldı' : 'Süreli mesajlar kapatıldı');
        } catch (err) {
            showToast('Ayarlanamadı: ' + err.message, 3500);
        }
        return;
    }

    if (id === 'copy') {
        if (!u.phone) { showToast('Numara yok'); return; }
        try {
            await navigator.clipboard.writeText(u.phone);
            showToast('Numara kopyalandı');
        } catch (e) {
            showToast('Kopyalanamadı');
        }
        return;
    }

    if (id === 'dial') {
        if (!u.phone) { showToast('Numara yok'); return; }
        window.location.href = 'tel:' + String(u.phone).replace(/[^\d+]/g, '');
        return;
    }

    if (id === 'wipe') {
        const ans = await auraDialog({
            accent: auraAccent(),
            title: 'Bu sohbeti kalıcı olarak silmek üzeresiniz',
            buttons: [{ id: 'ok', label: 'Sil' }, { id: 'cancel', label: 'İptal' }]
        });
        if (ans.id !== 'ok') return;
        try {
            await wipeChat(cid);
            showToast('Sohbet temizlendi');
        } catch (err) {
            showToast('Sohbet silinemedi: ' + err.message, 3500);
        }
        return;
    }

    if (id === 'block') {
        await toggleBlockUser(u.uid);
        refreshBlockLabel();
        return;
    }
}

async function refreshMuteLabel() {
    const me = getCurrentUser();
    if (!me || !curUser || !infoEl) return;
    const lab = infoEl.querySelector('[data-row="mute"] [data-label]');
    const ico = infoEl.querySelector('[data-row="mute"] i');
    try {
        const snap = await getDoc(doc(db, "users", me.uid, "chats", getChatId(me.uid, curUser.uid)));
        const muted = snap.exists() && !!snap.data().muted;
        lab.textContent = muted ? 'Sohbetin sesini aç' : 'Sohbeti sessize al';
        ico.className = 'fa-solid ' + (muted ? 'fa-bell' : 'fa-bell-slash') + ' text-amber-400 text-lg w-6 text-center';
    } catch (e) {}
}

function refreshBlockLabel() {
    const me = getCurrentUser();
    if (!me || !curUser || !infoEl) return;
    const map = window.__aurachatUsers;
    const meRec = map && map.get(me.uid);
    const blocked = !!(meRec && Array.isArray(meRec.blockedUids) && meRec.blockedUids.includes(curUser.uid));
    const lab = infoEl.querySelector('[data-row="block"] [data-label]');
    lab.textContent = blocked ? 'Engeli kaldır' : 'Engelle';
    lab.className = 'block text-[16px] ' + (blocked ? 'text-white' : 'text-rose-400');
}

// Üç nokta menüsü
function openDotsMenu() {
    const old = document.getElementById('ci-dots-menu');
    if (old) { old.remove(); return; }
    const m = document.createElement('div');
    m.id = 'ci-dots-menu';
    m.style.cssText = 'position:fixed;inset:0;z-index:68;';
    m.innerHTML = `
        <div style="position:absolute;top:52px;right:12px;min-width:190px;background:#233138;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.6);overflow:hidden;">
            <button type="button" data-m="msg" class="w-full flex items-center space-x-3 px-4 py-3 text-sm text-gray-100 text-left active:bg-white/10"><i class="fa-solid fa-message text-emerald-400 w-4"></i><span>Mesaj gönder</span></button>
            <button type="button" data-m="copy" class="w-full flex items-center space-x-3 px-4 py-3 text-sm text-gray-100 text-left active:bg-white/10"><i class="fa-solid fa-copy text-gray-300 w-4"></i><span>Numarayı kopyala</span></button>
        </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => {
        const b = e.target.closest('[data-m]');
        m.remove();
        if (!b) return;
        if (b.dataset.m === 'msg') ensureChat();
        else onRow('copy');
    });
}

// ---------- Tam ekran profil fotoğrafı ----------
let photoEl = null;
let photoOpen = false;

function closePhotoFromBack() {
    if (photoEl) { photoEl.remove(); photoEl = null; }
    photoOpen = false;
}
function closePhoto() {
    if (!photoOpen) return;
    closePhotoFromBack();
    popBackState();
}

function openPhotoViewer() {
    const u = curUser;
    if (!u || !u.avatar || photoOpen) return;
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;z-index:70;background:#000;touch-action:none;';
    el.innerHTML = `
        <div data-top style="position:absolute;top:0;left:0;right:0;height:60px;display:flex;align-items:center;padding:0 16px;background:rgba(0,0,0,.55);z-index:2;">
            <button type="button" data-back style="color:#fff;font-size:18px;padding:4px 8px 4px 0;"><i class="fa-solid fa-arrow-left"></i></button>
            <span style="flex:1;min-width:0;color:#fff;font-size:18px;margin-left:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(u.name || '')}</span>
            <button type="button" data-dots style="color:#fff;font-size:18px;padding:4px 0 4px 12px;"><i class="fa-solid fa-ellipsis-vertical"></i></button>
        </div>
        <div data-stage style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
            <img data-img src="${u.avatar}" style="max-width:100%;max-height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none;">
        </div>`;
    document.body.appendChild(el);
    photoEl = el;
    photoOpen = true;
    pushBackState(closePhotoFromBack);

    el.querySelector('[data-back]').addEventListener('click', closePhoto);
    el.querySelector('[data-dots]').addEventListener('click', () => {
        closePhoto();
        ensureChat();
    });

    // Yukarı / aşağı çekince kapanır (ekran yüksekliğinin %10'u)
    const stage = el.querySelector('[data-stage]');
    const top = el.querySelector('[data-top]');
    let startY = 0, dy = 0, drag = false;
    el.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        drag = true; startY = e.touches[0].clientY; dy = 0;
        stage.style.transition = 'none';
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
        if (!drag) return;
        dy = e.touches[0].clientY - startY;
        stage.style.transform = 'translateY(' + dy + 'px)';
        const k = Math.max(0, 1 - Math.abs(dy) / (window.innerHeight * 0.6));
        el.style.background = 'rgba(0,0,0,' + k + ')';
        top.style.opacity = String(k);
    }, { passive: true });
    const end = () => {
        if (!drag) return;
        drag = false;
        if (Math.abs(dy) > window.innerHeight * 0.1) {
            closePhoto();
            return;
        }
        stage.style.transition = 'transform .2s';
        stage.style.transform = '';
        el.style.background = '#000';
        top.style.opacity = '1';
    };
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
}

// ---------- Dışa açılan ----------
export function openContactInfo(uid, beforeMessage) {
    const me = getCurrentUser();
    const map = window.__aurachatUsers;
    let u = map && map.get(uid);
    if (!u && me && me.uid === uid) u = me;
    if (!u) return;

    curUser = u;
    curBefore = beforeMessage;
    const el = ensureEl();

    paintAvatar(el.querySelector('#ci-avatar'), u);
    paintAvatar(el.querySelector('#ci-bar-avatar'), u);
    el.querySelector('#ci-name').textContent = u.name || '';
    el.querySelector('#ci-bar-name').textContent = u.name || '';

    const phoneEl = el.querySelector('#ci-phone');
    phoneEl.textContent = u.phone || '';
    phoneEl.style.display = u.phone ? '' : 'none';

    const aboutEl = el.querySelector('#ci-about');
    aboutEl.textContent = u.about || 'Neler oluyor?';
    aboutEl.style.color = u.about ? '' : '#6b7280';

    el.querySelector('#ci-avatar-btn').style.pointerEvents = u.avatar ? '' : 'none';

    // Kendi kartı: arama ve sohbet satırları anlamsız
    const isMe = !!(me && me.uid === uid);
    el.querySelectorAll('[data-act]').forEach((b) => { b.style.display = isMe ? 'none' : ''; });
    el.querySelector('#ci-rows').style.display = isMe ? 'none' : '';

    // Telefon yoksa numara satırları gizlenir
    ['copy', 'dial'].forEach((k) => {
        const r = el.querySelector('[data-row="' + k + '"]');
        if (r) r.style.display = u.phone ? '' : 'none';
    });

    const scroller = el.querySelector('#ci-scroll');
    scroller.scrollTop = 0;
    el.querySelector('#ci-bar').style.background = 'rgba(32,44,51,0)';
    el.querySelector('#ci-bar-who').style.opacity = '0';
    el.querySelector('#ci-bar-spacer').style.display = '';
    el.querySelector('#ci-head').style.opacity = '1';

    refreshMuteLabel();
    refreshBlockLabel();

    if (infoOpen) return;
    el.classList.remove('hidden');
    el.classList.add('flex');
    infoOpen = true;
    setSecure(true);
    pushBackState(closeFromBack);
}
