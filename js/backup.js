// ==========================================
// GOOGLE DRIVE YEDEĞİ
// - Yedek, kullanıcının Drive'ında gizli "uygulama verisi" klasörüne (appDataFolder) yazılır
// - Drive izni giriş sırasında DEĞİL, sadece "Yedekle / Geri yükle"ye basılınca istenir
// - Yedeklenenler: sohbet mesajları (metin + bilgi alanları), yıldızlı mesajlar ve cihaz ayarları (sohbet temaları, arka planlar, siyah arayüz)
// - Telefondaki belgeler (İndirilenler/AuraChat) de ayrı dosyalar olarak yedeklenir
// - Telefondaki (Galeri) resimler de ayrı dosyalar olarak yedeklenir; geri yüklemede telefonda olmayanlar indirilir
// ==========================================

import { db, auth } from "./firebase-init.js";
import { collection, doc, getDoc, getDocs, setDoc, deleteField, serverTimestamp, query, orderBy, limit, startAfter, Timestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { GoogleAuthProvider, reauthenticateWithPopup } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { showToast, getCurrentUser, resetChatSession, listGalleryImages, readGalleryImageBase64, writeGalleryImageBase64, listDocumentFiles, readDocumentBase64, writeDocumentBase64 } from "./chat-core.js";
import { auraAccent } from "./aura-dialog.js";
import { pushBackState, popBackState } from "./back-handler.js";

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const BACKUP_NAME = 'aurachat-yedek.json';
const LAST_KEY = 'aura_backup_last';

// ---------- Drive erişim anahtarı ----------
function isNative() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

function getTokenNative() {
    return new Promise((resolve, reject) => {
        if (!window.AuraDrive || !window.AuraDrive.requestToken) {
            reject(new Error('Bu özellik için uygulamanın yeni sürümü (APK) gerekli.'));
            return;
        }
        let wasAway = false;
        let grace = null;
        const cleanup = () => {
            clearTimeout(t);
            clearTimeout(grace);
            document.removeEventListener('visibilitychange', onVis);
            window.removeEventListener('focus', onFocus);
            window.removeEventListener('blur', onBlur);
            window.__auraDriveCb = null;
        };
        // Google ekranı açılınca uygulama arka plana gider. Geri dönünce kısa süre içinde cevap gelmediyse kişi vazgeçmiştir
        const back = () => {
            if (!wasAway) return;
            clearTimeout(grace);
            grace = setTimeout(() => {
                if (!window.__auraDriveCb) return;
                cleanup();
                reject(new Error('Google izni iptal edildi.'));
            }, 2500);
        };
        const onVis = () => { if (document.hidden) { wasAway = true; clearTimeout(grace); } else back(); };
        const onBlur = () => { wasAway = true; clearTimeout(grace); };
        const onFocus = () => back();
        const t = setTimeout(() => { cleanup(); reject(new Error('Google izni zaman aşımına uğradı.')); }, 120000);
        document.addEventListener('visibilitychange', onVis);
        window.addEventListener('focus', onFocus);
        window.addEventListener('blur', onBlur);
        window.__auraDriveCb = (token, err) => {
            cleanup();
            if (token) resolve(token); else reject(new Error(err || 'Drive izni alınamadı.'));
        };
        window.AuraDrive.requestToken();
    });
}

async function getTokenWeb() {
    const user = auth.currentUser;
    if (!user) throw new Error('Giriş yapılmamış.');
    const provider = new GoogleAuthProvider();
    provider.addScope(DRIVE_SCOPE);
    if (user.email) provider.setCustomParameters({ login_hint: user.email, prompt: 'consent' });
    const result = await reauthenticateWithPopup(user, provider);
    const cred = GoogleAuthProvider.credentialFromResult(result);
    if (!cred || !cred.accessToken) throw new Error('Drive izni alınamadı.');
    return cred.accessToken;
}

// Google izin ekranından vazgeçilmesi (geri tuşu, pencereyi kapatma, "iptal") hata sayılmaz
function isCancelError(e) {
    const t = String((e && (e.code || e.message)) || e || '').toLowerCase();
    return /cancel|iptal|vazge|12501|12502|closed-by-user|popup-closed|dismiss|reddedil|denied|access_denied/.test(t);
}

async function getToken() {
    try {
        return await (isNative() ? getTokenNative() : getTokenWeb());
    } catch (e) {
        if (isCancelError(e)) e.userCancelled = true;
        throw e;
    }
}

// ---------- Drive REST ----------
async function driveFetch(token, url, opts) {
    const res = await fetch(url, Object.assign({}, opts, {
        headers: Object.assign({ Authorization: 'Bearer ' + token }, (opts && opts.headers) || {})
    }));
    if (!res.ok) {
        let msg = 'Drive hatası (' + res.status + ')';
        try {
            const j = await res.json();
            if (j && j.error && j.error.message) msg += ': ' + j.error.message;
        } catch (e) {}
        throw new Error(msg);
    }
    return res;
}

async function findBackupFile(token) {
    const q = encodeURIComponent("name='" + BACKUP_NAME + "'");
    const res = await driveFetch(token, 'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=' + q + '&fields=files(id,modifiedTime,size)&pageSize=1');
    const j = await res.json();
    return (j.files && j.files[0]) || null;
}

async function uploadBackup(token, json) {
    const existing = await findBackupFile(token);
    const boundary = 'aura' + Date.now();
    const meta = existing ? { name: BACKUP_NAME } : { name: BACKUP_NAME, parents: ['appDataFolder'] };
    const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta)
        + '\r\n--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + json
        + '\r\n--' + boundary + '--';
    const url = existing
        ? 'https://www.googleapis.com/upload/drive/v3/files/' + existing.id + '?uploadType=multipart'
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    await driveFetch(token, url, {
        method: existing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
        body
    });
}

