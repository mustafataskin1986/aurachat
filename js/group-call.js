// ==========================================
// GRUP SESLİ / GÖRÜNTÜLÜ ARAMA (WebRTC mesh + Firestore sinyalleşme)
//
// Sunucu (SFU) olmadığı için "mesh" yöntemi: arama açıkken herkes
// diğer herkesle birebir bağlantı kurar. Bu yüzden kişi sayısı
// sınırlı: sesli en fazla 6, görüntülü en fazla 4 kişi.
// STUN: Google'ın ücretsiz sunucusu. TURN yok - bazı ağlarda
// (simetrik NAT) iki kişi arasında bağlantı kurulamayabilir.
//
// Firestore yapısı:
//   chats/{groupId}/gcall/current            -> arama dokümanı
//     { callId, callType, status: 'active' | 'ended', participants: [uid],
//       startedBy, startedByName, groupName, startedAtMs, connectedAtMs,
//       everJoined, lastPingMs, endedAtMs }
//   chats/{groupId}/gcall/current/signals/*  -> { callId, from, to, kind, payload }
//
// Kural: iki kişi arasında offer'ı uid'si BÜYÜK olan gönderir
// (ikisi aynı anda offer gönderip çakışmasın diye).
//
// Arama açıkken sohbet ekranındaki herkese "Katıl / Reddet" ekranı
// çıkar (chat-core.js, grup sohbeti açılınca watchGroupCallForChat çağırır).
// Aramaya sonradan da katılınabilir, son kişi çıkınca arama biter ve
// sohbete süre mesajı düşer.
// ==========================================

import { db } from "./firebase-init.js";
import {
    doc, collection, setDoc, updateDoc, getDoc, addDoc, deleteDoc, onSnapshot, query, where,
    arrayUnion, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getCurrentUser, getCurrentChatId, sendPushToUser, showToast } from "./chat-core.js";
import { getUserColor, getInitials, escapeHtml } from "./ui-helpers.js";
import { pushBackState, popBackState } from "./back-handler.js";

const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

const MAX_AUDIO_PARTICIPANTS = 6;
const MAX_VIDEO_PARTICIPANTS = 4;
const PING_EVERY_MS = 20000;
const LIVE_WINDOW_MS = 70000;

// Şu an içinde olduğum arama
let activeGid = null;
let callId = null;
let callType = 'audio';
let groupName = 'Grup';
let localStream = null;
let micOn = true;
let camOn = true;
let facing = 'user';
let callStartMs = 0;
let lastParticipants = [];
let unsubCallDoc = null;
let unsubSignals = null;
let pingTimer = null;
let clockTimer = null;
const peers = new Map();      // uid -> { uid, pc, tile, inList, offered }
const pendingIce = new Map(); // uid -> [aday] (offer/answer gelmeden gelen ICE adayları)

// Sohbet ekranında izlenen grup (gelen arama için)
let unsubWatch = null;
let dismissedCallId = null;
let joinEl = null;
let joinShownFor = null;

function callRef(gid) {
    return doc(db, "chats", gid, "gcall", "current");
}

function signalsCol(gid) {
    return collection(db, "chats", gid, "gcall", "current", "signals");
}

function isGroupId(id) {
    return !!(id && window.__aurachatGroupIds && window.__aurachatGroupIds.has(id));
}

function userInfo(uid) {
    const me = getCurrentUser();
    if (me && me.uid === uid) return me;
    const m = window.__aurachatUsers;
    return (m && m.get(uid)) || { uid: uid, name: 'Kullanıcı' };
}

// Arama gerçekten açık mı? (herkes çökmüşse takılı kalan eski dokümanı yok say)
function isLive(d) {
    if (!d || d.status !== 'active') return false;
    const parts = Array.isArray(d.participants) ? d.participants : [];
    if (!parts.length) return false;
    const last = d.lastPingMs || d.startedAtMs || 0;
    return (Date.now() - last) < LIVE_WINDOW_MS;
}

