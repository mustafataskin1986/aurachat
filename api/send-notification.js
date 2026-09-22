import admin from 'firebase-admin';

if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch (err) {
    console.error("Firebase Admin başlatma hatası:", err);
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_TITLE = 100;
const MAX_BODY = 400;
const MAX_DATA_KEYS = 12;
const MAX_DATA_VALUE = 200;

async function sharesChat(senderUid, receiverUid, chatId) {
  if (senderUid === receiverUid) return false;

  const parts = chatId.split('_');
  if (parts.length === 2) {
    return parts.includes(senderUid) && parts.includes(receiverUid);
  }

  const snap = await admin.firestore().doc(`groups/${chatId}`).get();
  if (!snap.exists) return false;
  const members = Array.isArray(snap.data().members) ? snap.data().members : [];
  return members.includes(senderUid) && members.includes(receiverUid);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Yalnızca POST kabul edilir.' });
  }

  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!idToken) {
    return res.status(401).json({ error: 'Yetkisiz.' });
  }

  let senderUid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    senderUid = decoded.uid;
  } catch (err) {
    return res.status(401).json({ error: 'Geçersiz oturum.' });
  }

  const { receiverUid, title, body, data, tag } = req.body || {};

  if (!receiverUid || !title || !body) {
    return res.status(400).json({ error: 'Eksik parametre.' });
  }
  if (typeof receiverUid !== 'string' || !ID_RE.test(receiverUid)) {
    return res.status(400).json({ error: 'Geçersiz alıcı.' });
  }

  const chatId = (data && data.chatId) ? String(data.chatId) : '';
  if (!ID_RE.test(chatId)) {
    return res.status(400).json({ error: 'Geçersiz sohbet.' });
  }

  try {
    if (!(await sharesChat(senderUid, receiverUid, chatId))) {
      return res.status(403).json({ error: 'İzin yok.' });
    }

    // Alıcının bildirim jetonunu, engelleme ve sessize alma bilgisini sunucu okur
    const [userSnap, senderSnap, chatSummarySnap] = await Promise.all([
      admin.firestore().doc(`users/${receiverUid}`).get(),
      admin.firestore().doc(`users/${senderUid}`).get(),
      admin.firestore().doc(`users/${receiverUid}/chats/${chatId}`).get()
    ]);

    if (!userSnap.exists) {
      return res.status(404).json({ error: 'Alıcı bulunamadı.' });
    }
    const u = userSnap.data();
    const senderData = senderSnap.exists ? senderSnap.data() : {};

    const receiverBlockedUids = Array.isArray(u.blockedUids) ? u.blockedUids : [];
    const senderBlockedUids = Array.isArray(senderData.blockedUids) ? senderData.blockedUids : [];
    if (receiverBlockedUids.includes(senderUid) || senderBlockedUids.includes(receiverUid)) {
      return res.status(200).json({ success: false, reason: 'blocked' });
    }

    const isCall = !!(data && String(data.kind || '') === 'call');
    if (!isCall && chatSummarySnap.exists && chatSummarySnap.data().muted === true) {
      return res.status(200).json({ success: false, reason: 'muted' });
    }

    const token = u.fcmToken || u.fcm_token || u.pushToken;
    if (!token) {
      return res.status(200).json({ success: false, reason: 'no-token' });
    }

    const safeTitle = String(title).slice(0, MAX_TITLE);
    const safeBody = String(body).slice(0, MAX_BODY);
    const isWebPlatform = String(u.platform || '').toLowerCase().includes('pwa') || String(u.platform || '').toLowerCase().includes('web');

    const safeData = { title: safeTitle, body: safeBody };
    if (data && typeof data === 'object') {
      Object.keys(data).slice(0, MAX_DATA_KEYS).forEach((key) => {
        if (data[key] !== undefined && data[key] !== null) {
          safeData[key] = String(data[key]).slice(0, MAX_DATA_VALUE);
        }
      });
    }
    if (tag) safeData.tag = String(tag).slice(0, MAX_DATA_VALUE);

    const message = (isWebPlatform || isCall)
      ? {
          data: safeData,
          android: isCall ? { priority: 'high', ttl: 45000 } : { priority: 'high' },
          token: token,
        }
      : {
          notification: { title: safeTitle, body: safeBody },
          data: safeData,
          android: {
            priority: 'high',
            notification: {
              channelId: 'aurachat-messages',
              ...(tag ? { tag: String(tag) } : {})
            }
          },
          token: token,
        };

    const response = await admin.messaging().send(message);
    return res.status(200).json({ success: true, response });
  } catch (error) {
    console.error("Bildirim gönderme hatası:", error);
    return res.status(500).json({ error: 'Bildirim gönderilemedi.' });
  }
}