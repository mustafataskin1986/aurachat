// ==========================================
// GÖRÜNTÜLÜ ARAMA (WebRTC + Firestore sinyalleşme)
// Sadece 1'e 1 sohbetlerde çalışır (global oda desteklenmez).
// STUN: Google'ın ücretsiz sunucusu. TURN yok - bazı ağlarda
// (simetrik NAT) bağlantı kurulamayabilir.
// ==========================================

import { db } from "./firebase-init.js";
import {
    doc, collection, setDoc, updateDoc, onSnapshot, addDoc, serverTimestamp, getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getCurrentUser, getCurrentChatId, sendPushToUser } from "./chat-core.js";
import { getUserColor, getInitials } from "./ui-helpers.js";
import { pushBackState, popBackState } from "./back-handler.js";

const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

const videoCallBtn = document.getElementById('video-call-btn');

const incomingCallOverlay = document.getElementById('incoming-call-overlay');
const incomingCallerName = document.getElementById('incoming-caller-name');
const incomingCallerAvatar = document.getElementById('incoming-caller-avatar');
const btnAcceptCall = document.getElementById('btn-accept-call');
const btnDeclineCall = document.getElementById('btn-decline-call');

const activeCallOverlay = document.getElementById('active-call-overlay');
const localVideoEl = document.getElementById('local-video');
const remoteVideoEl = document.getElementById('remote-video');
const callStatusText = document.getElementById('call-status-text');
const btnHangup = document.getElementById('btn-hangup');
const btnToggleMic = document.getElementById('btn-toggle-mic');
const btnToggleCam = document.getElementById('btn-toggle-cam');
const btnSwitchCamera = document.getElementById('btn-switch-camera');

let pc = null;
let localStream = null;
let currentCallChatId = null;
let isCaller = false;
let unsubCallDoc = null;
let unsubRemoteCandidates = null;
let micEnabled = true;
let camEnabled = true;
let pendingOffer = null;
let currentFacingMode = 'user';

function callDocRef(chatId) {
    return doc(db, "chats", chatId, "call", "current");
}

function candidatesRef(chatId, who) {
    return collection(db, "chats", chatId, "call", "current", who);
}

// ------------------------------------------
// BİR SOHBETİN ARAMA DURUMUNU DİNLE
// chat-core.js, selectChat() her çağrıldığında bunu tetikler.
// ------------------------------------------
export function watchCallForChat(chatId) {
    if (unsubCallDoc) { unsubCallDoc(); unsubCallDoc = null; }
    if (!chatId || chatId === 'global') return;

    unsubCallDoc = onSnapshot(callDocRef(chatId), (snap) => {
        const user = getCurrentUser();
        if (!user || !snap.exists()) return;

        const data = snap.data();

        // Bana gelen, henüz açık bir arama yoksa ve bağlı değilsem -> göster
        if (data.status === 'ringing' && data.calleeUid === user.uid && !pc) {
            showIncomingCall(chatId, data.callerName, data.callerAvatar, data.offer);
        }

     // Karşı taraf kapattı/reddetti
        if (data.status === 'ended' || data.status === 'declined') {
            if (pc) {
                endCallUI(data.status === 'declined' ? 'Arama reddedildi' : 'Arama sonlandı');
            } else if (incomingCallOverlay && !incomingCallOverlay.classList.contains('hidden')) {
                // Ben daha cevap vermeden karşı taraf aramayı kapattı -
                // gelen arama ekranını otomatik kapat.
                hideIncomingCallUI();
                resetCallState();
            }
        }

        // Ben arayansam ve cevap geldiyse
        if (data.status === 'active' && isCaller && data.answer && pc && !pc.currentRemoteDescription) {
            pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            if (callStatusText) callStatusText.textContent = 'Bağlanıyor...';
        }
    });
}

// ------------------------------------------
// ARAMA BAŞLAT
// ------------------------------------------
if (videoCallBtn) {
    videoCallBtn.addEventListener('click', async () => {
        const chatId = getCurrentChatId();
        const user = getCurrentUser();
        if (!chatId || chatId === 'global' || !user) {
            alert("Görüntülü arama sadece kişisel sohbetlerde yapılabilir kanka.");
            return;
        }
        const otherUid = chatId.split('_').find(u => u !== user.uid);
        if (!otherUid) return;
        await startCall(chatId, otherUid);
    });
}