function fmtDuration(totalSec) {
    const s = Math.max(0, Math.round(Number(totalSec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m === 0) return `${r} sn`;
    return r ? `${m} dk ${r} sn` : `${m} dk`;
}

function playSafe(mediaEl) {
    try {
        const p = mediaEl.play();
        if (p && p.catch) p.catch(() => {});
    } catch (e) {}
}

// ------------------------------------------
// ARAMA EKRANI
// ------------------------------------------
let callEl = null;

function ensureCallUI() {
    if (callEl) return callEl;
    const el = document.createElement('div');
    el.className = 'hidden fixed inset-0 z-[80] bg-black flex-col';
    el.innerHTML = `
        <div class="px-4 pb-2 flex-shrink-0" style="padding-top:max(12px, env(safe-area-inset-top));">
            <p id="gc-title" class="text-white text-base font-semibold truncate"></p>
            <p id="gc-status" class="text-emerald-400 text-xs mt-0.5"></p>
        </div>
        <div id="gc-grid" class="flex-1 min-h-0 grid gap-1 px-1 pb-1"></div>
        <div class="flex items-center justify-center space-x-4 pt-3 flex-shrink-0" style="padding-bottom:max(24px, env(safe-area-inset-bottom));">
            <button type="button" id="gc-mic" class="w-14 h-14 rounded-full bg-white/15 text-white text-xl flex items-center justify-center"><i class="fa-solid fa-microphone"></i></button>
            <button type="button" id="gc-cam" class="w-14 h-14 rounded-full bg-white/15 text-white text-xl flex items-center justify-center"><i class="fa-solid fa-video"></i></button>
            <button type="button" id="gc-switch" class="w-14 h-14 rounded-full bg-white/15 text-white text-xl flex items-center justify-center"><i class="fa-solid fa-camera-rotate"></i></button>
            <button type="button" id="gc-hangup" class="w-14 h-14 rounded-full bg-rose-600 text-white text-xl flex items-center justify-center"><i class="fa-solid fa-phone-slash"></i></button>
        </div>
    `;
    document.body.appendChild(el);

    el.querySelector('#gc-mic').addEventListener('click', toggleMic);
    el.querySelector('#gc-cam').addEventListener('click', toggleCam);
    el.querySelector('#gc-switch').addEventListener('click', () => { switchCameraGroup(); });
    el.querySelector('#gc-hangup').addEventListener('click', () => {
        leaveCall();
        popBackState();
    });

    callEl = el;
    return el;
}

function makeTile(uid, isSelf) {
    const u = userInfo(uid);
    const name = isSelf ? 'Sen' : (u.name || 'Kullanıcı');
    const tile = document.createElement('div');
    tile.dataset.uid = uid;
    tile.className = 'relative bg-[#111b21] rounded-xl overflow-hidden flex items-center justify-center min-h-0';

    const avatar = u.avatar
        ? `<img src="${u.avatar}" class="w-20 h-20 rounded-full object-cover">`
        : `<div class="w-20 h-20 rounded-full flex items-center justify-center text-white text-2xl font-bold" style="background-color:${getUserColor(u.name || '?')};">${getInitials(u.name || '?')}</div>`;

    let media = '';
    if (callType === 'video') {
        media = `<video class="absolute inset-0 w-full h-full object-cover" style="background:transparent;" autoplay playsinline></video>`;
    } else if (!isSelf) {
        media = `<audio autoplay></audio>`;
    }

    tile.innerHTML = `
        ${avatar}
        ${media}
        <span class="absolute bottom-1.5 left-2 max-w-[90%] truncate text-white text-xs bg-black/50 rounded px-1.5 py-0.5"><span>${escapeHtml(name)}</span><span class="gc-state">${isSelf ? '' : ' • bağlanıyor...'}</span></span>
    `;

    if (isSelf) {
        const v = tile.querySelector('video');
        if (v) v.muted = true;
    }
    return tile;
}

function layoutGrid() {
    const grid = document.getElementById('gc-grid');
    if (!grid) return;
    const n = grid.children.length;
    grid.style.gridTemplateColumns = n <= 2 ? '1fr' : 'repeat(2, 1fr)';
    grid.style.gridAutoRows = '1fr';
}

function showCallUI(title) {
    const el = ensureCallUI();
    const isVideo = callType === 'video';
    el.querySelector('#gc-title').textContent = title || 'Grup araması';
    el.querySelector('#gc-status').textContent = 'Aranıyor...';
    el.querySelector('#gc-cam').style.display = isVideo ? '' : 'none';
    el.querySelector('#gc-switch').style.display = isVideo ? '' : 'none';
    el.querySelector('#gc-mic i').className = 'fa-solid fa-microphone';
    el.querySelector('#gc-cam i').className = 'fa-solid fa-video';

    const grid = el.querySelector('#gc-grid');
    grid.innerHTML = '';
    const me = getCurrentUser();
    const selfTile = makeTile(me.uid, true);
    grid.appendChild(selfTile);
    const v = selfTile.querySelector('video');
    if (v) {
        v.srcObject = localStream;
        playSafe(v);
    }
    layoutGrid();

    el.classList.remove('hidden');
    el.classList.add('flex');
}

function hideCallUI() {
    if (!callEl) return;
    callEl.querySelectorAll('video, audio').forEach((m) => { m.srcObject = null; });
    const grid = callEl.querySelector('#gc-grid');
    if (grid) grid.innerHTML = '';
    callEl.classList.add('hidden');
    callEl.classList.remove('flex');
}

function updateHeader() {
    const st = document.getElementById('gc-status');
    if (!st) return;
    const n = lastParticipants.length;
    if (n <= 1) {
        st.textContent = 'Aranıyor...';
        return;
    }
    const sec = Math.max(0, Math.floor((Date.now() - callStartMs) / 1000));
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(sec % 60).padStart(2, '0');
    st.textContent = `${n} kişi • ${mm}:${ss}`;
}

function toggleMic() {
    if (!localStream) return;
    micOn = !micOn;
    localStream.getAudioTracks().forEach((t) => { t.enabled = micOn; });
    const i = callEl && callEl.querySelector('#gc-mic i');
    if (i) i.className = micOn ? 'fa-solid fa-microphone' : 'fa-solid fa-microphone-slash';
}

function toggleCam() {
    if (!localStream) return;
    camOn = !camOn;
    localStream.getVideoTracks().forEach((t) => { t.enabled = camOn; });
    const i = callEl && callEl.querySelector('#gc-cam i');
    if (i) i.className = camOn ? 'fa-solid fa-video' : 'fa-solid fa-video-slash';
}

// Ön/arka kamera değiştirme: eski kamera kapatılıp yenisi açılır (Android'de ikisi aynı anda açılamıyor)
async function switchCameraGroup() {
    if (!localStream || callType !== 'video') return;
    const newFacing = facing === 'user' ? 'environment' : 'user';

    const oldTrack = localStream.getVideoTracks()[0];
    if (oldTrack) {
        localStream.removeTrack(oldTrack);
        oldTrack.stop();
    }

    let track = null;
    try {
        let ns;
        try {
            ns = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: newFacing } }, audio: false });
        } catch (e) {
            ns = await navigator.mediaDevices.getUserMedia({ video: { facingMode: newFacing }, audio: false });
        }
        track = ns.getVideoTracks()[0];
        if (track) facing = newFacing;
    } catch (err) {
        // Yeni kamera açılmadıysa eskisini geri aç ki görüntü donmasın
        try {
            const bs = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
            track = bs.getVideoTracks()[0];
        } catch (e2) {}
        showToast('Kamera değiştirilemedi: ' + err.message, 3500);
    }
    if (!track || !localStream) return;

    track.enabled = camOn;
    for (const p of peers.values()) {
        const sender = p.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) await sender.replaceTrack(track).catch(() => {});
    }
    localStream.addTrack(track);

    const selfV = callEl && callEl.querySelector('[data-uid="' + getCurrentUser().uid + '"] video');
    if (selfV) {
        selfV.srcObject = localStream;
        playSafe(selfV);
    }
}

