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

  const { token, title, body, platform, data, tag } = req.body;

  if (!token || !title || !body) {
    return res.status(400).json({ error: 'Eksik parametre.' });
  }

  const isWebPlatform = (platform || '').toLowerCase().includes('pwa') || (platform || '').toLowerCase().includes('web');

  // FCM data payload'ındaki tüm alanlar string olmak zorunda
  const safeData = { title, body };
  if (data && typeof data === 'object') {
    Object.keys(data).forEach((key) => {
      if (data[key] !== undefined && data[key] !== null) {
        safeData[key] = String(data[key]);
      }
    });
  }
  if (tag) safeData.tag = String(tag);

  try {
    const message = isWebPlatform
      ? {
          data: safeData,
          android: { priority: 'high' },
          token: token,
        }
      : {
          notification: { title, body },
          data: safeData,
          android: {
            priority: 'high',
            notification: {
              channelId: 'aurachat-high',
              ...(tag ? { tag: String(tag) } : {})
            }
          },
          token: token,
        };

    const response = await admin.messaging().send(message);
    return res.status(200).json({ success: true, response });
  } catch (error) {
    console.error("Bildirim gönderme hatası:", error);
    return res.status(500).json({ error: error.message });
  }
}
