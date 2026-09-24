// image-cropper.js — AuraChat WhatsApp tarzı kırpma ekranı
//
// Kullanım:
//   import { openImageCropper } from "./image-cropper.js";
//   const dataUrl = await openImageCropper(file, { size: 320 });
//   if (!dataUrl) return;   // İptal'e basıldı ya da geri tuşu
//
// Seçenekler: size (çıktı kenarı, px, varsayılan 320), aspect (en/boy, varsayılan 1 = kare),
//             quality (JPEG kalitesi, varsayılan 0.8)

import { pushBackState, popBackState } from "./back-handler.js";

const ICON_ROTATE = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v6h6"/><path d="M3.5 9A9 9 0 1 1 3 13"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>';

export function openImageCropper(file, opts = {}) {
    return new Promise((resolve) => {
        const aspect = opts.aspect || 1;
        const outSize = opts.size || 320;
        const quality = opts.quality || 0.8;
        const MAX_SIDE = 2048;
        const MIN_BOX = 70;

        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); start(img); };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;

        function start(image) {
            // Çalışma tuvali (büyük fotoğraflar telefonu yormasın diye küçültülür)
            const k = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
            let cw = Math.round(image.naturalWidth * k);
            let ch = Math.round(image.naturalHeight * k);
            let work = document.createElement('canvas');
            work.width = cw;
            work.height = ch;
            work.getContext('2d').drawImage(image, 0, 0, cw, ch);

            // ---------- ARAYÜZ ----------
            const root = document.createElement('div');
            root.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#0b141a;display:flex;flex-direction:column;padding-top:env(safe-area-inset-top,0px);touch-action:none;user-select:none;-webkit-user-select:none;';

            const stage = document.createElement('div');
            stage.style.cssText = 'flex:1;position:relative;min-height:0;';

            const wrap = document.createElement('div');
            wrap.style.cssText = 'position:absolute;overflow:hidden;touch-action:none;';
            work.style.cssText = 'display:block;';
            wrap.appendChild(work);

            const box = document.createElement('div');
            box.style.cssText = 'position:absolute;box-sizing:border-box;border:1px solid rgba(255,255,255,.7);box-shadow:0 0 0 9999px rgba(0,0,0,.55);touch-action:none;cursor:move;';

            // 3x3 ızgara çizgileri
            [33.333, 66.666].forEach((p) => {
                const v = document.createElement('div');
                v.style.cssText = 'position:absolute;top:0;bottom:0;width:1px;background:rgba(255,255,255,.5);pointer-events:none;left:' + p + '%;';
                const h = document.createElement('div');
                h.style.cssText = 'position:absolute;left:0;right:0;height:1px;background:rgba(255,255,255,.5);pointer-events:none;top:' + p + '%;';
                box.appendChild(v);
                box.appendChild(h);
            });

            // Köşe tutamaçları (görünen köşebent + büyük dokunma alanı)
            const corners = {
                tl: { pos: 'left:-12px;top:-12px;', br: 'left:12px;top:12px;', b: 'border-left:3px solid #fff;border-top:3px solid #fff;' },
                tr: { pos: 'right:-12px;top:-12px;', br: 'right:12px;top:12px;', b: 'border-right:3px solid #fff;border-top:3px solid #fff;' },
                bl: { pos: 'left:-12px;bottom:-12px;', br: 'left:12px;bottom:12px;', b: 'border-left:3px solid #fff;border-bottom:3px solid #fff;' },
                br: { pos: 'right:-12px;bottom:-12px;', br: 'right:12px;bottom:12px;', b: 'border-right:3px solid #fff;border-bottom:3px solid #fff;' }
            };
            Object.keys(corners).forEach((c) => {
                const hit = document.createElement('div');
                hit.dataset.corner = c;
                hit.style.cssText = 'position:absolute;width:44px;height:44px;touch-action:none;' + corners[c].pos;
                const mark = document.createElement('div');
                mark.style.cssText = 'position:absolute;width:20px;height:20px;pointer-events:none;' + corners[c].br + corners[c].b;
                hit.appendChild(mark);
                box.appendChild(hit);
            });

            wrap.appendChild(box);
            stage.appendChild(wrap);

            const bar = document.createElement('div');
            bar.style.cssText = 'flex:none;display:flex;align-items:center;justify-content:space-between;padding:18px 36px calc(env(safe-area-inset-bottom,0px) + 22px) 36px;';
            const btnCss = 'background:transparent;border:0;color:#22c55e;font-size:22px;padding:8px 4px;';
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'İptal';
            cancelBtn.style.cssText = btnCss;
            const rotBtn = document.createElement('button');
            rotBtn.innerHTML = ICON_ROTATE;
            rotBtn.style.cssText = 'background:transparent;border:0;color:#fff;padding:8px;';
            const doneBtn = document.createElement('button');
            doneBtn.textContent = 'Bitti';
            doneBtn.style.cssText = btnCss;
            bar.appendChild(cancelBtn);
            bar.appendChild(rotBtn);
            bar.appendChild(doneBtn);

            root.appendChild(stage);
            root.appendChild(bar);
            document.body.appendChild(root);

            // ---------- DURUM ----------
            let dispW = 0, dispH = 0;
            const b = { x: 0, y: 0, w: 0, h: 0 };
            let closed = false;
            let backActive = true;

            function applyBox() {
                box.style.left = b.x + 'px';
                box.style.top = b.y + 'px';
                box.style.width = b.w + 'px';
                box.style.height = b.h + 'px';
            }

            function layout() {
                const r = stage.getBoundingClientRect();
                const pad = 12;
                const aw = Math.max(50, r.width - pad * 2);
                const ah = Math.max(50, r.height - pad * 2);
                const s = Math.min(aw / cw, ah / ch);
                dispW = Math.floor(cw * s);
                dispH = Math.floor(ch * s);
                wrap.style.width = dispW + 'px';
                wrap.style.height = dispH + 'px';
                wrap.style.left = Math.round((r.width - dispW) / 2) + 'px';
                wrap.style.top = Math.round((r.height - dispH) / 2) + 'px';
                work.style.width = dispW + 'px';
                work.style.height = dispH + 'px';

                const w = Math.min(dispW, dispH * aspect) * 0.9;
                b.w = w;
                b.h = w / aspect;
                b.x = (dispW - b.w) / 2;
                b.y = (dispH - b.h) / 2;
                applyBox();
            }

            // ---------- SÜRÜKLEME / BOYUTLANDIRMA ----------
            let mode = null, corner = null, startPt = null, startBox = null;

            function pt(e) {
                const r = wrap.getBoundingClientRect();
                return { x: e.clientX - r.left, y: e.clientY - r.top };
            }

            box.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                try { box.setPointerCapture(e.pointerId); } catch (err) {}
                const c = e.target && e.target.dataset ? e.target.dataset.corner : null;
                mode = c ? 'resize' : 'move';
                corner = c;
                startPt = pt(e);
                startBox = { x: b.x, y: b.y, w: b.w, h: b.h };
            });

            box.addEventListener('pointermove', (e) => {
                if (!mode) return;
                e.preventDefault();
                const p = pt(e);

                if (mode === 'move') {
                    b.x = Math.min(Math.max(0, startBox.x + (p.x - startPt.x)), dispW - b.w);
                    b.y = Math.min(Math.max(0, startBox.y + (p.y - startPt.y)), dispH - b.h);
                } else {
                    const sideX = (corner === 'tl' || corner === 'bl') ? -1 : 1;
                    const sideY = (corner === 'tl' || corner === 'tr') ? -1 : 1;
                    const ax = sideX < 0 ? startBox.x + startBox.w : startBox.x;
                    const ay = sideY < 0 ? startBox.y + startBox.h : startBox.y;

                    let w = Math.max((p.x - ax) * sideX, (p.y - ay) * sideY * aspect);
                    const maxW = sideX < 0 ? ax : dispW - ax;
                    const maxH = sideY < 0 ? ay : dispH - ay;
                    w = Math.min(w, maxW, maxH * aspect);
                    w = Math.max(w, Math.min(MIN_BOX, maxW, maxH * aspect));
                    const h = w / aspect;

                    b.w = w;
                    b.h = h;
                    b.x = sideX < 0 ? ax - w : ax;
                    b.y = sideY < 0 ? ay - h : ay;
                }
                applyBox();
            });

            const endDrag = () => { mode = null; corner = null; };
            box.addEventListener('pointerup', endDrag);
            box.addEventListener('pointercancel', endDrag);

            // ---------- DÖNDÜR (saat yönünün tersine 90°) ----------
            rotBtn.addEventListener('click', () => {
                const n = document.createElement('canvas');
                n.width = ch;
                n.height = cw;
                const nctx = n.getContext('2d');
                nctx.translate(0, cw);
                nctx.rotate(-Math.PI / 2);
                nctx.drawImage(work, 0, 0);

                wrap.replaceChild(n, work);
                work = n;
                work.style.cssText = 'display:block;';
                const t = cw; cw = ch; ch = t;
                layout();
            });

            // ---------- KAPATMA ----------
            function finish(result) {
                if (closed) return;
                closed = true;
                window.removeEventListener('resize', layout);
                root.remove();
                if (backActive) { backActive = false; popBackState(); }
                resolve(result);
            }

            cancelBtn.addEventListener('click', () => finish(null));

            doneBtn.addEventListener('click', () => {
                const sx = (b.x / dispW) * cw;
                const sy = (b.y / dispH) * ch;
                const sw = (b.w / dispW) * cw;
                const sh = (b.h / dispH) * ch;
                const out = document.createElement('canvas');
                out.width = outSize;
                out.height = Math.round(outSize / aspect);
                const octx = out.getContext('2d');
                octx.imageSmoothingQuality = 'high';
                octx.drawImage(work, sx, sy, sw, sh, 0, 0, out.width, out.height);
                finish(out.toDataURL('image/jpeg', quality));
            });

            pushBackState(() => { backActive = false; finish(null); });
            window.addEventListener('resize', layout);
            layout();
            requestAnimationFrame(layout);
        }
    });
}
