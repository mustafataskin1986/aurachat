// ==========================================
// CHAT COMPOSER (form.js'in sohbet uyarlaması)
//
// Tek satırda:      [+]  [ yazı ]  [gönder / mikrofon]     (hepsi tek yuvarlak kutunun içinde)
// İkinci satırda:   yazı boydan boya yayılır, + ve gönder/mikrofon kutunun altındaki
//                   ayrı bir satıra iner (form.js'teki 3 katmanlı düzen)
// Üstte:            seçilen resimlerin önizleme şeridi (kırmızı × ile silinir)
//
// - Yükseklik ölçümü YOK: görünmez "ayna" kutu yazıyı taşır, tarayıcı satırı hesaplar.
// - Kaç satır olduğunu (tek satır mı çok satır mı) ayrı bir görünmez "prob" kutu belirler.
// - #message-input <input> ise otomatik <textarea>'ya çevrilir (aynı id, aynı class).
// - Yazı: DM Sans 16px (Kozmik'teki #soru_girdisi_xyz fontu).
// - Enter (klavyenin sağ alt tuşu): telefonda HER ZAMAN alt satıra geçer, masaüstünde
//   (fare varsa) chat-core'daki kendi Enter dinleyicisine bırakılır. document üzerinde
//   YAKALAMA (capture) aşamasında dinlenir; bu, kayıt sırasından bağımsız olarak
//   ta'nın kendi (target-phase) dinleyicilerinden ÖNCE çalışmayı garanti eder.
// - Metnin seçili hali (::selection) gönder butonunun rengini (--aura-btn) alır, yazı beyaz.
// - Composer'ın dışındaki sarmalayıcının (alt bar) arka planı şeffaflaştırılır.
//
// chat-core.js kullanır:  const composer = setupComposer();  composer.input  (textarea)
// ==========================================