async function downloadBackup(token) {
    const f = await findBackupFile(token);
    if (!f) return null;
    const res = await driveFetch(token, 'https://www.googleapis.com/drive/v3/files/' + f.id + '?alt=media');
    return { text: await res.text(), modifiedTime: f.modifiedTime };
}

// ---------- Resim yedeği (her resim Drive appData içinde ayrı dosya) ----------
const IMG_PREFIX = 'aurachat-img-';
const DOC_PREFIX = 'aurachat-doc-';

async function listDriveImages(token, prefix) {
    prefix = prefix || IMG_PREFIX;
    const out = new Map();
    let pageToken = '';
    do {
        const q = encodeURIComponent("name contains '" + prefix + "'");
        const url = 'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=' + q
            + '&fields=nextPageToken,files(id,name)&pageSize=1000' + (pageToken ? '&pageToken=' + pageToken : '');
        const j = await (await driveFetch(token, url)).json();
        (j.files || []).forEach((f) => { if (f.name && f.name.indexOf(prefix) === 0) out.set(f.name.slice(prefix.length), f.id); });
        pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out;
}

function b64ToBytes(b64) {
    const clean = String(b64).indexOf(',') >= 0 ? String(b64).split(',')[1] : String(b64);
    const bin = atob(clean);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
}

function bytesToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
}

async function uploadDriveImage(token, name, b64, prefix, mime) {
    const boundary = 'auraimg' + Date.now() + Math.random().toString(36).slice(2);
    const meta = { name: (prefix || IMG_PREFIX) + name, parents: ['appDataFolder'] };
    const body = new Blob([
        '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n',
        '--' + boundary + '\r\nContent-Type: ' + (mime || 'image/jpeg') + '\r\n\r\n',
        b64ToBytes(b64),
        '\r\n--' + boundary + '--'
    ]);
    await driveFetch(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
        body
    });
}

