// ==========================================
// ANKET (WhatsApp tarzı)
// - openPollCreator({ onSend }): "Anket oluşturun" tam ekran formu. Gönder'e basınca
//   onSend({ question, options:[{id,text}], multi }) çağrılır (mesajı chat-core gönderir).
// - buildPollHtml(msg, myUid, msgId): sohbet balonunun içi (soru, seçenekler, oy çubukları)
// - nextVotes(msg, myUid, optId): bir seçeneğe dokunulunca benim yeni oy listem
// - pollSummary(msg): sohbet listesi / cevap önizlemesi için kısa yazı
// Mesaj şekli: { type:'poll', question, options:[{id,text}], multi:bool, votes:{ uid:[optId,...] } }
// Bu dosya chat-core.js'i İÇE AKTARMAZ (döngü olmasın diye); chat-core bunu çağırır.
// ==========================================

import { pushBackState, popBackState } from "./back-handler.js";
import { escapeHtml } from "./ui-helpers.js";

const MAX_Q = 255;
const MAX_OPT = 100;
const MAX_OPTIONS = 12;

// ---------- sohbet balonu ----------
export function pollSummary(msg) {
    return '📊 ' + String((msg && msg.question) || 'Anket').slice(0, 100);
}

function votesMap(msg) {
    return (msg && msg.votes && typeof msg.votes === 'object') ? msg.votes : {};
}

export function nextVotes(msg, myUid, optId) {
    const mine = Array.isArray(votesMap(msg)[myUid]) ? votesMap(msg)[myUid] : [];
    const has = mine.includes(optId);
    if (msg.multi) return has ? mine.filter((x) => x !== optId) : mine.concat(optId);
    return has ? [] : [optId]; // tekli: aynısına tekrar dokunmak oyu geri alır
}

export function buildPollHtml(msg, myUid, msgId) {
    const opts = Array.isArray(msg.options) ? msg.options : [];
    const votes = votesMap(msg);
    const counts = {};
    let voters = 0;
    Object.keys(votes).forEach((uid) => {
        const arr = Array.isArray(votes[uid]) ? votes[uid] : [];
        if (arr.length) voters++;
        arr.forEach((id) => { counts[id] = (counts[id] || 0) + 1; });
    });
    const mine = Array.isArray(votes[myUid]) ? votes[myUid] : [];
    const maxCount = Math.max(1, ...opts.map((o) => counts[o.id] || 0));

    const rows = opts.map((o) => {
        const c = counts[o.id] || 0;
        const picked = mine.includes(o.id);
        const pct = voters ? Math.round((c / voters) * 100) : 0;
        const barW = voters ? Math.round((c / maxCount) * 100) : 0;
        const box = msg.multi
            ? `<span style="flex-shrink:0;width:20px;height:20px;border-radius:5px;border:2px solid ${picked ? '#22c55e' : 'rgba(255,255,255,.45)'};background:${picked ? '#22c55e' : 'transparent'};display:flex;align-items:center;justify-content:center;color:#04210f;font-size:11px;">${picked ? '<i class="fa-solid fa-check"></i>' : ''}</span>`
            : `<span style="flex-shrink:0;width:20px;height:20px;border-radius:9999px;border:2px solid ${picked ? '#22c55e' : 'rgba(255,255,255,.45)'};background:${picked ? '#22c55e' : 'transparent'};display:flex;align-items:center;justify-content:center;color:#04210f;font-size:11px;">${picked ? '<i class="fa-solid fa-check"></i>' : ''}</span>`;
        return `<div data-poll-opt="${escapeHtml(o.id)}" data-poll-msg="${escapeHtml(msgId)}" onclick="pollVote('${escapeHtml(msgId)}','${escapeHtml(o.id)}')" style="cursor:pointer;padding:7px 0;">
            <div style="display:flex;align-items:center;gap:10px;">
                ${box}
                <span class="break-words" style="flex:1;min-width:0;">${escapeHtml(o.text)}</span>
                <span style="flex-shrink:0;font-size:12px;opacity:.85;">${c}</span>
            </div>
            <div style="margin:5px 0 0 30px;height:5px;border-radius:9999px;background:rgba(255,255,255,.14);overflow:hidden;">
                <div style="height:100%;width:${barW}%;background:${picked ? '#22c55e' : 'rgba(255,255,255,.55)'};border-radius:9999px;transition:width .25s;"></div>
            </div>
            ${voters ? `<div style="margin:2px 0 0 30px;font-size:10px;opacity:.6;">%${pct}</div>` : ''}
        </div>`;
    }).join('');

    return `<div style="min-width:230px;max-width:300px;">
        <p class="break-words whitespace-pre-wrap" style="font-weight:600;font-size:15px;margin-bottom:2px;"><i class="fa-solid fa-square-poll-vertical" style="margin-right:6px;opacity:.85;"></i>${escapeHtml(msg.question || '')}</p>
        <p style="font-size:11px;opacity:.65;margin-bottom:4px;">${msg.multi ? 'Birden fazla seçenek seçebilirsiniz' : 'Bir seçenek seçin'}</p>
        ${rows}
        <p style="font-size:11px;opacity:.7;margin-top:2px;">${voters} oy</p>
    </div>`;
}

