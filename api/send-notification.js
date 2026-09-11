import admin from 'firebase-admin';

// Private Key içinde oluşan ters eğik çizgi ve yeni satır sorunlarını çözen güvenli metin:
const rawPrivateKey = `-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDSECcNDutv1Yp0\nIdCDt6tR4tyWnINmePv5lc4K/RpgjBlRn3gALeSyBkyVNXuHEs8JWE3OXwrbGXBO\n5d85xljgYQVn+4AyAr/FO76hQKnpZiwWqL8D5wjuh7P6x3xztM70tIUXjKIsayEL\nGGNs01U7M3I+ovCUCbAambuL7QjgByvOSh8ebeTs2pyovie0pajcsV2+ntNvcYCv\nE5Wzr+J9ACm0gZg9LtA6MFQPMi6C+EloVS9jdYsTJ871rIq6daAKOg3GkOErQq7D\n2eQnVlWaQ4ZC6K5pXnaqB+/TeT/ORAnaOa1gov4+9IiXdk7fq4NV6740XGNvBX2I\nBjeI9GLbAgMBAAECggEASCbpKuiRgMfBtzL4Ko33R/ia2RaoYZWzwt4sOAUIvtnQ\nRoN2VeVtlKJqQqPsqpAQ0f5lNznZAjnCJC971Z3l4CgjEbzGoybjlMz5JO0Pj44b\nHatXdPEx1bCB5uUHP7z+ivnIbzbMa2Jepq95UyNhtqRsnMwdw1NyjCh6zUydDEl6\nx2XCst0a0nQyY1fv9Q2/7P5zbDj44VK5yD9WEgp/PaLUhhIIwMyK5v4XDG1mngFP\nebZEsgiFdmUm8DMDrKfn8AK79md1gmseu9IpJwVcwOCUkTSZVjO6iRX5g2H5Chd1\nQ45MZMdKR2ImL+gy3BtFhunK7j54I8jAdsS80E96aQKBgQDztzqD1pjPx0P5Iu3p\nvYgN6bVAC7TEb4MQKgLRTGhNi8tmrXy+mXtOVTvO7B2E68PnC/R/es4g1nEH5CB7\n53VgmUT7n+xrW9wO4NFZWAca4nqHEXyVwPwsufYxOBpnDTOYHFaJgFETyo8hb7jO\niuwUI0BZ3wBp80fp316HKnELQwKBgQDcprBq+vTpe0ef5+LMar4t2avN+F9zIvxg\nE1P8e4QjEubkiCcWx54nPnZXj8j49FoG/oGsjmHsbh7QmyYa6rqM8hEn0F22ibhk\nEX25dpqjGO+1mTpwHUOGCabNal3emsR430PHPaysVhVnCnaOiZgbWi9pOSJJ/Hd9\ug14vAl0iQKBgDqGk7y5OfUbiw03AB8Tbqq4ptf8d6p8hOLK0+ZjDOEiYvQDUWOM\nA/ppqXUlamlTHLZNPqemW/2ywW39sHdQu/U4mUI7w1B8vLmt71gfNYWVQYtR/bMQ\npv4uohpruJtqpisvEvDuKYoxKHIFHEItRkgHtxpd3QGUdH6LL24SGRd1AoGBAJjS\nvpep7x0TLH19LuEkAUpiW5MRtpJZJfEpEd9qcQ+V1ONtxZ0KbuiBY5er16dOHlh/\nx7KK/xmw/5i+DHtSHhjmw6kOsQlvg42Ta7+bfOj/qW7ejNIAAreAUc4uIIvAJ9oL\n0LbbaZAHI1W1sn1woTA4m2PGlZAm01/6D8CSg/35AoGBAI1dOu3av24fVcZs4qq+\n1NwHAyTAHyPJcqcGLV0uigEYolGIBmJ7V//bFtBrtPjsQJVvEMaHavS7Xl1s4G2A\nW89VkhTp45zLdEIV1QutYbybFMxYn+rmwG61PWLBPUGVrT1R7q4dkgGtqi2kqg7g\nz5m2ymopNUeXKlt/wlFowQH3\n-----END PRIVATE KEY-----`;

const formattedPrivateKey = rawPrivateKey.split('\\n').join('\n');

if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: "aurachat-99f69",
        clientEmail: "firebase-adminsdk-fbsvc@aurachat-99f69.iam.gserviceaccount.com",
        privateKey: formattedPrivateKey,
      }),
    });
  } catch (err) {
    console.error("Firebase Admin başlatma hatası:", err);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Yalnızca POST kabul edilir.' });
  }

  const { token, title, body } = req.body;

  if (!token || !title || !body) {
    return res.status(400).json({ error: 'Eksik parametre.' });
  }

  try {
    const message = {
      notification: { title, body },
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'default' }
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