async function startCall(chatId, otherUid) {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
        alert("Kamera/mikrofon izni verilmedi kanka: " + err.message);
        return;
    }

    isCaller = true;
    currentCallChatId = chatId;

    pc = new RTCPeerConnection(RTC_CONFIG);
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    if (localVideoEl) localVideoEl.srcObject = localStream;

    pc.ontrack = (event) => {
        if (remoteVideoEl) remoteVideoEl.srcObject = event.streams[0];
        if (callStatusText) callStatusText.textContent = '';
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            addDoc(candidatesRef(chatId, 'callerCandidates'), event.candidate.toJSON());
        }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const user = getCurrentUser();
    await setDoc(callDocRef(chatId), {
        callerUid: user.uid,
        callerName: user.name,
        callerAvatar: user.avatar || '',
        calleeUid: otherUid,
        status: 'ringing',
        offer: { type: offer.type, sdp: offer.sdp },
        createdAt: serverTimestamp()
    });

    sendPushToUser(otherUid, `${user.name}`, "📹 Görüntülü arama yapıyor...", {
        chatId: chatId,
        otherUid: user.uid,
        otherName: user.name
    });

    listenRemoteCandidates(chatId, 'calleeCandidates');
    showActiveCallUI('Aranıyor...');
    pushBackState(() => { hangupCall(); });
}

// ------------------------------------------
// GELEN ARAMA
// ------------------------------------------
function showIncomingCall(chatId, callerName, callerAvatar, offer) {
    currentCallChatId = chatId;
    isCaller = false;
    pendingOffer = offer;

    if (incomingCallerName) incomingCallerName.textContent = callerName || 'Bilinmeyen';
    if (incomingCallerAvatar) {
        if (callerAvatar) {
            incomingCallerAvatar.style.backgroundColor = '';
            incomingCallerAvatar.innerHTML = `<img src="${callerAvatar}" class="w-full h-full object-cover">`;
        } else {
            incomingCallerAvatar.style.backgroundColor = getUserColor(callerName || '');
            incomingCallerAvatar.innerHTML = `<span>${getInitials(callerName || '')}</span>`;
        }
    }

    if (incomingCallOverlay) {
        incomingCallOverlay.classList.remove('hidden');
        incomingCallOverlay.classList.add('flex');
    }
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

function hideIncomingCallUI() {
    if (incomingCallOverlay) {
        incomingCallOverlay.classList.add('hidden');
        incomingCallOverlay.classList.remove('flex');
    }
}

if (btnDeclineCall) {
    btnDeclineCall.addEventListener('click', async () => {
        hideIncomingCallUI();
        if (currentCallChatId) {
            await updateDoc(callDocRef(currentCallChatId), { status: 'declined' }).catch(() => {});
        }
        resetCallState();
    });
}

if (btnAcceptCall) {
    btnAcceptCall.addEventListener('click', async () => {
        hideIncomingCallUI();
        await acceptCall();
    });
}

async function acceptCall() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
        alert("Kamera/mikrofon izni verilmedi kanka: " + err.message);
        resetCallState();
        return;
    }

    pc = new RTCPeerConnection(RTC_CONFIG);
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    if (localVideoEl) localVideoEl.srcObject = localStream;

    pc.ontrack = (event) => {
        if (remoteVideoEl) remoteVideoEl.srcObject = event.streams[0];
        if (callStatusText) callStatusText.textContent = '';
    };

    pc.onicecandidate = (event) => {
        if (event.candidate && currentCallChatId) {
            addDoc(candidatesRef(currentCallChatId, 'calleeCandidates'), event.candidate.toJSON());
        }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await updateDoc(callDocRef(currentCallChatId), {
        status: 'active',
        answer: { type: answer.type, sdp: answer.sdp }
    });

    listenRemoteCandidates(currentCallChatId, 'callerCandidates');
    showActiveCallUI('Bağlanıyor...');
    pushBackState(() => { hangupCall(); });
}

