import { db, auth } from "./firebase-init.js";
import { doc, getDoc, setDoc, collection, query, where, getDocs, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification, GoogleAuthProvider, signInWithPopup, signInWithCredential } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

let base64Image = '';
let verifyCheckInterval = null;

// GOOGLE CLIENT ID VE NATIVE ALGILAMA
const GOOGLE_CLIENT_ID = "447747395966-3shresouu36769er1b9656oec8vd13aa.apps.googleusercontent.com";

const isCapacitorNative = () => {
    return typeof window !== 'undefined' && window.Capacitor && window.Capacitor.isNativePlatform();
};

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
const btnForgotPassword = document.getElementById('btn-forgot-password');
const emailStatus = document.getElementById('email-status');
const btnGoogleSignIn = document.getElementById('btn-google-signin');

const profileImageInput = document.getElementById('profile-image-input');
const profilePreview = document.getElementById('profile-preview');

// MODAL ELEMENTLERİ
const forgotModal = document.getElementById('forgot-modal');
const forgotEmailInput = document.getElementById('forgot-email-input');
const btnForgotCancel = document.getElementById('btn-forgot-cancel');
const btnForgotSubmit = document.getElementById('btn-forgot-submit');

const verifyModal = document.getElementById('verify-modal');
const verifyEmailText = document.getElementById('verify-email-text');

const googleProvider = new GoogleAuthProvider();

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

// E-posta Canlı Format Doğrulama
if (emailInput && emailStatus) {
    emailInput.addEventListener('input', () => {
        const email = emailInput.value.trim();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!email) {
            emailStatus.textContent = '';
            emailStatus.className = 'text-xs font-semibold';
        } else if (emailRegex.test(email)) {
            emailStatus.textContent = '✓ Geçerli';
            emailStatus.className = 'text-xs font-semibold text-emerald-400';
        } else {
            emailStatus.textContent = 'Geçersiz E-posta';
            emailStatus.className = 'text-xs font-semibold text-rose-400';
        }
    });
}

// ŞİFREMİ UNUTTUM MODAL İŞLEMLERİ
if (btnForgotPassword) {
    btnForgotPassword.addEventListener('click', () => {
        if (forgotEmailInput && emailInput) {
            forgotEmailInput.value = emailInput.value.trim();
        }
        if (forgotModal) forgotModal.classList.remove('hidden');
    });
}

if (btnForgotCancel) {
    btnForgotCancel.addEventListener('click', () => {
        if (forgotModal) forgotModal.classList.add('hidden');
    });
}

