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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Yalnızca POST kabul edilir.' });
  }

  const { token, title, body, platform } = req.body;

  if (!token || !title || !body) {
    return res.status(400).json({ error: 'Eksik parametre.' });
  }

  const isWebPlatform = (platform || '').toLowerCase().includes('pwa') || (platform || '').toLowerCase().includes('web');

  try {
    const message = isWebPlatform
      ? {
          data: { title, body },
          android: { priority: 'high' },
          token: token,
        }
      : {
          notification: { title, body },
          data: { title, body },
          android: { priority: 'high' },
          token: token,
        };

    const response = await admin.messaging().send(message);
    return res.status(200).json({ success: true, response });
  } catch (error) {
    console.error("Bildirim gönderme hatası:", error);
    return res.status(500).json({ error: error.message });
  }
}
