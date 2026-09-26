// ==========================================
// CHAT COMPOSER (form.js'in sohbet uyarlaması)
//
// Tek satırda:      [+]  [ yazı ]  [gönder / mikrofon]     (hepsi tek yuvarlak kutunun içinde)
// İkinci satırda:   yazı boydan boya yayılır, + ve gönder/mikrofon kutunun altındaki
//                   ayrı bir satıra iner (form.js'teki 3 katmanlı düzen)
// Üstte:            seçilen resimlerin önizleme şeridi (kırmızı × ile silinir)
//
// GÜNCELLEME (yükseklik artık JS ile yazılıyor): Bazı WebView'lerde <textarea>
// CSS grid içinde height:auto verilince satır sayısına göre DOĞRU büyümüyor,
// sınırsız uzuyordu. Artık yükseklik hiç tarayıcıya bırakılmıyor: görünmez bir
// "prob" kutu ile kaç satır olduğu ölçülüyor, gerçek kutunun yüksekliği bu
// sayıdan hesaplanıp inline style ile (!important) doğrudan yazılıyor.
//
// - #message-input <input> ise otomatik <textarea>'ya çevrilir (aynı id, aynı class).
// - Yazı: DM Sans 16px (Kozmik'teki #soru_girdisi_xyz fontu).
// - Enter (klavyenin sağ alt tuşu): telefonda HER ZAMAN alt satıra geçer, masaüstünde
//   (dokunmatik değilse VE fare varsa) chat-core'daki kendi Enter dinleyicisine bırakılır.
// - Metnin seçili hali (::selection) gönder butonunun rengini (--aura-btn) alır, yazı beyaz.
// - Composer'ın dışındaki sarmalayıcının (#chat-area'ya kadar) arka planı şeffaflaştırılır.
//
// chat-core.js kullanır:  const composer = setupComposer();  composer.input  (textarea)
// ==========================================

