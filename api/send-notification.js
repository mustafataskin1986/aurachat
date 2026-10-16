import { admin, ID_RE, deliverPush } from './_push.js';

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

  const r = await deliverPush({ senderUid, receiverUid, title, body, data: data || {}, tag });
  return res.status(r.status).json(r.body);
}
