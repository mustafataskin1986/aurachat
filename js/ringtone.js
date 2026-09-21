// ==========================================
// ARAMA SESLERİ (ses dosyası gerekmez, WebAudio ile üretilir)
//
// - Gelen arama zili (+ titreşim): startRingtone() / stopRingtone()
// - Arayan tarafta "çalıyor" sesi:  startRingback() / stopRingback()
//
// Aynı anda tek ses çalar, aynı sesi tekrar başlatmak bir şey yapmaz.
// En fazla 45 sn çalar, sonra kendiliğinden susar.
// Ses telefonun MEDYA ses seviyesinden çıkar.
// ==========================================

const MAX_RING_MS = 45000;
const RING_VOLUME = 0.25;

let ctx = null;
let master = null;
let activeKind = null; // 'ring' | 'back' | null
let loopTimer = null;
let stopTimer = null;
let vibrateTimer = null;

function getCtx() {
    if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try {
            ctx = new AC();
            master = ctx.createGain();
            master.gain.value = RING_VOLUME;
            master.connect(ctx.destination);
        } catch (e) {
            ctx = null;
            return null;
        }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
}

// Belirli bir zamanda kısa bir ton çalar (freqs: aynı anda çalan frekanslar)
function beep(freqs, startAt, durSec) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, startAt);
    g.gain.linearRampToValueAtTime(1, startAt + 0.02);
    g.gain.setValueAtTime(1, startAt + durSec - 0.03);
    g.gain.linearRampToValueAtTime(0, startAt + durSec);
    g.connect(master);
    freqs.forEach((f) => {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        o.connect(g);
        o.start(startAt);
        o.stop(startAt + durSec + 0.05);
    });
}

function schedulePattern(kind) {
    const c = getCtx();
    if (!c) return;
    const t = c.currentTime + 0.05;
    if (kind === 'ring') {
        // Gelen arama: kısa iki çift ton
        beep([659, 784], t, 0.4);
        beep([659, 784], t + 0.55, 0.4);
    } else {
        // Arayan taraf: 425 Hz, 1 sn ötüp 3 sn susar
        beep([425], t, 1.0);
    }
}

function startTone(kind) {
    if (activeKind === kind) return;
    stopTone();

    const c = getCtx();
    if (!c) return;
    activeKind = kind;
    master.gain.setValueAtTime(RING_VOLUME, c.currentTime);

    schedulePattern(kind);
    loopTimer = setInterval(() => schedulePattern(kind), kind === 'ring' ? 3000 : 4000);
    stopTimer = setTimeout(stopTone, MAX_RING_MS);

    if (kind === 'ring' && navigator.vibrate) {
        navigator.vibrate([400, 150, 400]);
        vibrateTimer = setInterval(() => navigator.vibrate([400, 150, 400]), 3000);
    }
}

function stopTone() {
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    if (vibrateTimer) {
        clearInterval(vibrateTimer);
        vibrateTimer = null;
        if (navigator.vibrate) navigator.vibrate(0);
    }
    if (activeKind && ctx && master) {
        // Sıradaki ton daha çalmaya başlamadan hemen sustur
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setValueAtTime(0, ctx.currentTime);
    }
    activeKind = null;
}

export function startRingtone() { startTone('ring'); }
export function stopRingtone() { if (activeKind === 'ring') stopTone(); }
export function startRingback() { startTone('back'); }
export function stopRingback() { if (activeKind === 'back') stopTone(); }
