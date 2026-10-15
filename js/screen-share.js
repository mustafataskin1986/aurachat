// ==========================================
// EKRAN PAYLAŞIMI (tek yönlü, 1'e 1)
// - Paylaşan: telefonun tamamını paylaşır. Sadece Android uygulamasında (APK) çalışır,
//   ekran yakalama native tarafta (AuraScreen), kareler buraya JPEG olarak gelir,
//   canvas -> captureStream -> WebRTC ile karşıya gider (YEDEK yöntem, "jpeg").
//   Asıl yöntem "h264": telefonun donanım kodlayıcısı ekranı H.264 videoya çevirir, parçalar WebRTC veri kanalından
//   gider, izleyen tarayıcı WebCodecs (VideoDecoder) ile açıp canvas'a çizer. İzleyen cihaz desteklemiyorsa "jpeg"e düşer.
// - İzleyen: uygulamada ya da tarayıcıda izleyebilir.
// - Sinyalleşme: chats/{chatId}/call/screen (arama belgesi 'current' ile karışmaz),
//   davet: screenInvites/{izleyenUid}
// Dışarıya açılan işlevler: openScreenSharePicker(), startScreenShareTo(uid, name)
// ==========================================

import { db } from "./firebase-init.js";
import {
    doc, collection, setDoc, updateDoc, deleteDoc, onSnapshot, addDoc, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getCurrentUser, sendPushToUser, showToast } from "./chat-core.js";
import { getUserColor, getInitials, escapeHtml, getChatId } from "./ui-helpers.js";
import { pushBackState, popBackState } from "./back-handler.js";

const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

const INVITE_WAIT_MS = 45000;   // karşı taraf kabul etmezse davet düşer
const INVITE_FRESH_MS = 60000;  // bundan eski davetler gösterilmez

// ---------- oturum durumu ----------
let sess = null; // { sid, role:'sharer'|'viewer', chatId, otherUid, otherName, pc, unsubDoc, unsubCand, timers:[], ... }
let pendingInvite = null;

function screenDoc(chatId) { return doc(db, "chats", chatId, "call", "screen"); }
function candCol(chatId, who) { return collection(db, "chats", chatId, "call", "screen", who); }

function avatarHtml(name, avatar, size) {
    if (avatar) return `<img src="${avatar}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;">`;
    return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${getUserColor(name || '?')};color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center;font-size:${Math.round(size / 2.6)}px;">${escapeHtml(getInitials(name || '?'))}</div>`;
}

// ==========================================
// KİŞİ SEÇME PANELİ
// ==========================================
let pickerEl = null;
let pickerOpen = false;

function ensurePicker() {
    if (pickerEl) return pickerEl;
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;z-index:60;background:#0b141a;display:none;flex-direction:column;';
    el.innerHTML = `
        <div style="background:#202c33;padding:14px 16px;display:flex;align-items:center;gap:14px;border-bottom:1px solid #1f2933;flex-shrink:0;">
            <button type="button" id="ss-pick-back" style="color:#9ca3af;font-size:18px;padding:0 4px;"><i class="fa-solid fa-arrow-left"></i></button>
            <h2 style="color:#fff;font-size:16px;font-weight:500;">Ekran paylaş</h2>
        </div>
        <div style="padding:12px;flex-shrink:0;">
            <input id="ss-pick-search" type="text" placeholder="Kişi ara" autocomplete="off" style="width:100%;background:#202c33;color:#fff;font-size:14px;padding:12px 16px;border-radius:12px;border:1px solid transparent;outline:none;">
        </div>
        <div id="ss-pick-list" style="flex:1;overflow-y:auto;scrollbar-width:none;"></div>
    `;
    document.body.appendChild(el);
    el.querySelector('#ss-pick-back').addEventListener('click', () => closePicker(true));
    el.querySelector('#ss-pick-search').addEventListener('input', renderPickerList);
    pickerEl = el;
    return el;
}

