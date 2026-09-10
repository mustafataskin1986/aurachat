import { db, auth } from "./firebase-init.js";
import { doc, getDoc, setDoc, collection, query, where, getDocs, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

let base64Image = '';
let verifyCheckInterval = null;

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

const profileImageInput = document.getElementById('profile-image-input');
const profilePreview = document.getElementById('profile-preview');

// MODAL ELEMENTLERİ
const forgotModal = document.getElementById('forgot-modal');
const forgotEmailInput = document.getElementById('forgot-email-input');
const btnForgotCancel = document.getElementById('btn-forgot-cancel');
const btnForgotSubmit = document.getElementById('btn-forgot-submit');

const verifyModal = document.getElementById('verify-modal');
const verifyEmailText = document.getElementById('verify-email-text');

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

// 1. ŞİFREMİ UNUTTUM MODAL İŞLEMLERİ
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

// 2. ADIM 1 DEVAM ET: Önce giriş dener (Firestore'a dokunmadan, sadece Auth üzerinden).
// Başarısız olursa kayıt dener - email zaten var mı yok mu diye
// auth olmadan Firestore sorgusu atmaya gerek kalmıyor (izin hatasının sebebi buydu).
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
                // Giriş başarısız: ya hesap yok ya şifre yanlış. Kayıt denemesi ayırt eder.
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

            // Doğrulanmış - şimdi authenticated olduğumuz için Firestore'dan
            // profili güvenle okuyabiliriz
            const userDocSnap = await getDoc(doc(db, "users", userCred.user.uid));

            if (userDocSnap.exists()) {
                const userData = userDocSnap.data();
                const userObj = {
                    uid: userData.uid || userCred.user.uid,
                    name: userData.name || userCred.user.uid,
                    email: userData.email,
                    phone: userData.phone || '',
                    avatar: userData.avatar || ''
                };
                localStorage.setItem('aurachat_user', JSON.stringify(userObj));
                if (loginOverlay) loginOverlay.classList.add('hidden');
                if (window.initApp) window.initApp(); else location.reload();
            } else {
                // Doğrulanmış ama profil hiç tamamlanmamış - adım 2'ye geç
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

if (btnStep2Back) {
    btnStep2Back.addEventListener('click', () => {
        if (verifyCheckInterval) clearInterval(verifyCheckInterval);
        step2.classList.add('hidden');
        step1.classList.remove('hidden');
        if (stepSubtitle) stepSubtitle.textContent = 'Giriş yapmak için bilgilerinizi girin kanka.';
    });
}

// 3. ADIM 2 PROFİL KAYIT FORMU
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const username = usernameInput ? usernameInput.value.trim() : '';
        const email = emailInput ? emailInput.value.trim().toLowerCase() : '';
        const rawPhone = phoneInput ? phoneInput.value.trim() : '';

        // Sadece rakamları ayıkla ve son 10 haneyi al
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
            // Numarayı veritabanında 3 farklı olası formatta kontrol et (mükerrer kaydı önler)
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
                phone: formattedPhone, // Veritabanına uluslararası standartta (+905XXXXXXXXX) kaydet
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
