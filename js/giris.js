import { db, auth } from "./firebase-init.js";
import { doc, getDoc, setDoc, collection, query, where, getDocs, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification, deleteUser, signOut, GoogleAuthProvider, signInWithPopup, signInWithCredential } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

let base64Image = '';
let verifyCheckInterval = null;

// GOOGLE CLIENT ID VE NATIVE ALGILAMA
const GOOGLE_CLIENT_ID = "447747395966-3shresouu36769er1b9656oec8vd13aa.apps.googleusercontent.com";

const isCapacitorNative = () => {
    return typeof window !== 'undefined' && window.Capacitor && window.Capacitor.isNativePlatform();
};


// ------------------------------------------
// ŞİFRE KAYDETME: e-posta / şifre alanları gerçek <input> olmalı ki Google (Chrome / Android otomatik doldurma)
// "şifreyi kaydet" önerisi çıksın. Eski textarea'lar aynı id ve görünümle gerçek input'a çevrilir.
// ------------------------------------------
function upgradeLoginInput(id, attrs) {
    const old = document.getElementById(id);
    if (!old || old.tagName === 'INPUT') return;
    const inp = document.createElement('input');
    inp.id = old.id;
    inp.className = old.className;
    inp.setAttribute('style', (old.getAttribute('style') || '').replace(/-webkit-text-security:[^;]*;?/g, ''));
    inp.placeholder = old.placeholder;
    inp.setAttribute('autocapitalize', 'none');
    inp.setAttribute('autocorrect', 'off');
    inp.spellcheck = false;
    Object.keys(attrs).forEach((k) => inp.setAttribute(k, attrs[k]));
    old.replaceWith(inp);
}
upgradeLoginInput('email-input', { type: 'email', name: 'username', autocomplete: 'username', inputmode: 'email' });
upgradeLoginInput('password-input', { type: 'password', name: 'password', autocomplete: 'current-password' });
(function () {
    const f = document.getElementById('login-form');
    if (f) f.setAttribute('autocomplete', 'on');
})();

// Giriş başarılı olunca tarayıcıya şifreyi kaydettir (Chrome / PWA). APK'da otomatik doldurma servisi
// alanlar gizlenince kendi önerisini gösterir.
async function offerSavePassword(email, password, name) {
    try {
        if (window.PasswordCredential && navigator.credentials && navigator.credentials.store && email && password) {
            const cred = new window.PasswordCredential({ id: email, password: password, name: name || email });
            await navigator.credentials.store(cred);
        }
    } catch (e) {}
}

// ------------------------------------------
// E-POSTA YAZIM HATASI KORUMASI
// ------------------------------------------
const KNOWN_PROVIDERS = [
    ['gmail', 'com'], ['hotmail', 'com'], ['outlook', 'com'], ['yahoo', 'com'], ['icloud', 'com'],
    ['yandex', 'com'], ['live', 'com'], ['msn', 'com'], ['protonmail', 'com'], ['ymail', 'com'], ['mynet', 'com']
];
const KNOWN_TLDS = ['com', 'net', 'org', 'com.tr', 'net.tr', 'org.tr', 'edu.tr', 'gov.tr', 'co.uk', 'de', 'fr', 'it', 'es', 'ru', 'nl', 'info', 'io', 'me', 'tr', 'eu'];

function lev(a, b) {
    const m = a.length, n = b.length;
    const d = [];
    for (let i = 0; i <= m; i++) { d[i] = [i]; }
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            // iki harfin yer değiştirmesi (gmial -> gmail) tek hata sayılır
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
    }
    return d[m][n];
}

// Bilinen servislere benzeyen yanlış alan adı varsa düzeltilmiş adresi döndürür, yoksa ''
function suggestEmail(email) {
    const at = email.lastIndexOf('@');
    if (at < 1) return '';
    const local = email.slice(0, at);
    const domain = email.slice(at + 1).toLowerCase();
    const dot = domain.indexOf('.');
    if (dot < 1) return '';
    const name = domain.slice(0, dot);
    const tld = domain.slice(dot + 1);
    let best = null;
    for (const [pname, ptld] of KNOWN_PROVIDERS) {
        const dist = lev(name, pname);
        const limit = pname.length <= 5 ? 1 : 2;
        if (dist <= limit && (!best || dist < best.dist)) best = { pname, ptld, dist };
    }
    if (!best) return '';
    const tldOk = KNOWN_TLDS.includes(tld);
    if (best.dist === 0 && tldOk) return ''; // tam doğru
    const newTld = tldOk ? tld : best.ptld;
    const fixed = local + '@' + best.pname + '.' + newTld;
    return fixed === email ? '' : fixed;
}

