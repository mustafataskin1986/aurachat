// ==========================================
// KİŞİ BİLGİSİ SAYFASI
// - Bire bir sohbette başlığa dokununca, grup üyelerine dokununca açılır
// - Büyük avatar, isim, Hakkımda yazısı, telefon ve "Mesaj" butonu
// ==========================================

import { getCurrentUser, selectChat } from "./chat-core.js";
import { getUserColor, getInitials, escapeHtml } from "./ui-helpers.js";
import { pushBackState, popBackState } from "./back-handler.js";

let infoEl = null;
let infoOpen = false;

function closeFromBack() {
    if (infoEl) {
        infoEl.classList.add('hidden');
        infoEl.classList.remove('flex');
    }
    infoOpen = false;
}

function closeInfo() {
    if (!infoOpen) return;
    closeFromBack();
    popBackState();
}

function ensureEl() {
    if (infoEl) return infoEl;
    const el = document.createElement('div');
    el.className = 'fixed inset-0 bg-[#0b141a] hidden flex-col';
    el.style.zIndex = '65';
    el.innerHTML = `
        <div class="bg-[#202c33] px-4 py-3.5 flex items-center space-x-4 border-b border-gray-800 flex-shrink-0">
            <button type="button" id="contact-info-back" class="text-gray-400 hover:text-white transition text-lg px-1">
                <i class="fa-solid fa-arrow-left"></i>
            </button>
            <h2 class="text-white font-medium text-base">Kişi bilgisi</h2>
        </div>
        <div class="flex-1 overflow-y-auto">
            <div class="flex flex-col items-center pt-8 pb-6 px-6">
                <div id="contact-info-avatar" class="rounded-full flex items-center justify-center text-white font-bold text-5xl shadow-lg overflow-hidden" style="width:136px;height:136px;"></div>
                <h2 id="contact-info-name" class="text-white text-2xl mt-4 text-center break-words max-w-full"></h2>
                <button type="button" id="contact-info-msg" class="mt-5 px-8 py-2.5 rounded-full bg-emerald-500 text-white text-sm font-medium active:scale-95 transition">
                    <i class="fa-solid fa-message mr-2"></i>Mesaj
                </button>
            </div>
            <div class="border-t border-gray-800/60 px-5 py-4">
                <p class="text-gray-400 text-xs mb-1">Hakkında</p>
                <p id="contact-info-about" class="text-white text-[15px] break-words"></p>
            </div>
            <div id="contact-info-phone-wrap" class="border-t border-gray-800/60 px-5 py-4">
                <p class="text-gray-400 text-xs mb-1">Telefon</p>
                <p id="contact-info-phone" class="text-white text-[15px]"></p>
            </div>
        </div>
    `;
    document.body.appendChild(el);
    el.querySelector('#contact-info-back').addEventListener('click', closeInfo);
    infoEl = el;
    return el;
}

export function openContactInfo(uid, beforeMessage) {
    const me = getCurrentUser();
    const map = window.__aurachatUsers;
    let u = map && map.get(uid);
    if (!u && me && me.uid === uid) u = me;
    if (!u) return;

    const el = ensureEl();
    const avatarBox = el.querySelector('#contact-info-avatar');
    if (u.avatar) {
        avatarBox.style.background = '';
        avatarBox.innerHTML = `<img src="${u.avatar}" class="w-full h-full object-cover">`;
    } else {
        avatarBox.style.background = getUserColor(u.name || '?');
        avatarBox.textContent = getInitials(u.name || '?');
    }
    el.querySelector('#contact-info-name').textContent = u.name || '';

    const aboutEl = el.querySelector('#contact-info-about');
    aboutEl.textContent = u.about || 'Neler oluyor?';
    aboutEl.className = u.about ? 'text-white text-[15px] break-words' : 'text-gray-500 text-[15px] break-words';

    const phoneWrap = el.querySelector('#contact-info-phone-wrap');
    phoneWrap.style.display = u.phone ? '' : 'none';
    el.querySelector('#contact-info-phone').textContent = u.phone || '';

    const msgBtn = el.querySelector('#contact-info-msg');
    msgBtn.style.display = (me && me.uid === uid) ? 'none' : '';
    msgBtn.onclick = () => {
        closeInfo();
        if (typeof beforeMessage === 'function') beforeMessage();
        selectChat({ uid: u.uid, name: u.name, avatar: u.avatar || '' });
    };

    if (infoOpen) return;
    el.classList.remove('hidden');
    el.classList.add('flex');
    infoOpen = true;
    pushBackState(closeFromBack);
}
