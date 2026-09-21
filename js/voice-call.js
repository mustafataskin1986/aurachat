// ==========================================
// SESLİ ARAMA (WebRTC + Firestore sinyalleşme)
// video-call.js ile birebir aynı sinyalleşme akışını, aynı
// chats/{chatId}/call/current dokümanı ve aynı incoming/active
// overlay DOM elementlerini paylaşır. callType: 'audio' alanıyla
// video aramadan ayrışır. Kamera hiç açılmaz - sadece mikrofon;
// aktif arama ekranında video kutuları yerine avatar/isim
// gösterilir.
// ==========================================

import { db } from "./firebase-init.js";
import {
    doc, collection, setDoc, updateDoc, onSnapshot, addDoc, serverTimestamp, getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getCurrentUser, getCurrentChatId, sendPushToUser, logMissedCall, logDeclinedCall, logCallDuration, showToast } from "./chat-core.js";
import { getUserColor, getInitials } from "./ui-helpers.js";
import { pushBackState, popBackState } from "./back-handler.js";

const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

const voiceCallBtn = document.getElementById('voice-call-btn');

const incomingCallOverlay = document.getElementById('incoming-call-overlay');
const incomingCallerName = document.getElementById('incoming-caller-name');
const incomingCallerAvatar = document.getElementById('incoming-caller-avatar');
const btnAcceptCall = document.getElementById('btn-accept-call');
const btnDeclineCall = document.getElementById('btn-decline-call');

const activeCallOverlay = document.getElementById('active-call-overlay');
const remoteAudioEl = document.getElementById('voice-remote-audio');
const voiceCallDisplay = document.getElementById('voice-call-display');
const voiceCallAvatar = document.getElementById('voice-call-avatar');
const voiceCallName = document.getElementById('voice-call-name');
const remoteVideoEl = document.getElementById('remote-video');
const localVideoEl = document.getElementById('local-video');
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
let pendingOffer = null;
let pendingCallerUid = null;
let pendingCallerName = null;
let callStartTime = null;

function callDocRef(chatId) {
    return doc(db, "chats", chatId, "call", "current");
}

function candidatesRef(chatId, who) {
    return collection(db, "chats", chatId, "call", "current", who);
}

// ------------------------------------------
// BİR SOHBETİN SESLİ ARAMA DURUMUNU DİNLE
// chat-core.js, selectChat() her çağrıldığında bunu tetikler.
// ------------------------------------------
export function watchVoiceCallForChat(chatId) {
    if (unsubCallDoc) { unsubCallDoc(); unsubCallDoc = null; }
    if (!chatId || chatId === 'global') return;

    unsubCallDoc = onSnapshot(callDocRef(chatId), (snap) => {
        const user = getCurrentUser();
        if (!user || !snap.exists()) return;

        const data = snap.data();

        // Sadece sesli arama ise devreye gir - video ise video-call.js halleder
    if (data.status === 'ringing' && data.calleeUid === user.uid && !pc && !window.__aurachatCallActive && data.callType === 'audio') {
            showIncomingVoiceCall(chatId, data.callerName, data.callerAvatar, data.offer, data.callerUid);
        }

        if ((data.status === 'ended' || data.status === 'declined') && data.callType === 'audio') {
            if (pc) {
                endCallUI(data.status === 'declined' ? 'Arama reddedildi' : 'Arama sonlandı');
            } else if (incomingCallOverlay && !incomingCallOverlay.classList.contains('hidden') && incomingCallOverlay.dataset.callType === 'audio') {
                hideIncomingCallUI();
                resetCallState();
            }
        }

        if (data.status === 'active' && isCaller && data.answer && pc && !pc.currentRemoteDescription) {
          pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            callStartTime = null;
            pc.onconnectionstatechange = () => {
                if (pc && pc.connectionState === 'connected' && !callStartTime) callStartTime = Date.now();
            };
            if (callStatusText) callStatusText.textContent = 'Bağlanıyor...';
        }
    });
}