export function setupComposer() {
    const old = document.getElementById('message-input');
    if (!old) return { input: old, addImages() {}, takeImages() { return []; }, clearImages() {}, hasImages() { return false; }, onChange() {} };

    const LINE = 24;         // satır yüksekliği (px)
    const PAD_V = 10;        // yazı kutusunun üst+alt iç boşluğu toplamı (5+5)
    const SINGLE_H = 52;     // tek satır durumunda pilin toplam yüksekliği (px, çerçeve dahil)
    const MAX_TEXT_H = 166;  // yazı kutusu en fazla bu kadar uzar (~6.5 satır), sonra içeride kayar
    const MAX_IMAGES = 20;
    const FONT = `'DM Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    const TEXT_CSS = `font-family:${FONT} !important;font-size:16px !important;line-height:${LINE}px !important;letter-spacing:0.02em !important;white-space:pre-wrap;overflow-wrap:anywhere;`;

    // ---------- <input> ise <textarea> yap ----------
    let ta = old;
    const valueDesc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (old.tagName !== 'TEXTAREA') {
        ta = document.createElement('textarea');
        Array.from(old.attributes).forEach((a) => {
            if (a.name === 'type' || a.name === 'value' || a.name === 'style') return;
            ta.setAttribute(a.name, a.value);
        });
        valueDesc.set.call(ta, old.value || '');
        old.replaceWith(ta);
    }
    ta.rows = 1;
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off');

    const row = ta.parentElement;
    const attach = document.getElementById('attach-btn');
    const send = document.getElementById('send-btn');
    row.classList.add('aura-composer');

    // ---------- CSS ----------
    const style = document.createElement('style');
    style.id = 'aura-composer-css';
    style.textContent = `
#chat-area .aura-composer.aura-composer{display:grid !important;grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto auto;align-items:stretch;align-content:center;position:relative;margin:0 !important;padding:0 !important;background:#000000 !important;border:1px solid var(--aura-btn,#22c55e) !important;border-radius:0 !important;overflow:hidden;min-height:${SINGLE_H}px}
#chat-area .aura-composer.aura-composer:focus-within{box-shadow:inset 0 0 0 1px var(--aura-btn,#22c55e) !important}
#chat-area .aura-composer.aura-composer[style*="display: none"]{display:none !important}
.aura-composer > *{margin:0 !important}

.aura-composer > #message-input{grid-row:2;grid-column:1;align-self:center;display:block;width:100% !important;min-width:0;box-sizing:border-box !important;padding:5px var(--aura-pr,62px) 5px var(--aura-pl,52px) !important;color:#ffffff;caret-color:var(--aura-btn,#22c55e);resize:none !important;overflow-x:hidden;overflow-y:hidden;scrollbar-width:none;touch-action:manipulation;${TEXT_CSS}}
#chat-area .aura-composer > #message-input,#chat-area .aura-composer > #message-input:focus{background:transparent !important;border:0 !important;border-radius:0 !important;outline:0 !important;box-shadow:none !important}
.aura-composer > #message-input::-webkit-scrollbar{display:none}
.aura-composer > #message-input::selection{background:var(--aura-btn,#22c55e);color:#ffffff}

/* Çok satır: yazı boydan boya (köşelerden 5px), + ve gönder alt satıra iner */
.aura-composer.aura-multi > #message-input{padding:5px !important}

.aura-composer > #attach-btn{grid-row:2;grid-column:1;align-self:center;justify-self:start;z-index:2;margin:0 0 0 5px !important}
.aura-composer > #send-btn,.aura-composer > #mic-btn{grid-row:2;grid-column:1;align-self:center;justify-self:end;z-index:2;margin:0 5px 0 0 !important}
.aura-composer.aura-multi > #attach-btn{grid-row:3;align-self:center;margin:0 0 5px 5px !important}
.aura-composer.aura-multi > #send-btn,.aura-composer.aura-multi > #mic-btn{grid-row:3;align-self:center;margin:0 5px 5px 0 !important}

.aura-composer > :not(#attach-btn):not(#message-input):not(#send-btn):not(#mic-btn):not(.aura-tray):not(.aura-clear){grid-row:2;grid-column:1;align-self:center;z-index:1;background:transparent !important;margin-right:56px !important}

.aura-composer > .aura-clear{display:none;grid-row:2;grid-column:1;justify-self:end;align-self:start;margin:5px 5px 0 0 !important;width:22px;height:22px;border-radius:50%;background:#2a2b2d;border:1px solid rgba(255,255,255,.12);color:#ffffff;font-size:14px;font-weight:bold;line-height:1;align-items:center;justify-content:center;z-index:3;padding:0}

.aura-composer > .aura-tray{grid-row:1;grid-column:1;display:none;gap:12px;overflow-x:auto;padding:12px 14px 2px 14px;scrollbar-width:none}
.aura-composer > .aura-tray::-webkit-scrollbar{display:none}
.aura-composer.has-tray > .aura-tray{display:flex}
.aura-thumb{position:relative;flex:none;width:65px;height:65px}
.aura-thumb img{width:100%;height:100%;display:block;object-fit:cover;border-radius:12px;border:1px solid rgba(255,255,255,.15);box-shadow:0 2px 8px rgba(0,0,0,.3)}
.aura-thumb button{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;background:#f44336;color:#ffffff;border:0;font-size:12px;font-weight:bold;line-height:1;padding:0;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.6);z-index:2}

.aura-probe{position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;box-sizing:content-box;padding:0;border:0;overflow:hidden;${TEXT_CSS}}`;
    document.head.appendChild(style);

    // ---------- Alt bar sarmalayıcısının arka planını ve boşluğunu kaldır ----------
    // index.html'i görmediğimiz için sarmalayıcının sınıf adını bilmiyoruz; composer'ın
    // (row) dışındaki kapsayıcı katmanları #chat-area'ya kadar (dahil) temizliyoruz.
    // Asıl tema rengini chat-theme.js #chat-area'ya kendisi basıyor, burası sadece
    // araya giren opak katmanları ve boşlukları temizliyor - composer duvardan duvara
    // ve klavyeye bitişik dursun diye.
    let ancestor = row.parentElement;
    let ancestorHops = 0;
    while (ancestor && ancestorHops < 6) {
        if (ancestorHops === 0) {
            // "Alt panel": form.js'teki gibi koyu, yukarı doğru şeffaflaşan gradient
            ancestor.style.setProperty('background', 'linear-gradient(to top, rgba(0,0,0,.95) 0%, rgba(0,0,0,.75) 30%, rgba(0,0,0,.45) 60%, rgba(0,0,0,.15) 85%, rgba(0,0,0,0) 100%)', 'important');
        } else {
            ancestor.style.setProperty('background', 'transparent', 'important');
            ancestor.style.setProperty('background-image', 'none', 'important');
        }
        ancestor.style.setProperty('backdrop-filter', 'none', 'important');
        ancestor.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
        ancestor.style.setProperty('box-shadow', 'none', 'important');
        ancestor.style.setProperty('padding', '0', 'important');
        ancestor.style.setProperty('margin', '0', 'important');
        ancestor.style.setProperty('border', '0', 'important');
        ancestorHops++;
        if (ancestor.id === 'chat-area') break;
        ancestor = ancestor.parentElement;
    }

    // ---------- Prob kutu (satır sayısını ölçmek için), önizleme şeridi, temizle (×) butonu ----------
    const probe = document.createElement('div');
    probe.className = 'aura-probe';
    document.body.appendChild(probe);

    const tray = document.createElement('div');
    tray.className = 'aura-tray';
    row.insertBefore(tray, row.firstChild);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'aura-clear';
    clearBtn.textContent = '×';
    clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
    clearBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        ta.value = '';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
    });
    row.appendChild(clearBtn);

    function measureLines(text, width) {
        if (width <= 0 || !text) return 1;
        probe.style.width = Math.max(20, width) + 'px';
        probe.textContent = text + '\u200b';
        return Math.max(1, Math.round(probe.scrollHeight / LINE));
    }

    // ---------- Senkron: kenar boşlukları, mod (tek/çok satır), gerçek yükseklik ----------
    function sync() {
        if (!ta.isConnected || document.hidden) return;
        const val = ta.value;

        // + ve gönder butonunun genişliği kadar kenar boşluğu (tek satır modu)
        const mic = document.getElementById('mic-btn');
        const rightW = Math.max(send ? send.offsetWidth : 0, mic ? mic.offsetWidth : 0);
        const leftW = (attach && row.contains(attach)) ? attach.offsetWidth : 0;
        const rightInside = !!((send && row.contains(send)) || (mic && row.contains(mic)));
        const singlePl = leftW ? leftW + 10 : 16;
        const singlePr = rightInside ? (rightW || 46) + 10 : 16;
        row.style.setProperty('--aura-pl', singlePl + 'px');
        row.style.setProperty('--aura-pr', singlePr + 'px');

        const inner = row.clientWidth;
        // Klavye açılıp kapanırken (özellikle arka plandan dönüşte) bir an
        // için 0 veya anlamsız genişlik okunabiliyor - bu yanlış değerle
        // hesaplayıp sonra doğrusuna "zıplamak" yerine, geçersiz okumayı atla
        if (inner <= 0) return;

        // 1) Tek satır genişliğinde kaç satır çıkıyor? (moda karar vermek için)
        const singleWidth = inner - singlePl - singlePr;
        const multi = measureLines(val, singleWidth) > 1;
        row.classList.toggle('aura-multi', multi);
        clearBtn.style.display = multi ? 'flex' : 'none';

        // 2) Gerçek satır sayısı: moda göre doğru genişlikte tekrar ölç
        const lines = multi ? measureLines(val, inner - 10) : 1;

        // 3) Yüksekliği KENDİMİZ yazıyoruz (tarayıcıya bırakmıyoruz - bazı WebView'lerde
        // grid içindeki textarea sınırsız büyüyebiliyordu)
        const raw = lines * LINE + PAD_V;
        const finalH = Math.min(raw, MAX_TEXT_H);
        ta.style.setProperty('height', finalH + 'px', 'important');
        ta.style.setProperty('overflow-y', raw > MAX_TEXT_H ? 'auto' : 'hidden', 'important');

        // En üst sınıra gelince imleç en alt satırda görünsün
        if (raw > MAX_TEXT_H && ta.selectionStart >= val.length - 1) {
            ta.scrollTop = ta.scrollHeight;
        }
    }

    // "messageInput.value = ''" (mesaj gidince) yazılınca da kutu tek satıra dönsün
    Object.defineProperty(ta, 'value', {
        configurable: true,
        get() { return valueDesc.get.call(this); },
        set(v) { valueDesc.set.call(this, v); sync(); }
    });
    let resizeRafId = null;
    function syncOnResize() {
        // Art arda gelen resize olaylarını (klavye açılıp kapanırken
        // onlarca kez ateşleniyor) tek bir animasyon karesinde birleştir
        if (resizeRafId) return;
        resizeRafId = requestAnimationFrame(() => {
            resizeRafId = null;
            sync();
        });
    }
    ta.addEventListener('input', sync);
    window.addEventListener('resize', syncOnResize);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') syncOnResize();
    });

    // ---------- ENTER (klavyenin sağ alt tuşu) ----------
    // Telefonda mutlaka alt satıra geçer. Masaüstünde (dokunmatik yoksa VE fare varsa)
    // hiçbir şey yapılmaz, chat-core'daki kendi Enter dinleyicisi gönderir. document
    // üzerinde YAKALAMA (capture) aşamasında dinlenir: bu, ta'ya sonradan eklenmiş
    // başka bir Enter dinleyicisinden (kayıt sırası ne olursa olsun) ÖNCE çalışmayı garanti eder.
    const isDesktop = () => {
        const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
        if (hasTouch) return false; // dokunmatik cihazda asla masaüstü sayılmaz
        try { return window.matchMedia('(pointer: fine)').matches; } catch (e) { return false; }
    };
    function insertNewlineAtCursor() {
        const s = ta.selectionStart;
        const e = ta.selectionEnd;
        const before = valueDesc.get.call(ta);
        let ok = false;

        // 1. yöntem: setRangeText (bu cihazda çalıştığı doğrulandı)
        try {
            if (typeof ta.setRangeText === 'function') {
                ta.setRangeText('\n', s, e, 'end');
                if (valueDesc.get.call(ta) !== before) ok = true;
            }
        } catch (err) {}

        // 2. yöntem: execCommand (yedek)
        if (!ok) {
            try {
                ta.focus();
                ta.setSelectionRange(s, e);
                document.execCommand('insertText', false, '\n');
                if (valueDesc.get.call(ta) !== before) ok = true;
            } catch (err) {}
        }

        // 3. yöntem: değeri elle böl ve native setter ile yaz (son çare)
        if (!ok) {
            try {
                valueDesc.set.call(ta, before.slice(0, s) + '\n' + before.slice(e));
                ta.selectionStart = ta.selectionEnd = s + 1;
            } catch (err) {}
        }

        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    ['keydown', 'keypress'].forEach((type) => {
        document.addEventListener(type, (e) => {
            const looksLikeEnter = e.key === 'Enter' || e.keyCode === 13 || e.which === 13 || e.code === 'Enter';
            if (e.target !== ta || !looksLikeEnter || isDesktop()) return;
            e.preventDefault();
            e.stopPropagation();
            if (type === 'keydown') insertNewlineAtCursor();
        }, true);
    });

    // ---------- Resim önizleme şeridi ----------
    let pending = []; // { file, url }
    const listeners = [];
    function notify() { listeners.forEach((fn) => { try { fn(); } catch (e) {} }); }

    function renderTray() {
        tray.innerHTML = '';
        pending.forEach((p, i) => {
            const wrap = document.createElement('div');
            wrap.className = 'aura-thumb';
            const img = document.createElement('img');
            img.src = p.url;
            img.alt = '';
            const x = document.createElement('button');
            x.type = 'button';
            x.textContent = '×';
            x.addEventListener('click', (e) => { e.stopPropagation(); removeAt(i); });
            wrap.appendChild(img);
            wrap.appendChild(x);
            tray.appendChild(wrap);
        });
        row.classList.toggle('has-tray', pending.length > 0);
    }

    function removeAt(i) {
        const removed = pending.splice(i, 1)[0];
        if (removed) URL.revokeObjectURL(removed.url);
        renderTray();
        notify();
    }

    function addImages(files) {
        const room = MAX_IMAGES - pending.length;
        Array.from(files).slice(0, Math.max(0, room)).forEach((f) => {
            pending.push({ file: f, url: URL.createObjectURL(f) });
        });
        renderTray();
        notify();
    }

    function takeImages() {
        const files = pending.map((p) => p.file);
        pending.forEach((p) => URL.revokeObjectURL(p.url));
        pending = [];
        renderTray();
        notify();
        return files;
    }

    function clearImages() {
        if (pending.length) takeImages();
    }

    sync();
    requestAnimationFrame(sync);

    return {
        input: ta,
        addImages: addImages,
        takeImages: takeImages,
        clearImages: clearImages,
        hasImages: () => pending.length > 0,
        onChange: (fn) => { listeners.push(fn); }
    };
}