// ------------------------------------------
// BAĞLANTILAR (her katılımcı için bir RTCPeerConnection)
// ------------------------------------------
function setPeerState(uid, text) {
    const entry = peers.get(uid);
    if (!entry || !entry.tile) return;
    const s = entry.tile.querySelector('.gc-state');
    if (s) s.textContent = text;
}

function attachRemoteStream(uid, stream) {
    const entry = peers.get(uid);
    if (!entry || !entry.tile || !stream) return;
    const media = entry.tile.querySelector('video, audio');
    if (!media) return;
    if (media.srcObject !== stream) media.srcObject = stream;
    playSafe(media);
}

async function sendSignal(toUid, kind, payload) {
    const me = getCurrentUser();
    if (!activeGid || !me) return;
    try {
        await addDoc(signalsCol(activeGid), {
            callId: callId,
            from: me.uid,
            to: toUid,
            kind: kind,
            payload: payload,
            createdAt: serverTimestamp()
        });
    } catch (err) {}
}

function createPeer(uid) {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const entry = { uid: uid, pc: pc, tile: null, inList: false, offered: false };

    if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    pc.onicecandidate = (ev) => {
        if (ev.candidate) sendSignal(uid, 'ice', JSON.stringify(ev.candidate.toJSON()));
    };
    pc.ontrack = (ev) => {
        attachRemoteStream(uid, ev.streams && ev.streams[0]);
    };
    pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === 'connected') setPeerState(uid, '');
        else if (st === 'failed') setPeerState(uid, ' • bağlanamadı');
        else if (st === 'disconnected') setPeerState(uid, ' • bağlantı zayıf');
    };

    const grid = document.getElementById('gc-grid');
    entry.tile = makeTile(uid, false);
    if (grid) grid.appendChild(entry.tile);
    peers.set(uid, entry);
    layoutGrid();
    return entry;
}