function renderPickerList() {
    const me = getCurrentUser();
    const listEl = pickerEl.querySelector('#ss-pick-list');
    const q = (pickerEl.querySelector('#ss-pick-search').value || '').trim().toLocaleLowerCase('tr');
    listEl.innerHTML = '';
    const usersMap = window.__aurachatUsers;
    let users = usersMap ? Array.from(usersMap.values()).filter((u) => me && u.uid !== me.uid) : [];
    if (q) users = users.filter((u) => (u.name || '').toLocaleLowerCase('tr').includes(q));
    users.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'tr'));
    if (!users.length) {
        listEl.innerHTML = '<p style="text-align:center;color:#6b7280;font-size:12px;padding:32px 0;">Kişi bulunamadı.</p>';
        return;
    }
    users.forEach((u) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid rgba(31,41,51,.4);cursor:pointer;';
        row.innerHTML = `${avatarHtml(u.name, u.avatar, 44)}<div style="margin-left:12px;min-width:0;flex:1;"><span style="display:block;color:#fff;font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(u.name || '')}</span>${u.about ? `<span style="display:block;color:#9ca3af;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(u.about)}</span>` : ''}</div><i class="fa-solid fa-display" style="color:#10b981;"></i>`;
        row.addEventListener('click', () => {
            closePicker(true);
            startScreenShareTo(u.uid, u.name, u.avatar);
        });
        listEl.appendChild(row);
    });
}

function closePicker(fromUi) {
    if (!pickerEl || !pickerOpen) return;
    pickerOpen = false;
    pickerEl.style.display = 'none';
    if (fromUi) popBackState();
}

export function openScreenSharePicker() {
    const me = getCurrentUser();
    if (!me || !me.uid) return;
    if (!(window.AuraScreen && window.AuraScreen.isSupported && window.AuraScreen.isSupported())) {
        showToast('Ekran paylaşmak için Android uygulamasını (APK) kullan. İzlemek her yerde çalışır.', 3600);
        return;
    }
    if (sess) { showToast('Zaten bir ekran paylaşımı var'); return; }
    const el = ensurePicker();
    el.querySelector('#ss-pick-search').value = '';
    renderPickerList();
    el.style.display = 'flex';
    pickerOpen = true;
    pushBackState(() => closePicker(false));
}

// ==========================================
// PAYLAŞAN TARAF
// ==========================================
let barEl = null;      // paylaşırken uygulamada görünen küçük şerit
let waitEl = null;     // "Bekleniyor..." penceresi
let sharerCanvas = null;
let sharerCtx = null;
let lastImg = null;
let redrawTimer = null;

function showBar(text) {
    if (!barEl) {
        barEl = document.createElement('div');
        barEl.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top,0px) + 8px);left:50%;transform:translateX(-50%);z-index:100001;background:#dc2626;color:#fff;border-radius:9999px;padding:8px 8px 8px 16px;display:flex;align-items:center;gap:12px;font-size:13px;font-weight:600;box-shadow:0 6px 20px rgba(0,0,0,.5);max-width:92vw;';
        barEl.innerHTML = '<span id="ss-bar-text" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span><button type="button" id="ss-bar-stop" style="background:#fff;color:#dc2626;border-radius:9999px;padding:6px 14px;font-weight:700;font-size:13px;">Durdur</button>';
        document.body.appendChild(barEl);
        barEl.querySelector('#ss-bar-stop').addEventListener('click', () => endSession('Ekran paylaşımı durduruldu', true));
    }
    barEl.querySelector('#ss-bar-text').textContent = text;
    barEl.style.display = 'flex';
}

function hideBar() { if (barEl) barEl.style.display = 'none'; }

