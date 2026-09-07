import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
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

// 🇹🇷 MAİLLERİN TÜRKÇE GİTMESİNİ SAĞLAYAN SATIR:
auth.languageCode = 'tr';

let base64Image = '';

const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');
const profileImageInput = document.getElementById('profile-image-input');
const profilePreview = document.getElementById('profile-preview');

// ==========================================
// 🛠️ DİNAMİK E-POSTA VE ŞİFREMİ UNUTTUM ALANLARI
// ==========================================
let emailInput = document.getElementById('email-input');

if (passwordInput && passwordInput.parentElement) {
    const parentContainer = passwordInput.parentElement;

    // 1. E-posta Giriş Kutusunu Otomatik Ekle
    if (!emailInput) {
        const emailDiv = document.createElement('div');
        emailDiv.style.cssText = 'margin-bottom: 12px; width: 100%; text-align: left;';
        emailDiv.innerHTML = `
            <label style="color: #8696a0; font-size: 14px; display: block; margin-bottom: 6px;">E-posta Adresin</label>
            <input type="email" id="email-input" placeholder="Örn: ahmet@gmail.com" required style="width: 100%; padding: 12px; background: #202c33; border: 1px solid #2a3942; border-radius: 8px; color: #fff; outline: none; box-sizing: border-box;">
        `;
        parentContainer.parentNode.insertBefore(emailDiv, parentContainer);
        emailInput = document.getElementById('email-input');
    }

    // 2. Şifremi Unuttum Linkini Otomatik Ekle
    if (!document.getElementById('forgot-password-link')) {
        const headerDiv = document.createElement('div');
        headerDiv.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; width: 100%;';
        
        const existingLabel = parentContainer.querySelector('label');
        const labelText = existingLabel ? existingLabel.innerText : 'Şifren';
        if (existingLabel) existingLabel.remove();

        headerDiv.innerHTML = `
            <span style="color: #8696a0; font-size: 14px;">${labelText}</span>
            <a href="#" id="forgot-password-link" style="color: #00a884; font-size: 13px; text-decoration: none; font-weight: 500;">Şifremi Unuttum?</a>
        `;

        parentContainer.insertBefore(headerDiv, passwordInput);

        document.getElementById('forgot-password-link').addEventListener('click', (e) => {
            e.preventDefault();
            window.resetPassword();
        });
    }
}

// ==========================================
// ⚙️ KLAVYE YÜKSEKLİK & EKRAN KİLİT AYARLARI
// ==========================================
// 1., 2. ve 3. kutucuğa tıklandığında kart TEK VE SABİT bir yüksekliğe geçer.
const KEYBOARD_OFFSET_PX = -30;

window.addEventListener('scroll', () => {
    if (loginOverlay && !loginOverlay.classList.contains('hidden')) {
        window.scrollTo(0, 0);
    }
});

if (loginOverlay) {
    loginOverlay.addEventListener('touchmove', (e) => {
        e.preventDefault();
    }, { passive: false });
}

const setCardOffset = (offset) => {
    const targetCard = loginOverlay ? (loginOverlay.firstElementChild || loginForm) : loginForm;
    if (targetCard) {
        targetCard.style.transition = 'transform 0.25s ease-out';
        targetCard.style.transform = `translateY(${offset}px)`;
    }
};

// Tüm kutucuklar tıklandığında aynı sabit yüksekliğe (-30px) çıkar
[usernameInput, emailInput, passwordInput].forEach(input => {
    if (input) {
        input.addEventListener('focus', () => {
            setCardOffset(KEYBOARD_OFFSET_PX);
            setTimeout(() => window.scrollTo(0, 0), 50);
        });

        input.addEventListener('blur', () => {
            setCardOffset(0);
            window.scrollTo(0, 0);
        });
    }
});

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        if (window.visualViewport.height >= window.innerHeight - 50) {
            setCardOffset(0);
            window.scrollTo(0, 0);
            if (document.activeElement && (document.activeElement === usernameInput || document.activeElement === emailInput || document.activeElement === passwordInput)) {
                document.activeElement.blur();
            }
        }
    });
}

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

// ==========================================
// 📧 E-POSTA İLE ŞİFRE SIFIRLAMA FONKSİYONU
// ==========================================
window.resetPassword = async function() {
    const email = prompt("Şifreni sıfırlamak için kayıtlı E-posta adresini gir:");
    if (!email || email.trim() === "") return;

    try {
        await sendPasswordResetEmail(auth, email.trim());
        alert("Şifre sıfırlama bağlantısı e-posta adresine gönderildi kanka! Gelen kutunu (ve Spam klasörünü) kontrol et.");
    } catch (err) {
        console.error("Şifre sıfırlama hatası:", err);
        if (err.code === 'auth/user-not-found') {
            alert("Bu e-posta adresiyle kayıtlı bir kullanıcı bulunamadı!");
        } else if (err.code === 'auth/invalid-email') {
            alert("Lütfen geçerli bir e-posta adresi gir!");
        } else {
            alert("Şifre sıfırlama maili gönderilirken bir hata oluştu.");
        }
    }
};

// ==========================================
// 🚀 GİRİŞ VE KAYIT İŞLEMLERİ (Firebase Auth)
// ==========================================
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = usernameInput ? usernameInput.value.trim() : '';
        const email = emailInput ? emailInput.value.trim() : '';
        const password = passwordInput ? passwordInput.value.trim() : '';

        if (!username || !email || !password) {
            alert("Lütfen tüm alanları doldur kanka!");
            return;
        }

        try {
            let userCredential;

            try {
                // 1. Önce giriş yapmayı dene
                userCredential = await signInWithEmailAndPassword(auth, email, password);
            } catch (signInErr) {
                // 2. Kullanıcı yoksa yeni kayıt oluştur
                if (signInErr.code === 'auth/user-not-found' || signInErr.code === 'auth/invalid-credential') {
                    try {
                        userCredential = await createUserWithEmailAndPassword(auth, email, password);
                    } catch (signUpErr) {
                        if (signUpErr.code === 'auth/wrong-password' || signUpErr.code === 'auth/invalid-credential') {
                            alert("Şifre hatalı kanka!");
                            return;
                        }
                        throw signUpErr;
                    }
                } else {
                    throw signInErr;
                }
            }

            // Firestore Veritabanını Güncelle
            const userRef = doc(db, "users", username);
            const userSnap = await getDoc(userRef);

            let finalAvatar = base64Image;
            if (userSnap.exists() && !finalAvatar && userSnap.data().avatar) {
                finalAvatar = userSnap.data().avatar;
            }

            await setDoc(userRef, {
                name: username,
                email: email,
                avatar: finalAvatar || '',
                lastSeen: serverTimestamp()
            }, { merge: true });

            const userObj = {
                name: username,
                email: email,
                avatar: finalAvatar || ''
            };

            localStorage.setItem('aurachat_user', JSON.stringify(userObj));
            if (loginOverlay) loginOverlay.classList.add('hidden');
            
            if (window.initApp) {
                window.initApp();
            } else {
                location.reload();
            }

        } catch (err) {
            console.error("Giriş/Kayıt hatası:", err);
            if (err.code === 'auth/weak-password') {
                alert("Şifre en az 6 karakter olmalıdır!");
            } else if (err.code === 'auth/invalid-email') {
                alert("Geçersiz e-posta adresi!");
            } else {
                alert("İşlem sırasında bir hata oluştu.");
            }
        }
    });
}
