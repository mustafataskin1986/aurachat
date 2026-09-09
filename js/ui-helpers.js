// ==========================================
// ORTAK YARDIMCI FONKSİYONLAR
// contacts.js, chat-core.js ve admin.js bu dosyayı kullanır
// ==========================================

// CANLI / DİNAMİK AVATAR RENK LİSTESİ
export const AVATAR_COLORS = [
    '#e53935', '#d81b60', '#8e24aa', '#5e35b1', '#3949ab',
    '#1e88e5', '#039be5', '#00acc1', '#00897b', '#43a047',
    '#7cb342', '#fb8c00', '#f4511e', '#6d4c41', '#546e7a',
    '#059669', '#2563eb', '#d97706', '#dc2626', '#9333ea'
];

// İsme Göre Değişmeyen Sabit/Farklı Renk Üretici
export function getUserColor(str) {
    if (!str) return '#00897b';
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % AVATAR_COLORS.length;
    return AVATAR_COLORS[index];
}

// BAŞ HARF ÜRETİCİ (Mustafa -> M | Mustafa Taşkın -> MT)
export function getInitials(name) {
    if (!name) return 'AC';
    const cleanName = name.replace(/^👑\s*/, '').trim();
    const parts = cleanName.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'AC';
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

// Admin İsim ve Taç Ayarı
export function formatAdminUser(user, adminEmail) {
    if (!user) return user;
    if (user.email && user.email.toLowerCase() === adminEmail.toLowerCase()) {
        if (!user.name.startsWith('👑')) {
            user.name = '👑 ' + user.name.replace(/^👑\s*/, '');
        }
    }
    return user;
}

// Tarih/Saat Formatlama (Bugün -> saat, Dün -> "Dün", Eski -> gg.aa.yyyy)
export function formatTimestamp(dateObj) {
    if (!dateObj) return '';
    const now = new Date();
    const date = new Date(dateObj);

    const isToday = now.toDateString() === date.toDateString();

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday = yesterday.toDateString() === date.toDateString();

    if (isToday) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (isYesterday) {
        return 'Dün';
    } else {
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        return `${day}.${month}.${year}`;
    }
}

// Telefon numarasının son 10 hanesini normalize eder (rehber eşleştirme ve mükerrer kayıt kontrolü için)
export function getPhoneLast10(ph) {
    if (!ph) return '';
    const digits = String(ph).replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : '';
}

// HTML injection'a karşı temel koruma
export function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// İki kullanıcı arasındaki chatId'yi UID bazlı üretir (isim bazlı değil!)
// Böylece kullanıcı rumuzunu değiştirse bile sohbet geçmişi kaybolmaz,
// iki farklı kişi aynı ismi seçse bile çakışma olmaz.
export function getChatId(uidA, uidB) {
    return [uidA, uidB].sort().join('_');
}