export async function startScreenShareTo(otherUid, otherName, otherAvatar) {
    const me = getCurrentUser();
    if (!me || !me.uid || !otherUid) return;
    if (!(window.AuraScreen && window.AuraScreen.isSupported && window.AuraScreen.isSupported())) {
        showToast('Ekran paylaşmak için Android uygulamasını (APK) kullan');
        return;
    }
    if (sess) { showToast('Zaten bir ekran paylaşımı var'); return; }

    const chatId = getChatId(me.uid, otherUid);
    const sid = String(Date.now()) + Math.random().toString(36).slice(2, 7);
    sess = { sid, role: 'sharer', chatId, otherUid, otherName: otherName || '', pc: null, unsubDoc: null, unsubCand: null, timers: [], capturing: false, ended: false };

    try {
        await setDoc(screenDoc(chatId), {
            sid: sid,
            status: 'ringing',
            sharerUid: me.uid,
            sharerName: me.name || '',
            viewerUid: otherUid,
            createdAt: serverTimestamp()
        });
        await setDoc(doc(db, "screenInvites", otherUid), {
            sid: sid,
            chatId: chatId,
            fromUid: me.uid,
            fromName: me.name || '',
            fromAvatar: me.avatar || '',
            at: Date.now()
        });
    } catch (e) {
        sess = null;
        showToast('Davet gönderilemedi (engelli olabilir)', 3000);
        return;
    }

    sendPushToUser(otherUid, `${me.name || ''}`, '🖥️ Ekranını paylaşmak istiyor', {
        chatId: chatId, otherUid: me.uid, otherName: me.name || '', tag: `screen_${chatId}`
    });

    showWait(otherName || 'Kişi');
    pushBackState(() => endSession('Ekran paylaşımı iptal edildi', true));

    // Kabul edilmezse düşsün
    sess.timers.push(setTimeout(() => {
        if (sess && sess.sid === sid && !sess.capturing) endSession('Karşı taraf yanıt vermedi', true);
    }, INVITE_WAIT_MS));

    sess.unsubDoc = onSnapshot(screenDoc(chatId), (snap) => {
        if (!sess || sess.sid !== sid || !snap.exists()) return;
        const d = snap.data();
        if (d.sid !== sid) return;
        if (d.status === 'declined') { endSession('Ekran paylaşımı reddedildi', false); return; }
        if (d.status === 'ended') { endSession('Ekran paylaşımı sona erdi', false); return; }
        if (d.status === 'accepted' && !sess.capturing) {
            sess.capturing = true;
            // İzleyen H.264 çözebiliyor ve bu telefonda kodlayıcı varsa H.264, yoksa eski JPEG yöntemi
            const A = window.AuraScreen;
            sess.mode = (d.h264 === true && A && typeof A.supportsH264 === 'function' && typeof A.startWithMode === 'function' && A.supportsH264()) ? 'h264' : 'jpeg';
            hideWait();
            beginCapture();
        }
        if (d.status === 'active' && d.answer && sess.pc && !sess.pc.currentRemoteDescription) {
            sess.pc.setRemoteDescription(new RTCSessionDescription(d.answer)).catch(() => {});
        }
    });
}

function showWait(name) {
    hideWait();
    waitEl = document.createElement('div');
    waitEl.style.cssText = 'position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;';
    waitEl.innerHTML = `<div style="background:#202c33;color:#fff;border-radius:20px;padding:24px;width:min(86vw,320px);text-align:center;"><i class="fa-solid fa-display" style="font-size:30px;color:#10b981;"></i><p style="margin:14px 0 4px;font-weight:600;">${escapeHtml(name)} bekleniyor...</p><p style="font-size:12px;color:#9ca3af;">Kabul edince telefon ekran paylaşım iznini soracak.</p><button type="button" id="ss-wait-cancel" style="margin-top:18px;background:#374151;color:#fff;border-radius:9999px;padding:10px 22px;font-weight:600;">Vazgeç</button></div>`;
    document.body.appendChild(waitEl);
    waitEl.querySelector('#ss-wait-cancel').addEventListener('click', () => endSession('Ekran paylaşımı iptal edildi', true));
}

function hideWait() { if (waitEl) { waitEl.remove(); waitEl = null; } }

// Karşı taraf kabul etti: Android'in ekran yakalama iznini iste
function beginCapture() {
    if (!sess) return;
    try {
        if (sess.mode === 'h264') window.AuraScreen.startWithMode(true);
        else window.AuraScreen.start();
    } catch (e) {
        endSession('Ekran yakalama başlatılamadı', true);
    }
}

// Native taraf çağırır
window.__auraScreenDenied = function () {
    if (sess && sess.role === 'sharer') endSession('Ekran paylaşımı izni verilmedi', true);
};

window.__auraScreenStarted = function () {
    if (sess && sess.role === 'sharer') {
        showBar('Ekranın paylaşılıyor');
        // H.264'te video hemen akar: bağlantıyı şimdi kur (JPEG'de ilk kare gelince kurulur)
        if (sess.mode === 'h264' && !sess.pc && !sess.connecting) {
            sess.connecting = true;
            connectSharer('h264').catch(() => endSession('Bağlantı kurulamadı', true));
        }
    }
};

window.__auraScreenStopped = function () {
    if (sess && sess.role === 'sharer') endSession('Ekran paylaşımı durdu', true);
};

window.__auraScreenFrame = function (b64) {
    if (!sess || sess.role !== 'sharer' || sess.ended) return;
    const img = new Image();
    img.onload = () => {
        if (!sess || sess.role !== 'sharer' || sess.ended) return;
        lastImg = img;
        if (!sharerCanvas) {
            sharerCanvas = document.createElement('canvas');
            sharerCanvas.width = img.naturalWidth;
            sharerCanvas.height = img.naturalHeight;
            sharerCtx = sharerCanvas.getContext('2d');
        }
        sharerCtx.drawImage(img, 0, 0, sharerCanvas.width, sharerCanvas.height);
        if (!sess.pc && !sess.connecting) {
            sess.connecting = true;
            connectSharer('jpeg').catch(() => endSession('Bağlantı kurulamadı', true));
        }
    };
    img.src = 'data:image/jpeg;base64,' + b64;
};

