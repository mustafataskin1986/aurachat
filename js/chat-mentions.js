// Grupta @ ile etiketleme: yazarken üye listesi açılır, seçilen isim mesaja eklenir.
// Mesaja { mentions: [uid...], mentionNames: [isim...] } alanları yazılır (aynı sırada).

const ALL_NAME = 'Herkes';

let inputEl = null;
let isActiveFn = () => false;
let getMembersFn = async () => [];
let popup = null;
let members = [];
let membersFor = '';
let chosen = new Map(); // isim -> uid ('*' = herkes)
let tokenStart = -1;
let shown = [];

function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function norm(s) {
    return String(s || '').toLocaleLowerCase('tr');
}

function ensurePopup() {
    if (popup) return popup;
    popup = document.createElement('div');
    popup.style.cssText = 'position:absolute;left:8px;right:8px;display:none;z-index:40;max-height:220px;overflow-y:auto;background:#1f2c34;border:1px solid rgba(255,255,255,0.12);border-radius:12px;box-shadow:0 -4px 18px rgba(0,0,0,0.45);';
    const host = document.getElementById('chat-area') || document.body;
    host.appendChild(popup);
    // Dokununca yazı kutusu odağını kaybetmesin
    popup.addEventListener('pointerdown', (e) => e.preventDefault());
    popup.addEventListener('click', (e) => {
        const row = e.target.closest('[data-mi]');
        if (!row) return;
        pick(shown[Number(row.dataset.mi)]);
    });
    return popup;
}

function hide() {
    if (popup) popup.style.display = 'none';
    tokenStart = -1;
}

function position() {
    const host = document.getElementById('chat-area');
    const row = inputEl && inputEl.parentElement;
    if (!host || !row || !popup) return;
    const hr = host.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    popup.style.bottom = Math.max(0, Math.round(hr.bottom - rr.top + 6)) + 'px';
}

function render(list) {
    ensurePopup();
    shown = list;
    popup.innerHTML = list.map((m, i) => {
        const initial = esc((m.name || '?').trim().charAt(0).toUpperCase());
        const avatar = m.uid === '*'
            ? '<span style="width:34px;height:34px;border-radius:50%;background:#128c7e;color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">@</span>'
            : `<span style="width:34px;height:34px;border-radius:50%;background:#3b4a54;color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;flex-shrink:0;">${initial}</span>`;
        const sub = m.uid === '*' ? '<span style="color:#8696a0;font-size:12px;">Tüm grup üyelerini etiketle</span>' : '';
        return `<div data-mi="${i}" style="display:flex;align-items:center;gap:10px;padding:8px 12px;color:#e9edef;font-size:15px;cursor:pointer;">${avatar}<span style="display:flex;flex-direction:column;min-width:0;"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(m.name)}</span>${sub}</span></div>`;
    }).join('');
    popup.style.display = list.length ? 'block' : 'none';
    position();
}

function pick(m) {
    if (!m || !inputEl || tokenStart < 0) return;
    const caret = inputEl.selectionStart || inputEl.value.length;
    const before = inputEl.value.slice(0, tokenStart);
    const after = inputEl.value.slice(caret);
    const insert = '@' + m.name + ' ';
    inputEl.value = before + insert + after;
    const pos = (before + insert).length;
    inputEl.setSelectionRange(pos, pos);
    chosen.set(m.name, m.uid);
    hide();
    // Yazı kutusunun yüksekliği ve gönder düğmesi güncellensin
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.focus();
}

async function loadMembers(chatId) {
    if (membersFor === chatId && members.length) return;
    try {
        members = (await getMembersFn()) || [];
        membersFor = chatId;
    } catch (e) {
        members = [];
    }
}

async function onInput() {
    if (!inputEl || !isActiveFn()) { hide(); return; }
    const caret = inputEl.selectionStart == null ? inputEl.value.length : inputEl.selectionStart;
    const upto = inputEl.value.slice(0, caret);
    const m = upto.match(/(^|\s)@([^@\n]{0,30})$/);
    if (!m) { hide(); return; }
    const query = norm(m[2]);
    tokenStart = caret - m[2].length - 1;
    await loadMembers(inputEl.dataset.mentionChat || '');
    const all = [{ uid: '*', name: ALL_NAME }].concat(members);
    const list = all.filter((x) => !query || norm(x.name).includes(query)).slice(0, 30);
    // Yazarken liste değiştiyse eski sonuçla ezme
    const nowCaret = inputEl.selectionStart == null ? inputEl.value.length : inputEl.selectionStart;
    if (nowCaret !== caret) return;
    render(list);
}

export function setupMentions(opts) {
    inputEl = opts.input;
    isActiveFn = opts.isActive;
    getMembersFn = opts.getMembers;
    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('blur', () => setTimeout(hide, 150));
    inputEl.addEventListener('keyup', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') onInput();
    });
}

// Sohbet değişince çağrılır
export function resetMentions(chatId) {
    chosen = new Map();
    members = [];
    membersFor = '';
    if (inputEl) inputEl.dataset.mentionChat = chatId || '';
    hide();
}

// Gönderilecek metinden etiketlenen kişileri çıkarır. allUids: gönderen hariç tüm üyeler
export function collectMentions(text, allUids) {
    const uids = [];
    const names = [];
    chosen.forEach((uid, name) => {
        const re = new RegExp('(^|\\s)@' + escRe(name) + '(?=$|[\\s.,;:!?)])');
        if (!re.test(text)) return;
        if (uid === '*') {
            (allUids || []).forEach((u) => { if (!uids.includes(u)) uids.push(u); });
            if (!names.includes(name)) names.push(name);
            return;
        }
        if (!uids.includes(uid)) uids.push(uid);
        if (!names.includes(name)) names.push(name);
    });
    return { uids, names };
}

export function clearChosenMentions() {
    chosen = new Map();
}

// Kaçışlı HTML içindeki @İsim parçalarını vurgular. msg.mentions ve msg.mentionNames kullanılır
export function highlightMentions(html, msg, myUid, myName) {
    const names = msg && Array.isArray(msg.mentionNames) ? msg.mentionNames : [];
    if (!names.length) return html;
    const uids = Array.isArray(msg.mentions) ? msg.mentions : [];
    const iAmMentioned = uids.includes(myUid);
    let out = html;
    names.forEach((name) => {
        const mine = iAmMentioned && (name === myName || name === ALL_NAME);
        const safe = escRe(esc(name));
        const re = new RegExp('(^|\\s|>)(@' + safe + ')(?=$|[\\s.,;:!?)<])', 'g');
        const style = mine
            ? 'color:#53bdeb;font-weight:600;background:rgba(83,189,235,0.18);border-radius:4px;padding:0 3px;'
            : 'color:#53bdeb;font-weight:600;';
        out = out.replace(re, (_, pre, tok) => `${pre}<span style="${style}">${tok}</span>`);
    });
    return out;
}