if (btnForgotSubmit) {
    btnForgotSubmit.addEventListener('click', async () => {
        const email = forgotEmailInput ? forgotEmailInput.value.trim().toLowerCase() : '';
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!email || !emailRegex.test(email)) {
            alert("Lütfen geçerli bir e-posta adresi yaz kanka!");
            return;
        }

        const originalText = btnForgotSubmit.innerHTML;
        btnForgotSubmit.disabled = true;
        btnForgotSubmit.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Gönderiliyor...`;

        try {
            await sendPasswordResetEmail(auth, email);
            alert(`Sıfırlama bağlantısı ${email} adresine başarıyla gönderildi kanka! Gelen kutunu ve Spam klasörünü kontrol et.`);
            if (forgotModal) forgotModal.classList.add('hidden');
        } catch (err) {
            if (err.code === 'auth/user-not-found') {
                alert("Bu e-posta adresiyle kayıtlı bir kullanıcı bulunamadı kanka!");
            } else if (err.code === 'auth/too-many-requests') {
                alert("Çok fazla başarısız deneme yapıldı. Lütfen biraz bekleyin veya internetinizi (IP) değiştirip tekrar deneyin.");
            } else {
                alert("Sıfırlama maili gönderilemedi: " + err.message);
            }
        } finally {
            btnForgotSubmit.disabled = false;
            btnForgotSubmit.innerHTML = originalText;
        }
    });
}

function validateStep1() {
    const email = emailInput ? emailInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value.trim() : '';
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!email || !emailRegex.test(email)) {
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
    btnStep1Next.addEventListener('click', async () => {
        if (!validateStep1()) return;

        const email = emailInput.value.trim().toLowerCase();
        const password = passwordInput.value.trim();

        const originalBtnContent = btnStep1Next.innerHTML;
        btnStep1Next.disabled = true;
        btnStep1Next.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-sm"></i> <span>Kontrol Ediliyor...</span>`;

        try {
            let userCred;
            let isNewAccount = false;

            try {
                userCred = await signInWithEmailAndPassword(auth, email, password);
            } catch (signInErr) {
                try {
                    userCred = await createUserWithEmailAndPassword(auth, email, password);
                    isNewAccount = true;
                } catch (createErr) {
                    if (createErr.code === 'auth/email-already-in-use') {
                        alert("Şifren hatalı kanka! Lütfen doğru şifre gir veya 'Şifremi Unuttum?' bağlantısını kullan.");
                    } else if (createErr.code === 'auth/too-many-requests') {
                        alert("Çok fazla deneme yapıldı kanka. Lütfen biraz bekleyin veya internetinizi (IP) değiştirip tekrar deneyin.");
                    } else if (createErr.code === 'auth/weak-password') {
                        alert("Şifren çok zayıf kanka, en az 6 karakter olmalı.");
                    } else {
                        alert("İşlem hatası: " + createErr.message);
                    }
                    return;
                }
            }

            if (!userCred || !userCred.user) return;

            if (isNewAccount) {
                await sendEmailVerification(userCred.user);
                if (verifyEmailText) verifyEmailText.textContent = email;
                if (verifyModal) verifyModal.classList.remove('hidden');
                startVerifyPolling();
                return;
            }

            await userCred.user.reload();

            if (!userCred.user.emailVerified) {
                await sendEmailVerification(userCred.user);
                if (verifyEmailText) verifyEmailText.textContent = email;
                if (verifyModal) verifyModal.classList.remove('hidden');
                startVerifyPolling();
                return;
            }

            const userDocSnap = await getDoc(doc(db, "users", userCred.user.uid));

            if (userDocSnap.exists()) {
                const userData = userDocSnap.data();
                const userObj = {
                    uid: userData.uid || userCred.user.uid,
                    name: userData.name || '',
                    email: userData.email,
                    phone: userData.phone || '',
                    avatar: userData.avatar || ''
                };
                localStorage.setItem('aurachat_user', JSON.stringify(userObj));
                if (loginOverlay) loginOverlay.classList.add('hidden');
                if (window.initApp) window.initApp(); else location.reload();
            } else {
                if (emailStatus) {
                    emailStatus.textContent = '✓ Onaylandı';
                    emailStatus.className = 'text-xs font-semibold text-emerald-400';
                }
                step1.classList.add('hidden');
                step2.classList.remove('hidden');
                if (stepSubtitle) stepSubtitle.textContent = 'E-posta Onaylandı! Profilini tamamla kanka.';
            }

        } catch (err) {
            alert("İşlem hatası: " + err.message);
        } finally {
            btnStep1Next.disabled = false;
            btnStep1Next.innerHTML = originalBtnContent;
        }
    });
}

function startVerifyPolling() {
    if (verifyCheckInterval) clearInterval(verifyCheckInterval);
    verifyCheckInterval = setInterval(async () => {
        if (auth.currentUser) {
            await auth.currentUser.reload();
            if (auth.currentUser.emailVerified) {
                clearInterval(verifyCheckInterval);
                if (verifyModal) verifyModal.classList.add('hidden');
                if (emailStatus) {
                    emailStatus.textContent = '✓ Onaylandı';
                    emailStatus.className = 'text-xs font-semibold text-emerald-400';
                }
                step1.classList.add('hidden');
                step2.classList.remove('hidden');
                if (stepSubtitle) stepSubtitle.textContent = 'E-posta Onaylandı! Profilini tamamla kanka.';
            }
        }
    }, 3000);
}

// HİBRİT GOOGLE GİRİŞ FONKSİYONU
async function executeGoogleSignIn() {
    if (isCapacitorNative()) {
        const GoogleAuth = window.Capacitor?.Plugins?.GoogleAuth;
        if (!GoogleAuth) {
            throw new Error("Capacitor GoogleAuth eklentisi bulunamadı.");
        }
        await GoogleAuth.initialize({
            clientId: GOOGLE_CLIENT_ID,
            scopes: ['profile', 'email'],
            grantOfflineAccess: true
        });
        const googleUser = await GoogleAuth.signIn();
        const credential = GoogleAuthProvider.credential(googleUser.authentication.idToken);
        return await signInWithCredential(auth, credential);
    } else {
        return await signInWithPopup(auth, googleProvider);
    }
}

