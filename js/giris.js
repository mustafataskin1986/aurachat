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

// 🇹🇷 MAİLLERİN TÜRKÇE GİTMESİNİ SAĞLAYAN SATIR
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

// ==========================================
// 🔗 ŞİFREMİ UNUTTUM LİNKİ EKLEME
// ==========================================
if (passwordInput && passwordInput.parentElement) {
    const parentContainer = passwordInput.parentElement;
    if (!document.getElementById('forgot-password-link')) {
        const headerDiv = document.createElement('div');
        headerDiv.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; width: 100%;';
        
        const existingLabel = parentContainer.querySelector('label');
        const labelText = existingLabel ? existingLabel.innerText : 'Şifren';
        if (existingLabel) existingLabel.remove();

        headerDiv.innerHTML = `
            <span class="text-xs font-medium text-gray-300">${labelText}</span>
            <a href="#" id="forgot-password-link" class="text-xs text-emerald-400 hover:underline font-medium">Şifremi Unuttum?</a>
        `;

        parentContainer.insertBefore(headerDiv, passwordInput);

        document.getElementById('forgot-password-link').addEventListener('click', (e) => {
            e.preventDefault();
            window.resetPassword();
        });
    }
}

// ==========================================
// ⚙️ UYUMLU KLAVYE VE ODAKLANMA (FOCUS) AYARLARI
// ==========================================
const KEYBOARD_OFFSET_PX = -20;

const setCardOffset = (offset) => {
    const targetCard = loginOverlay ? loginOverlay.firstElementChild : loginForm;
    if (targetCard) {
        targetCard.style.transition = 'transform 0.25s ease-out';
        targetCard.style.transform = `translateY(${offset}px)`;
    }
};

[emailInput, passwordInput, phoneInput, usernameInput].forEach(input => {
    if (input) {
        input.addEventListener('focus', () => setCardOffset(KEYBOARD_OFFSET_PX));
        input.addEventListener('blur', () => setCardOffset(0));
    }
});

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        if (window.visualViewport.height >= window.innerHeight - 50) {
            setCardOffset(0);
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
// 🔀 2 ADIMLI GEÇİŞ MANTIĞI (STEP NAVIGATION)
// ==========================================
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

if (btnStep1Next) {
    btnStep1Next.addEventListener('click', () => {
        if (validateStep1()) {
            step1.classList.add('hidden');
            step2.classList.remove('hidden');
            if (stepSubtitle) {
                stepSubtitle.textContent = 'Adım 2/2: Profilini özelleştir, numara ve rumuzunu gir.';
            }
        }
    });
}

if (btnStep2Back) {
    btnStep2Back.addEventListener('click', () => {
        step2.classList.add('hidden');
        step1.classList.remove('hidden');
        if (stepSubtitle) {
            stepSubtitle.textContent = 'Giriş yapmak için bilgilerinizi girin kanka.';
        }
    });
}

// Step 1 girdilerinde Enter basılınca form yerine sonraki adıma geçişi sağla
[emailInput, passwordInput].forEach(input => {
    if (input) {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                btnStep1Next.click();
            }
        });
    }
});

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
// 🚀 AKILLI GİRİŞ VE KAYIT İŞLEMLERİ (Firebase Auth + Firestore)
// ==========================================
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        // Step 1 doğrulaması düşmüşse kontrol et
        if (!validateStep1()) {
            step2.classList.add('hidden');
            step1.classList.remove('hidden');
            return;
        }

        const username = usernameInput ? usernameInput.value.trim() : '';
        const email = emailInput ? emailInput.value.trim().toLowerCase() : '';
        const password = passwordInput ? passwordInput.value.trim() : '';
        const rawPhone = phoneInput ? phoneInput.value.trim() : '';
        const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);

        if (!username) {
            alert("Lütfen bir kullanıcı adı veya rumuz belirt kanka!");
            return;
        }

        if (cleanPhone.length !== 10) {
            alert("Lütfen 10 haneli telefon numaranı eksiksiz gir kanka! (Örn: 5551234567)");
            return;
        }

        try {
            // 🧠 1. AKILLI KULLANICI ADI & E-POSTA KONTROLÜ
            const usersRef = collection(db, "users");
            const q = query(usersRef, where("email", "==", email));
            const querySnapshot = await getDocs(q);

            if (!querySnapshot.empty) {
                // E-posta veritabanında var! Kullanıcı adını doğrula
                const existingUserData = querySnapshot.docs[0].data();
                const registeredUsername = existingUserData.name || querySnapshot.docs[0].id;

                if (registeredUsername.toLowerCase() !== username.toLowerCase()) {
                    alert(`Girdiğin kullanıcı adı bu e-posta adresiyle eşleşmiyor kanka! (Kayıtlı Ad: ${registeredUsername})`);
                    return;
                }
            } else {
                // E-posta veritabanında yok (Yeni Kayıt). Kullanıcı adı başkasına ait mi kontrol et
                const userDocRef = doc(db, "users", username);
                const userDocSnap = await getDoc(userDocRef);

                if (userDocSnap.exists()) {
                    alert("Bu kullanıcı adı başka bir hesap tarafından kullanılıyor kanka! Lütfen farklı bir ad seç.");
                    return;
                }
            }

            // 🔐 2. FIREBASE AUTH İŞLEMLERİ (Giriş veya Yeni Kayıt)
            let userCredential;

            try {
                userCredential = await signInWithEmailAndPassword(auth, email, password);
            } catch (signInErr) {
                if (signInErr.code === 'auth/wrong-password' || signInErr.code === 'auth/invalid-credential') {
                    alert("Şifreyi yanlış girdiniz kanka!");
                    return;
                }

                if (signInErr.code === 'auth/user-not-found') {
                    try {
                        userCredential = await createUserWithEmailAndPassword(auth, email, password);
                    } catch (signUpErr) {
                        if (signUpErr.code === 'auth/email-already-in-use') {
                            alert("Şifreyi yanlış girdiniz kanka!");
                            return;
                        }
                        throw signUpErr;
                    }
                } else {
                    throw signInErr;
                }
            }

            // 💾 3. FIRESTORE VERİTABANINI GÜNCELLE
            const userRef = doc(db, "users", username);
            const userSnap = await getDoc(userRef);

            let finalAvatar = base64Image;
            if (userSnap.exists() && !finalAvatar && userSnap.data().avatar) {
                finalAvatar = userSnap.data().avatar;
            }

            await setDoc(userRef, {
                name: username,
                email: email,
                phone: cleanPhone,
                avatar: finalAvatar || '',
                lastSeen: serverTimestamp()
            }, { merge: true });

            const userObj = {
                name: username,
                email: email,
                phone: cleanPhone,
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
            if (err.code === 'auth/wrong-password' || err.code === 'auth/email-already-in-use' || err.code === 'auth/invalid-credential') {
                alert("Şifreyi yanlış girdiniz kanka!");
            } else if (err.code === 'auth/weak-password') {
                alert("Şifre en az 6 karakter olmalıdır!");
            } else if (err.code === 'auth/invalid-email') {
                alert("Geçersiz e-posta adresi!");
            } else if (err.code === 'auth/too-many-requests') {
                alert("Çok fazla hatalı deneme yaptın. Lütfen biraz bekleyip tekrar dene kanka!");
            } else {
                alert("Giriş yapılırken bir hata oluştu. Lütfen tekrar dene.");
            }
        }
    });
}
