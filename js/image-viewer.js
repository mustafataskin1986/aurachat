// image-viewer.js — AuraChat WhatsApp tarzı resim görüntüleyici
// Kullanım:
//   window.openImageViewer({
//     items: [{ src, time, senderName, id }],   // time: ms, Date veya Firestore Timestamp
//     index: 0,
//     album: true,          // çoklu resimde true: alt alta liste, birine basınca tek resim
//     onDownload(item){}, onForward(item){}, onStar(item){}, onMenu(item, btnEl){},
//     onReply(item){}, onReplySend(item, text){}, onReact(item, emoji){},
//     getReaction(item) -> emoji|null, reactionEmojis:[...], isStarred(item) -> bool,
//     onStar(item) -> Promise<bool>, menuItems:[{label, fn(item)}]
//   });
//   window.closeImageViewer();  window.imageViewerIsOpen();

(function () {
  var CSS = '' +
    '#ivw{position:fixed;inset:0;z-index:99999;background:#000;color:#fff;display:flex;flex-direction:column;font-family:inherit;touch-action:none}' +
    '#ivw .iv-top{position:absolute;top:0;left:0;right:0;z-index:3;display:flex;align-items:center;gap:6px;padding:calc(env(safe-area-inset-top,0px) + 10px) 8px 10px 8px;background:rgba(11,20,26,.92);transition:transform .2s,opacity .2s}' +
    '#ivw .iv-top.iv-hide{transform:translateY(-100%);opacity:0;pointer-events:none}' +
    '#ivw .iv-btn{width:44px;height:44px;border:0;background:transparent;color:#fff;display:flex;align-items:center;justify-content:center;border-radius:50%;flex:none}' +
    '#ivw .iv-btn:active{background:rgba(255,255,255,.15)}' +
    '#ivw .iv-btn svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '#ivw .iv-titlebox{flex:1;min-width:0;padding-left:4px}' +
    '#ivw .iv-title{font-size:18px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '#ivw .iv-sub{font-size:14px;opacity:.75;margin-top:2px}' +
    '#ivw .iv-list{position:absolute;inset:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:calc(env(safe-area-inset-top,0px) + 70px) 0 20px 0;touch-action:pan-y}' +
    '#ivw .iv-list img{display:block;width:100%;height:auto;margin:0 0 6px 0;background:#111}' +
    '#ivw .iv-stage{position:absolute;inset:0;overflow:hidden;display:flex;align-items:center;justify-content:center;touch-action:none}' +
    '#ivw .iv-stage img{max-width:100%;max-height:100%;object-fit:contain;transform-origin:50% 50%;will-change:transform;user-select:none;-webkit-user-drag:none}' +
    '#ivw .iv-bottom{position:absolute;left:0;right:0;bottom:0;z-index:3;padding:10px 12px calc(env(safe-area-inset-bottom,0px) + 12px) 12px;background:linear-gradient(transparent,rgba(0,0,0,.6));transition:transform .2s,opacity .2s}' +
    '#ivw .iv-bottom.iv-hide{transform:translateY(100%);opacity:0;pointer-events:none}' +
    '#ivw .iv-pill{display:flex;align-items:center;gap:6px;background:#1f2c34;border-radius:28px;padding:0 8px 0 20px;height:52px}' +
    '#ivw .iv-reply{flex:1;font-size:19px;opacity:.6;background:transparent;border:0;color:#fff;text-align:left;height:52px}' +
    '#ivw .iv-emo{width:44px;height:44px;border:0;background:transparent;font-size:30px;display:flex;align-items:center;justify-content:center;border-radius:50%}' +
    '#ivw .iv-emo:active{background:rgba(255,255,255,.15)}' +
    '#ivw .iv-emo.iv-on{background:rgba(255,255,255,.22)}' +
    '#ivw .iv-reply{outline:none;opacity:1;min-width:0;padding:0}' +
    '#ivw .iv-reply::placeholder{color:#fff;opacity:.6}' +
    '#ivw .iv-emos{display:flex;align-items:center;gap:2px;flex:none}' +
    '#ivw .iv-send{width:44px;height:44px;border:0;border-radius:50%;background:#22c55e;color:#fff;display:none;align-items:center;justify-content:center;flex:none}' +
    '#ivw .iv-send svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '#ivw .iv-strip{display:none;gap:2px;padding:6px 8px;border-radius:9999px;background:#233138;box-shadow:0 4px 14px rgba(0,0,0,.5);width:max-content;margin:0 auto 10px auto}' +
    '#ivw .iv-menu{position:absolute;top:calc(env(safe-area-inset-top,0px) + 58px);right:10px;z-index:5;min-width:200px;background:#233138;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.6);overflow:hidden}' +
    '#ivw .iv-menu button{display:block;width:100%;text-align:left;padding:14px 18px;border:0;background:transparent;color:#fff;font-size:16px}' +
    '#ivw .iv-menu button:active{background:rgba(255,255,255,.12)}';

  var ICON = {
    back: '<svg viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
    fwd: '<svg viewBox="0 0 24 24"><path d="M15 4l6 6-6 6M21 10H9a6 6 0 0 0-6 6v2"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="M12 2l3 6.5 7 .9-5.2 4.8 1.4 7L12 17.8 5.8 21.2l1.4-7L2 9.4l7-.9z"/></svg>',
    dots: '<svg viewBox="0 0 24 24" style="fill:currentColor;stroke:none"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
    send: '<svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg>',
    smile: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9.5h.01M15 9.5h.01"/></svg>'
  };

  var root = null, opts = null, cur = 0, mode = 'single', fromAlbum = false;
  var barsVisible = true, tapTimer = null, vvHandler = null;

  function ensureCss() {
    if (document.getElementById('ivw-css')) return;
    var s = document.createElement('style');
    s.id = 'ivw-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function toDate(t) {
    if (!t) return null;
    if (t.toDate) return t.toDate();
    if (t instanceof Date) return t;
    return new Date(t);
  }

  function timeLabel(t) {
    var d = toDate(t);
    if (!d || isNaN(d.getTime())) return '';
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    var now = new Date();
    var a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var b = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var diff = Math.round((a - b) / 86400000);
    if (diff === 0) return 'Bugün ' + hm;
    if (diff === 1) return 'Dün ' + hm;
    return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear() + ' ' + hm;
  }

  function btn(icon, label, fn) {
    var b = document.createElement('button');
    b.className = 'iv-btn';
    b.setAttribute('aria-label', label);
    b.innerHTML = icon;
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(b); });
    return b;
  }

  function item() { return opts.items[cur]; }

  function downloadDefault(it) {
    var a = document.createElement('a');
    a.href = it.src;
    a.download = 'AuraChat_' + Date.now() + '.jpg';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function clear() {
    if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
    root.innerHTML = '';
  }

  function paintStar(b, on) {
    b.style.color = on ? '#fbbf24' : '';
    var sv = b.querySelector('svg');
    if (sv) sv.style.fill = on ? '#fbbf24' : 'none';
  }

  function toggleMenu() {
    var old = root.querySelector('.iv-menu');
    if (old) { old.remove(); return; }
    var items = (opts && opts.menuItems) || [];
    if (!items.length) return;
    var m = document.createElement('div');
    m.className = 'iv-menu';
    items.forEach(function (mi) {
      var b = document.createElement('button');
      b.textContent = mi.label;
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var it = item();
        m.remove();
        if (mi.fn) mi.fn(it);
      });
      m.appendChild(b);
    });
    root.appendChild(m);
  }

  // ---------- ÜST BAR ----------
  function buildTop(title, sub, single) {
    var top = document.createElement('div');
    top.className = 'iv-top';
    top.appendChild(btn(ICON.back, 'Geri', function () { goBack(); }));
    var tb = document.createElement('div');
    tb.className = 'iv-titlebox';
    tb.innerHTML = '<div class="iv-title"></div><div class="iv-sub"></div>';
    tb.firstChild.textContent = title || '';
    tb.lastChild.textContent = sub || '';
    top.appendChild(tb);
    if (single && !(opts && opts.viewOnce)) {
      top.appendChild(btn(ICON.down, 'İndir', function () {
        (opts.onDownload || downloadDefault)(item());
      }));
      top.appendChild(btn(ICON.fwd, 'İlet', function () {
        if (opts.onForward) opts.onForward(item());
      }));
      var starBtn = btn(ICON.star, 'Yıldızla', function () {
        if (!opts.onStar) return;
        Promise.resolve(opts.onStar(item())).then(function (v) {
          if (typeof v === 'boolean') paintStar(starBtn, v);
        });
      });
      paintStar(starBtn, !!(opts.isStarred && opts.isStarred(item())));
      top.appendChild(starBtn);
      top.appendChild(btn(ICON.dots, 'Menü', function () {
        toggleMenu();
      }));
    }
    return top;
  }

  // ---------- ALT BAR (Cevapla + tepkiler) ----------
  var REACT_DEFAULT = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

  function buildBottom() {
    var bt = document.createElement('div');
    bt.className = 'iv-bottom';

    var strip = document.createElement('div');
    strip.className = 'iv-strip';
    var pill = document.createElement('div');
    pill.className = 'iv-pill';

    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'iv-reply';
    inp.placeholder = 'Cevapla';
    inp.setAttribute('enterkeyhint', 'send');
    inp.setAttribute('autocomplete', 'off');

    var emos = document.createElement('div');
    emos.className = 'iv-emos';

    var sendBtn = document.createElement('button');
    sendBtn.className = 'iv-send';
    sendBtn.setAttribute('aria-label', 'Gönder');
    sendBtn.innerHTML = ICON.send;

    function curReaction() {
      return (opts && opts.getReaction) ? opts.getReaction(item()) : null;
    }

    function react(emo) {
      if (opts && opts.onReact) opts.onReact(item(), emo);
      strip.style.display = 'none';
      paintEmos();
    }

    function emoBtn(emo, parent) {
      var b = document.createElement('button');
      b.className = 'iv-emo' + (curReaction() === emo ? ' iv-on' : '');
      b.textContent = emo;
      b.addEventListener('click', function (e) { e.stopPropagation(); react(emo); });
      parent.appendChild(b);
    }

    function paintEmos() {
      emos.innerHTML = '';
      emoBtn('❤️', emos);
      emoBtn('😂', emos);
      emos.appendChild(btn(ICON.smile, 'Emoji', function () {
        strip.style.display = strip.style.display === 'flex' ? 'none' : 'flex';
      }));
      strip.innerHTML = '';
      ((opts && opts.reactionEmojis) || REACT_DEFAULT).forEach(function (emo) { emoBtn(emo, strip); });
    }

    var focused = false;
    function sync() {
      var has = inp.value.trim().length > 0;
      emos.style.display = (focused || has) ? 'none' : 'flex';
      sendBtn.style.display = has ? 'flex' : 'none';
      if (focused) strip.style.display = 'none';
    }

    function doSend() {
      var text = inp.value.trim();
      if (!text) return;
      var it = item();
      var cb = opts && opts.onReplySend;
      close();
      if (cb) cb(it, text);
    }

    inp.addEventListener('focus', function () { focused = true; sync(); });
    inp.addEventListener('blur', function () { focused = false; sync(); });
    inp.addEventListener('input', sync);
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); doSend(); }
    });
    sendBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    sendBtn.addEventListener('click', function (e) { e.stopPropagation(); doSend(); });

    paintEmos();
    pill.appendChild(inp);
    pill.appendChild(emos);
    pill.appendChild(sendBtn);
    bt.appendChild(strip);
    bt.appendChild(pill);
    return bt;
  }

  // ---------- %25 ÇEKİNCE KAPANMA ----------
  function setBg(a) {
    if (root) root.style.backgroundColor = 'rgba(0,0,0,' + a + ')';
  }

  function flyOut(el, dir) {
    el.style.transition = 'transform .2s ease-out';
    el.style.transform = 'translateY(' + (dir * window.innerHeight) + 'px)';
    setBg(0);
    setTimeout(close, 200);
  }

  function attachListDismiss(list) {
    var drag = false, startY = 0, base = 0, dirSign = 0, curDy = 0;
    list.style.overscrollBehavior = 'contain';

    list.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      drag = false;
      curDy = 0;
      list.style.transition = 'none';
    }, { passive: true });

    list.addEventListener('touchmove', function (e) {
      if (e.touches.length !== 1) return;
      var y = e.touches[0].clientY;
      if (!drag) {
        var atTop = list.scrollTop <= 0;
        var atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
        var d = y - startY;
        if ((atTop && d > 6) || (atBottom && d < -6)) {
          drag = true;
          base = y;
          dirSign = d > 0 ? 1 : -1;
        } else {
          return;
        }
      }
      var dy = y - base;
      if (dy * dirSign < 0) dy = 0;
      curDy = dy;
      if (e.cancelable) e.preventDefault();
      list.style.transform = 'translateY(' + dy + 'px)';
      setBg(1 - Math.min(1, Math.abs(dy) / (window.innerHeight * 0.6)));
    }, { passive: false });

    list.addEventListener('touchend', function () {
      if (!drag) return;
      drag = false;
      if (Math.abs(curDy) > window.innerHeight * 0.10) {
        flyOut(list, curDy > 0 ? 1 : -1);
      } else {
        list.style.transition = 'transform .2s ease-out';
        list.style.transform = '';
        setBg(1);
      }
    }, { passive: true });
  }

  // ---------- LİSTE (çoklu resim, alt alta) ----------
  function showList() {
    mode = 'list';
    clear();
    var it0 = opts.items[0] || {};
    root.appendChild(buildTop(it0.senderName || '', opts.items.length + ' fotoğraf', false));
    var list = document.createElement('div');
    list.className = 'iv-list';
    opts.items.forEach(function (it, i) {
      var img = document.createElement('img');
      img.src = it.src;
      img.addEventListener('click', function () {
        fromAlbum = true;
        cur = i;
        showSingle();
      });
      list.appendChild(img);
    });
    root.appendChild(list);
    attachListDismiss(list);
    var startImg = list.children[cur];
    if (startImg) setTimeout(function () { startImg.scrollIntoView({ block: 'center' }); }, 0);
  }

  // ---------- TEK RESİM (zoom / çift tık) ----------
  function showSingle() {
    mode = 'single';
    barsVisible = true;
    clear();
    var it = item();
    var top = buildTop(it.senderName || '', timeLabel(it.time), true);
    var bottom = buildBottom();
    if (opts && opts.viewOnce) bottom.style.display = 'none';
    var stage = document.createElement('div');
    stage.className = 'iv-stage';
    var img = document.createElement('img');
    img.src = it.src;
    img.draggable = false;
    stage.appendChild(img);
    stage.addEventListener('touchstart', function () {
      var a = document.activeElement;
      if (a && a.classList && a.classList.contains('iv-reply')) a.blur();
      var mn = root && root.querySelector('.iv-menu');
      if (mn) mn.remove();
    }, { passive: true });
    root.appendChild(stage);
    root.appendChild(top);
    root.appendChild(bottom);

    function setBars(v) {
      barsVisible = v;
      top.classList.toggle('iv-hide', !v);
      bottom.classList.toggle('iv-hide', !v);
    }

    var s = 1, tx = 0, ty = 0;
    function apply() {
      img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
    }
    function clampPan() {
      var w = img.offsetWidth * s, h = img.offsetHeight * s;
      var maxX = Math.max(0, (w - stage.clientWidth) / 2);
      var maxY = Math.max(0, (h - stage.clientHeight) / 2);
      tx = Math.min(maxX, Math.max(-maxX, tx));
      ty = Math.min(maxY, Math.max(-maxY, ty));
    }
    function rel(x, y) {
      var r = stage.getBoundingClientRect();
      return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 };
    }
    function zoomAt(px, py, ns) {
      ns = Math.min(5, Math.max(1, ns));
      tx = px - (px - tx) * (ns / s);
      ty = py - (py - ty) * (ns / s);
      s = ns;
      if (s <= 1.01) { s = 1; tx = 0; ty = 0; }
      clampPan();
      apply();
    }

    var pinch = null, pan = null, lastTap = { t: 0, x: 0, y: 0 }, moved = false, startT = 0;
    var dragging = false, barsBeforeDrag = true;

    stage.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) {
        var a = e.touches[0], b = e.touches[1];
        var m = rel((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
        pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), s: s, tx: tx, ty: ty, mx: m.x, my: m.y };
        pan = null;
        moved = true;
      } else if (e.touches.length === 1) {
        var t = e.touches[0];
        pan = { x: t.clientX, y: t.clientY, tx: tx, ty: ty };
        moved = false;
        startT = Date.now();
      }
    }, { passive: false });

    stage.addEventListener('touchmove', function (e) {
      e.preventDefault();
      if (pinch && e.touches.length === 2) {
        var a = e.touches[0], b = e.touches[1];
        var d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        var m = rel((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
        var ns = Math.min(5, Math.max(1, pinch.s * d / pinch.d));
        var ratio = ns / pinch.s;
        tx = m.x - (pinch.mx - pinch.tx) * ratio;
        ty = m.y - (pinch.my - pinch.ty) * ratio;
        s = ns;
        clampPan();
        apply();
      } else if (pan && e.touches.length === 1) {
        var t = e.touches[0];
        var dx = t.clientX - pan.x, dy = t.clientY - pan.y;
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
        if (s > 1) {
          tx = pan.tx + dx;
          ty = pan.ty + dy;
          clampPan();
          apply();
        } else if (dragging || (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx))) {
          if (!dragging) {
            dragging = true;
            barsBeforeDrag = barsVisible;
            setBars(false);
          }
          tx = 0;
          ty = dy;
          apply();
          setBg(1 - Math.min(1, Math.abs(dy) / (window.innerHeight * 0.6)));
        }
      }
    }, { passive: false });

    stage.addEventListener('touchend', function (e) {
      if (e.touches.length === 0) {
        if (dragging) {
          dragging = false;
          pan = null;
          img.style.transition = 'transform .2s ease-out';
          if (Math.abs(ty) > window.innerHeight * 0.10) {
            ty = (ty > 0 ? 1 : -1) * window.innerHeight;
            apply();
            setBg(0);
            setTimeout(close, 200);
          } else {
            tx = 0;
            ty = 0;
            apply();
            setBg(1);
            setBars(barsBeforeDrag);
            setTimeout(function () { img.style.transition = ''; }, 220);
          }
          return;
        }
        if (pinch) {
          pinch = null;
          if (s < 1.05) { s = 1; tx = 0; ty = 0; apply(); }
          pan = null;
          return;
        }
        if (pan && !moved && Date.now() - startT < 300) {
          var now = Date.now();
          var x = pan.x, y = pan.y;
          if (now - lastTap.t < 300 && Math.abs(x - lastTap.x) < 40 && Math.abs(y - lastTap.y) < 40) {
            // ÇİFT TIK: yakınlaştır / uzaklaştır
            if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
            lastTap.t = 0;
            var p = rel(x, y);
            if (s > 1) { s = 1; tx = 0; ty = 0; apply(); }
            else zoomAt(p.x, p.y, 2.5);
          } else {
            lastTap = { t: now, x: x, y: y };
            if (tapTimer) clearTimeout(tapTimer);
            tapTimer = setTimeout(function () { tapTimer = null; setBars(!barsVisible); }, 280);
          }
        }
        pan = null;
      } else if (e.touches.length === 1 && pinch) {
        pinch = null;
        var t = e.touches[0];
        pan = { x: t.clientX, y: t.clientY, tx: tx, ty: ty };
        moved = true;
      }
    }, { passive: true });
  }

  function goBack() {
    if (mode === 'single' && fromAlbum && opts.album) {
      fromAlbum = false;
      showList();
      return;
    }
    close();
  }

  function close() {
    if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
    var cb = opts && opts.onClose;
    if (vvHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', vvHandler);
      window.visualViewport.removeEventListener('scroll', vvHandler);
    }
    vvHandler = null;
    if (root) { root.remove(); root = null; }
    opts = null;
    if (cb) cb();
  }

  window.openImageViewer = function (o) {
    if (!o || !o.items || !o.items.length) return;
    ensureCss();
    if (root) close();
    opts = o;
    cur = o.index || 0;
    fromAlbum = false;
    root = document.createElement('div');
    root.id = 'ivw';
    document.body.appendChild(root);
    if (window.visualViewport) {
      vvHandler = function () {
        if (!root) return;
        root.style.height = window.visualViewport.height + 'px';
        root.style.top = window.visualViewport.offsetTop + 'px';
        root.style.bottom = 'auto';
      };
      window.visualViewport.addEventListener('resize', vvHandler);
      window.visualViewport.addEventListener('scroll', vvHandler);
    }
    if (o.album && o.items.length > 1) showList();
    else showSingle();
  };

  // Android geri tuşu için: true dönerse geri tuşu görüntüleyici tarafından işlendi
  window.imageViewerBack = function () {
    if (!root) return false;
    goBack();
    return true;
  };
  window.closeImageViewer = close;
  window.imageViewerIsOpen = function () { return !!root; };
})();