function listenRemoteCandidates(chatId, who) {
    if (unsubRemoteCandidates) unsubRemoteCandidates();
    unsubRemoteCandidates = onSnapshot(candidatesRef(chatId, who), (snap) => {
        snap.docChanges().forEach((change) => {
            if (change.type === 'added' && pc) {
                pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(() => {});
            }
        });
    });
}

// ------------------------------------------
// ARAMA EKRANI
// ------------------------------------------
function showActiveCallUI(statusText) {
    if (activeCallOverlay) {
        activeCallOverlay.classList.remove('hidden');
        activeCallOverlay.classList.add('flex');
    }
    if (callStatusText) callStatusText.textContent = statusText;
    micEnabled = true;
    camEnabled = true;
}

async function hangupCall() {
    if (currentCallChatId) {
        try {
            const snap = await getDoc(callDocRef(currentCallChatId));
            const data = snap.exists() ? snap.data() : null;
            const wasRinging = data && data.status === 'ringing';

            await updateDoc(callDocRef(currentCallChatId), { status: 'ended' }).catch(() => {});

            // Karşı taraf hiç cevap vermeden ben kapattıysam ona
            // "cevapsız arama" bildirimi gönder.
            if (wasRinging && isCaller && data.calleeUid) {
                const user = getCurrentUser();
                sendPushToUser(data.calleeUid, `${user.name}`, "☎️ Cevapsız görüntülü arama", {
                    chatId: currentCallChatId,
                    otherUid: user.uid,
                    otherName: user.name
                });
            }
        } catch (err) {
            console.error("Arama sonlandırılırken hata:", err);
        }
    }
    endCallUI('Arama sonlandı');
}

function endCallUI(message) {
    if (callStatusText) callStatusText.textContent = message;
    setTimeout(() => {
        if (activeCallOverlay) {
            activeCallOverlay.classList.add('hidden');
            activeCallOverlay.classList.remove('flex');
        }
        resetCallState();
    }, 800);
}

function resetCallState() {
    if (pc) { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (unsubRemoteCandidates) { unsubRemoteCandidates(); unsubRemoteCandidates = null; }
    if (localVideoEl) localVideoEl.srcObject = null;
    if (remoteVideoEl) remoteVideoEl.srcObject = null;
    isCaller = false;
    currentCallChatId = null;
    pendingOffer = null;
    currentFacingMode = 'user';
}

if (btnHangup) {
    btnHangup.addEventListener('click', () => {
        hangupCall();
        popBackState();
    });
}

if (btnToggleMic) {
    btnToggleMic.addEventListener('click', () => {
        if (!localStream) return;
        micEnabled = !micEnabled;
        localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
        btnToggleMic.classList.toggle('bg-rose-600', !micEnabled);
        btnToggleMic.classList.toggle('bg-white/20', micEnabled);
    });
}

if (btnToggleCam) {
    btnToggleCam.addEventListener('click', () => {
        if (!localStream) return;
        camEnabled = !camEnabled;
        localStream.getVideoTracks().forEach(t => t.enabled = camEnabled);
        btnToggleCam.classList.toggle('bg-rose-600', !camEnabled);
        btnToggleCam.classList.toggle('bg-white/20', camEnabled);
    });
}

async function switchCamera() {
    if (!localStream || !pc) return;

    const newFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';

    try {
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: newFacingMode },
            audio: false
        });
        const newVideoTrack = newStream.getVideoTracks()[0];
        if (!newVideoTrack) return;

        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) await sender.replaceTrack(newVideoTrack);

        const oldVideoTrack = localStream.getVideoTracks()[0];
        if (oldVideoTrack) {
            localStream.removeTrack(oldVideoTrack);
            oldVideoTrack.stop();
        }
        localStream.addTrack(newVideoTrack);
        if (localVideoEl) localVideoEl.srcObject = localStream;

        currentFacingMode = newFacingMode;
    } catch (err) {
        alert("Kamera değiştirilemedi kanka: " + err.message);
    }
}

if (btnSwitchCamera) {
    btnSwitchCamera.addEventListener('click', () => switchCamera());
}