// ---- H.264 yardımcıları ----
function b64ToBytes(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
}

// Başta SPS (NAL tipi 7) var mı?
function hasSps(u8) {
    const n = Math.min(u8.length - 5, 48);
    for (let i = 0; i < n; i++) {
        if (u8[i] === 0 && u8[i + 1] === 0) {
            if (u8[i + 2] === 1 && (u8[i + 3] & 31) === 7) return true;
            if (u8[i + 2] === 0 && u8[i + 3] === 1 && (u8[i + 4] & 31) === 7) return true;
        }
    }
    return false;
}

// SPS'ten WebCodecs codec dizesi: avc1.PPCCLL
function codecFromSps(u8) {
    const hex = (v) => ('0' + (v & 255).toString(16)).slice(-2);
    for (let i = 0; i < u8.length - 8; i++) {
        let k = -1;
        if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 1 && (u8[i + 3] & 31) === 7) k = i + 4;
        else if (u8[i] === 0 && u8[i + 1] === 0 && u8[i + 2] === 0 && u8[i + 3] === 1 && (u8[i + 4] & 31) === 7) k = i + 5;
        if (k > 0) return 'avc1.' + hex(u8[k]) + hex(u8[k + 1]) + hex(u8[k + 2]);
    }
    return 'avc1.42E01F';
}

function askKeyFrame() {
    try { if (window.AuraScreen && window.AuraScreen.requestKeyFrame) window.AuraScreen.requestKeyFrame(); } catch (e) {}
}

function sendMeta() {
    const s = sess;
    if (!s || s.role !== 'sharer' || !s.dc || s.dc.readyState !== 'open' || !s.codec || !s.w || !s.h) return;
    try {
        s.dc.send(JSON.stringify({ t: 'meta', codec: s.codec, w: s.w, h: s.h }));
        s.metaSent = true;
        s.waitKey = true;
        askKeyFrame();
    } catch (e) {}
}

// Native taraf: H.264 ayar paketi (SPS/PPS)
window.__auraScreenCfg = function (b64, w, h) {
    const s = sess;
    if (!s || s.role !== 'sharer' || s.ended) return;
    try { s.cfg = b64ToBytes(b64); s.codec = codecFromSps(s.cfg); s.w = w; s.h = h; } catch (e) { return; }
    sendMeta();
};

// Native taraf: yakalama boyutu (bazı cihazlar SPS/PPS'i ayrı pakette vermez, boyut yine de bilinsin)
window.__auraScreenSize = function (w, h) {
    const s = sess;
    if (!s || s.role !== 'sharer') return;
    s.w = w; s.h = h;
    sendMeta();
};

// Native taraf: H.264 kare. Paket: [tip(1: delta, 2: anahtar)][süre ms (4 bayt)][veri]
window.__auraScreenH264 = function (b64, key, pts) {
    const s = sess;
    if (!s || s.role !== 'sharer' || s.ended || s.mode !== 'h264') return;
    // Ayrı SPS/PPS paketi gelmediyse codec bilgisini anahtar karenin içinden al
    if (!s.codec && key) {
        try { const u0 = b64ToBytes(b64); if (hasSps(u0)) { s.codec = codecFromSps(u0); sendMeta(); } } catch (e) {}
    }
    const dc = s.dc;
    if (!dc || dc.readyState !== 'open' || !s.metaSent) return;
    // Hat tıkandıysa her şeyi atla, yeni anahtar kare bekle (gecikme birikmesin)
    if (dc.bufferedAmount > 600000) {
        if (!s.waitKey) s.waitKey = true;
        const now = Date.now();
        if (!s.lastKeyReq || now - s.lastKeyReq > 1000) { s.lastKeyReq = now; askKeyFrame(); }
        return;
    }
    if (s.waitKey && !key) return;
    let u;
    try { u = b64ToBytes(b64); } catch (e) { return; }
    if (key) {
        s.waitKey = false;
        // Anahtar karede SPS/PPS yoksa başına ekle (izleyen çözücü her anahtar karede başlayabilsin)
        if (s.cfg && !hasSps(u)) {
            const m = new Uint8Array(s.cfg.length + u.length);
            m.set(s.cfg, 0);
            m.set(u, s.cfg.length);
            u = m;
        }
    }
    if (u.length > 250000) { s.waitKey = true; askKeyFrame(); return; }
    const out = new Uint8Array(u.length + 5);
    out[0] = key ? 2 : 1;
    new DataView(out.buffer).setUint32(1, pts >>> 0);
    out.set(u, 5);
    try { dc.send(out); } catch (e) {}
};

