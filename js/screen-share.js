// ==========================================
// EKRAN PAYLAŞIMI (tek yönlü, 1'e 1)
// - Paylaşan: telefonun tamamını paylaşır. Sadece Android uygulamasında (APK) çalışır,
//   ekran yakalama native tarafta (AuraScreen), kareler buraya JPEG olarak gelir,
//   canvas -> captureStream -> WebRTC ile karşıya gider.
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
        window.AuraScreen.start();
    } catch (e) {
        endSession('Ekran yakalama başlatılamadı', true);
    }
}

// Native taraf çağırır
window.__auraScreenDenied = function () {
    if (sess && sess.role === 'sharer') endSession('Ekran paylaşımı izni verilmedi', true);
};

window.__auraScreenStarted = function () {
    if (sess && sess.role === 'sharer') showBar('Ekranın paylaşılıyor');
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
            connectSharer().catch(() => endSession('Bağlantı kurulamadı', true));
        }
    };
    img.src = 'data:image/jpeg;base64,' + b64;
};

async function connectSharer() {
    const s = sess;
    if (!s) return;
    const stream = sharerCanvas.captureStream(10);
    const track = stream.getVideoTracks()[0];
    try { track.contentHint = 'detail'; } catch (e) {}

    const pc = new RTCPeerConnection(RTC_CONFIG);
    s.pc = pc;
    const sender = pc.addTrack(track, stream);
    try {
        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = 2500000;
        p.degradationPreference = 'maintain-resolution';
        await sender.setParameters(p);
    } catch (e) {}

    pc.onicecandidate = (ev) => {
        if (ev.candidate) addDoc(candCol(s.chatId, 'callerCandidates'), Object.assign({ sid: s.sid }, ev.candidate.toJSON())).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
        if (!sess || sess !== s) return;
        if (pc.connectionState === 'failed') endSession('Bağlantı koptu', true);
    };

    // Ekran duruyorsa da görüntü akması için son kare periyodik yeniden çizilir
    redrawTimer = setInterval(() => {
        if (sharerCtx && lastImg) { try { sharerCtx.drawImage(lastImg, 0, 0, sharerCanvas.width, sharerCanvas.height); } catch (e) {} }
    }, 250);

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
    await updateDoc(screenDoc(s.chatId), { status: 'offer', offer: { type: offer.type, sdp: offer.sdp } });
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

    await updateDoc(screenDoc(s.chatId), { status: 'accepted' }).catch(() => {});
    deleteDoc(doc(db, "screenInvites", me.uid)).catch(() => {});

    s.timers.push(setTimeout(() => {
        if (sess === s && !s.answered) endSession('Paylaşım başlamadı', true);
    }, 40000));
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