// Kuyruktaki işleri en fazla 3 paralel çalıştırır
async function runPool(items, worker, onStep) {
    let i = 0, ok = 0, fail = 0;
    const run = async () => {
        while (i < items.length) {
            const it = items[i++];
            try { await worker(it); ok++; } catch (e) { fail++; }
            if (onStep) onStep(ok + fail, items.length);
        }
    };
    await Promise.all([run(), run(), run()]);
    return { ok, fail };
}

async function backupImages(token, p, from, to) {
    let local = [];
    try { local = await listGalleryImages(); } catch (e) {}
    if (!local.length) return { sent: 0, had: 0, fail: 0 };
    const onDrive = await listDriveImages(token);
    const todo = local.filter((x) => !onDrive.has(x.name));
    const r = await runPool(todo, async (x) => {
        const b64 = await readGalleryImageBase64(x.path);
        if (!b64) throw new Error('okunamadı');
        await uploadDriveImage(token, x.name, b64);
    }, (n, total) => p.set(from + (n / Math.max(1, total)) * (to - from), 'Resimler yükleniyor… ' + n + '/' + total));
    return { sent: r.ok, had: local.length - todo.length, fail: r.fail };
}

async function restoreImages(token, p, from, to) {
    let local = new Set();
    try { (await listGalleryImages()).forEach((x) => local.add(x.name)); } catch (e) {}
    const onDrive = await listDriveImages(token);
    const todo = [];
    onDrive.forEach((id, name) => { if (!local.has(name)) todo.push({ id, name }); });
    const r = await runPool(todo, async (x) => {
        const res = await driveFetch(token, 'https://www.googleapis.com/drive/v3/files/' + x.id + '?alt=media');
        const ok = await writeGalleryImageBase64(x.name, bytesToB64(await res.arrayBuffer()));
        if (!ok) throw new Error('yazılamadı');
    }, (n, total) => p.set(from + (n / Math.max(1, total)) * (to - from), 'Resimler indiriliyor… ' + n + '/' + total));
    return { got: r.ok, had: local.size, fail: r.fail, driveCount: onDrive.size };
}

// ---------- Belge yedeği (İndirilenler/AuraChat içindeki dosyalar) ----------
async function backupDocs(token, p, from, to) {
    let local = [];
    try { local = await listDocumentFiles(); } catch (e) {}
    if (!local.length) return { sent: 0, had: 0, fail: 0 };
    const onDrive = await listDriveImages(token, DOC_PREFIX);
    const todo = local.filter((x) => !onDrive.has(x.name));
    const r = await runPool(todo, async (x) => {
        const b64 = await readDocumentBase64(x.name);
        if (!b64) throw new Error('okunamadı');
        await uploadDriveImage(token, x.name, b64, DOC_PREFIX, 'application/octet-stream');
    }, (n, total) => p.set(from + (n / Math.max(1, total)) * (to - from), 'Belgeler yükleniyor… ' + n + '/' + total));
    return { sent: r.ok, had: local.length - todo.length, fail: r.fail };
}

async function restoreDocs(token, p, from, to) {
    let local = new Set();
    try { (await listDocumentFiles()).forEach((x) => local.add(x.name)); } catch (e) {}
    const onDrive = await listDriveImages(token, DOC_PREFIX);
    const todo = [];
    onDrive.forEach((id, name) => { if (!local.has(name)) todo.push({ id, name }); });
    const r = await runPool(todo, async (x) => {
        const res = await driveFetch(token, 'https://www.googleapis.com/drive/v3/files/' + x.id + '?alt=media');
        const ok = await writeDocumentBase64(x.name, bytesToB64(await res.arrayBuffer()));
        if (!ok) throw new Error('yazılamadı');
    }, (n, total) => p.set(from + (n / Math.max(1, total)) * (to - from), 'Belgeler indiriliyor… ' + n + '/' + total));
    return { got: r.ok, fail: r.fail, driveCount: onDrive.size };
}