// Native taraf: iç ses parçası (24 kHz mono 16 bit PCM). Paket: [3][süre(4 bayt, kullanılmaz)][PCM]
window.__auraScreenAudio = function (b64) {
    const s = sess;
    if (!s || s.role !== 'sharer' || s.ended || s.mode !== 'h264') return;
    const dc = s.dc;
    if (!dc || dc.readyState !== 'open' || dc.bufferedAmount > 400000) return;
    let u;
    try { u = b64ToBytes(b64); } catch (e) { return; }
    const out = new Uint8Array(u.length + 5);
    out[0] = 3;
    out.set(u, 5);
    try { dc.send(out); } catch (e) {}
};

async function connectSharer(mode) {
    const s = sess;
    if (!s) return;
    const h264 = mode === 'h264';
    const pc = new RTCPeerConnection(RTC_CONFIG);
    s.pc = pc;

    if (h264) {
        const dc = pc.createDataChannel('screen', { ordered: true });
        dc.binaryType = 'arraybuffer';
        s.dc = dc;
        dc.onopen = () => sendMeta();
        dc.onmessage = (ev) => {
            if (typeof ev.data !== 'string') return;
            try { if (JSON.parse(ev.data).t === 'kf') { s.waitKey = true; askKeyFrame(); } } catch (e) {}
        };
    } else {
        const stream = sharerCanvas.captureStream(10);
        const track = stream.getVideoTracks()[0];
        try { track.contentHint = 'detail'; } catch (e) {}
        const sender = pc.addTrack(track, stream);
        try {
            const p = sender.getParameters();
            if (!p.encodings || !p.encodings.length) p.encodings = [{}];
            p.encodings[0].maxBitrate = 2500000;
            p.degradationPreference = 'maintain-resolution';
            await sender.setParameters(p);
        } catch (e) {}
        // Ekran duruyorsa da görüntü akması için son kare periyodik yeniden çizilir
        redrawTimer = setInterval(() => {
            if (sharerCtx && lastImg) { try { sharerCtx.drawImage(lastImg, 0, 0, sharerCanvas.width, sharerCanvas.height); } catch (e) {} }
        }, 250);
    }

    pc.onicecandidate = (ev) => {
        if (ev.candidate) addDoc(candCol(s.chatId, 'callerCandidates'), Object.assign({ sid: s.sid }, ev.candidate.toJSON())).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
        if (!sess || sess !== s) return;
        if (pc.connectionState === 'failed') endSession('Bağlantı koptu', true);
    };

    s.unsubCand = onSnapshot(candCol(s.chatId, 'calleeCandidates'), (snap) => {
        snap.docChanges().forEach((ch) => {
            const d = ch.doc.data();
            if (ch.type === 'added' && sess === s && s.pc && d.sid === s.sid) {
                const c = Object.assign({}, d); delete c.sid;
                s.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
            }
        });
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await updateDoc(screenDoc(s.chatId), { status: 'offer', mode: h264 ? 'h264' : 'jpeg', offer: { type: offer.type, sdp: offer.sdp } });
}

// ==========================================
// İZLEYEN TARAF
// ==========================================
let inviteEl = null;
let viewerEl = null;

function showInvite(inv) {
    hideInvite();
    pendingInvite = inv;
    inviteEl = document.createElement('div');
    inviteEl.style.cssText = 'position:fixed;inset:0;z-index:100003;background:rgba(0,0,0,.78);display:flex;align-items:center;justify-content:center;';
    inviteEl.innerHTML = `<div style="background:#202c33;color:#fff;border-radius:24px;padding:26px 22px;width:min(88vw,340px);text-align:center;display:flex;flex-direction:column;align-items:center;gap:6px;">
        ${avatarHtml(inv.fromName, inv.fromAvatar, 72)}
        <p style="margin-top:10px;font-weight:600;font-size:17px;">${escapeHtml(inv.fromName || 'Biri')}</p>
        <p style="font-size:13px;color:#9ca3af;">ekranını seninle paylaşmak istiyor</p>
        <div style="display:flex;gap:12px;margin-top:20px;width:100%;">
            <button type="button" id="ss-inv-no" style="flex:1;background:#374151;color:#fff;border-radius:9999px;padding:12px;font-weight:600;">Reddet</button>
            <button type="button" id="ss-inv-yes" style="flex:1;background:#10b981;color:#fff;border-radius:9999px;padding:12px;font-weight:700;">İzle</button>
        </div></div>`;
    document.body.appendChild(inviteEl);
    inviteEl.querySelector('#ss-inv-no').addEventListener('click', () => declineInvite());
    inviteEl.querySelector('#ss-inv-yes').addEventListener('click', () => acceptInvite());
    if (navigator.vibrate) { try { navigator.vibrate([200, 100, 200]); } catch (e) {} }
}

function hideInvite() { if (inviteEl) { inviteEl.remove(); inviteEl = null; } }

async function declineInvite() {
    const inv = pendingInvite;
    pendingInvite = null;
    hideInvite();
    if (!inv) return;
    const me = getCurrentUser();
    await updateDoc(screenDoc(inv.chatId), { status: 'declined' }).catch(() => {});
    if (me) deleteDoc(doc(db, "screenInvites", me.uid)).catch(() => {});
}

async function acceptInvite() {
    const inv = pendingInvite;
    pendingInvite = null;
    hideInvite();
    const me = getCurrentUser();
    if (!inv || !me) return;
    if (sess) { showToast('Zaten bir ekran paylaşımı var'); return; }

    // Davet hâlâ geçerli mi?
    let d = null;
    try { const s = await getDoc(screenDoc(inv.chatId)); d = s.exists() ? s.data() : null; } catch (e) {}
    if (!d || d.sid !== inv.sid || d.status !== 'ringing') {
        showToast('Paylaşım sona ermiş');
        deleteDoc(doc(db, "screenInvites", me.uid)).catch(() => {});
        return;
    }

    sess = { sid: inv.sid, role: 'viewer', chatId: inv.chatId, otherUid: inv.fromUid, otherName: inv.fromName || '', pc: null, unsubDoc: null, unsubCand: null, timers: [], ended: false };
    const s = sess;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    s.pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.ondatachannel = (ev) => viewerAttachChannel(s, ev.channel);
    pc.ontrack = (ev) => {
        const v = viewerEl && viewerEl.querySelector('video');
        if (v) {
            v.srcObject = ev.streams && ev.streams[0] ? ev.streams[0] : new MediaStream([ev.track]);
            v.play().catch(() => {});
        }
        const st = viewerEl && viewerEl.querySelector('#ss-view-status');
        if (st) st.style.display = 'none';
    };
    pc.onicecandidate = (ev) => {
        if (ev.candidate) addDoc(candCol(s.chatId, 'calleeCandidates'), Object.assign({ sid: s.sid }, ev.candidate.toJSON())).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
        if (sess === s && pc.connectionState === 'failed') endSession('Bağlantı koptu', true);
    };

    showViewer(inv.fromName || 'Ekran paylaşımı');
    pushBackState(() => endSession('Ekran izleme kapatıldı', true));
    // Ses çalma izni için "İzle" dokunuşu sırasında bağlam oluşturulur; ekrana dokununca da yeniden başlatılır
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
            try { s.actx = new AC({ sampleRate: 24000 }); } catch (e) { s.actx = new AC(); }
            s.nextT = 0;
            s.actx.resume().catch(() => {});
            viewerEl.addEventListener('click', () => { try { if (s.actx && s.actx.state === 'suspended') s.actx.resume(); } catch (e) {} });
        }
    } catch (e) {}

    s.unsubCand = onSnapshot(candCol(s.chatId, 'callerCandidates'), (snap) => {
        snap.docChanges().forEach((ch) => {
            const c0 = ch.doc.data();
            if (ch.type === 'added' && sess === s && s.pc && c0.sid === s.sid) {
                const c = Object.assign({}, c0); delete c.sid;
                s.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
            }
        });
    });

    s.unsubDoc = onSnapshot(screenDoc(s.chatId), async (snap) => {
        if (sess !== s || !snap.exists()) return;
        const dd = snap.data();
        if (dd.sid !== s.sid) return;
        if (dd.status === 'ended' || dd.status === 'declined') { endSession('Ekran paylaşımı sona erdi', false); return; }
        if (dd.status === 'offer' && dd.offer && !s.answered) {
            s.answered = true;
            try {
                await s.pc.setRemoteDescription(new RTCSessionDescription(dd.offer));
                const answer = await s.pc.createAnswer();
                await s.pc.setLocalDescription(answer);
                await updateDoc(screenDoc(s.chatId), { status: 'active', answer: { type: answer.type, sdp: answer.sdp } });
            } catch (e) { endSession('Bağlantı kurulamadı', true); }
        }
    });

    // Bu cihaz H.264 çözebiliyor mu? (WebCodecs) Paylaşan buna göre yöntem seçer
    let h264ok = false;
    try {
        if (window.VideoDecoder && window.EncodedVideoChunk && VideoDecoder.isConfigSupported) {
            const r = await VideoDecoder.isConfigSupported({ codec: 'avc1.42E01F', optimizeForLatency: true, avc: { format: 'annexb' } });
            h264ok = !!(r && r.supported);
        }
    } catch (e) {}
    await updateDoc(screenDoc(s.chatId), { status: 'accepted', h264: h264ok }).catch(() => {});
    deleteDoc(doc(db, "screenInvites", me.uid)).catch(() => {});

    s.timers.push(setTimeout(() => {
        if (sess === s && !s.answered) endSession('Paylaşım başlamadı', true);
    }, 40000));
}