// ---------- "Anket oluşturun" ekranı ----------
let overlayEl = null;
let vvHandler = null;

function closeCreator(viaBack) {
    if (!overlayEl) return;
    overlayEl.remove();
    overlayEl = null;
    if (vvHandler && window.visualViewport) window.visualViewport.removeEventListener('resize', vvHandler);
    vvHandler = null;
    if (!viaBack) popBackState();
}

function smallToast(text) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'position:fixed;left:50%;bottom:110px;transform:translateX(-50%);z-index:100001;background:#233138;color:#fff;padding:10px 16px;border-radius:12px;font-size:14px;max-width:80vw;text-align:center;box-shadow:0 4px 14px rgba(0,0,0,.5);';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
}

export function openPollCreator(opts) {
    if (overlayEl) return;
    const onSend = opts && opts.onSend;
    const el = document.createElement('div');
    overlayEl = el;
    el.style.cssText = 'position:fixed;left:0;top:0;right:0;height:100%;z-index:99990;background:#0b1016;color:#e9edef;display:flex;flex-direction:column;';
    el.innerHTML = `
        <div style="display:flex;align-items:center;gap:18px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.07);flex-shrink:0;">
            <button type="button" data-poll-back aria-label="Geri" style="width:36px;height:36px;font-size:20px;color:#e9edef;"><i class="fa-solid fa-arrow-left"></i></button>
            <span style="font-size:20px;">Anket oluşturun</span>
        </div>
        <div data-poll-scroll style="flex:1;overflow-y:auto;padding:18px 18px 110px;">
            <p style="color:#9aa5ad;font-size:15px;margin:6px 0 12px;">Soru</p>
            <div>
                <input data-poll-q type="text" maxlength="${MAX_Q}" placeholder="Soru sorun" style="width:100%;box-sizing:border-box;background:transparent;border:1.5px solid #5b6770;border-radius:12px;padding:15px 16px;font-size:17px;color:#e9edef;outline:none;">
                <div data-poll-qc style="text-align:right;color:#9aa5ad;font-size:13px;margin:6px 12px 0 0;">0/${MAX_Q}</div>
            </div>
            <p style="color:#9aa5ad;font-size:15px;margin:26px 0 12px;">Seçenekler</p>
            <div data-poll-opts></div>
            <div style="height:1px;background:rgba(255,255,255,.07);margin:8px -18px 0;"></div>
            <label style="display:flex;align-items:center;justify-content:space-between;padding:22px 0 8px;font-size:17px;cursor:pointer;">
                <span>Birden çok yanıta izin ver</span>
                <span data-poll-sw style="width:60px;height:34px;border-radius:9999px;background:#22c55e;position:relative;flex-shrink:0;transition:background .2s;">
                    <span data-poll-knob style="position:absolute;top:3px;right:3px;width:28px;height:28px;border-radius:9999px;background:#0b1016;color:#22c55e;display:flex;align-items:center;justify-content:center;font-size:13px;transition:all .2s;"><i class="fa-solid fa-check"></i></span>
                </span>
            </label>
        </div>
        <button type="button" data-poll-send aria-label="Gönder" style="position:absolute;right:18px;bottom:22px;width:64px;height:64px;border-radius:20px;background:#22c55e;color:#04210f;font-size:24px;box-shadow:0 4px 14px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;"><i class="fa-solid fa-paper-plane"></i></button>
    `;
    document.body.appendChild(el);

    const qIn = el.querySelector('[data-poll-q]');
    const qCount = el.querySelector('[data-poll-qc]');
    const optsBox = el.querySelector('[data-poll-opts]');
    const sw = el.querySelector('[data-poll-sw]');
    const knob = el.querySelector('[data-poll-knob]');
    let multi = true;

    function paintSwitch() {
        sw.style.background = multi ? '#22c55e' : '#3b4650';
        knob.style.right = multi ? '3px' : '';
        knob.style.left = multi ? '' : '3px';
        knob.style.color = multi ? '#22c55e' : 'transparent';
    }
    paintSwitch();
    el.querySelector('label').addEventListener('click', (e) => { e.preventDefault(); multi = !multi; paintSwitch(); });

    qIn.addEventListener('input', () => { qCount.textContent = qIn.value.length + '/' + MAX_Q; });

    function optInputs() { return Array.from(optsBox.querySelectorAll('[data-poll-o]')); }

    function addOption(focus) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin-bottom:6px;';
        wrap.innerHTML = `
            <div style="position:relative;">
                <input data-poll-o type="text" maxlength="${MAX_OPT}" placeholder="+ Ekleyin" style="width:100%;box-sizing:border-box;background:transparent;border:1.5px solid #5b6770;border-radius:12px;padding:15px 44px 15px 16px;font-size:17px;color:#e9edef;outline:none;">
                <button type="button" data-poll-del aria-label="Sil" style="display:none;position:absolute;right:6px;top:50%;transform:translateY(-50%);width:36px;height:36px;color:#9aa5ad;font-size:15px;"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div data-poll-oc style="text-align:right;color:#9aa5ad;font-size:13px;margin:6px 12px 14px 0;">0/${MAX_OPT}</div>`;
        optsBox.appendChild(wrap);
        const inp = wrap.querySelector('[data-poll-o]');
        const cnt = wrap.querySelector('[data-poll-oc]');
        inp.addEventListener('focus', () => { inp.style.borderColor = '#22c55e'; });
        inp.addEventListener('blur', () => { inp.style.borderColor = '#5b6770'; });
        inp.addEventListener('input', () => {
            cnt.textContent = inp.value.length + '/' + MAX_OPT;
            refresh();
        });
        inp.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const all = optInputs();
            const i = all.indexOf(inp);
            if (all[i + 1]) all[i + 1].focus();
        });
        wrap.querySelector('[data-poll-del]').addEventListener('click', () => {
            if (optInputs().length <= 2) return;
            wrap.remove();
            refresh();
        });
        if (focus) inp.focus();
    }

    // Son kutu doldukça yeni boş kutu eklenir; 2'den fazlaysa dolu kutularda sil (x) düğmesi çıkar
    function refresh() {
        const all = optInputs();
        const last = all[all.length - 1];
        if (last && last.value.trim() && all.length < MAX_OPTIONS) addOption(false);
        const now = optInputs();
        now.forEach((inp) => {
            const del = inp.parentElement.querySelector('[data-poll-del]');
            del.style.display = (now.length > 2 && inp.value.trim()) ? 'block' : 'none';
        });
    }

    addOption(false);
    addOption(false);

    // Klavye açılınca ekran yüksekliği küçülsün ki gönder düğmesi klavyenin üstünde kalsın
    if (window.visualViewport) {
        vvHandler = () => { if (overlayEl) overlayEl.style.height = window.visualViewport.height + 'px'; };
        window.visualViewport.addEventListener('resize', vvHandler);
        vvHandler();
    }

    pushBackState(() => closeCreator(true));
    el.querySelector('[data-poll-back]').addEventListener('click', () => closeCreator(false));

    el.querySelector('[data-poll-send]').addEventListener('click', async () => {
        const question = qIn.value.trim();
        if (!question) { smallToast('Önce bir soru yaz'); qIn.focus(); return; }
        const seen = new Set();
        const texts = [];
        optInputs().forEach((i) => {
            const t = i.value.trim();
            if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); texts.push(t); }
        });
        if (texts.length < 2) { smallToast('En az 2 farklı seçenek gerekli'); return; }
        const options = texts.map((text, i) => ({ id: 'o' + i, text }));
        closeCreator(false);
        try { if (onSend) await onSend({ question, options, multi }); } catch (e) { smallToast('Anket gönderilemedi'); }
    });

    setTimeout(() => { if (overlayEl === el) qIn.focus(); }, 150);
}

window.openPollCreator = openPollCreator;