// ---------- Cihaz ayarları (sohbet temaları, arka planlar, siyah arayüz) ----------
function collectSettings() {
    const out = {};
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k) continue;
            if (k.indexOf('aurachat_theme_') === 0 || k === 'aurachat_black_ui') out[k] = localStorage.getItem(k);
        }
    } catch (e) {}
    return out;
}

// Cihazda zaten olan ayarın üstüne yazılmaz; sadece eksikler eklenir
function restoreSettings(settings) {
    let n = 0;
    try {
        Object.keys(settings || {}).forEach((k) => {
            if (!(k.indexOf('aurachat_theme_') === 0 || k === 'aurachat_black_ui')) return;
            if (localStorage.getItem(k) !== null) return;
            try { localStorage.setItem(k, String(settings[k])); n++; } catch (e) {}
        });
    } catch (e) {}
    return n;
}

// ---------- İlerleme penceresi ----------
function openProgress(title, doneTitle) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:320;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.65);';
    const box = document.createElement('div');
    box.style.cssText = 'width:100%;max-width:340px;border-radius:24px;padding:24px;background:#111b21;border:1px solid rgba(255,255,255,.08);color:#e9edef;';
    const h = document.createElement('div');
    h.textContent = title;
    h.style.cssText = 'font-size:18px;margin-bottom:14px;';
    const bar = document.createElement('div');
    bar.style.cssText = 'height:6px;border-radius:3px;background:rgba(255,255,255,.12);overflow:hidden;';
    const fill = document.createElement('div');
    fill.style.cssText = 'height:100%;width:8%;background:' + auraAccent() + ';transition:width .25s;';
    bar.appendChild(fill);
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:13px;color:#8696a0;margin-top:12px;min-height:18px;';
    box.appendChild(h); box.appendChild(bar); box.appendChild(msg);
    let hidden = false;
    // Arka plandayken ekranın üstünde (durum çubuğunun altında) tema renginde ilerleme çubuğu
    const topBar = document.createElement('div');
    topBar.style.cssText = 'position:fixed;top:0;left:0;height:3px;width:0;z-index:400;background:' + auraAccent() + ';transition:width .25s;pointer-events:none;';
    const bgRow = document.createElement('div');
    bgRow.style.cssText = 'display:flex;justify-content:flex-end;margin-top:16px;';
    const bgBtn = document.createElement('button');
    bgBtn.type = 'button';
    bgBtn.textContent = 'Arka planda devam et';
    bgBtn.style.cssText = 'background:none;border:1px solid ' + auraAccent() + ';border-radius:999px;color:' + auraAccent() + ';font-size:14px;padding:8px 18px;cursor:pointer;';
    bgBtn.addEventListener('click', () => { hidden = true; try { overlay.remove(); } catch (e) {} try { document.body.appendChild(topBar); topBar.style.width = fill.style.width; } catch (e2) {} });
    bgRow.appendChild(bgBtn);
    box.appendChild(bgRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    return {
        set(pct, text) {
            if (hidden) { topBar.style.width = Math.max(4, Math.min(100, pct)) + '%'; return; }
            fill.style.width = Math.max(4, Math.min(100, pct)) + '%';
            if (text != null) msg.textContent = text;
        },
        close() { try { overlay.remove(); } catch (e) {} try { topBar.remove(); } catch (e) {} },
        // Sonucu aynı pencerede göster, altına Kapat butonu koy (pencere kendiliğinden kapanmaz)
        done(text, isError) {
            if (hidden) {
                hidden = false;
                try { topBar.style.width = '100%'; setTimeout(() => { try { topBar.remove(); } catch (e3) {} }, 300); } catch (e) {}
                try { document.body.appendChild(overlay); } catch (e) {}
            }
            h.textContent = isError ? 'İşlem tamamlanamadı' : (doneTitle || h.textContent);
            try { bgRow.remove(); } catch (e) {}
            fill.style.width = '100%';
            fill.style.background = isError ? '#ef4444' : auraAccent();
            msg.textContent = text;
            msg.style.color = isError ? '#fca5a5' : '#e9edef';
            msg.style.fontSize = '14px';
            msg.style.lineHeight = '1.4';
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:flex-end;margin-top:18px;';
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = 'Tamam';
            b.style.cssText = 'background:none;border:1px solid ' + auraAccent() + ';border-radius:999px;color:' + auraAccent() + ';font-size:16px;padding:9px 22px;cursor:pointer;';
            b.addEventListener('click', () => { try { overlay.remove(); } catch (e) {} });
            row.appendChild(b);
            box.appendChild(row);
        }
    };
}