function removePeer(uid) {
    const entry = peers.get(uid);
    if (!entry) return;
    try { entry.pc.close(); } catch (e) {}
    if (entry.tile) {
        const m = entry.tile.querySelector('video, audio');
        if (m) m.srcObject = null;
        entry.tile.remove();
    }
    peers.delete(uid);
    pendingIce.delete(uid);
    layoutGrid();
}

async function callPeer(uid) {
    const entry = peers.get(uid) || createPeer(uid);
    if (entry.offered) return;
    entry.offered = true;
    try {
        const offer = await entry.pc.createOffer();
        await entry.pc.setLocalDescription(offer);
        sendSignal(uid, 'offer', JSON.stringify({ type: offer.type, sdp: offer.sdp }));
    } catch (err) {
        setPeerState(uid, ' • bağlanamadı');
    }
}

// Katılımcı listesi değişince: yeni gelenlerle bağlantı kur, gidenleri kapat
function reconcilePeers(parts) {
    const me = getCurrentUser();
    if (!me) return;
    const others = parts.filter((u) => u !== me.uid);

    others.forEach((uid) => {
        let entry = peers.get(uid);
        if (!entry) {
            entry = createPeer(uid);
            if (me.uid > uid) callPeer(uid);
        }
        entry.inList = true;
    });

    Array.from(peers.keys()).forEach((uid) => {
        const entry = peers.get(uid);
        if (entry && entry.inList && !others.includes(uid)) removePeer(uid);
    });
}

async function flushIce(uid, entry) {
    const list = pendingIce.get(uid);
    if (!list || !list.length) return;
    pendingIce.delete(uid);
    for (const cand of list) {
        try { await entry.pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {}
    }
}

async function handleSignal(s) {
    const from = s.from;
    if (!from || !activeGid) return;

    if (s.kind === 'offer') {
        const entry = peers.get(from) || createPeer(from);
        if (entry.pc.signalingState !== 'stable') return; // çakışma: yok say
        await entry.pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(s.payload)));
        await flushIce(from, entry);
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        sendSignal(from, 'answer', JSON.stringify({ type: answer.type, sdp: answer.sdp }));
    } else if (s.kind === 'answer') {
        const entry = peers.get(from);
        if (!entry || entry.pc.signalingState !== 'have-local-offer') return;
        await entry.pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(s.payload)));
        await flushIce(from, entry);
    } else if (s.kind === 'ice') {
        const cand = JSON.parse(s.payload);
        const entry = peers.get(from);
        if (entry && entry.pc.remoteDescription) {
            entry.pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        } else {
            if (!pendingIce.has(from)) pendingIce.set(from, []);
            pendingIce.get(from).push(cand);
        }
    }
}

function startSignalListener(gid) {
    const me = getCurrentUser();
    if (!me) return;
    const q = query(signalsCol(gid), where('to', '==', me.uid));
    unsubSignals = onSnapshot(q, (snap) => {
        snap.docChanges().forEach((ch) => {
            if (ch.type !== 'added') return;
            const s = ch.doc.data();
            deleteDoc(ch.doc.ref).catch(() => {}); // işlenen sinyali temizle
            if (s.callId !== callId) return;       // eski aramadan kalma
            handleSignal(s).catch(() => {});
        });
    }, () => {});
}

// Arama dokümanı: katılımcı listesi değişince bağlantıları güncelle, arama bitince kapat
function startCallDocListener(gid) {
    unsubCallDoc = onSnapshot(callRef(gid), (snap) => {
        if (!activeGid || !snap.exists()) return;
        const d = snap.data();
        if (d.callId !== callId || d.status === 'ended') {
            endedByRemote();
            return;
        }
        const parts = Array.isArray(d.participants) ? d.participants : [];
        lastParticipants = parts;
        callStartMs = d.connectedAtMs || d.startedAtMs || callStartMs || Date.now();
        reconcilePeers(parts);
        updateHeader();
    }, () => {});
}