// GOOGLE İLE GİRİŞ BUTONU
if (btnGoogleSignIn) {
    btnGoogleSignIn.addEventListener('click', async () => {
        btnGoogleSignIn.disabled = true;
        const originalContent = btnGoogleSignIn.innerHTML;
        btnGoogleSignIn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> <span>Bağlanıyor...</span>`;

        try {
            const userCred = await executeGoogleSignIn();
            const user = userCred.user;

            const userDocSnap = await getDoc(doc(db, "users", user.uid));

            if (userDocSnap.exists()) {
                const userData = userDocSnap.data();
                const userObj = {
                    uid: userData.uid || user.uid,
                    name: userData.name || '',
                    email: userData.email,
                    phone: userData.phone || '',
                    avatar: userData.avatar || ''
                };
                localStorage.setItem('aurachat_user', JSON.stringify(userObj));
                if (loginOverlay) loginOverlay.classList.add('hidden');
                if (window.initApp) window.initApp(); else location.reload();
            } else {
                if (emailInput) emailInput.value = user.email || '';
                if (usernameInput) usernameInput.value = user.displayName || '';
                if (user.photoURL) {
                    base64Image = user.photoURL;
                    if (profilePreview) {
                        profilePreview.innerHTML = `<img src="${user.photoURL}" class="w-full h-full object-cover rounded-full">`;
                    }
                }
                if (emailStatus) {
                    emailStatus.textContent = '✓ Google ile onaylandı';
                    emailStatus.className = 'text-xs font-semibold text-emerald-400';
                }
                step1.classList.add('hidden');
                step2.classList.remove('hidden');
                if (stepSubtitle) stepSubtitle.textContent = 'Google ile bağlandın! Telefon numaranı ekleyip profilini tamamla kanka.';
            }
        } catch (err) {
            if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
                // Kullanıcı kapattı
            } else if (err.code === 'auth/popup-blocked') {
                alert("Tarayıcı popup'ı engelledi kanka. Popup izni verip tekrar dene.");
            } else {
                alert("Google ile giriş yapılamadı: " + err.message);
            }
        } finally {
            btnGoogleSignIn.disabled = false;
            btnGoogleSignIn.innerHTML = originalContent;
        }
    });
}

if (btnStep2Back) {
    btnStep2Back.addEventListener('click', () => {
        if (verifyCheckInterval) clearInterval(verifyCheckInterval);
        step2.classList.add('hidden');
        step1.classList.remove('hidden');
        if (stepSubtitle) stepSubtitle.textContent = 'Giriş yapmak için bilgilerinizi girin kanka.';
    });
}

// ADIM 2 PROFİL KAYIT FORMU
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const username = usernameInput ? usernameInput.value.trim() : '';
        const email = emailInput ? emailInput.value.trim().toLowerCase() : '';
        const rawPhone = phoneInput ? phoneInput.value.trim() : '';

        const digits = rawPhone.replace(/\D/g, '');
        const cleanPhone = digits.length >= 10 ? digits.slice(-10) : '';
        const formattedPhone = '+90' + cleanPhone;

        if (!username || cleanPhone.length !== 10) {
            alert("Lütfen kullanıcı adı ve 10 haneli telefon numaranı eksiksiz gir kanka!");
            return;
        }

        const submitBtn = document.getElementById('btn-step-2-submit');
        let originalSubmitContent = '';
        if (submitBtn) {
            originalSubmitContent = submitBtn.innerHTML;
            submitBtn.disabled = true;
            submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-sm"></i> <span>Kayıt Tamamlanıyor...</span>`;
        }

        try {
            const phoneFormats = [cleanPhone, formattedPhone, '0' + cleanPhone];
            const phoneQuery = query(collection(db, "users"), where("phone", "in", phoneFormats));
            const phoneSnap = await getDocs(phoneQuery);

            if (!phoneSnap.empty) {
                alert("Bu telefon numarası başka bir hesaba tanımlı kanka! Lütfen kendi telefon numaranı gir.");
                return;
            }

            const currentUserAuth = auth.currentUser;
            if (!currentUserAuth) {
                alert("Oturum süresi doldu kanka. Lütfen Adım 1'den tekrar başla.");
                location.reload();
                return;
            }

            const userRef = doc(db, "users", currentUserAuth.uid);
            await setDoc(userRef, {
                uid: currentUserAuth.uid,
                name: username,
                email: email,
                phone: formattedPhone,
                avatar: base64Image || '',
                lastSeen: serverTimestamp()
            });

            const userObj = {
                uid: currentUserAuth.uid,
                name: username,
                email: email,
                phone: formattedPhone,
                avatar: base64Image || ''
            };
            localStorage.setItem('aurachat_user', JSON.stringify(userObj));

            if (loginOverlay) loginOverlay.classList.add('hidden');
            if (window.initApp) window.initApp(); else location.reload();

        } catch (err) {
            alert("Kayıt oluşturulurken hata: " + err.message);
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalSubmitContent;
            }
        }
    });
}