// ---------- Veri toplama ----------
function stripValue(v) {
    if (v == null) return v;
    if (v instanceof Timestamp) return { __ts: v.toMillis() };
    if (Array.isArray(v)) return v.map(stripValue);
    if (typeof v === 'object') {
        const o = {};
        Object.keys(v).forEach((k) => { o[k] = stripValue(v[k]); });
        return o;
    }
    return v;
}

function reviveValue(v) {
    if (v == null) return v;
    if (Array.isArray(v)) return v.map(reviveValue);
    if (typeof v === 'object') {
        if (typeof v.__ts === 'number' && Object.keys(v).length === 1) return Timestamp.fromMillis(v.__ts);
        const o = {};
        Object.keys(v).forEach((k) => { o[k] = reviveValue(v[k]); });
        return o;
    }
    return v;
}

// Resim/belge içeriği yedeğe girmesin (çok yer kaplar), geri kalan her şey girsin
const HEAVY_FIELDS = ['imageUrl', 'images', 'fileData', 'audioUrl', 'voiceData'];

async function collectMessages(chatId, clearedMs, onCount) {
    const out = [];
    let last = null;
    for (;;) {
        const q = last
            ? query(collection(db, 'chats', chatId, 'messages'), orderBy('createdAt', 'asc'), startAfter(last), limit(500))
            : query(collection(db, 'chats', chatId, 'messages'), orderBy('createdAt', 'asc'), limit(500));
        const snap = await getDocs(q);
        if (snap.empty) break;
        snap.forEach((d) => {
            const data = d.data();
            const ms = data.createdAt && data.createdAt.toMillis ? data.createdAt.toMillis() : 0;
            if (clearedMs && ms <= clearedMs) return;
            const copy = Object.assign({}, data);
            HEAVY_FIELDS.forEach((f) => { delete copy[f]; });
            out.push({ id: d.id, data: stripValue(copy) });
        });
        last = snap.docs[snap.docs.length - 1];
        if (onCount) onCount(out.length);
        if (snap.size < 500) break;
    }
    return out;
}

async function buildBackup(me, p) {
    const chatsSnap = await getDocs(collection(db, 'users', me, 'chats'));
    const chats = [];
    chatsSnap.forEach((d) => chats.push({ id: d.id, data: d.data() }));
    const result = { app: 'AuraChat', version: 1, uid: me, createdAt: Date.now(), chats: [], starred: [], settings: collectSettings() };
    let done = 0;
    for (const c of chats) {
        const cleared = c.data.clearedAt && c.data.clearedAt.toMillis ? c.data.clearedAt.toMillis() : 0;
        p.set(10 + (done / Math.max(1, chats.length)) * 68, 'Sohbetler okunuyor… ' + (done + 1) + '/' + chats.length);
        let msgs = [];
        try { msgs = await collectMessages(c.id, cleared); } catch (e) { msgs = []; }
        result.chats.push({ id: c.id, clearedAt: cleared || null, messages: msgs });
        done++;
    }
    try {
        const st = await getDocs(collection(db, 'users', me, 'starred'));
        st.forEach((d) => result.starred.push({ id: d.id, data: stripValue(d.data()) }));
    } catch (e) {}
    return result;
}

// ---------- Ana işlemler ----------
let busy = false;

function fmtDate(ms) {
    try { return new Date(ms).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; }
}

function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
}

