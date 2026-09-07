import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

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

let base64Image = '';

const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');
const profileImageInput = document.getElementById('profile-image-input');
const profilePreview = document.getElementById('profile-preview');

// ==========================================
// ⚙️ KLAVYE YÜKSEKLİK / KAYDIRMA AYARI
// ==========================================
const KEYBOARD_OFFSET_PX = -120; // Şu anki ideal yüksekliğin

// Ortadaki form kutusunu yumuşakça kaydıran/sıfırlayan fonksiyon
const setCardOffset = (offset) => {
    const targetCard = loginOverlay ? (loginOverlay.firstElementChild || loginForm) : loginForm;
    if (targetCard) {
        targetCard.style.transition = 'transform 0.25s ease-out';
        targetCard.style.transform = `translateY(${offset}px)`;
    }
};

// Input alanlarına odaklanıldığında ve odaktan çıkıldığında
[usernameInput, passwordInput].forEach(input => {
    if (input) {
        input.addEventListener('focus', () => {
            setCardOffset(KEYBOARD_OFFSET_PX);
        });

        input.addEventListener('blur', () => {
            setCardOffset(0);
        });
    }
});

// 📱 MOBİL KLAVYE KAPANMA KONTROLÜ (Kesin Çözüm)
// Mobil klavye gizlendiğinde ekran boyutu eski haline döner, bu anı yakalayıp menüyü indiriyoruz
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        // Ekran yüksekliği klavye kapandığı için genişlediyse:
        if (window.visualViewport.height >= window.innerHeight - 50) {
            setCardOffset(0); // Menüyü merkeze indir
            if (document.activeElement && (document.activeElement === usernameInput || document.activeElement === passwordInput)) {
                document.activeElement.blur(); // Odaklanmayı kaldır
            }
        }
    });
}

// 🖱️ Boş bir yere dokunulursa klavyeyi kapat ve menüyü merkeze indir
if (loginOverlay) {
    loginOverlay.addEventListener('click', (e) => {
        if (e.target === loginOverlay) {
            setCardOffset(0);
            if (usernameInput) usernameInput.blur();
            if (passwordInput) passwordInput.blur();
        }
    });
}

// Oturum kontrolü
const currentUser = JSON.parse(localStorage.stringify ? localStorage.getItem('aurachat_user') : null);
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

// Giriş Formu İşlemleri
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = usernameInput.value.trim();
        const password = passwordInput.value.trim();
        if (!username || !password) return;

        try {
            const userRef = doc(db, "users", username);
            const userSnap = await getDoc(userRef);

            let finalAvatar = base64Image;

            if (userSnap.exists()) {
                const userData = userSnap.data();
                if (userData.password && userData.password !== password) {
                    alert("Şifre hatalı kanka! Bu isim başka bir şifreyle kayıtlı.");
                    return;
                }
                if (!finalAvatar && userData.avatar) {
                    finalAvatar = userData.avatar;
                }
            }

            await setDoc(userRef, {
                name: username,
                password: password,
                avatar: finalAvatar || '',
                lastSeen: serverTimestamp()
            }, { merge: true });

            const userObj = {
                name: username,
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
            console.error("Giriş hatası:", err);
            alert("Giriş yapılırken bir sorun oluştu.");
        }
    });
}
