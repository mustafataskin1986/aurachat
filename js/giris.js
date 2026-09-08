import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, collection, query, where, getDocs, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyDTOmajjZsfnikrJLM1UVmXMlUobFNyJGs",
    authDomain: "aurachat-99f69.firebaseapp.com",
    projectId: "aurachat-99f69",
    storageBucket: "aurachat-99f69.firebasestorage.app",
    messagingSenderId: "447747395966",
    appId: "1:447747395966:web:7db71f9f912a188d17632f"
};

const app = initializeApp(firebaseConfig, "loginApp");
const db = getFirestore(app);
const auth = getAuth(app);

auth.languageCode = 'tr';

let base64Image = '';

// DOM ELEMENTLERİ
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const step1 = document.getElementById('step-1');
const step2 = document.getElementById('step-2');
const stepSubtitle = document.getElementById('step-subtitle');

const emailInput = document.getElementById('email-input');
const passwordInput = document.getElementById('password-input');
const phoneInput = document.getElementById('phone-input');
const usernameInput = document.getElementById('username-input');

const btnStep1Next = document.getElementById('btn-step-1-next');
const btnStep2Back = document.getElementById('btn-step-2-back');

const profileImageInput = document.getElementById('profile-image-input');
const profilePreview = document.getElementById('profile-preview');

// Oturum kontrolü
const currentUser = JSON.parse(localStorage.getItem('aurachat_user'));
if (currentUser && loginOverlay) {
    loginOverlay.classList.add('hidden');
} else if (loginOverlay) {
    loginOverlay.classList.remove('hidden');
}

// Profil Fotoğrafı Önizleme
if (profileImageInput) {
    profileImageInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = function(uploadEvent) {
                base64Image = uploadEvent.target.result;
                if (profilePreview) {
                    profilePreview.innerHTML = `<img src="${base64Image}" class="w-full h-full object-cover rounded-full">`;
                }
            };
            reader.readAsDataURL(file);
        }
    });
}

function validateStep1() {
    const email = emailInput ? emailInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value.trim() : '';

    if (!email || !email.includes('@')) {
        alert("Lütfen geçerli bir e-posta adresi gir kanka!");
        return false;
    }
    if (!password || password.length < 6) {
        alert("Şifren en az 6 karakter olmalıdır!");
        return false;
    }
    return true;
}

// Devam Et butonuna basıldığında Doğrudan Giriş Denemesi Yapılır
if (btnStep1Next) {
    btnStep1Next.addEventListener('click', async () => {
        if (!validateStep1()) return;

        const email = emailInput.value.trim().toLowerCase();
        const password = passwordInput.value.trim();

        try {
            // Önce Giriş Yapmayı Dene
            const userCredential = await signInWithEmailAndPassword(auth, email, password);
            
            // Giriş başarılıysa Firestore'dan Kullanıcı Bilgisini Çek
            const q = query(collection(db, "users"), where("email", "==", email));
            const querySnapshot = await getDocs(q);

            if (!querySnapshot.empty) {
                const userData = querySnapshot.docs[0].data();
                const userObj = {
                    name: userData.name || querySnapshot.docs[0].id,
                    email: userData.email,
                    phone: userData.phone || '',
                    avatar: userData.avatar || ''
                };
                localStorage.setItem('aurachat_user', JSON.stringify(userObj));
                if (loginOverlay) loginOverlay.classList.add('hidden');
                if (window.initApp) window.initApp(); else location.reload();
            } else {
                // Auth var ama Firestore kaydı yoksa Adım 2'ye yönlendir
                step1.classList.add('hidden');
                step2.classList.remove('hidden');
            }

        } catch (err) {
            if (err.code === 'auth/user-not-found') {
                // Kullanıcı yoksa YENİ KAYIT adımına geç
                step1.classList.add('hidden');
                step2.classList.remove('hidden');
                if (stepSubtitle) stepSubtitle.textContent = 'Yeni Kayıt: Profilini özelleştir kanka.';
            } else if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
                alert("Şifreni yanlış girdin kanka!");
            } else {
                alert("Bir hata oluştu: " + err.message);
            }
        }
    });
}

if (btnStep2Back) {
    btnStep2Back.addEventListener('click', () => {
        step2.classList.add('hidden');
        step1.classList.remove('hidden');
    });
}

// Form Gönderildiğinde (Sadece Adım 2 Yeni Kayıt İşlemleri İçin)
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const username = usernameInput ? usernameInput.value.trim() : '';
        const email = emailInput ? emailInput.value.trim().toLowerCase() : '';
        const password = passwordInput ? passwordInput.value.trim() : '';
        const rawPhone = phoneInput ? phoneInput.value.trim() : '';
        const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);

        if (!username || cleanPhone.length !== 10) {
            alert("Lütfen kullanıcı adı ve 10 haneli telefon numaranı eksiksiz gir kanka!");
            return;
        }

        try {
            // Firebase Auth ile Yeni Kullanıcı Oluştur
            await createUserWithEmailAndPassword(auth, email, password);

            // Firestore Veritabanına Kaydet
            const userRef = doc(db, "users", username);
            await setDoc(userRef, {
                name: username,
                email: email,
                phone: cleanPhone,
                avatar: base64Image || '',
                lastSeen: serverTimestamp()
            }, { merge: true });

            const userObj = { name: username, email: email, phone: cleanPhone, avatar: base64Image || '' };
            localStorage.setItem('aurachat_user', JSON.stringify(userObj));
            
            if (loginOverlay) loginOverlay.classList.add('hidden');
            if (window.initApp) window.initApp(); else location.reload();

        } catch (err) {
            if (err.code === 'auth/email-already-in-use') {
                alert("Bu e-posta adresi zaten kullanımda! Lütfen doğru şifre ile Adım 1'den giriş yap kanka.");
            } else {
                alert("Kayıt oluşturulurken hata: " + err.message);
            }
        }
    });
}