async function doBackup() {
    const user = getCurrentUser();
    if (!user) { showToast('Önce giriş yapmalısın'); return; }
    const p = openProgress('Drive\'a yedekleniyor', 'Yedeklendi');
    try {
        p.set(4, 'Google izni isteniyor…');
        const token = await getToken();
        markDriveAllowed();
        const data = await buildBackup(user.uid, p);
        p.set(80, 'Drive\'a yükleniyor…');
        const json = JSON.stringify(data);
        await uploadBackup(token, json);
        let imgInfo = { sent: 0, had: 0, fail: 0 };
        try { imgInfo = await backupImages(token, p, 82, 94); } catch (e) { imgInfo.fail = 1; }
        let docInfo = { sent: 0, had: 0, fail: 0 };
        try { docInfo = await backupDocs(token, p, 94, 99); } catch (e) { docInfo.fail = 1; }
        const total = data.chats.reduce((a, c) => a + c.messages.length, 0);
        try { localStorage.setItem(LAST_KEY, JSON.stringify({ t: Date.now(), size: json.length, msgs: total })); } catch (e) {}
        p.set(100, 'Tamamlandı');
        let doneTxt = 'Yedeklendi: ' + total + ' mesaj, ' + fmtSize(json.length);
        const imgTotal = imgInfo.sent + imgInfo.had;
        if (imgTotal || imgInfo.fail) doneTxt += ', ' + imgTotal + ' resim' + (imgInfo.fail ? ' (' + imgInfo.fail + ' resim yüklenemedi, tekrar dene)' : '');
        const docTotal = docInfo.sent + docInfo.had;
        if (docTotal || docInfo.fail) doneTxt += ', ' + docTotal + ' belge' + (docInfo.fail ? ' (' + docInfo.fail + ' belge yüklenemedi, tekrar dene)' : '');
        const setCount = Object.keys(data.settings || {}).length;
        if (setCount) doneTxt += ', ' + setCount + ' ayar';
        p.done(doneTxt);
    } catch (e) {
        if (e && e.userCancelled) { p.close(); return; }
        p.done(String((e && e.message) || e || 'Yedekleme başarısız'), true);
    }
}