// İzleyen: gelen iç ses parçalarını kısa bir tamponla sırayla çal (24 kHz mono PCM)
function playAudioChunk(s, u8) {
    try {
        if (!s.actx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            try { s.actx = new AC({ sampleRate: 24000 }); } catch (e) { s.actx = new AC(); }
            s.nextT = 0;
        }
        const ctx = s.actx;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const n = u8.length >> 1;
        if (n < 10) return;
        const buf = ctx.createBuffer(1, n, 24000);
        const ch = buf.getChannelData(0);
        const dv = new DataView(u8.buffer, u8.byteOffset, n * 2);
        for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
        const now = ctx.currentTime;
        // Geride kaldıysak (sessizlik / takılma) 120 ms'lik tamponla yeniden başla; çok öne geçtiyse (gecikme birikti) parçayı at
        if (!s.nextT || s.nextT < now + 0.02) s.nextT = now + 0.12;
        else if (s.nextT - now > 0.7) return;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(s.nextT);
        s.nextT += buf.duration;
    } catch (e) {}
}

// H.264 veri kanalı: paketleri WebCodecs ile çöz, canvas'a çiz (her zaman en yeni kare gösterilir)
function viewerAttachChannel(s, ch) {
    ch.binaryType = 'arraybuffer';
    let pending = null;
    let raf = 0;
    const requestKey = () => { try { if (ch.readyState === 'open') ch.send(JSON.stringify({ t: 'kf' })); } catch (e) {} };

    function paint(canvas, ctx) {
        raf = 0;
        if (!pending) return;
        try { ctx.drawImage(pending, 0, 0, canvas.width, canvas.height); } catch (e) {}
        try { pending.close(); } catch (e) {}
        pending = null;
    }

    function makeDecoder(meta) {
        if (!viewerEl || sess !== s) return;
        const canvas = viewerEl.querySelector('#ss-view-canvas');
        const video = viewerEl.querySelector('video');
        if (!canvas) return;
        canvas.width = meta.w;
        canvas.height = meta.h;
        const ctx = canvas.getContext('2d');
        if (video) video.style.display = 'none';
        canvas.style.display = 'block';
        if (s.dec) { try { s.dec.close(); } catch (e) {} }
        const dec = new VideoDecoder({
            output: (frame) => {
                if (pending) { try { pending.close(); } catch (e) {} }
                pending = frame;
                const st = viewerEl && viewerEl.querySelector('#ss-view-status');
                if (st) st.style.display = 'none';
                if (!raf) raf = requestAnimationFrame(() => paint(canvas, ctx));
            },
            error: () => { s.gotKey = false; requestKey(); }
        });
        dec.configure({ codec: meta.codec, codedWidth: meta.w, codedHeight: meta.h, optimizeForLatency: true, avc: { format: 'annexb' } });
        s.dec = dec;
        s.gotKey = false;
    }

    ch.onmessage = (ev) => {
        if (sess !== s) return;
        if (typeof ev.data === 'string') {
            try { const m = JSON.parse(ev.data); if (m && m.t === 'meta') makeDecoder(m); } catch (e) {}
            return;
        }
        const u = new Uint8Array(ev.data);
        if (u.length < 6) return;
        if (u[0] === 3) { playAudioChunk(s, u.subarray(5)); return; }
        const dec = s.dec;
        if (!dec || dec.state === 'closed') return;
        const key = u[0] === 2;
        if (!s.gotKey) { if (!key) return; s.gotKey = true; }
        // Çözücü geride kaldıysa: delta kareleri atla, yeni anahtar kare iste
        if (dec.decodeQueueSize > 8 && !key) { s.gotKey = false; requestKey(); return; }
        const ts = new DataView(ev.data).getUint32(1) * 1000;
        try {
            dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data: u.subarray(5) }));
        } catch (e) { s.gotKey = false; requestKey(); }
    };
}

