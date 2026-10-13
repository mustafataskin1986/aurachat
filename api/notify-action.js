import { admin, ID_RE, deliverPush } from './_push.js';

const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || 'AIzaSyDTOmajjZsfnikrJLM1UVmXMlUobFNyJGs';
const REFERER = 'https://aurachat-amber.vercel.app/';
const MAX_TEXT = 2000;

// Bildirimden gelen istek: Android uygulaması kapalıyken bile "Cevapla" ve "Okundu" çalışsın diye
// oturumun yenileme jetonuyla kimlik doğrulanır.
async function uidFromRefreshToken(refreshToken) {
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${WEB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': REFERER },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || !j.id_token) return null;
  const decoded = await admin.auth().verifyIdToken(j.id_token);
  return decoded.uid;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Yalnızca POST kabul edilir.' });
  }

  const { refreshToken, action, chatId, text } = req.body || {};
  if (typeof refreshToken !== 'string' || !refreshToken || !['reply', 'read', 'mute', 'avatar', 'images', 'ackimages', 'msgsync'].includes(action)) {
    return res.status(400).json({ error: 'Eksik parametre.' });
  }
  if (typeof chatId !== 'string' || !ID_RE.test(chatId)) {
    return res.status(400).json({ error: 'Geçersiz sohbet.' });
  }

  let uid;
  try {
    uid = await uidFromRefreshToken(refreshToken);
  } catch (e) { uid = null; }
  if (!uid) return res.status(401).json({ error: 'Geçersiz oturum.' });

  const db = admin.firestore();
  const FV = admin.firestore.FieldValue;

  try {
    // Sohbetin tarafı mı? Doğrudan sohbette karşı kişi, grupta üyeler
    const parts = chatId.split('_');
    const isGroup = parts.length !== 2;
    let otherUid = null;
    let groupData = null;
    let members = [];
    if (!isGroup) {
      if (!parts.includes(uid)) return res.status(403).json({ error: 'İzin yok.' });
      otherUid = parts[0] === uid ? parts[1] : parts[0];
      members = [uid, otherUid];
    } else {
      const g = await db.doc(`groups/${chatId}`).get();
      if (!g.exists) return res.status(404).json({ error: 'Grup yok.' });
      groupData = g.data();
      members = Array.isArray(groupData.members) ? groupData.members : [];
      if (!members.includes(uid)) return res.status(403).json({ error: 'İzin yok.' });
    }

    const [meSnap, presSnap] = await Promise.all([
      db.doc(`users/${uid}`).get(),
      db.doc(`presence/${uid}`).get()
    ]);
    const me = meSnap.exists ? meSnap.data() : {};
    const myName = String(me.name || me.displayName || me.username || 'AuraChat');
    const hideReceipts = presSnap.exists && presSnap.data().hideReceipts === true;

    async function markRead() {
      await db.doc(`users/${uid}/chats/${chatId}`).set({ unreadCount: 0 }, { merge: true });
      if (hideReceipts) return;
      if (!isGroup) {
        const q = await db.collection(`chats/${chatId}/messages`)
          .where('senderUid', '==', otherUid).where('read', '==', false).limit(100).get();
        if (!q.empty) {
          const batch = db.batch();
          q.docs.forEach((d) => batch.update(d.ref, { read: true }));
          await batch.commit();
        }
        await db.doc(`users/${otherUid}/chats/${chatId}`).set({ lastMessageRead: true }, { merge: true });
      } else {
        const q = await db.collection(`chats/${chatId}/messages`).orderBy('createdAt', 'desc').limit(50).get();
        const batch = db.batch();
        let n = 0;
        q.docs.forEach((d) => {
          const m = d.data();
          if (m.senderUid === uid || m.type === 'system') return;
          const readBy = Array.isArray(m.readBy) ? m.readBy : [];
          if (!readBy.includes(uid)) { batch.update(d.ref, { readBy: FV.arrayUnion(uid) }); n++; }
        });
        if (n) await batch.commit();
      }
    }

    if (action === 'mute') {
      await db.doc(`users/${uid}/chats/${chatId}`).set({ muted: true }, { merge: true });
      return res.status(200).json({ success: true });
    }

    if (action === 'avatar') {
      // Sadece doğrudan sohbette karşı kişinin profil resmi
      if (isGroup) return res.status(200).json({ avatar: '' });
      const o = await db.doc(`users/${otherUid}`).get();
      const av = o.exists && typeof o.data().avatar === 'string' ? o.data().avatar : '';
      return res.status(200).json({ avatar: av.length < 2000000 ? av : '' });
    }

    // Android kodu: bildirim gelince sohbetin telefondaki kaydına yazılacak yeni mesajlar.
    // afterMs = telefondaki kaydın en son mesajının zamanı. O andan sonraki TÜM mesajlar verilir (arada boşluk kalmasın).
    // Resim/ses/belge/tek seferlik ya da çok büyük mesaj varsa partial:true döner, telefon yazmaz (uygulama açılınca normal yoldan gelir).
    if (action === 'msgsync') {
      if (isGroup) return res.status(200).json({ partial: true, items: [] });
      const afterMs = Number(req.body.afterMs);
      if (!Number.isFinite(afterMs) || afterMs <= 0) return res.status(200).json({ partial: true, items: [] });
      const q = await db.collection(`chats/${chatId}/messages`)
        .where('createdAt', '>', admin.firestore.Timestamp.fromMillis(afterMs))
        .orderBy('createdAt', 'asc').limit(40).get();
      if (q.size >= 40) return res.status(200).json({ partial: true, items: [] });
      const conv = (v) => {
        if (v && typeof v.toMillis === 'function' && typeof v.seconds === 'number') return { seconds: v.seconds, nanoseconds: v.nanoseconds };
        if (Array.isArray(v)) return v.map(conv);
        if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach((k) => { o[k] = conv(v[k]); }); return o; }
        return v;
      };
      const items = [];
      let total = 0;
      for (const d of q.docs) {
        const m = d.data();
        if (['image', 'audio', 'document'].includes(m.type) || m.viewOnce) return res.status(200).json({ partial: true, items: [] });
        if (!m.createdAt || typeof m.createdAt.toMillis !== 'function') return res.status(200).json({ partial: true, items: [] });
        const data = {};
        Object.keys(m).forEach((k) => { data[k] = k === 'createdAt' ? m.createdAt.toMillis() : conv(m[k]); });
        const size = JSON.stringify(data).length;
        total += size;
        if (size > 100000 || total > 600000) return res.status(200).json({ partial: true, items: [] });
        items.push({ id: d.id, data });
      }
      return res.status(200).json({ partial: false, items });
    }

    // Android kodu: yeni gelen (okunmamış) fotoğrafları telefona indirmek için verir
    if (action === 'images') {
      if (isGroup) return res.status(200).json({ items: [] });
      const q = await db.collection(`chats/${chatId}/messages`)
        .where('senderUid', '==', otherUid).where('read', '==', false).limit(30).get();
      const items = [];
      let total = 0;
      q.docs.forEach((d) => {
        const m = d.data();
        if (m.type !== 'image' || m.viewOnce) return;
        const imgs = Array.isArray(m.images)
          ? m.images.filter((x) => typeof x === 'string' && x)
          : (typeof m.imageUrl === 'string' && m.imageUrl ? [m.imageUrl] : []);
        if (!imgs.length) return;
        const size = imgs.reduce((a, b) => a + b.length, 0);
        if (total + size > 3500000) return;
        total += size;
        const t = m.createdAt && m.createdAt.toMillis ? m.createdAt.toMillis() : Date.now();
        items.push({ id: d.id, t, album: (m.imagesCount || 0) > 1, imgs });
      });
      return res.status(200).json({ items });
    }

    // Telefona yazıldığı bildirilen fotoğrafların sunucudaki kopyasını temizler (sadece alıcı tarafı, sadece doğrudan sohbet)
    if (action === 'ackimages') {
      if (isGroup) return res.status(200).json({ success: true });
      const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).filter((x) => typeof x === 'string' && /^[A-Za-z0-9]{20}$/.test(x)).slice(0, 30);
      for (const mid of ids) {
        const ref = db.doc(`chats/${chatId}/messages/${mid}`);
        const snap = await ref.get();
        if (!snap.exists) continue;
        const m = snap.data();
        if (m.senderUid !== otherUid || m.type !== 'image' || m.viewOnce) continue;
        if ((m.imagesCount || 0) > 1) await ref.update({ images: null, imagesDelivered: true });
        else await ref.update({ imageUrl: null, imageDelivered: true });
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'read') {
      await markRead();
      return res.status(200).json({ success: true });
    }

    const msgText = typeof text === 'string' ? text.trim().slice(0, MAX_TEXT) : '';
    if (!msgText) return res.status(400).json({ error: 'Boş mesaj.' });

    const msgRef = await db.collection(`chats/${chatId}/messages`).add({
      text: msgText,
      senderUid: uid,
      senderName: myName,
      createdAt: FV.serverTimestamp(),
      read: false
    });

    const preview = msgText.slice(0, 100);
    if (!isGroup) {
      await db.doc(`users/${uid}/chats/${chatId}`).set({
        otherUid: otherUid,
        lastMessage: preview,
        lastMessageTime: FV.serverTimestamp(),
        lastSenderUid: uid,
        lastMessageRead: false,
        unreadCount: 0,
        updatedAt: FV.serverTimestamp()
      }, { merge: true });
      await db.doc(`users/${otherUid}/chats/${chatId}`).set({
        otherUid: uid,
        otherName: myName,
        lastMessage: preview,
        lastMessageTime: FV.serverTimestamp(),
        lastSenderUid: uid,
        lastMessageRead: false,
        typing: false,
        unreadCount: FV.increment(1),
        updatedAt: FV.serverTimestamp()
      }, { merge: true });
      await deliverPush({
        senderUid: uid, receiverUid: otherUid, title: myName, body: msgText,
        data: { chatId, otherUid: uid, otherName: myName, msgType: 'text' },
        tag: `msg-${msgRef.id}`
      });
    } else {
      const gName = String(groupData.name || 'Grup');
      await Promise.all(members.map((m) => db.doc(`users/${m}/chats/${chatId}`).set({
        isGroup: true,
        groupName: gName,
        lastMessage: preview,
        lastMessageTime: FV.serverTimestamp(),
        lastSenderUid: uid,
        lastSenderName: myName,
        lastMessageRead: false,
        unreadCount: m === uid ? 0 : FV.increment(1),
        updatedAt: FV.serverTimestamp()
      }, { merge: true })));
      await Promise.all(members.filter((m) => m !== uid).map((m) => deliverPush({
        senderUid: uid, receiverUid: m, title: gName, body: `${myName}: ${msgText}`,
        data: { chatId, otherUid: chatId, otherName: gName },
        tag: `msg-${msgRef.id}`
      })));
    }

    // Cevap verilen sohbetin eski mesajları da okunmuş sayılır
    try { await markRead(); } catch (e) {}
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('notify-action hatası:', err && err.message);
    return res.status(500).json({ error: 'İşlem başarısız.' });
  }
}