async function doRestore() {
    const user = getCurrentUser();
    if (!user) { showToast('Önce giriş yapmalısın'); return; }
    const p = openProgress('Yedekten geri yükleniyor', 'Geri yüklendi');
    try {
        p.set(4, 'Google izni isteniyor…');
        const token = await getToken();
        markDriveAllowed();
        p.set(10, 'Yedek indiriliyor…');
        const dl = await downloadBackup(token);
        if (!dl) { p.done('Drive\'da yedek bulunamadı', true); return; }
        const data = JSON.parse(dl.text);
        if (!data || data.app !== 'AuraChat' || data.uid !== user.uid) {
            p.done('Bu yedek bu hesaba ait değil', true);
            return;
        }
        let restored = 0, failed = 0, skippedCleared = 0, rowsMade = 0, existing = 0;
        let firstErr = '';
        let idx = 0;
        for (const c of data.chats) {
            p.set(15 + (idx / Math.max(1, data.chats.length)) * 78, 'Sohbet ' + (idx + 1) + '/' + data.chats.length);
            idx++;
            // Şu an sunucuda olan mesajları bul, sadece eksikleri yaz
            const have = new Set();
            try {
                const snap = await getDocs(collection(db, 'chats', c.id, 'messages'));
                snap.forEach((d) => have.add(d.id));
            } catch (e) {}
            // Sohbet bende silinmiş/temizlenmişse (sunucuda mesajlar durur ama gizlidir) yedekteki duruma döndür
            let myClear = 0;
            let rowExists = false;
            try {
                const s0 = await getDoc(doc(db, 'users', user.uid, 'chats', c.id));
                rowExists = s0.exists();
                if (rowExists && s0.data().clearedAt && s0.data().clearedAt.toMillis) myClear = s0.data().clearedAt.toMillis();
            } catch (e) {}
            const backupClear = c.clearedAt || 0;
            let unhid = false;
            if (myClear > backupClear || !rowExists) {
                try {
                    const lastMsg = c.messages.length ? reviveValue(c.messages[c.messages.length - 1].data) : null;
                    const lastText = lastMsg ? (lastMsg.type === 'image' ? '📷 Fotoğraf' : String(lastMsg.text || '')).slice(0, 100) : '';
                    const rowPatch = {
                        clearedAt: backupClear ? Timestamp.fromMillis(backupClear) : deleteField(),
                        keepRow: true
                    };
                    const parts0 = String(c.id).split('_');
                    if (parts0.length === 2 && parts0.includes(user.uid)) {
                        rowPatch.otherUid = parts0[0] === user.uid ? parts0[1] : parts0[0];
                        if (lastMsg) {
                            rowPatch.lastMessage = lastText;
                            rowPatch.lastMessageTime = lastMsg.createdAt || serverTimestamp();
                            rowPatch.lastSenderUid = lastMsg.senderUid || rowPatch.otherUid;
                            rowPatch.updatedAt = lastMsg.createdAt || serverTimestamp();
                        }
                        rowPatch.unreadCount = 0;
                    }
                    // Önce cihazdaki temizleme işaretini düzelt (liste güncellenince açılan hazırlık eski işareti okumasın)
                    try {
                        if (backupClear) localStorage.setItem('aura_clr_' + user.uid + '_' + c.id, String(backupClear));
                        else localStorage.removeItem('aura_clr_' + user.uid + '_' + c.id);
                    } catch (e) {}
                    await resetChatSession(c.id);
                    await setDoc(doc(db, 'users', user.uid, 'chats', c.id), rowPatch, { merge: true });
                    await resetChatSession(c.id);
                    myClear = backupClear;
                    unhid = true;
                    rowsMade++;
                } catch (e) {
                    if (!firstErr) firstErr = 'liste: ' + String((e && (e.code || e.message)) || e);
                }
            }
            for (const m of c.messages) {
                if (have.has(m.id)) { existing++; continue; }
                const d = reviveValue(m.data);
                const ms = d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : 0;
                if (myClear && ms <= myClear) { skippedCleared++; continue; }
                try {
                    await setDoc(doc(db, 'chats', c.id, 'messages', m.id), d);
                    restored++;
                } catch (e) {
                    failed++;
                    if (!firstErr) firstErr = String((e && (e.code || e.message)) || e);
                }
            }
        }
        for (const s of (data.starred || [])) {
            try { await setDoc(doc(db, 'users', user.uid, 'starred', s.id), reviveValue(s.data), { merge: true }); } catch (e) {}
        }
        const setRestored = restoreSettings(data.settings);
        let imgR = { got: 0, had: 0, fail: 0, driveCount: 0 };
        try { imgR = await restoreImages(token, p, 95, 98); } catch (e) { imgR.fail = 1; }
        let docR = { got: 0, fail: 0, driveCount: 0 };
        try { docR = await restoreDocs(token, p, 98, 99); } catch (e) { docR.fail = 1; }
        p.set(100, 'Tamamlandı');
        let txt = restored + ' mesaj geri yüklendi';
        if (imgR.got) txt += ', ' + imgR.got + ' resim telefona indirildi';
        else if (imgR.driveCount) txt += ', resimler telefonda zaten vardı';
        if (imgR.fail) txt += ', ' + imgR.fail + ' resim indirilemedi';
        if (docR.got) txt += ', ' + docR.got + ' belge telefona indirildi';
        if (docR.fail) txt += ', ' + docR.fail + ' belge indirilemedi';
        if (setRestored) txt += ', ' + setRestored + ' ayar geri geldi';
        if (existing) txt += ', ' + existing + ' mesaj zaten vardı';
        if (rowsMade) txt += ', ' + rowsMade + ' sohbet geri getirildi';
        if (failed) txt += ', ' + failed + ' mesaj yazılamadı';
        if (firstErr) txt += ' (hata: ' + firstErr + ')';
        if (restored || rowsMade || imgR.got || docR.got || setRestored) txt += '. Uygulamayı kapatıp açarsan görünür.';
        p.done(txt);
    } catch (e) {
        if (e && e.userCancelled) { p.close(); return; }
        p.done(String((e && e.message) || e || 'Geri yükleme başarısız'), true);
    }
}