function cleanupLocal() {
    if (unsubCallDoc) { unsubCallDoc(); unsubCallDoc = null; }
    if (unsubSignals) { unsubSignals(); unsubSignals = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    peers.forEach((p) => { try { p.pc.close(); } catch (e) {} });
    peers.clear();
    pendingIce.clear();
    if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
        localStream = null;
    }
    hideCallUI();
    window.__aurachatCallActive = false;
    dismissedCallId = callId; // ayrıldığım aramanın "Katıl" ekranı tekrar çıkmasın
    activeGid = null;
    callId = null;
    lastParticipants = [];
}

function endedByRemote() {
    if (!activeGid) return;
    cleanupLocal();
    popBackState();
    showToast('Arama sona erdi');
}

// ------------------------------------------
// ARAMAYI BAŞLAT / KATIL
// ------------------------------------------
async function startOrJoin(gid, requestedType) {
    const me = getCurrentUser();
    if (!me || !me.uid || !isGroupId(gid)) return;
    if (window.__aurachatCallActive || activeGid) {
        showToast('Zaten bir arama devam ediyor');
        return;
    }
    window.__aurachatCallActive = true; // hazırlık sırasında çift dokunuş olmasın

    let existing = null;
    let members = [];
    let gname = 'Grup';
    try {
        const results = await Promise.all([getDoc(callRef(gid)), getDoc(doc(db, "groups", gid))]);
        if (results[0].exists()) existing = results[0].data();
        if (results[1].exists()) {
            const g = results[1].data();
            members = Array.isArray(g.members) ? g.members : [];
            gname = g.name || 'Grup';
        }
    } catch (err) {
        window.__aurachatCallActive = false;
        showToast('Arama başlatılamadı: ' + err.message, 3500);
        return;
    }

    if (!members.includes(me.uid)) {
        window.__aurachatCallActive = false;
        showToast('Bu grubun üyesi değilsin');
        return;
    }

    const live = isLive(existing);
    const type = live ? (existing.callType === 'video' ? 'video' : 'audio') : requestedType;
    const cap = type === 'video' ? MAX_VIDEO_PARTICIPANTS : MAX_AUDIO_PARTICIPANTS;
    if (live && existing.participants.length >= cap) {
        window.__aurachatCallActive = false;
        showToast(`Arama dolu (en fazla ${cap} kişi)`);
        return;
    }

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: type === 'video'
                ? { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 640 }, frameRate: { ideal: 20 } }
                : false
        });
    } catch (err) {
        window.__aurachatCallActive = false;
        alert((type === 'video' ? 'Kamera/mikrofon' : 'Mikrofon') + ' izni verilmedi kanka: ' + err.message);
        return;
    }

    activeGid = gid;
    callType = type;
    groupName = gname;
    micOn = true;
    camOn = true;
    facing = 'user';
    lastParticipants = [me.uid];
    callStartMs = Date.now();
    callId = live ? existing.callId : ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    peers.clear();
    pendingIce.clear();
    hideJoinPrompt();
    showCallUI(gname);

    // Kendimi listeye yazmadan ÖNCE sinyalleri dinlemeye başla (ilk offer'lar kaçmasın)
    startSignalListener(gid);

    try {
        if (live) {
            const upd = { participants: arrayUnion(me.uid), everJoined: true, lastPingMs: Date.now() };
            if (!existing.everJoined) upd.connectedAtMs = Date.now();
            await updateDoc(callRef(gid), upd);
        } else {
            await setDoc(callRef(gid), {
                callId: callId,
                callType: type,
                status: 'active',
                startedBy: me.uid,
                startedByName: me.name || '',
                groupName: gname,
                participants: [me.uid],
                everJoined: false,
                startedAtMs: Date.now(),
                lastPingMs: Date.now(),
                updatedAt: serverTimestamp()
            });
        }
    } catch (err) {
        cleanupLocal();
        showToast('Arama başlatılamadı: ' + err.message, 3500);
        return;
    }

    startCallDocListener(gid);
    pingTimer = setInterval(() => {
        if (activeGid) updateDoc(callRef(activeGid), { lastPingMs: Date.now() }).catch(() => {});
    }, PING_EVERY_MS);
    clockTimer = setInterval(updateHeader, 1000);
    pushBackState(() => { leaveCall(); });

    if (!live) {
        const typeText = type === 'video' ? '📹 görüntülü' : '📞 sesli';
        members.forEach((uid) => {
            if (uid === me.uid) return;
            sendPushToUser(uid, gname, `${me.name} ${typeText} grup araması başlattı`, {
                chatId: gid,
                otherUid: gid,
                otherName: gname,
                tag: `gcall_${gid}`
            });
        });
    }
}

