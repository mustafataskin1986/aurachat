document.addEventListener('DOMContentLoaded', () => {
    const loginOverlay = document.getElementById('login-overlay');
    const loginForm = document.getElementById('login-form');
    const usernameInput = document.getElementById('username-input');
    const profileImageInput = document.getElementById('profile-image-input');
    const profilePreview = document.getElementById('profile-preview');

    let base64Image = '';

    // Daha önce giriş yapmış mı kontrol et (Kalıcılık / Hatırlama)
    const savedUser = JSON.parse(localStorage.getItem('aurachat_user'));

    if (savedUser) {
        // Kullanıcı daha önce kayıt olmuşsa giriş ekranını gizle, verileri yükle
        loginOverlay.classList.add('hidden');
        updateUserInterface(savedUser);
    } else {
        // Kayıt yoksa şık giriş ekranını göster
        loginOverlay.classList.remove('hidden');
    }

    // Profil resmi seçildiğinde önizleme yap ve Base64'e çevir
    profileImageInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = function(uploadEvent) {
                base64Image = uploadEvent.target.result;
                profilePreview.innerHTML = `<img src="${base64Image}" class="w-full h-full object-cover rounded-full">`;
            };
            reader.readAsDataURL(file);
        }
    });

    // Form gönderildiğinde (Giriş yapıldığında)
    loginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const username = usernameInput.value.trim();
        if (!username) return;

        const userData = {
            name: username,
            avatar: base64Image || ''
        };

        // Tarayıcıya kalıcı olarak kaydet
        localStorage.setItem('aurachat_user', JSON.stringify(userData));
        
        // Giriş ekranını kapat ve arayüzü güncelle
        loginOverlay.classList.add('hidden');
        updateUserInterface(userData);
    });
});

// Arayüzdeki profil fotoğrafını ve ismi güncelleyen fonksiyon
function updateUserInterface(user) {
    const userProfileContainer = document.getElementById('user-profile-container');
    const userNameSpan = document.getElementById('user-name-span');

    if (userProfileContainer) {
        if (user.avatar) {
            userProfileContainer.innerHTML = `<img src="${user.avatar}" class="w-10 h-10 rounded-full object-cover shadow border border-emerald-500/50">`;
        } else {
            const initials = user.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
            userProfileContainer.innerHTML = `<div class="w-10 h-10 bg-gradient-to-tr from-cyan-600 to-emerald-500 rounded-full flex items-center justify-center text-white font-semibold shadow">${initials}</div>`;
        }
    }

    if (userNameSpan) {
        userNameSpan.textContent = user.name;
    }
}
