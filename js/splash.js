// ==========================================
// SPLASH - açılış ekranı (tek katman)
// index.html <head> başında KLASİK script olarak yüklenir.
// Kapatmak için: window.hideAuraSplash()  (app-init.js çağırır)
// ==========================================
(function () {
 if (window.__auraSplashInit) return;
    window.__auraSplashInit = true;

    // APK içindeysek native splash zaten var: JS splash çizme, sadece hide'ı native'e ilet
    if (window.AuraSplash) {
        window.hideAuraSplash = function () {
            try { window.AuraSplash.hide(); } catch (e) {}
        };
        return;
    }

    var MIN_MS = window.AuraSplash ? 0 : 1000;    // APK'da native zaten gösteriyor, ekstra bekleme yok
    var MAX_MS = 2000;   // güvenlik: ne olursa olsun bu sürede kapan
    var FADE_MS = 500;
    var start = Date.now();
    var done = false;

    var css =
        '#aura-splash,#aura-splash *{outline:none!important;border:0!important;box-shadow:none!important;-webkit-tap-highlight-color:transparent!important;-webkit-user-select:none;user-select:none;touch-action:none}' +
        '#aura-splash{position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483646;background:#000;display:flex;align-items:center;justify-content:center;transition:opacity ' + FADE_MS + 'ms ease,transform ' + FADE_MS + 'ms ease}' +
        '#aura-splash.hide{opacity:0;transform:scale(1.04);pointer-events:none}' +
        '#aura-splash .glow{position:absolute;width:520px;height:520px;max-width:140vw;max-height:140vw;border-radius:50%;background:radial-gradient(circle,rgba(147,51,234,.35) 0%,rgba(219,39,119,.12) 45%,transparent 70%);animation:auraGlow 2.4s ease-in-out infinite}' +
        '#aura-splash .box{position:absolute;left:0;right:0;top:50%;margin-top:-52px;text-align:center;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
        '#aura-splash .ring{position:relative;width:104px;height:104px;margin:0 auto 22px}' +
        '#aura-splash .ring i{position:absolute;top:0;left:0;right:0;bottom:0;border-radius:50%;background:linear-gradient(-45deg,#4f46e5,#9333ea,#db2777,#06b6d4);background-size:300% 300%;animation:auraBg 6s ease infinite;opacity:.85}' +
        '#aura-splash .ring b{position:absolute;top:3px;left:3px;right:3px;bottom:3px;border-radius:50%;background:#000;display:flex;align-items:center;justify-content:center}' +
        '#aura-splash h1{margin:0;font-size:40px;font-weight:800;letter-spacing:-.5px;color:#f3f4f6}' +
        '#aura-splash h1 span{background:linear-gradient(135deg,#c084fc,#f472b6,#38bdf8);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}' +
        '@keyframes auraGlow{0%,100%{opacity:.6;transform:scale(1)}50%{opacity:1;transform:scale(1.08)}}' +
        '@keyframes auraBg{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}';

    var html =
        '<div class="glow"></div>' +
        '<div class="box">' +
            '<div class="ring"><i></i><b>' +
                '<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="url(#auraSplashGrad)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
                    '<defs><linearGradient id="auraSplashGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c084fc"/><stop offset=".5" stop-color="#f472b6"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs>' +
                    '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M12.2 6.2L11 5M3 21l9-9"/>' +
                    '<path d="M12.2 11.8L11 13"/>' +
                '</svg>' +
            '</b></div>' +
            '<h1>Aura<span>Chat</span></h1>' +
        '</div>';

    var root = document.documentElement;
    var style = document.createElement('style');
    style.id = 'aura-splash-css';
    style.textContent = css;
    (document.head || root).appendChild(style);

    var el = document.createElement('div');
    el.id = 'aura-splash';
    el.innerHTML = html;
    root.appendChild(el);

    window.hideAuraSplash = function () {
        if (done) return;
        done = true;
        var wait = Math.max(0, MIN_MS - (Date.now() - start));
        setTimeout(function () {
            try { if (window.AuraSplash) { var h0 = document.getElementById('aura-splash'); if (h0) h0.style.display = 'none'; window.AuraSplash.hide(); } } catch (e) {}
            var s = document.getElementById('aura-splash');
            if (!s) return;
            s.classList.add('hide');
            setTimeout(function () {
                if (s.parentNode) s.parentNode.removeChild(s);
                var c = document.getElementById('aura-splash-css');
                if (c && c.parentNode) c.parentNode.removeChild(c);
            }, FADE_MS + 60);
        }, wait);
    };

    setTimeout(window.hideAuraSplash, MAX_MS);
})();