// ------------------------------------------
// ARAMADAN AYRIL (son kişi çıkarsa arama biter, sohbete süre mesajı düşer)
// ------------------------------------------
async function leaveCall() {
    if (!activeGid) return;
    const gid = activeGid;
    const myCallId = callId;
    const me = getCurrentUser();
    cleanupLocal();
    if (!me) return;

    let endedInfo = null;
    try {
        await runTransaction(db, async (tx) => {
            endedInfo = null;
            const ref = callRef(gid);
            const s = await tx.get(ref);
            if (!s.exists()) return;
            const d = s.data();
            if (d.callId !== myCallId) return;
            const parts = (Array.isArray(d.participants) ? d.participants : []).filter((u) => u !== me.uid);
            if (parts.length === 0 && d.status === 'active') {
                tx.update(ref, { participants: [], status: 'ended', endedAtMs: Date.now() });
                endedInfo = d;
            } else {
                tx.update(ref, { participants: parts });
            }
        });
    } catch (err) {
        return;
    }

    if (endedInfo) await logGroupCallEnd(gid, endedInfo, me);
}

async function logGroupCallEnd(gid, d, me) {
    const isVideo = d.callType === 'video';
    const icon = isVideo ? '📹' : '📞';
    const typeLabel = isVideo ? 'görüntülü grup araması' : 'sesli grup araması';

    let text;
    if (d.everJoined) {
        const sec = Math.round((Date.now() - (d.connectedAtMs || d.startedAtMs || Date.now())) / 1000);
        text = `${icon} ${isVideo ? 'Görüntülü' : 'Sesli'} grup araması sona erdi • ${fmtDuration(sec)}`;
    } else {
        text = `${icon} Cevapsız ${typeLabel}`;
    }

    try {
        await addDoc(collection(db, "chats", gid, "messages"), {
            type: 'system',
            text: text,
            senderUid: me.uid,
            senderName: me.name || '',
            createdAt: serverTimestamp(),
            read: true
        });

        const gs = await getDoc(doc(db, "groups", gid));
        const g = gs.exists() ? gs.data() : {};
        const members = Array.isArray(g.members) ? g.members : [];
        const gname = g.name || d.groupName || 'Grup';

        await Promise.allSettled(members.map((uid) => setDoc(doc(db, "users", uid, "chats", gid), {
            isGroup: true,
            groupName: gname,
            lastMessage: text,
            lastMessageTime: serverTimestamp(),
            lastSenderUid: me.uid,
            lastSenderName: '',
            lastMessageRead: false,
            updatedAt: serverTimestamp()
        }, { merge: true })));

        if (!d.everJoined) {
            members.forEach((uid) => {
                if (uid === me.uid) return;
                sendPushToUser(uid, gname, `☎️ Cevapsız ${typeLabel}`, {
                    chatId: gid,
                    otherUid: gid,
                    otherName: gname,
                    tag: `gcall_${gid}`
                });
            });
        }
    } catch (err) {}
}

