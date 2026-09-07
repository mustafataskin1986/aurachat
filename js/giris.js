// giris.js — Giriş ekranı modülü (IIFE + HTML injection + window export)
(function () {
    const GIRIS_HTML = `
    <div id="login-overlay" class="fixed inset-0 z-50 bg-[#0b141a] flex items-center justify-center p-4 hidden">
        <div class="bg-[#111b21] border border-gray-800 rounded-2xl p-6 md:p-8 w-full max-w-md shadow-2xl text-center">
            <div class="w-16 h-16 bg-gradient-to-tr from-cyan-600 to-emerald-500 rounded-full flex items-center justify-center text-white text-2xl font-bold mx-auto mb-4 shadow-lg">
                <i class="fa-solid fa-comments"></i>
            </div>
            <h2 class="text-white text-xl font-bold mb-1">AuraChat'e Hoş Geldin</h2>
            <p class="text-gray-400 text-sm mb-6">Güvenli sohbet için adını ve şifreni gir kanka.</p>

            <form id="login-form" class="space-y-4 text-left" autocomplete="off">
                <div class="flex flex-col items-center">
                    <label for="profile-image-input" class="cursor-pointer group relative">
                        <div id="profile-preview" class="w-20 h-20 bg-[#202c33] border-2 border-dashed border-gray-600 rounded-full flex items-center justify-center text-gray-400 overflow-hidden group-hover:border-emerald-500 transition shadow-inner">
                            <i class="fa-solid fa-camera text-xl"></i>
                        </div>
                        <div class="absolute bottom-0 right-0 bg-emerald-600 text-white w-6 h-6 rounded-full flex items-center text-xs justify-center shadow">
                            <i class="fa-solid fa-plus"></i>
                        </div>
                    </label>
                    <input type="file" id="profile-image-input" accept="image/*" class="hidden">
                    <span class="text-xs text-gray-400 mt-2">Profil Fotoğrafı Ekle (İsteğe bağlı)</span>
                </div>

                <div>
                    <label class="block text-xs font-medium text-gray-300 mb-1">Adın veya Rumuzun</label>
                    <textarea id="username-input" rows="1" name="aurachat_usr_field" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" data-lpignore="true" data-form-type="other" placeholder="Örn: Hasan" required class="w-full bg-[#202c33] text-white text-sm px-4 py-3 rounded-xl border border-transparent focus:border-emerald-500/50 focus:outline-none transition placeholder-gray-500 resize-none overflow-hidden leading-tight" style="height:46px; max-height:46px;" oninput="this.value = this.value.replace(/\\n/g, '');"></textarea>
                </div>

                <div>
                    <label class="block text-xs font-medium text-gray-300 mb-1">Şifren</label>
                    <textarea id="password-input" rows="1" name="aurachat_pwd_field" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" data-lpignore="true" data-form-type="other" placeholder="Örn: 123456" required class="w-full bg-[#202c33] text-white text-sm px-4 py-3 rounded-xl border border-transparent focus:border-emerald-500/50 focus:outline-none transition placeholder-gray-500 resize-none overflow-hidden leading-tight" style="height:46px; max-height:46px; -webkit-text-security: disk;" oninput="this.value = this.value.replace(/\\n/g, '');"></textarea>
                </div>

                <button type="submit" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-3 rounded-xl transition shadow-lg flex items-center justify-center space-x-2 mt-2">
                    <span>Sohbete Başla</span>
                    <i class="fa-solid fa-arrow-right text-sm"></i>
                </button>
            </form>
        </div>
    </div>`;

    let submitCallback = null;
    let base64Image = '';
    let injected = false;

    function girisiEnjekteEt() {
        if (injected) return;
        const sarmalayici = document.createElement('div');
        sarmalayici.id = 'giris-container';
        sarmalayici.innerHTML = GIRIS_HTML;
        document.body.prepend(sarmalayici);
        injected = true;
    }

    function olaylariBagla() {
        const profileImageInput = document.getElementById('profile-image-input');
        const profilePreview = document.getElementById('profile-preview');
        const loginForm = document.getElementById('login-form');
        const usernameInput = document.getElementById('username-input');
        const passwordInput = document.getElementById('password-input');

        profileImageInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = function (uploadEvent) {
                    base64Image = uploadEvent.target.result;
                    profilePreview.innerHTML = `<img src="${base64Image}" class="w-full h-full object-cover rounded-full">`;
                };
                reader.readAsDataURL(file);
            }
        });

        loginForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const username = usernameInput.value.trim();
            const password = passwordInput.value.trim();
            if (!username || !password) return;
            if (submitCallback) {
                submitCallback(username, password, base64Image);
            }
        });
    }

    window.KozmikGiris = {
        // onSubmit(username, password, avatarBase64) — form gönderildiğinde çağrılır
        init: function (onSubmit) {
            girisiEnjekteEt();
            olaylariBagla();
            submitCallback = onSubmit;
        },
        show: function () {
            const overlay = document.getElementById('login-overlay');
            if (overlay) overlay.classList.remove('hidden');
        },
        hide: function () {
            const overlay = document.getElementById('login-overlay');
            if (overlay) overlay.classList.add('hidden');
        },
        showError: function (message) {
            alert(message);
        }
    };
})();