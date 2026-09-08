import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, setDoc, collection, query, where, getDocs, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

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

// 2. ADIM 1 DEVAM ET VE CANLI DOĞRULAMA KONTROLÜ
if (btnStep1Next) {
    btnStep1Next.addEventListener('click', async () => {
        if (!validateStep1()) return;

        const email = emailInput.value.trim().toLowerCase();
        const password = passwordInput.value.trim();

        const originalBtnContent = btnStep1Next.innerHTML;
        btnStep1Next.disabled = true;
        btnStep1Next.innerHTML = `<i class="fa-solid fa-spinner fa-spin text-sm"></i> <span>Kontrol Ediliyor...</span>`;

        try {
            // Önce bu mail veritabanımızda zaten kayıtlı mı kontrol et
            const q = query(collection(db, "users"), where("email", "==", email));
            const querySnapshot = await getDocs(q);

            if (!querySnapshot.empty) {
                // KULLANICI VAR -> Giriş Yapmayı Dene
                try {
                    await signInWithEmailAndPassword(auth, email, password);
                    
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

                } catch (authErr) {
                    if (authErr.code === 'auth/wrong-password' || authErr.code === 'auth/invalid-credential') {
                        alert("Şifren hatalı kanka! Lütfen doğru şifre gir veya 'Şifremi Unuttum?' bağlantısını kullan.");
                    } else if (authErr.code === 'auth/too-many-requests') {
                        alert("Çok fazla hatalı giriş yapıldı. Lütfen biraz bekleyin veya internet bağlantınızı değiştirin.");
                    } else {
                        alert("Giriş yapılamadı: " + authErr.message);
                    }
                }
            } else {
                // KULLANICI YOK -> Mail Doğrulama Sürecini Başlat
                let userCred;
                try {
                    userCred = await createUserWithEmailAndPassword(auth, email, password);
                } catch (createErr) {
                    if (createErr.code === 'auth/email-already-in-use') {
                        // Eğer mail auth sisteminde var ama Firestore kaydı yoksa giriş yapmayı dene
                        try {
                            userCred = await signInWithEmailAndPassword(auth, email, password);
                        } catch (loginErr) {
                            alert("Bu e-posta adresi sistemde kayıtlı ancak girdiğin şifre hatalı kanka!");
                            return;
                        }
                    } else if (createErr.code === 'auth/too-many-requests') {
                        alert("Çok fazla deneme yapıldı kanka. Lütfen internetini (IP) değiştirip tekrar dene.");
                        return;
                    } else {
                        throw createErr;
                    }
                }

                if (userCred && userCred.user) {
                    // Doğrulama maili gönder
                    await sendEmailVerification(userCred.user);

                    if (verifyEmailText) verifyEmailText.textContent = email;
                    if (verifyModal) verifyModal.classList.remove('hidden');

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
            }

        } catch (err) {
            alert("İşlem hatası: " + err.message);
        } finally {
            btnStep1Next.disabled = false;
            btnStep1Next.innerHTML = originalBtnContent;
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

// 3. ADIM 2 PROFİL KAYIT FORMU
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const username = usernameInput ? usernameInput.value.trim() : '';
        const email = emailInput ? emailInput.value.trim().toLowerCase() : '';
        const rawPhone = phoneInput ? phoneInput.value.trim() : '';
        const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);

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
            const phoneQuery = query(collection(db, "users"), where("phone", "==", cleanPhone));
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
                phone: cleanPhone,
                avatar: base64Image || '',
                lastSeen: serverTimestamp()
            });

            const userObj = { name: username, email: email, phone: cleanPhone, avatar: base64Image || '' };
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