// ==========================================
// GOOGLE DRIVE YEDEĞİ
// - Yedek, kullanıcının Drive'ında gizli "uygulama verisi" klasörüne (appDataFolder) yazılır
// - Drive izni giriş sırasında DEĞİL, sadece "Yedekle / Geri yükle"ye basılınca istenir
// - Yedeklenenler: sohbet mesajları (metin + bilgi alanları) ve yıldızlı mesajlar
// - Resim/belge içeriği yedeğe girmez (zaten Galeri / İndirilenler klasöründe)
// ==========================================

import { db, auth } from "./firebase-init.js";
import { collection, doc, getDoc, getDocs, setDoc, query, orderBy, limit, startAfter, Timestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { GoogleAuthProvider, reauthenticateWithPopup } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { showToast, getCurrentUser } from "./chat-core.js";
import { auraDialog, auraAccent } from "./aura-dialog.js";

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
        const t = setTimeout(() => reject(new Error('Google izni zaman aşımına uğradı.')), 120000);
        window.__auraDriveCb = (token, err) => {
            clearTimeout(t);
            window.__auraDriveCb = null;
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
    const result = await reauthenticateWithPopup(user, provider);
    const cred = GoogleAuthProvider.credentialFromResult(result);
    if (!cred || !cred.accessToken) throw new Error('Drive izni alınamadı.');
    return cred.accessToken;
}

async function getToken() {
    return isNative() ? getTokenNative() : getTokenWeb();
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

// ---------- İlerleme penceresi ----------
function openProgress(title) {
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
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    return {
        set(pct, text) {
            fill.style.width = Math.max(4, Math.min(100, pct)) + '%';
            if (text != null) msg.textContent = text;
        },
        close() { try { overlay.remove(); } catch (e) {} }
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
    const result = { app: 'AuraChat', version: 1, uid: me, createdAt: Date.now(), chats: [], starred: [] };
    let done = 0;
    for (const c of chats) {
        const cleared = c.data.clearedAt && c.data.clearedAt.toMillis ? c.data.clearedAt.toMillis() : 0;
        p.set(10 + (done / Math.max(1, chats.length)) * 75, 'Sohbetler okunuyor… ' + (done + 1) + '/' + chats.length);
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
    const p = openProgress('Drive\'a yedekleniyor');
    try {
        p.set(4, 'Google izni isteniyor…');
        const token = await getToken();
        const data = await buildBackup(user.uid, p);
        p.set(90, 'Drive\'a yükleniyor…');
        const json = JSON.stringify(data);
        await uploadBackup(token, json);
        const total = data.chats.reduce((a, c) => a + c.messages.length, 0);
        try { localStorage.setItem(LAST_KEY, JSON.stringify({ t: Date.now(), size: json.length, msgs: total })); } catch (e) {}
        p.set(100, 'Tamamlandı');
        p.close();
        showToast('Yedeklendi: ' + total + ' mesaj, ' + fmtSize(json.length), 3500);
    } catch (e) {
        p.close();
        showToast(String((e && e.message) || e || 'Yedekleme başarısız'), 4500);
    }
}

async function doRestore() {
    const user = getCurrentUser();
    if (!user) { showToast('Önce giriş yapmalısın'); return; }
    const p = openProgress('Yedekten geri yükleniyor');
    try {
        p.set(4, 'Google izni isteniyor…');
        const token = await getToken();
        p.set(10, 'Yedek indiriliyor…');
        const dl = await downloadBackup(token);
        if (!dl) { p.close(); showToast('Drive\'da yedek bulunamadı', 3500); return; }
        const data = JSON.parse(dl.text);
        if (!data || data.app !== 'AuraChat' || data.uid !== user.uid) {
            p.close();
            showToast('Bu yedek bu hesaba ait değil', 3500);
            return;
        }
        let restored = 0, failed = 0, skippedCleared = 0;
        let idx = 0;
        for (const c of data.chats) {
            p.set(15 + (idx / Math.max(1, data.chats.length)) * 80, 'Sohbet ' + (idx + 1) + '/' + data.chats.length);
            idx++;
            // Şu an sunucuda olan mesajları bul, sadece eksikleri yaz
            const have = new Set();
            try {
                const snap = await getDocs(collection(db, 'chats', c.id, 'messages'));
                snap.forEach((d) => have.add(d.id));
            } catch (e) {}
            let myClear = 0;
            try {
                const s = await getDoc(doc(db, 'users', user.uid, 'chats', c.id));
                if (s.exists() && s.data().clearedAt && s.data().clearedAt.toMillis) myClear = s.data().clearedAt.toMillis();
            } catch (e) {}
            for (const m of c.messages) {
                if (have.has(m.id)) continue;
                const d = reviveValue(m.data);
                const ms = d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : 0;
                if (myClear && ms <= myClear) { skippedCleared++; continue; }
                try {
                    await setDoc(doc(db, 'chats', c.id, 'messages', m.id), d);
                    restored++;
                } catch (e) {
                    failed++;
                }
            }
        }
        for (const s of (data.starred || [])) {
            try { await setDoc(doc(db, 'users', user.uid, 'starred', s.id), reviveValue(s.data), { merge: true }); } catch (e) {}
        }
        p.set(100, 'Tamamlandı');
        p.close();
        let txt = restored + ' mesaj geri yüklendi';
        if (failed) txt += ', ' + failed + ' mesaj yazılamadı';
        showToast(txt, 5000);
    } catch (e) {
        p.close();
        showToast(String((e && e.message) || e || 'Geri yükleme başarısız'), 4500);
    }
}

export async function openBackupMenu() {
    if (busy) return;
    let info = '';
    try {
        const l = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
        if (l) info = 'Son yedek: ' + fmtDate(l.t) + ' · ' + l.msgs + ' mesaj · ' + fmtSize(l.size);
    } catch (e) {}
    if (info) showToast(info, 3000);
    const choice = await auraDialog({
        title: 'Google Drive yedeği',
        accent: auraAccent(),
        buttons: [
            { id: 'backup', label: 'Şimdi yedekle' },
            { id: 'restore', label: 'Yedekten geri yükle' },
            { id: 'cancel', label: 'Kapat' }
        ]
    });
    const id = choice && (choice.id || choice);
    if (id !== 'backup' && id !== 'restore') return;
    busy = true;
    try {
        if (id === 'backup') await doBackup(); else await doRestore();
    } finally {
        busy = false;
    }
}

window.__auraOpenBackup = openBackupMenu;