// ------------------------------------------
// GELEN ARAMA: grup sohbeti açıkken arama başlarsa "Katıl / Reddet" ekranı
// (chat-core.js, grup sohbeti seçilince çağırır; grup dışı sohbette null verir)
// ------------------------------------------
function ensureJoinPrompt() {
    if (joinEl) return joinEl;
    const el = document.createElement('div');
    el.className = 'hidden fixed inset-0 z-[75] bg-[#0b141a] flex-col items-center justify-center px-6 text-center';
    el.innerHTML = `
        <div class="w-24 h-24 rounded-full bg-emerald-600/20 text-emerald-400 flex items-center justify-center text-4xl mb-5"><i id="gc-join-icon" class="fa-solid fa-phone"></i></div>
        <p id="gc-join-type" class="text-emerald-400 text-sm mb-1"></p>
        <h2 id="gc-join-name" class="text-white text-2xl font-semibold break-words max-w-full"></h2>
        <p id="gc-join-sub" class="text-gray-400 text-sm mt-2"></p>
        <div class="flex items-center justify-center space-x-16 mt-14">
            <button type="button" id="gc-join-decline" class="flex flex-col items-center space-y-2">
                <span class="w-16 h-16 rounded-full bg-rose-600 text-white text-2xl flex items-center justify-center"><i class="fa-solid fa-phone-slash"></i></span>
                <span class="text-gray-300 text-xs">Reddet</span>
            </button>
            <button type="button" id="gc-join-accept" class="flex flex-col items-center space-y-2">
                <span class="w-16 h-16 rounded-full bg-emerald-500 text-white text-2xl flex items-center justify-center"><i id="gc-join-accept-icon" class="fa-solid fa-phone"></i></span>
                <span class="text-gray-300 text-xs">Katıl</span>
            </button>
        </div>
    `;
    document.body.appendChild(el);

    el.querySelector('#gc-join-decline').addEventListener('click', () => {
        dismissedCallId = el.dataset.callId || null;
        hideJoinPrompt();
    });
    el.querySelector('#gc-join-accept').addEventListener('click', () => {
        const gid = el.dataset.gid;
        const type = el.dataset.type;
        hideJoinPrompt();
        if (gid) startOrJoin(gid, type || 'audio');
    });

    joinEl = el;
    return el;
}

function showJoinPrompt(gid, d) {
    const el = ensureJoinPrompt();
    const type = d.callType === 'video' ? 'video' : 'audio';
    const parts = Array.isArray(d.participants) ? d.participants : [];
    const icon = type === 'video' ? 'fa-solid fa-video' : 'fa-solid fa-phone';

    el.dataset.gid = gid;
    el.dataset.type = type;
    el.dataset.callId = d.callId || '';
    el.querySelector('#gc-join-type').textContent = type === 'video' ? 'Grup görüntülü araması' : 'Grup sesli araması';
    el.querySelector('#gc-join-name').textContent = d.groupName || 'Grup';
    el.querySelector('#gc-join-sub').textContent = `${d.startedByName || 'Biri'} başlattı • ${parts.length} kişi katıldı`;
    el.querySelector('#gc-join-icon').className = icon;
    el.querySelector('#gc-join-accept-icon').className = icon;

    el.classList.remove('hidden');
    el.classList.add('flex');
    if (joinShownFor !== d.callId) {
        joinShownFor = d.callId;
        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    }
}

function hideJoinPrompt() {
    if (joinEl) {
        joinEl.classList.add('hidden');
        joinEl.classList.remove('flex');
    }
    joinShownFor = null;
}

export function watchGroupCallForChat(chatId) {
    if (unsubWatch) { unsubWatch(); unsubWatch = null; }
    hideJoinPrompt();
    if (!chatId || !isGroupId(chatId)) return;

    unsubWatch = onSnapshot(callRef(chatId), (snap) => {
        const me = getCurrentUser();
        if (!me || !snap.exists()) { hideJoinPrompt(); return; }
        const d = snap.data();
        const parts = Array.isArray(d.participants) ? d.participants : [];
        if (isLive(d) && !parts.includes(me.uid) && !window.__aurachatCallActive && d.callId !== dismissedCallId) {
            showJoinPrompt(chatId, d);
        } else {
            hideJoinPrompt();
        }
    }, () => {});
}

// ------------------------------------------
// SOHBET ÜST BARINDAKİ SESLİ / GÖRÜNTÜLÜ ARAMA DÜĞMELERİ (sadece grup sohbetinde)
// video-call.js ve voice-call.js grup sohbetinde kendi dinleyicilerini atlar.
// ------------------------------------------
const groupVideoBtn = document.getElementById('video-call-btn');
const groupVoiceBtn = document.getElementById('voice-call-btn');

if (groupVideoBtn) {
    groupVideoBtn.addEventListener('click', () => {
        const id = getCurrentChatId();
        if (isGroupId(id)) startOrJoin(id, 'video');
    });
}

if (groupVoiceBtn) {
    groupVoiceBtn.addEventListener('click', () => {
        const id = getCurrentChatId();
        if (isGroupId(id)) startOrJoin(id, 'audio');
    });
}

// Uygulama kapanırken aramadan çık (en iyi çaba)
window.addEventListener('pagehide', () => {
    if (activeGid) leaveCall();
});