function driveAllowed() {
    try { return localStorage.getItem('aura_drive_ok') === '1'; } catch (e) { return false; }
}

function markDriveAllowed() {
    try { localStorage.setItem('aura_drive_ok', '1'); } catch (e) {}
}

function openBackupDialog(info) {
    return new Promise((resolve) => {
        const black = document.documentElement.hasAttribute('data-aura-black');
        const accent = auraAccent();
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.6);';
        const box = document.createElement('div');
        box.style.cssText = 'width:100%;max-width:360px;border-radius:28px;padding:28px 24px 20px;box-shadow:0 10px 40px rgba(0,0,0,.6);'
            + 'background:' + (black ? '#000' : '#111b21') + ';border:1px solid rgba(255,255,255,.08);';

        const h = document.createElement('div');
        h.textContent = 'Google Drive yedeği';
        h.style.cssText = 'color:#e9edef;font-size:20px;line-height:1.3;margin:0 4px 6px;';
        box.appendChild(h);

        if (!driveAllowed()) {
            const note = document.createElement('div');
            note.textContent = 'İlk yedekleme için sizden bir kere izin istenecektir. Sonraki yedekleme ve geri yükleme işlemlerinde izin istenmeyecektir.';
            note.style.cssText = 'color:#8696a0;font-size:12px;line-height:1.4;margin:0 4px 14px;';
            box.appendChild(note);
        } else {
            h.style.marginBottom = '14px';
        }

        let done = false;
        const finish = (id, fromBack) => {
            if (done) return;
            done = true;
            overlay.remove();
            if (!fromBack) popBackState();
            resolve(id);
        };

        const mkLeft = (label, id) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.style.cssText = 'display:block;width:100%;text-align:left;background:none;border:0;color:' + accent + ';font-size:17px;padding:12px 4px;cursor:pointer;';
            b.addEventListener('click', () => finish(id, false));
            return b;
        };
        box.appendChild(mkLeft('Şimdi yedekle', 'backup'));
        box.appendChild(mkLeft('Geri yükle', 'restore'));

        if (info) {
            const inf = document.createElement('div');
            inf.textContent = info;
            inf.style.cssText = 'color:#8696a0;font-size:13px;line-height:1.4;margin:6px 4px 0;';
            box.appendChild(inf);
        }

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;justify-content:flex-end;margin-top:18px;';
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = 'Kapat';
        close.style.cssText = 'background:none;border:1px solid ' + accent + ';border-radius:999px;color:' + accent + ';font-size:16px;padding:9px 22px;cursor:pointer;';
        close.addEventListener('click', () => finish('cancel', false));
        row.appendChild(close);
        box.appendChild(row);

        overlay.appendChild(box);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) finish('cancel', false); });
        document.body.appendChild(overlay);
        pushBackState(() => finish('cancel', true));
    });
}

export async function openBackupMenu() {
    if (busy) return;
    let info = '';
    try {
        const l = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
        if (l) info = 'Son yedek: ' + fmtDate(l.t) + ' · ' + l.msgs + ' mesaj · ' + fmtSize(l.size);
    } catch (e) {}
    const id = await openBackupDialog(info);
    if (id !== 'backup' && id !== 'restore') return;
    busy = true;
    try {
        if (id === 'backup') await doBackup(); else await doRestore();
    } finally {
        busy = false;
    }
}

window.__auraOpenBackup = openBackupMenu;