// ------------------------------------------
// ARAMA BAŞLAT
// ------------------------------------------
if (voiceCallBtn) {
    voiceCallBtn.addEventListener('click', async () => {
        const chatId = getCurrentChatId();
        if (window.__aurachatGroupIds && window.__aurachatGroupIds.has(chatId)) return; // grup araması group-call.js'te
        const user = getCurrentUser();
        if (!chatId || chatId === 'global' || !user) {
            alert("Sesli arama sadece kişisel sohbetlerde yapılabilir kanka.");
            return;
        }
        const otherUid = chatId.split('_').find(u => u !== user.uid);
        if (!otherUid) return;
        await startVoiceCall(chatId, otherUid);
    });
}

export async function startVoiceCall(chatId, otherUid) {
    if (window.__aurachatCallActive) {
        alert("Zaten bir arama devam ediyor kanka.");
        return;
    }

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        alert("Mikrofon izni verilmedi kanka: " + err.message);
        return;
    }

    window.__aurachatCallActive = true;
    isCaller = true;
    currentCallChatId = chatId;

    pc = new RTCPeerConnection(RTC_CONFIG);
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.ontrack = (event) => {
        if (remoteAudioEl) remoteAudioEl.srcObject = event.streams[0];
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
        callType: 'audio',
        offer: { type: offer.type, sdp: offer.sdp },
        createdAt: serverTimestamp()
    });

    sendPushToUser(otherUid, `${user.name}`, "📞 Sesli arama yapıyor...", {
        chatId: chatId,
        otherUid: user.uid,
        otherName: user.name,
        tag: `call_${chatId}`
    });

    listenRemoteCandidates(chatId, 'calleeCandidates');
    showActiveVoiceCallUI('Aranıyor...', user.name, user.avatar || '');
    pushBackState(() => { hangupVoiceCall(); });
}

// ------------------------------------------
// GELEN ARAMA
// ------------------------------------------
function showIncomingVoiceCall(chatId, callerName, callerAvatar, offer, callerUid) {
    currentCallChatId = chatId;
    isCaller = false;
    pendingOffer = offer;
    pendingCallerUid = callerUid;
    pendingCallerName = callerName;

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

    const typeLabel = document.getElementById('incoming-call-type-label');
    const acceptIcon = document.getElementById('btn-accept-call-icon');
    if (typeLabel) typeLabel.textContent = 'Sesli arama';
    if (acceptIcon) acceptIcon.className = 'fa-solid fa-phone';
    if (incomingCallOverlay) incomingCallOverlay.dataset.callType = 'audio';

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
        if (!incomingCallOverlay || incomingCallOverlay.dataset.callType !== 'audio') return;
        hideIncomingCallUI();
        if (currentCallChatId) {
            await updateDoc(callDocRef(currentCallChatId), { status: 'declined' }).catch(() => {});
            const user = getCurrentUser();
          if (pendingCallerUid && user) {
                logDeclinedCall(currentCallChatId, pendingCallerUid, pendingCallerName, user.uid, 'audio');
            }
        }
        showToast("Aramayı reddettiniz");
        resetCallState();
    });
}

if (btnAcceptCall) {
    btnAcceptCall.addEventListener('click', async () => {
        if (!incomingCallOverlay || incomingCallOverlay.dataset.callType !== 'audio') return;
        hideIncomingCallUI();
        await acceptVoiceCall();
    });
}