function showViewer(title) {
    hideViewer();
    viewerEl = document.createElement('div');
    viewerEl.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#000;display:flex;flex-direction:column;';
    viewerEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:calc(env(safe-area-inset-top,0px) + 10px) 12px 10px 12px;background:rgba(11,20,26,.92);flex-shrink:0;">
            <button type="button" id="ss-view-close" style="width:40px;height:40px;border-radius:50%;color:#fff;font-size:18px;"><i class="fa-solid fa-xmark"></i></button>
            <div style="min-width:0;flex:1;"><div style="color:#fff;font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(title)}</div><div style="color:#9ca3af;font-size:12px;">Ekran paylaşımı</div></div>
        </div>
        <div style="position:relative;flex:1;min-height:0;">
            <video autoplay playsinline muted style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;"></video>
            <canvas id="ss-view-canvas" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;display:none;"></canvas>
            <div id="ss-view-status" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:14px;">Bağlanıyor...</div>
        </div>`;
    document.body.appendChild(viewerEl);
    viewerEl.querySelector('#ss-view-close').addEventListener('click', () => endSession('Ekran izleme kapatıldı', true));
}

function hideViewer() {
    if (!viewerEl) return;
    const v = viewerEl.querySelector('video');
    if (v) { try { v.srcObject = null; } catch (e) {} }
    viewerEl.remove();
    viewerEl = null;
}

// ==========================================
// DAVET İZLEYİCİSİ (uygulama açıkken her ekranda)
// ==========================================
let watchUid = null;
let unsubInvite = null;

function watchInvites() {
    const me = getCurrentUser();
    const uid = me && me.uid ? me.uid : null;
    if (uid === watchUid) return;
    if (unsubInvite) { unsubInvite(); unsubInvite = null; }
    watchUid = uid;
    if (!uid) return;
    unsubInvite = onSnapshot(doc(db, "screenInvites", uid), (snap) => {
        if (!snap.exists()) { if (pendingInvite) { hideInvite(); pendingInvite = null; } return; }
        const d = snap.data();
        if (!d || !d.chatId || !d.at || !d.sid) return;
        if (Math.abs(Date.now() - d.at) > INVITE_FRESH_MS) return;
        if (sess) return;
        if (pendingInvite && pendingInvite.sid === d.sid) return;
        showInvite(d);
    }, () => {});
}

setInterval(watchInvites, 1500);

// ==========================================
// OTURUMU KAPAT
// ==========================================
function endSession(message, notifyRemote) {
    const s = sess;
    if (!s || s.ended) return;
    s.ended = true;
    sess = null;

    s.timers.forEach((t) => clearTimeout(t));
    if (redrawTimer) { clearInterval(redrawTimer); redrawTimer = null; }
    if (s.unsubDoc) { try { s.unsubDoc(); } catch (e) {} }
    if (s.unsubCand) { try { s.unsubCand(); } catch (e) {} }
    if (s.dec) { try { s.dec.close(); } catch (e) {} s.dec = null; }
    if (s.actx) { try { s.actx.close(); } catch (e) {} s.actx = null; }
    if (s.dc) { try { s.dc.close(); } catch (e) {} }
    if (s.pc) { try { s.pc.close(); } catch (e) {} }

    if (s.role === 'sharer') {
        try { if (window.AuraScreen && window.AuraScreen.stop) window.AuraScreen.stop(); } catch (e) {}
        sharerCanvas = null; sharerCtx = null; lastImg = null;
        hideBar();
        hideWait();
        if (notifyRemote) {
            updateDoc(screenDoc(s.chatId), { status: 'ended' }).catch(() => {});
            deleteDoc(doc(db, "screenInvites", s.otherUid)).catch(() => {});
        }
    } else {
        hideViewer();
        if (notifyRemote) updateDoc(screenDoc(s.chatId), { status: 'ended' }).catch(() => {});
    }
    popBackState();
    if (message) showToast(message, 2600);
}

window.openScreenSharePicker = openScreenSharePicker;
window.startScreenShareTo = startScreenShareTo;