export function setupComposer() {
    const old = document.getElementById('message-input');
    if (!old) return { input: old, addImages() {}, takeImages() { return []; }, clearImages() {}, hasImages() { return false; }, onChange() {} };

    const LINE = 24;         // satır yüksekliği (px)
    const SINGLE_H = 52;     // tek satır toplam yükseklik (px, çerçeve dahil)
    const MAX_TEXT_H = 170;  // yazı alanı en fazla bu kadar (~6 satır), sonra içeride kayar
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
#chat-area .aura-composer.aura-composer{display:grid !important;grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto auto;align-items:stretch;align-content:center;position:relative;margin:8px 10px !important;padding:0 !important;background:#000000 !important;border:1px solid var(--aura-btn,#22c55e) !important;border-radius:10px !important;overflow:hidden;min-height:${SINGLE_H}px}
#chat-area .aura-composer.aura-composer:focus-within{box-shadow:inset 0 0 0 1px var(--aura-btn,#22c55e) !important}
#chat-area .aura-composer.aura-composer[style*="display: none"]{display:none !important}
.aura-composer > *{margin:0 !important}

.aura-composer > #message-input{grid-row:2;grid-column:1;align-self:center;display:block;width:100% !important;min-width:0;box-sizing:border-box !important;height:auto !important;min-height:0 !important;max-height:none !important;padding:5px var(--aura-pr,62px) 5px var(--aura-pl,52px) !important;color:#ffffff;caret-color:var(--aura-btn,#22c55e);resize:none !important;overflow-x:hidden;overflow-y:auto;scrollbar-width:none;touch-action:manipulation;${TEXT_CSS}}
#chat-area .aura-composer > #message-input,#chat-area .aura-composer > #message-input:focus{background:transparent !important;border:0 !important;border-radius:0 !important;outline:0 !important;box-shadow:none !important}
.aura-composer > #message-input::-webkit-scrollbar{display:none}
.aura-composer > #message-input::selection{background:var(--aura-btn,#22c55e);color:#ffffff}
.aura-composer > .aura-mirror{grid-row:2;grid-column:1;align-self:center;visibility:hidden;pointer-events:none;box-sizing:border-box;min-height:${SINGLE_H - 2}px;max-height:${MAX_TEXT_H}px;overflow:hidden;padding:5px var(--aura-pr,62px) 5px var(--aura-pl,52px);${TEXT_CSS}}

/* Çok satır: yazı boydan boya (köşelerden 5px), + ve gönder alt satıra iner */
.aura-composer.aura-multi > #message-input,.aura-composer.aura-multi > .aura-mirror{padding:5px !important}

.aura-composer > #attach-btn{grid-row:2;grid-column:1;align-self:center;justify-self:start;z-index:2;margin:0 0 0 5px !important}
.aura-composer > #send-btn,.aura-composer > #mic-btn{grid-row:2;grid-column:1;align-self:center;justify-self:end;z-index:2;margin:0 5px 0 0 !important}
.aura-composer.aura-multi > #attach-btn{grid-row:3;align-self:center;margin:0 0 5px 5px !important}
.aura-composer.aura-multi > #send-btn,.aura-composer.aura-multi > #mic-btn{grid-row:3;align-self:center;margin:0 5px 5px 0 !important}

.aura-composer > :not(#attach-btn):not(#message-input):not(#send-btn):not(#mic-btn):not(.aura-mirror):not(.aura-tray):not(.aura-clear){grid-row:2;grid-column:1;align-self:center;z-index:1;background:transparent !important;margin-right:56px !important}

.aura-composer > .aura-clear{display:none;grid-row:2;grid-column:1;justify-self:end;align-self:start;margin:5px 5px 0 0 !important;width:22px;height:22px;border-radius:50%;background:#2a2b2d;border:1px solid rgba(255,255,255,.12);color:#ffffff;font-size:14px;font-weight:bold;line-height:1;align-items:center;justify-content:center;z-index:3;padding:0}

.aura-composer > .aura-tray{grid-row:1;grid-column:1;display:none;gap:12px;overflow-x:auto;padding:12px 14px 2px 14px;scrollbar-width:none}
.aura-composer > .aura-tray::-webkit-scrollbar{display:none}
.aura-composer.has-tray > .aura-tray{display:flex}
.aura-thumb{position:relative;flex:none;width:65px;height:65px}
.aura-thumb img{width:100%;height:100%;display:block;object-fit:cover;border-radius:12px;border:1px solid rgba(255,255,255,.15);box-shadow:0 2px 8px rgba(0,0,0,.3)}
.aura-thumb button{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;background:#f44336;color:#ffffff;border:0;font-size:12px;font-weight:bold;line-height:1;padding:0;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.6);z-index:2}

.aura-probe{position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;box-sizing:content-box;padding:0;border:0;overflow:hidden;${TEXT_CSS}}`;
    document.head.appendChild(style);

// ---------- Alt bar sarmalayıcısının arka planını kaldır ----------
    // index.html'i görmediğimiz için sarmalayıcının sınıf adını bilmiyoruz; composer'ın
    // (row) dışındaki kapsayıcı katmanları #chat-area'ya kadar (dahil) temizliyoruz.
    // Asıl tema rengini chat-theme.js #chat-area'ya kendisi basıyor, burası sadece
    // araya giren opak katmanları şeffaflaştırıyor.
    let ancestor = row.parentElement;
    let ancestorHops = 0;
    while (ancestor && ancestorHops < 6) {
        ancestor.style.setProperty('background', 'transparent', 'important');
        ancestor.style.setProperty('background-image', 'none', 'important');
        ancestor.style.setProperty('backdrop-filter', 'none', 'important');
        ancestor.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
        ancestor.style.setProperty('box-shadow', 'none', 'important');
        ancestorHops++;
        if (ancestor.id === 'chat-area') break;
        ancestor = ancestor.parentElement;
    }

    // ---------- Ayna kutu, prob kutu, önizleme şeridi, temizle (×) butonu ----------
    const mirror = document.createElement('div');
    mirror.className = 'aura-mirror';
    ta.insertAdjacentElement('afterend', mirror);

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

    // ---------- Senkron ----------
    function sync() {
        if (!ta.isConnected) return;

        // Tek satırdaki kenar boşlukları (+ ve gönder genişliği + 5px kenar + 5px nefes payı)
        const mic = document.getElementById('mic-btn');
        const rightW = Math.max(send ? send.offsetWidth : 0, mic ? mic.offsetWidth : 0);
        const leftW = (attach && row.contains(attach)) ? attach.offsetWidth : 0;
        const rightInside = !!((send && row.contains(send)) || (mic && row.contains(mic)));
        const pl = leftW ? leftW + 10 : 16;
        const pr = rightInside ? (rightW || 46) + 10 : 16;
        row.style.setProperty('--aura-pl', pl + 'px');
        row.style.setProperty('--aura-pr', pr + 'px');

        // Tek satır genişliğinde kaç satır çıkıyor? (mod ne olursa olsun aynı ölçü)
        const inner = row.clientWidth;
        let multi = false;
        if (inner > 0 && ta.value.length > 0) {
            probe.style.width = Math.max(40, inner - pl - pr) + 'px';
            probe.textContent = ta.value + '\u200b';
            multi = Math.round(probe.scrollHeight / LINE) > 1;
        }
        row.classList.toggle('aura-multi', multi);
        clearBtn.style.display = multi ? 'flex' : 'none';

        mirror.textContent = ta.value + '\u200b';

        // En üst sınıra gelince imleç en alt satırda görünsün
        if (mirror.scrollHeight > mirror.clientHeight + 1 && ta.selectionStart >= ta.value.length - 1) {
            ta.scrollTop = ta.scrollHeight;
        }
    }

    // "messageInput.value = ''" (mesaj gidince) yazılınca da kutu tek satıra dönsün
    Object.defineProperty(ta, 'value', {
        configurable: true,
        get() { return valueDesc.get.call(this); },
        set(v) { valueDesc.set.call(this, v); sync(); }
    });
    ta.addEventListener('input', sync);
    window.addEventListener('resize', sync);

    // ---------- ENTER (klavyenin sağ alt tuşu) ----------
    // Telefonda mutlaka alt satıra geçer. Masaüstünde (fare varsa) hiçbir şey yapılmaz,
    // chat-core'daki kendi Enter dinleyicisi gönderir. document üzerinde YAKALAMA
    // (capture) aşamasında dinlenir: bu, ta'ya sonradan eklenmiş başka bir Enter
    // dinleyicisinden (kayıt sırası ne olursa olsun) ÖNCE çalışmayı garanti eder.
    const isDesktop = () => {
        const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
        if (hasTouch) return false; // dokunmatik cihazda asla masaüstü sayılmaz
        try { return window.matchMedia('(pointer: fine)').matches; } catch (e) { return false; }
    };
    function insertNewlineAtCursor() {
        const s = ta.selectionStart;
        const e = ta.selectionEnd;
        ta.setRangeText('\n', s, e, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    ['keydown', 'keypress'].forEach((type) => {
        document.addEventListener(type, (e) => {
            if (e.target !== ta || e.key !== 'Enter' || isDesktop()) return;
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
