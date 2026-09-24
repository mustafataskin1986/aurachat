// ==========================================
// CHAT COMPOSER (form.js'in sohbet uyarlaması)
//
// Mesaj kutusu tek bir yuvarlak "hap" olur. İçinde:
//   [ önizleme şeridi: seçilen resimler, kırmızı × ile silinir ]
//   [ yazı alanı: satır satır yukarı uzar (en fazla 6 satır) ]
//   [+] sol altta, [gönder / mikrofon] sağ altta (yazı ikisinin arasında akar)
//
// - Yükseklik ölçümü YOK: görünmez bir "ayna" kutu aynı yazıyı taşır, tarayıcı
//   satır sayısını kendisi hesaplar, textarea onun yüksekliğine uzar.
// - #message-input <input> ise otomatik <textarea>'ya çevrilir (aynı id, aynı class).
// - Çerçeve rengi ve imleç: gönder butonunun rengi (--aura-btn), aktifken 2 kat kalın.
// - Klavyenin sağ alt tuşu (enter) alt satıra geçer.
// - Resimler hemen gitmez, önizleme olarak bekler, gönder tuşuyla gider.
//
// chat-core.js kullanır:  const composer = setupComposer();  composer.input  (textarea)
// ==========================================

export function setupComposer() {
    const old = document.getElementById('message-input');
    if (!old) return { input: old, addImages() {}, takeImages() { return []; }, clearImages() {}, hasImages() { return false; }, onChange() {} };

    const SINGLE_H = 46;   // tek satır toplam yükseklik (px, çerçeve dahil)
    const MAX_H = 166;     // en fazla 6 satır, sonra içeride kayar
    const MAX_IMAGES = 20;

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
    ta.setAttribute('enterkeyhint', 'enter');
    ta.setAttribute('autocomplete', 'off');

    const row = ta.parentElement;
    const attach = document.getElementById('attach-btn');
    const send = document.getElementById('send-btn');
    row.classList.add('aura-composer');

    // ---------- CSS ----------
    const style = document.createElement('style');
    style.id = 'aura-composer-css';
    style.textContent = `
#chat-area .aura-composer.aura-composer{display:grid !important;grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto;align-items:stretch;position:relative;margin:8px 10px !important;padding:0 !important;background:#000000 !important;border:1px solid var(--aura-btn,#22c55e) !important;border-radius:26px !important;overflow:hidden;min-height:${SINGLE_H}px}
#chat-area .aura-composer.aura-composer:focus-within{box-shadow:inset 0 0 0 1px var(--aura-btn,#22c55e) !important}
#chat-area .aura-composer.aura-composer[style*="display: none"]{display:none !important}
.aura-composer > *{margin:0 !important}

.aura-composer > #message-input{grid-row:2;grid-column:1;display:block;width:100% !important;min-width:0;box-sizing:border-box !important;height:auto !important;min-height:0 !important;max-height:none !important;padding:10px var(--aura-pr,62px) 10px var(--aura-pl,52px) !important;background:transparent !important;border:0 !important;border-radius:0 !important;outline:0 !important;box-shadow:none !important;color:#ffffff;caret-color:var(--aura-btn,#22c55e);font-size:16px !important;line-height:24px !important;resize:none !important;white-space:pre-wrap;overflow-wrap:anywhere;overflow-x:hidden;overflow-y:auto;scrollbar-width:none;touch-action:manipulation}
.aura-composer > #message-input::-webkit-scrollbar{display:none}
.aura-composer > .aura-mirror{grid-row:2;grid-column:1;visibility:hidden;pointer-events:none;box-sizing:border-box;min-height:${SINGLE_H - 2}px;max-height:${MAX_H - 2}px;overflow:hidden;padding:10px var(--aura-pr,62px) 10px var(--aura-pl,52px);font-size:16px;line-height:24px;white-space:pre-wrap;overflow-wrap:anywhere}

.aura-composer > #attach-btn{grid-row:2;grid-column:1;align-self:end;justify-self:start;z-index:2;margin:0 0 2px 4px !important}
.aura-composer > #send-btn,.aura-composer > #mic-btn{grid-row:2;grid-column:1;align-self:end;justify-self:end;z-index:2;margin:0 3px 2px 0 !important}
.aura-composer > :not(#attach-btn):not(#message-input):not(#send-btn):not(#mic-btn):not(.aura-mirror):not(.aura-tray):not(.aura-clear){grid-row:2;grid-column:1;align-self:center;z-index:1;background:transparent !important;margin-right:56px !important}

.aura-composer > .aura-clear{display:none;position:absolute;top:7px;right:8px;width:22px;height:22px;border-radius:50%;background:#2a2b2d;border:1px solid rgba(255,255,255,.12);color:#ffffff;font-size:14px;font-weight:bold;line-height:1;align-items:center;justify-content:center;z-index:3;padding:0}

.aura-composer > .aura-tray{grid-row:1;grid-column:1;display:none;gap:12px;overflow-x:auto;padding:12px 14px 2px 14px;scrollbar-width:none}
.aura-composer > .aura-tray::-webkit-scrollbar{display:none}
.aura-composer.has-tray > .aura-tray{display:flex}
.aura-thumb{position:relative;flex:none;width:65px;height:65px}
.aura-thumb img{width:100%;height:100%;display:block;object-fit:cover;border-radius:12px;border:1px solid rgba(255,255,255,.15);box-shadow:0 2px 8px rgba(0,0,0,.3)}
.aura-thumb button{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;background:#f44336;color:#ffffff;border:0;font-size:12px;font-weight:bold;line-height:1;padding:0;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.6);z-index:2}`;
    document.head.appendChild(style);

    // ---------- Ayna kutu, önizleme şeridi, temizle (×) butonu ----------
    const mirror = document.createElement('div');
    mirror.className = 'aura-mirror';
    ta.insertAdjacentElement('afterend', mirror);

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

    // ---------- Senkron: ayna + kenar boşlukları + × butonu ----------
    function sync() {
        if (!ta.isConnected) return;

        const mic = document.getElementById('mic-btn');
        const rightW = Math.max(send ? send.offsetWidth : 0, mic ? mic.offsetWidth : 0);
        const leftW = (attach && row.contains(attach)) ? attach.offsetWidth : 0;
        const rightInside = !!((send && row.contains(send)) || (mic && row.contains(mic)));
        row.style.setProperty('--aura-pr', (rightInside ? (rightW || 46) + 10 : 16) + 'px');
        row.style.setProperty('--aura-pl', (leftW ? leftW + 10 : 16) + 'px');

        mirror.textContent = ta.value + '\u200b';
        clearBtn.style.display = (ta.value.length > 0 && mirror.offsetHeight > SINGLE_H + 2) ? 'flex' : 'none';

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
