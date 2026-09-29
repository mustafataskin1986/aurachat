// ==========================================
// CHAT COMPOSER (form.js'in sohbet uyarlaması)
// ==========================================

export function setupComposer() {
    const old = document.getElementById('message-input');
    if (!old) return { input: old, addImages() {}, takeImages() { return []; }, clearImages() {}, hasImages() { return false; }, onChange() {} };

    const LINE = 24;         // 20px * 1.2 satır yüksekliği (px)
    const SINGLE_H = 36;     // tek satır toplam yükseklik (px, çerçeve dahil)
    const MAX_TEXT_H = 98;   // yazı alanı en fazla bu kadar (tam 4 satır), sonra içeride kayar
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
    ta.setAttribute('enterkeyhint', 'enter');      // sağ alt tuş = alt satıra geç
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off');      // klavye harfleri otomatik büyütmesin

    const row = ta.parentElement;
    const attach = document.getElementById('attach-btn');
    const send = document.getElementById('send-btn');
    row.classList.add('aura-composer');

    const actionsWrapper = document.createElement('div');
    actionsWrapper.className = 'aura-actions';
    row.appendChild(actionsWrapper);
    if (attach && row === attach.parentElement) actionsWrapper.appendChild(attach);
    if (send && actionsWrapper !== send.parentElement) actionsWrapper.appendChild(send);
    
    if (send) {
        let keepKeyboard = false;
        send.addEventListener('pointerdown', () => { keepKeyboard = document.activeElement === ta; });
        send.addEventListener('mousedown', (e) => e.preventDefault());
        send.addEventListener('click', () => {
            if (keepKeyboard) setTimeout(() => ta.focus(), 0);
            keepKeyboard = false;
        });
    }

    // ---------- CSS ----------
    const style = document.createElement('style');
    style.id = 'aura-composer-css';
    style.textContent = `
#chat-area .aura-composer.aura-composer {
    display: grid !important;
    grid-template-columns: minmax(0,1fr);
    grid-template-rows: auto minmax(0,1fr) auto !important;
    align-items: stretch;
    position: relative;
    margin: 0 !important;
    padding: 5px !important;
    background: var(--aura-composer-bg,#202c33) !important;
    transition: background-color .2s, border-color .2s;
    border: 1px solid rgba(255,255,255,0.12) !important; /* Varsayılan mat gri çerçeve */
    border-radius: 10px !important;
    overflow: hidden;
    min-height: ${SINGLE_H}px;
    max-height: ${MAX_TEXT_H + 70}px;
}

/* Sadece aktifken, odaklanıldığında veya resim/yazı varken yeşil çerçeve yap */
#chat-area .aura-composer.aura-composer:focus-within,
#chat-area .aura-composer.has-tray,
#chat-area .aura-composer.aura-multi {
    border-color: var(--aura-btn,#22c55e) !important;
}

#chat-area .aura-composer.has-tray {
    max-height: ${MAX_TEXT_H + 160}px !important;
}

#chat-area .aura-composer.aura-composer:focus-within {
    box-shadow: inset 0 0 0 1px var(--aura-btn,#22c55e) !important;
}
#chat-area .aura-composer.aura-composer[style*="display: none"] {
    display: none !important;
}
.aura-composer > * {
    margin: 0 !important;
}

.aura-composer > #message-input {
    grid-row: 2;
    grid-column: 1;
    align-self: center;
    display: block;
    width: 100% !important;
    min-width: 0;
    box-sizing: border-box !important;
    min-height: 0 !important;
    max-height: ${MAX_TEXT_H}px !important;
    padding: 5px var(--aura-pr,62px) 5px var(--aura-pl,52px) !important;
    color: #ffffff;
    caret-color: var(--aura-btn,#22c55e);
    resize: none !important;
    overflow-x: hidden;
    overflow-y: auto;
    scrollbar-width: none;
    touch-action: manipulation;
    ${TEXT_CSS}
}

#chat-area .aura-composer > #message-input,
#chat-area .aura-composer > #message-input:focus,
#chat-area .aura-composer > #message-input:hover,
#chat-area .aura-composer > #message-input:active {
    background: transparent !important;
    transition: background-color .2s;
    border: 0 !important;
    border-radius: 5px !important;
    outline: 0 !important;
    box-shadow: none !important;
}

.aura-composer > #message-input::-webkit-scrollbar {
    display: none;
}

.aura-composer > .aura-mirror {
    grid-row: 2;
    grid-column: 1;
    visibility: hidden;
    pointer-events: none;
    box-sizing: border-box;
    min-height: ${SINGLE_H - 2}px;
    max-height: ${MAX_TEXT_H}px;
    overflow: hidden;
    padding: 5px var(--aura-pr,62px) 5px var(--aura-pl,52px);
    ${TEXT_CSS}
}

.aura-composer.aura-multi > #message-input,
.aura-composer.aura-multi > .aura-mirror {
    padding: 0 5px 2px 5px !important;
}

#chat-area .aura-composer.aura-composer.aura-multi {
    padding-top: 15px !important;
}

.aura-composer > .aura-actions {
    grid-row: 2;
    grid-column: 1;
    align-self: end;
    justify-self: end;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 8px 4px 0 !important;
}
.aura-composer.aura-multi > .aura-actions {
    grid-row: 3;
    align-self: center;
    margin: 0 8px 6px 0 !important;
}

.aura-composer > :not(.aura-actions):not(#message-input):not(.aura-mirror):not(.aura-tray):not(.aura-clear) {
    grid-row: 2;
    grid-column: 1;
    align-self: center;
    z-index: 1;
    background: transparent !important;
    margin-right: 56px !important;
}

.aura-composer > .aura-clear {
    display: none;
    grid-row: 2;
    grid-column: 1;
    justify-self: end;
    align-self: start;
    margin: 7px 8px 0 0 !important;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #2a2b2d;
    border: 1px solid rgba(255,255,255,.12);
    color: #ffffff;
    font-size: 14px;
    font-weight: bold;
    line-height: 1;
    align-items: center;
    justify-content: center;
    z-index: 3;
    padding: 0;
}

.aura-composer > .aura-tray {
    grid-row: 1;
    grid-column: 1;
    display: none;
    gap: 12px;
    overflow-x: auto;
    padding: 12px 14px 2px 14px;
    scrollbar-width: none;
}
.aura-composer > .aura-tray::-webkit-scrollbar {
    display: none;
}
.aura-composer.has-tray > .aura-tray {
    display: flex;
}
.aura-thumb {
    position: relative;
    flex: none;
    width: 65px;
    height: 65px;
}
.aura-thumb img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,.15);
    box-shadow: 0 2px 8px rgba(0,0,0,.3);
}
.aura-thumb button {
    position: absolute;
    top: -6px;
    right: -6px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--aura-btn,#22c55e);
    color: #ffffff;
    border: 0;
    font-size: 12px;
    font-weight: bold;
    line-height: 1;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 6px rgba(0,0,0,.6);
    z-index: 2;
}

.aura-probe {
    position: fixed;
    left: -9999px;
    top: 0;
    visibility: hidden;
    pointer-events: none;
    box-sizing: content-box;
    padding: 0;
    border: 0;
    overflow: hidden;
    ${TEXT_CSS}
}`;
    document.head.appendChild(style);

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

    function sync() {
        if (!ta.isConnected) return;

        const actions = row.querySelector('.aura-actions');
        const pl = 16;
        const pr = actions ? actions.offsetWidth + 24 : 62;
        row.style.setProperty('--aura-pl', pl + 'px');
        row.style.setProperty('--aura-pr', pr + 'px');

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
        mirror.style.height = 'auto';

        const naturalH = ta.value.length > 0 ? mirror.scrollHeight : SINGLE_H - 10;
        const textH = Math.min(Math.max(naturalH, SINGLE_H - 10), MAX_TEXT_H);
        
        if (ta.value.length === 0) {
            ta.style.height = '';
            mirror.style.height = '';
        } else {
            ta.style.height = textH + 'px';
            mirror.style.height = textH + 'px';
        }

        if (naturalH > textH + 1 && ta.selectionStart >= ta.value.length - 1) {
            ta.scrollTop = ta.scrollHeight;
        }
    }

    Object.defineProperty(ta, 'value', {
        configurable: true,
        get() { return valueDesc.get.call(this); },
        set(v) { valueDesc.set.call(this, v); sync(); }
    });
    ta.addEventListener('input', sync);
    window.addEventListener('resize', sync);

    const isDesktop = () => window.matchMedia('(pointer: fine)').matches;
    function insertNewline() {
        const s = ta.selectionStart;
        const e = ta.selectionEnd;
        ta.setRangeText('\n', s, e, 'end');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    ['keydown', 'keypress'].forEach((type) => {
        ta.addEventListener(type, (e) => {
            const looksLikeEnter = e.key === 'Enter' || e.keyCode === 13 || e.which === 13 || e.code === 'Enter';
            if (!looksLikeEnter || isDesktop()) return;
            e.stopImmediatePropagation();
            e.preventDefault();
            if (type === 'keydown') insertNewline();
        }, true);
    });

    ta.addEventListener('beforeinput', (e) => {
        if (e.inputType !== 'insertLineBreak' || isDesktop()) return;
        e.preventDefault();
        insertNewline();
    });

    let pending = [];
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
            x.addEventListener('mousedown', (e) => e.preventDefault());
            x.addEventListener('click', (e) => { e.stopPropagation(); removeAt(i); });
            wrap.appendChild(img);
            wrap.appendChild(x);
            tray.appendChild(wrap);
        });
        row.classList.toggle('has-tray', pending.length > 0);
        sync();
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