async function acceptVoiceCall() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
        alert("Mikrofon izni verilmedi kanka: " + err.message);
        resetCallState();
        return;
    }

    window.__aurachatCallActive = true;
    pc = new RTCPeerConnection(RTC_CONFIG);
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.ontrack = (event) => {
        if (remoteAudioEl) remoteAudioEl.srcObject = event.streams[0];
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
    callStartTime = null;
    pc.onconnectionstatechange = () => {
        if (pc && pc.connectionState === 'connected' && !callStartTime) callStartTime = Date.now();
    };
    showActiveVoiceCallUI('Bağlanıyor...', pendingCallerName, '');
    pushBackState(() => { hangupVoiceCall(); });
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
// ARAMA EKRANI (video kutuları gizli, avatar/isim görünür)
// ------------------------------------------
function showActiveVoiceCallUI(statusText, displayName, displayAvatar) {
    if (activeCallOverlay) {
        activeCallOverlay.classList.remove('hidden');
        activeCallOverlay.classList.add('flex');
        activeCallOverlay.dataset.callType = 'audio';
    }
    if (remoteVideoEl) remoteVideoEl.classList.add('hidden');
    if (localVideoEl) localVideoEl.classList.add('hidden');
    if (btnToggleCam) btnToggleCam.classList.add('hidden');
    if (btnSwitchCamera) btnSwitchCamera.classList.add('hidden');

    if (voiceCallDisplay) {
        voiceCallDisplay.classList.remove('hidden');
        voiceCallDisplay.classList.add('flex');
    }
    if (voiceCallName) voiceCallName.textContent = displayName || '';
    if (voiceCallAvatar) {
        if (displayAvatar) {
            voiceCallAvatar.style.backgroundColor = '';
            voiceCallAvatar.innerHTML = `<img src="${displayAvatar}" class="w-full h-full object-cover">`;
        } else {
            voiceCallAvatar.style.backgroundColor = getUserColor(displayName || '');
            voiceCallAvatar.innerHTML = `<span>${getInitials(displayName || '')}</span>`;
        }
    }

    if (callStatusText) callStatusText.textContent = statusText;
    micEnabled = true;
}

async function hangupVoiceCall() {
    if (currentCallChatId) {
        try {
            const snap = await getDoc(callDocRef(currentCallChatId));
            const data = snap.exists() ? snap.data() : null;
            const wasRinging = data && data.status === 'ringing';

            // Konuşma süresini hemen al ve sıfırla (çift çağrılırsa ikinci seferde yazılmaz)
            const wasConnected = !!callStartTime;
            const talkSeconds = wasConnected ? Math.round((Date.now() - callStartTime) / 1000) : 0;
            callStartTime = null;

            await updateDoc(callDocRef(currentCallChatId), { status: 'ended' }).catch(() => {});

            // Bağlantı kurulmuş bir arama ise iki sohbete de süre mesajı yaz
            if (wasConnected && data && data.status === 'active' && data.callerUid && data.calleeUid) {
                const me = getCurrentUser();
                const otherUid = data.callerUid === me.uid ? data.calleeUid : data.callerUid;
                logCallDuration(currentCallChatId, me.uid, me.name, otherUid, 'audio', talkSeconds);
            }

            if (wasRinging && isCaller && data.calleeUid) {
                const user = getCurrentUser();
                logMissedCall(currentCallChatId, user.uid, user.name, data.calleeUid, 'audio');
                sendPushToUser(data.calleeUid, `${user.name}`, "☎️ Cevapsız sesli arama", {
                    chatId: currentCallChatId,
                    otherUid: user.uid,
                    otherName: user.name,
                    tag: `call_${currentCallChatId}`
                });
            }
        } catch (err) {
            console.error("Sesli arama sonlandırılırken hata:", err);
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
        if (voiceCallDisplay) {
            voiceCallDisplay.classList.add('hidden');
            voiceCallDisplay.classList.remove('flex');
        }
        resetCallState();
    }, 800);
}

function resetCallState() {
    window.__aurachatCallActive = false;
    if (pc) { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (unsubRemoteCandidates) { unsubRemoteCandidates(); unsubRemoteCandidates = null; }
    if (remoteAudioEl) remoteAudioEl.srcObject = null;
    isCaller = false;
    currentCallChatId = null;
    pendingOffer = null;
    pendingCallerUid = null;
    pendingCallerName = null;
}

if (btnHangup) {
    btnHangup.addEventListener('click', () => {
        if (!activeCallOverlay || activeCallOverlay.dataset.callType !== 'audio') return;
        hangupVoiceCall();
        popBackState();
    });
}

if (btnToggleMic) {
    btnToggleMic.addEventListener('click', () => {
        if (!localStream) return;
        micEnabled = !micEnabled;
        localStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
        const icon = btnToggleMic.querySelector('i');
        if (icon) icon.className = micEnabled ? 'fa-solid fa-microphone' : 'fa-solid fa-microphone-slash';
    });
}