// Yeni hesap açmadan önce adresi büyük yazıyla gösterip onay ister.
// Döner: { action:'create' } | { action:'replace', email } | { action:'cancel' }
function confirmNewAccountEmail(email) {
    return new Promise((resolve) => {
        const suggestion = suggestEmail(email);
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;padding:16px;';
        const box = document.createElement('div');
        box.style.cssText = 'background:#111b21;border:1px solid #1f2c34;border-radius:18px;padding:22px;width:100%;max-width:360px;text-align:center;color:#e9edef;box-shadow:0 10px 40px rgba(0,0,0,.6);';
        const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        box.innerHTML = `
            <div style="font-size:18px;font-weight:700;margin-bottom:6px;">E-posta adresin doğru mu?</div>
            <div style="font-size:12px;color:#9aa5ad;margin-bottom:12px;">Hesap yoksa yeni hesap açılacak ve doğrulama bağlantısı bu adrese gidecek. Şifren yanlışsa geri dön, şifreni düzelt.</div>
            <div style="font-size:16px;font-weight:700;color:#34d399;word-break:break-all;background:#0b141a;border-radius:12px;padding:12px;margin-bottom:12px;">${esc(email)}</div>
            ${suggestion ? `<div style="font-size:13px;color:#fbbf24;margin-bottom:10px;">Yazım hatası olabilir. Şunu mu demek istedin?</div>
            <button type="button" data-act="use" style="width:100%;background:#059669;color:#fff;font-weight:700;padding:12px;border-radius:12px;margin-bottom:8px;word-break:break-all;">${esc(suggestion)}</button>` : ''}
            <button type="button" data-act="ok" style="width:100%;background:${suggestion ? 'transparent' : '#059669'};border:${suggestion ? '1px solid #3b4650' : '0'};color:#fff;font-weight:600;padding:12px;border-radius:12px;margin-bottom:8px;">Evet, bu adres doğru</button>
            <button type="button" data-act="fix" style="width:100%;color:#9aa5ad;padding:10px;font-size:14px;">Geri dön, düzelteyim</button>`;
        wrap.appendChild(box);
        document.body.appendChild(wrap);
        box.addEventListener('click', (e) => {
            const b = e.target.closest('[data-act]');
            if (!b) return;
            wrap.remove();
            if (b.dataset.act === 'use') resolve({ action: 'replace', email: suggestion });
            else if (b.dataset.act === 'ok') resolve({ action: 'create' });
            else resolve({ action: 'cancel' });
        });
    });
}

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
                // Yeni hesap açılacaksa: doğrulama kodu yanlış adrese gitmesin diye önce adresi onaylat
                const decision = await confirmNewAccountEmail(email);
                if (decision.action === 'replace') {
                    emailInput.value = decision.email;
                    emailInput.dispatchEvent(new Event('input'));
                    return;
                }
                if (decision.action !== 'create') {
                    emailInput.focus();
                    return;
                }
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

       if (userDocSnap.exists() && userDocSnap.data().name) {
                const userData = userDocSnap.data();
                const userObj = {
                    uid: userData.uid || userCred.user.uid,
                    name: userData.name || '',
                    email: userData.email,
                    phone: userData.phone || '',
                    avatar: userData.avatar || ''
                };
                localStorage.setItem('aurachat_user', JSON.stringify(userObj));
                offerSavePassword(email, password, userObj.name);
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

// Doğrulama ekranında "adres yanlış" düğmesi: henüz doğrulanmamış hesabı siler, e-posta alanına döner
(function addWrongAddressButton() {
    if (!verifyModal) return;
    const resend = document.getElementById('btn-resend-verify');
    if (!resend || document.getElementById('btn-verify-wrong')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-verify-wrong';
    btn.textContent = 'E-posta adresim yanlış, düzelt';
    btn.className = 'block mx-auto mt-3 text-xs text-amber-400 underline';
    resend.insertAdjacentElement('afterend', btn);
    btn.addEventListener('click', async () => {
        if (verifyCheckInterval) clearInterval(verifyCheckInterval);
        try {
            const u = auth.currentUser;
            if (u && !u.emailVerified) await deleteUser(u);
        } catch (e) {
            try { await signOut(auth); } catch (e2) {}
        }
        verifyModal.classList.add('hidden');
        if (emailInput) { emailInput.focus(); try { emailInput.select(); } catch (e) {} }
    });
})();

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

         if (userDocSnap.exists() && userDocSnap.data().name) {
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
        // 1. adımda (e-posta/şifre) Enter'a basılırsa "Devam Et" çalışsın
        if (step2 && step2.classList.contains('hidden')) {
            if (btnStep1Next && !btnStep1Next.disabled) btnStep1Next.click();
            return;
        }

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
            offerSavePassword(email, passwordInput ? passwordInput.value.trim() : '', username);

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
