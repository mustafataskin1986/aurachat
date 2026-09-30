(function() {

    // ============================================================
    // 1) CSS ENJEKSİYONU
    // ============================================================
    const style = document.createElement('style');
    style.textContent = `
    .isaretleme-overlay {
        position: fixed;
        inset: 0;
        background: #000000;
        z-index: 200020;
        display: none;
        flex-direction: column;
        padding: env(safe-area-inset-top) 16px env(safe-area-inset-bottom) 16px;
        animation: tsdFadeIn 0.2s ease;
        box-sizing: border-box;
        overflow: hidden;
    }
    .isaretleme-overlay.acik {
        display: flex;
    }
    .isrt-blur-bg {
        position: absolute;
        inset: 0;
        z-index: -1;
        background-size: cover;
        background-position: center;
        filter: blur(40px) brightness(0.4);
        transform: scale(1.1);
        pointer-events: none;
    }
    .isrt-ust-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 4px 12px 4px;
        flex-shrink: 0;
        z-index: 10;
        gap: 12px;
    }
    .isrt-kapat-btn {
        background: rgba(255,255,255,0.12);
        border: none;
        color: #fff;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        font-size: 22px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }
    .isrt-ust-sag {
        display: flex;
        gap: 8px;
        flex-shrink: 0;
    }
    .isrt-ikon-btn {
        background: rgba(255,255,255,0.12);
        border: none;
        color: #fff;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: opacity 0.15s;
    }
    .isrt-ikon-btn:disabled {
        opacity: 0.25;
        cursor: default;
    }
    .isrt-canvas-alani {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        position: relative;
        overflow: hidden;
        min-height: 0;
    }
    #isaretlemeCanvas {
        border-radius: 24px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.7);
        touch-action: none;
        background: transparent;
        max-width: 100%;
        max-height: 100%;
    }
    
    /* Gelişmiş Dinamik Sürüklenebilir Not Tasarımı */
    .isrt-not-kutu {
        position: absolute;
        z-index: 200050;
        display: inline-flex;
        align-items: center;
        box-sizing: border-box;
        background: rgba(0, 0, 0, 0.25);
        border: 1px dashed rgba(255, 255, 255, 0.3);
        border-radius: 12px;
        padding: 4px;
        cursor: move;
        touch-action: none;
    }
    .isrt-not-kutu.editing {
        background: rgba(0, 0, 0, 0.65);
        border: 1px solid #ffffff;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    }
    .isrt-not-text-view {
        font: bold 14px Arial, "MS Sans Serif", sans-serif;
        padding: 4px 8px;
        white-space: pre-wrap;
        word-break: break-word;
        min-width: 40px;
        min-height: 20px;
        user-select: none;
        -webkit-user-select: none;
    }
    .isrt-not-yazi {
        display: none;
        background: transparent;
        border: none;
        outline: none;
        font: bold 14px Arial, "MS Sans Serif", sans-serif;
        padding: 4px 8px;
        resize: none;
        width: 100px;
        height: 24px;
        overflow: hidden;
        white-space: pre-wrap;
        word-break: break-word;
        caret-color: currentColor;
    }
    .isrt-not-kutu.editing .isrt-not-text-view {
        display: none;
    }
    .isrt-not-kutu.editing .isrt-not-yazi {
        display: block;
    }
    
    /* RENK SEÇİM ALANI */
    .isrt-renk-satiri {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 16px;
        padding: 20px 4px 12px 4px;
        flex-shrink: 0;
        z-index: 10;
    }
    .isrt-renk {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: none;
        outline: none;
        cursor: pointer;
        padding: 0;
        flex-shrink: 0;
        position: relative;
        transition: transform 0.15s ease;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    }
    .isrt-renk.secili {
        transform: scale(1.25);
        outline: 2px solid rgba(255, 255, 255, 0.8);
        outline-offset: 2px;
    }
    
    .isrt-kirp-katmani {
        position: absolute;
        display: none;
        z-index: 8;
        overflow: visible;
    }
    .isrt-kirp-kutu {
        position: absolute;
        border: 2px dashed #ffffff;
        box-shadow: 0 0 0 9999px rgba(0,0,0,0.65);
        touch-action: none;
        cursor: move;
    }
    .isrt-kirp-tutamak {
        position: absolute;
        width: 22px;
        height: 22px;
        background: #ffffff;
        border-radius: 50%;
        box-shadow: 0 2px 6px rgba(0,0,0,0.5);
        touch-action: none;
    }
    .isrt-kirp-tl { top: -11px; left: -11px; cursor: nwse-resize; }
    .isrt-kirp-tr { top: -11px; right: -11px; cursor: nesw-resize; }
    .isrt-kirp-bl { bottom: -11px; left: -11px; cursor: nesw-resize; }
    .isrt-kirp-br { bottom: -11px; right: -11px; cursor: nwse-resize; }
    .isrt-kirp-onayla-btn {
        position: absolute;
        bottom: 16px;
        left: 50%;
        transform: translateX(-50%);
        display: none;
        align-items: center;
        gap: 6px;
        background: #ffffff;
        color: #000;
        border: none;
        padding: 10px 22px;
        border-radius: 24px;
        font-weight: bold;
        font-size: 14px;
        cursor: pointer;
        z-index: 9;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
    }

    /* ALT ARAÇLAR */
    .isrt-alt-araclar {
        display: flex;
        justify-content: center;
        gap: 24px;
        padding: 12px 0 24px 0;
        flex-shrink: 0;
        width: 100%;
        z-index: 10;
    }
    .isrt-arac-btn {
        background: none;
        border: none;
        color: #fff;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        font-size: 14px;
    }
    .isrt-arac-ikon {
        width: 72px;
        height: 72px;
        border-radius: 36px;
        background: rgba(255,255,255,0.08);
        color: #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.2s, color 0.2s;
    }
    .isrt-arac-btn.aktif .isrt-arac-ikon {
        background: #ffffff;
        color: #000000;
    }
    
    .isrt-bitti-btn {
        background: #ffffff;
        color: #000000;
        border: none;
        padding: 10px 20px;
        border-radius: 20px;
        font-weight: 600;
        font-size: 14px;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        transition: transform 0.1s, background 0.2s;
        white-space: nowrap;
    }
    .isrt-bitti-btn:active {
        transform: scale(0.95);
    }
    
    @keyframes tsdFadeIn { from { opacity: 0; } to { opacity: 1; } }
    `;
    document.head.appendChild(style);

    // ============================================================
    // 2) HTML ENJEKSİYONU
    // ============================================================
    const gecici = document.createElement('div');
    gecici.innerHTML = `
    <div id="isaretlemeOverlay" class="isaretleme-overlay">
        <div id="isrtBlurBg" class="isrt-blur-bg"></div>
        
        <div class="isrt-ust-bar">
            <button class="isrt-kapat-btn" onclick="window.isaretlemeyiKapatVeGeriAl()">×</button>
            <button type="button" class="isrt-bitti-btn" onclick="isaretlemeyiBitir()">Düzenlemeyi bitir</button>
            <div class="isrt-ust-sag">
                <button id="isrtGeriBtn" class="isrt-ikon-btn" onclick="isaretlemeGeriAl()" title="Geri al">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"></path></svg>
                </button>
                <button id="isrtIleriBtn" class="isrt-ikon-btn" onclick="isaretlemeIleriAl()" title="İleri al">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"></path><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"></path></svg>
                </button>
            </div>
        </div>

        <div id="isrtCanvasAlani" class="isrt-canvas-alani">
            <canvas id="isaretlemeCanvas"></canvas>
            <div id="isrtKirpKatmani" class="isrt-kirp-katmani">
                <div class="isrt-kirp-kutu" id="isrtKirpKutu">
                    <div class="isrt-kirp-tutamak isrt-kirp-tl" data-yon="tl"></div>
                    <div class="isrt-kirp-tutamak isrt-kirp-tr" data-yon="tr"></div>
                    <div class="isrt-kirp-tutamak isrt-kirp-bl" data-yon="bl"></div>
                    <div class="isrt-kirp-tutamak isrt-kirp-br" data-yon="br"></div>
                </div>
            </div>
            <button type="button" id="isrtKirpOnaylaBtn" class="isrt-kirp-onayla-btn" onclick="isrtKirpiUygula()">✓ Kırp</button>
        </div>

        <div class="isrt-renk-satiri">
            <button type="button" class="isrt-renk" style="background:#000000" data-renk="#000000" onclick="isaretlemeRenkSec('#000000', this)"></button>
            <button type="button" class="isrt-renk" style="background:#f44336" data-renk="#f44336" onclick="isaretlemeRenkSec('#f44336', this)"></button>
            <button type="button" class="isrt-renk" style="background:#ffeb3b" data-renk="#ffeb3b" onclick="isaretlemeRenkSec('#ffeb3b', this)"></button>
            <button type="button" class="isrt-renk" style="background:#4caf50" data-renk="#4caf50" onclick="isaretlemeRenkSec('#4caf50', this)"></button>
            <button type="button" class="isrt-renk" style="background:#2196f3" data-renk="#2196f3" onclick="isaretlemeRenkSec('#2196f3', this)"></button>
            <button type="button" class="isrt-renk" style="background:#9c27b0" data-renk="#9c27b0" onclick="isaretlemeRenkSec('#9c27b0', this)"></button>
            <button type="button" class="isrt-renk secili" style="background:#ffffff" data-renk="#ffffff" onclick="isaretlemeRenkSec('#ffffff', this)"></button>
        </div>

        <div class="isrt-alt-araclar">
            <button type="button" class="isrt-arac-btn" data-arac="eskiz" onclick="isaretlemeAraciSec('eskiz')">
                <div class="isrt-arac-ikon">
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"></path><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path><path d="M2 2l7.586 7.586"></path><circle cx="11" cy="11" r="2"></circle></svg>
                </div>
                <span>Eskiz</span>
            </button>
            <button type="button" class="isrt-arac-btn" data-arac="not" onclick="isaretlemeAraciSec('not')">
                <div class="isrt-arac-ikon">
                    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" y1="20" x2="15" y2="20"></line><line x1="12" y1="4" x2="12" y2="20"></line></svg>
                </div>
                <span>Not ekle</span>
            </button>
            <button type="button" class="isrt-arac-btn" data-arac="kirp" onclick="isaretlemeAraciSec('kirp')">
                <div class="isrt-arac-ikon">
                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.13 1L6 16a2 2 0 0 0 2 2h15"></path><path d="M1 6.13L16 6a2 2 0 0 1 2 2v15"></path></svg>
                </div>
                <span>Kırp</span>
            </button>
        </div>
    </div>
    `;
    while (gecici.firstChild) {
        document.body.appendChild(gecici.firstChild);
    }

    // ============================================================
    // 3) İŞARETLEME MOTORU DEĞİŞKENLERİ
    // ============================================================
    window.isrtHedef = null;      
    window.isrtIndex = null;
    window.isrtAktifArac = null;  
    window.isrtAktifRenk = '#ffffff';
    window.isrtGecmis = [];
    window.isrtGecmisIndex = -1;

    function isaretlemeyiAc(hedef, index, event) {
        if (event) { event.stopPropagation(); event.preventDefault(); }
        const dizi = hedef === 'tsd' ? window.tsdGorseller : window.seciliGorseller;
        if (!dizi || !dizi[index]) return;

        window.isrtHedef = hedef;
        window.isrtIndex = index;
        window.isrtGecmis = [];
        window.isrtGecmisIndex = -1;

        const blurBg = document.getElementById('isrtBlurBg');
        if (blurBg) blurBg.style.backgroundImage = `url('${dizi[index]}')`;

        const img = new Image();
        img.onload = function() {
            const canvas = document.getElementById('isaretlemeCanvas');
            const alan = document.getElementById('isrtCanvasAlani');
            const maxW = Math.max(alan.clientWidth - 10, 100);
            const maxH = Math.max(alan.clientHeight - 10, 100);
            let w = img.naturalWidth, h = img.naturalHeight;
            const oran = Math.min(maxW / w, maxH / h, 1);
            w = Math.round(w * oran); h = Math.round(h * oran);
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            isrtGecmisePush();
            
            isaretlemeAraciSec('eskiz');
        };
        img.src = dizi[index];

        document.getElementById('isaretlemeOverlay').classList.add('acik');
        if (window.isrtPushBack) {
            window.isrtPushBack(isaretlemeyiKapat);
            window.isrtBackPushed = true;
        } else {
            history.pushState({ isaretlemeAcik: true }, "");
        }
    }

    window.isaretlemeyiKapatVeGeriAl = function() {
    if (window.isrtBackPushed && window.isrtPopBack) {
            window.isrtBackPushed = false;
            window.isrtPopBack();
            isaretlemeyiKapat();
        } else if (history.state && history.state.isaretlemeAcik) {
            history.back();
        } else {
            isaretlemeyiKapat();
        }
    };

    function isaretlemeyiKapat() {
        const overlay = document.getElementById('isaretlemeOverlay');
        if (!overlay) return;
        overlay.classList.remove('acik');
        window.isrtBackPushed = false;
        if (window.isrtOnClose) window.isrtOnClose();
        document.querySelectorAll('.isrt-not-kutu').forEach(el => el.remove());
        isrtKirpIptal();
        window.isrtHedef = null;
        window.isrtIndex = null;
        window.isrtGecmis = [];
        window.isrtGecmisIndex = -1;
        window.isrtAktifArac = null;
    }

    window.addEventListener('popstate', function(e) {
        const overlay = document.getElementById('isaretlemeOverlay');
        if (overlay && overlay.classList.contains('acik')) {
            isaretlemeyiKapat();
        }
    });

    // NOTLARI CANVAS ÜZERİNE KALICI OLARAK BASMA
    function isrtNotlariCanvasaBakeEt() {
        const canvas = document.getElementById('isaretlemeCanvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const canvasRect = canvas.getBoundingClientRect();
        
        const oranX = canvas.width / canvasRect.width;
        const oranY = canvas.height / canvasRect.height;

        document.querySelectorAll('.isrt-not-kutu').forEach(kutu => {
            const yaziEl = kutu.querySelector('.isrt-not-yazi');
            const viewEl = kutu.querySelector('.isrt-not-text-view');
            const metin = kutu.classList.contains('editing') ? yaziEl.value.trim() : viewEl.innerText.trim();
            
            if (metin) {
                const kutuRect = kutu.getBoundingClientRect();
                const cX = (kutuRect.left - canvasRect.left) * oranX;
                const cY = (kutuRect.top - canvasRect.top) * oranY;
                
                ctx.fillStyle = viewEl.style.color || window.isrtAktifRenk;
                const canvasFontSize = Math.round(14 * oranX);
                ctx.font = `bold ${canvasFontSize}px Arial, "MS Sans Serif", sans-serif`;
                ctx.textBaseline = 'top';
                
                metin.split('\n').forEach((satir, i) => {
                    ctx.fillText(satir, cX, cY + i * (canvasFontSize + 4));
                });
            }
            kutu.remove();
        });
    }

    function isaretlemeyiBitir() {
        isrtNotlariCanvasaBakeEt();
        const canvas = document.getElementById('isaretlemeCanvas');
        const kirpBtn = document.getElementById('isrtKirpOnaylaBtn');
        if (kirpBtn && kirpBtn.style.display === 'flex') {
            isrtKirpiUygula();
        }

        if (!canvas.width || !canvas.height) { window.isaretlemeyiKapatVeGeriAl(); return; }
        const veri = canvas.toDataURL('image/jpeg', 0.92);
        const dizi = window.isrtHedef === 'tsd' ? window.tsdGorseller : window.seciliGorseller;
        if (dizi && typeof window.isrtIndex === 'number' && dizi[window.isrtIndex] !== undefined) {
            dizi[window.isrtIndex] = veri;
        }
        if (window.isrtHedef === 'tsd' && typeof window.tsdGorselOnizlemeRender === 'function') {
            window.tsdGorselOnizlemeRender();
        } else if (typeof window.gorselOnizlemeRender === 'function') {
            window.gorselOnizlemeRender();
        }
        window.isaretlemeyiKapatVeGeriAl();
        if (typeof window.sistemUyarisiGoster === 'function') window.sistemUyarisiGoster("✏️ İşaretleme kaydedildi!");
    }

    function isaretlemeAraciSec(arac) {
        const eskiArac = window.isrtAktifArac;
        window.isrtAktifArac = arac; 
        
        // HATA DÜZELTİLDİ: Sadece ikon değil butonun beyaz olması için doğru sınıfı seçtik
        document.querySelectorAll('.isrt-arac-btn').forEach(b => {
            b.classList.toggle('aktif', b.dataset.arac === window.isrtAktifArac);
        });

        if (eskiArac === 'kirp' && window.isrtAktifArac !== 'kirp') isrtKirpIptal();
        if (window.isrtAktifArac === 'kirp') isrtKirpBaslat();
    }

    function isaretlemeRenkSec(renk, btn) {
        window.isrtAktifRenk = renk;
        document.querySelectorAll('.isrt-renk').forEach(b => b.classList.remove('secili'));
        if (btn) btn.classList.add('secili');
        
        const aktifKutu = document.querySelector('.isrt-not-kutu.editing');
        if (aktifKutu) {
            aktifKutu.querySelector('.isrt-not-yazi').style.color = renk;
            aktifKutu.querySelector('.isrt-not-text-view').style.color = renk;
        }
    }

    function isrtDurumGuncelle() {
        const geriBtn = document.getElementById('isrtGeriBtn');
        const ileriBtn = document.getElementById('isrtIleriBtn');
        if (geriBtn) geriBtn.disabled = window.isrtGecmisIndex <= 0;
        if (ileriBtn) ileriBtn.disabled = window.isrtGecmisIndex >= window.isrtGecmis.length - 1;
    }

    function isrtGecmisePush() {
        const canvas = document.getElementById('isaretlemeCanvas');
        const veri = canvas.toDataURL('image/png');
        window.isrtGecmis = window.isrtGecmis.slice(0, window.isrtGecmisIndex + 1);
        window.isrtGecmis.push(veri);
        window.isrtGecmisIndex = window.isrtGecmis.length - 1;
        isrtDurumGuncelle();
    }

    function isrtGecmisiUygula() {
        const canvas = document.getElementById('isaretlemeCanvas');
        const ctx = canvas.getContext('2d');
        const img = new Image();
        img.onload = () => { 
            canvas.width = img.naturalWidth; 
            canvas.height = img.naturalHeight;
            ctx.clearRect(0, 0, canvas.width, canvas.height); 
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height); 
        };
        img.src = window.isrtGecmis[window.isrtGecmisIndex];
        isrtDurumGuncelle();
    }

    function isaretlemeGeriAl() {
        if (window.isrtGecmisIndex <= 0) return;
        window.isrtGecmisIndex--;
        isrtGecmisiUygula();
    }

    function isaretlemeIleriAl() {
        if (window.isrtGecmisIndex >= window.isrtGecmis.length - 1) return;
        window.isrtGecmisIndex++;
        isrtGecmisiUygula();
    }

    // ============================================================
    // DİNAMİK YAZDIKÇA BÜYÜYEN VE SÜRÜKLENEN NOT SİSTEMİ
    // ============================================================
    function isrtNotAlaniniBoyutlandir(textarea) {
        textarea.style.height = 'auto';
        const lines = textarea.value.split('\n');
        let maxCh = 4;
        lines.forEach(l => { if (l.length > maxCh) maxCh = l.length; });
        // Yazı genişliğini 14px font harf sayısına göre dinamik esnetiyoruz
        textarea.style.width = Math.max(80, Math.min(320, maxCh * 9 + 24)) + 'px';
        textarea.style.height = textarea.scrollHeight + 'px';
    }

    function isrtNotEkleAtAbsolute(solPx, ustPx) {
        const alan = document.getElementById('isrtCanvasAlani');
        const kutu = document.createElement('div');
        kutu.className = 'isrt-not-kutu editing';
        kutu.style.left = solPx + 'px';
        kutu.style.top = ustPx + 'px';
        
        // HATA DÜZELTİLDİ: Yeşil tik butonu tamamen kaldırıldı
        kutu.innerHTML = `
            <div class="isrt-not-text-view" style="color:${window.isrtAktifRenk}"></div>
            <textarea class="isrt-not-yazi" rows="1" style="color:${window.isrtAktifRenk}"></textarea>
        `;
        alan.appendChild(kutu);

        const yaziAlaniEl = kutu.querySelector('.isrt-not-yazi');
        const textViewEl = kutu.querySelector('.isrt-not-text-view');

        yaziAlaniEl.addEventListener('input', function() {
            isrtNotAlaniniBoyutlandir(this);
        });

        setTimeout(() => {
            yaziAlaniEl.focus();
            isrtNotAlaniniBoyutlandir(yaziAlaniEl);
        }, 60);

        kutu.addEventListener('dblclick', function(e) {
            e.stopPropagation();
            if (kutu.classList.contains('editing')) return;
            kutu.classList.add('editing');
            yaziAlaniEl.value = textViewEl.innerText;
            isrtNotAlaniniBoyutlandir(yaziAlaniEl);
            setTimeout(() => { yaziAlaniEl.focus(); }, 60);
        });

        // HEM YAZARKEN HEM NORMAL HALDE ULTRA AKICI SÜRÜKLEME (MOVE) MOTORU
        let suruklemeAktif = false;
        let baslangicX = 0, baslangicY = 0, kutuBaslangicSol = 0, kutuBaslangicUst = 0;

        kutu.addEventListener('pointerdown', function(e) {
            if (e.target.closest('button')) return;
            if (e.target !== yaziAlaniEl) {
                e.preventDefault(); 
            }
            e.stopPropagation();
            suruklemeAktif = true;
            baslangicX = e.clientX; 
            baslangicY = e.clientY;
            kutuBaslangicSol = parseFloat(kutu.style.left) || 0;
            kutuBaslangicUst = parseFloat(kutu.style.top) || 0;
            kutu.setPointerCapture(e.pointerId);
        });

        kutu.addEventListener('pointermove', function(e) {
            if (!suruklemeAktif) return;
            e.preventDefault();
            const dx = e.clientX - baslangicX;
            const dy = e.clientY - baslangicY;
            kutu.style.left = (kutuBaslangicSol + dx) + 'px';
            kutu.style.top = (kutuBaslangicUst + dy) + 'px';
        });

        function suruklemeBitir(e) {
            if (suruklemeAktif) {
                kutu.releasePointerCapture(e.pointerId);
                suruklemeAktif = false;
            }
        }
        kutu.addEventListener('pointerup', suruklemeBitir);
        kutu.addEventListener('pointercancel', suruklemeBitir);
    }

    // ============================================================
    // 4) OLAY BAĞLANTILARI VE YENİ DOKUNMA YÖNETİMİ
    // ============================================================
    function isaretlemeOlaylariniBaslat() {
        const canvas = document.getElementById('isaretlemeCanvas');
        const alan = document.getElementById('isrtCanvasAlani');
        const overlay = document.getElementById('isaretlemeOverlay');
        if (!canvas || !alan || !overlay) return;
        
        if (canvas.dataset.olaylarBaglandi === "true") return;
        canvas.dataset.olaylarBaglandi = "true";

        let ciziliyor = false;
        let sonX = 0, sonY = 0;

        function konumAl(e) {
            const rect = canvas.getBoundingClientRect();
            const oranX = canvas.width / rect.width;
            const oranY = canvas.height / rect.height;
            return { x: (e.clientX - rect.left) * oranX, y: (e.clientY - rect.top) * oranY };
        }

        alan.addEventListener('pointerdown', function(e) {
            if (e.target.closest('.isrt-not-kutu') || e.target.closest('button') || e.target.closest('.isrt-kirp-katmani')) return;

            // Ekranda açık bir editör varsa, boşluğa dokununca otomatik kaydet kapat
            const aktifKutu = document.querySelector('.isrt-not-kutu.editing');
            if (aktifKutu) {
                const yaziAlaniEl = aktifKutu.querySelector('.isrt-not-yazi');
                const textViewEl = aktifKutu.querySelector('.isrt-not-text-view');
                const metin = yaziAlaniEl.value.trim();
                if (!metin) {
                    aktifKutu.remove();
                } else {
                    textViewEl.innerText = metin;
                    aktifKutu.classList.remove('editing');
                }
                return; 
            }

            if (window.isrtAktifArac === 'not') {
                e.preventDefault();
                const alanRect = alan.getBoundingClientRect();
                const clickX = e.clientX - alanRect.left;
                const clickY = e.clientY - alanRect.top;
                isrtNotEkleAtAbsolute(clickX, clickY);
            }
        });

        // HATA DÜZELTİLDİ: Çizim motoru tek parmaklı (isPrimary) işleme ayarlandı
        canvas.addEventListener('pointerdown', function(e) {
            if (!e.isPrimary) return; // Sadece tek parmak kabul et
            if (document.querySelector('.isrt-not-kutu.editing')) return;

            if (window.isrtAktifArac === 'eskiz') {
                e.preventDefault();
                ciziliyor = true;
                
                canvas.setPointerCapture(e.pointerId); // Eskizi parmağa kilitle (kaymayı engeller)

                const p = konumAl(e);
                sonX = p.x; sonY = p.y;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = window.isrtAktifRenk;
                ctx.beginPath();
                ctx.arc(sonX, sonY, 3, 0, Math.PI * 2);
                ctx.fill();
            }
        });

        canvas.addEventListener('pointermove', function(e) {
            if (!e.isPrimary || !ciziliyor || window.isrtAktifArac !== 'eskiz' || document.querySelector('.isrt-not-kutu.editing')) return;
            e.preventDefault();
            const p = konumAl(e);
            const ctx = canvas.getContext('2d');
            ctx.strokeStyle = window.isrtAktifRenk;
            ctx.lineWidth = 6;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(sonX, sonY);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
            sonX = p.x; sonY = p.y;
        });

        function ciziBitir(e) {
            if (ciziliyor && e.isPrimary) {
                ciziliyor = false;
                canvas.releasePointerCapture(e.pointerId);
                isrtGecmisePush();
            }
        }
        window.addEventListener('pointerup', ciziBitir);
        window.addEventListener('pointercancel', ciziBitir);

        // Alt barlar veya renk değiştiricilere basıldığında editörün kapanmasını engelleme filtresi
        document.addEventListener('pointerdown', function(e) {
            const aktifKutu = document.querySelector('.isrt-not-kutu.editing');
            if (aktifKutu && !aktifKutu.contains(e.target)) {
                if (e.target.closest('.isrt-renk-satiri') || 
                    e.target.closest('.isrt-alt-araclar') || 
                    e.target.closest('.isrt-ust-bar') ||
                    e.target.closest('#isrtKirpOnaylaBtn')) {
                    return;
                }
            }
        });

        // ===== Kırpma İşlemleri =====
        const kirpKutu = document.getElementById('isrtKirpKutu');
        const kirpKatman = document.getElementById('isrtKirpKatmani');
        if (kirpKutu && kirpKatman) {
            let mod = null;
            let kbaslX = 0, kbaslY = 0;
            let kutuBasl = { left: 0, top: 0, width: 0, height: 0 };

            function kirpBaslatOku(e, modYeni) {
                e.preventDefault(); e.stopPropagation();
                mod = modYeni;
                kbaslX = e.clientX; kbaslY = e.clientY;
                kutuBasl = {
                    left: parseFloat(kirpKutu.style.left) || 0,
                    top: parseFloat(kirpKutu.style.top) || 0,
                    width: parseFloat(kirpKutu.style.width) || 0,
                    height: parseFloat(kirpKutu.style.height) || 0
                };
            }

            kirpKutu.addEventListener('pointerdown', function(e) {
                if (e.target.classList.contains('isrt-kirp-tutamak')) return;
                kirpBaslatOku(e, 'tasi');
            });
            kirpKutu.querySelectorAll('.isrt-kirp-tutamak').forEach(function(tutamak) {
                tutamak.addEventListener('pointerdown', function(e) {
                    kirpBaslatOku(e, tutamak.dataset.yon);
                });
            });

            window.addEventListener('pointermove', function(e) {
                if (!mod) return;
                e.preventDefault();
                const dx = e.clientX - kbaslX;
                const dy = e.clientY - kbaslY;
                let { left, top, width, height } = kutuBasl;

                if (mod === 'tasi') { left += dx; top += dy; } 
                else if (mod === 'tl') { left += dx; top += dy; width -= dx; height -= dy; } 
                else if (mod === 'tr') { top += dy; width += dx; height -= dy; } 
                else if (mod === 'bl') { left += dx; width -= dx; height += dy; } 
                else if (mod === 'br') { width += dx; height += dy; }

                if (width < 40) width = 40;
                if (height < 40) height = 40;

                const katmanGen = kirpKatman.clientWidth;
                const katmanYuk = kirpKatman.clientHeight;
                if (mod === 'tasi') {
                    left = Math.max(0, Math.min(left, katmanGen - width));
                    top = Math.max(0, Math.min(top, katmanYuk - height));
                }

                kirpKutu.style.left = left + 'px';
                kirpKutu.style.top = top + 'px';
                kirpKutu.style.width = width + 'px';
                kirpKutu.style.height = height + 'px';
            });

            window.addEventListener('pointerup', function() { mod = null; });
            window.addEventListener('pointercancel', function() { mod = null; });
        }
    }

    function isrtKirpBaslat() {
        const canvas = document.getElementById('isaretlemeCanvas');
        const alan = document.getElementById('isrtCanvasAlani');
        const katman = document.getElementById('isrtKirpKatmani');
        const kutu = document.getElementById('isrtKirpKutu');
        const onaylaBtn = document.getElementById('isrtKirpOnaylaBtn');
        if (!canvas || !alan || !katman || !kutu) return;

        const canvasRect = canvas.getBoundingClientRect();
        const alanRect = alan.getBoundingClientRect();

        const solBase = canvasRect.left - alanRect.left;
        const ustBase = canvasRect.top - alanRect.top;
        const genBase = canvasRect.width;
        const yukBase = canvasRect.height;

        katman.style.left = solBase + 'px';
        katman.style.top = ustBase + 'px';
        katman.style.width = genBase + 'px';
        katman.style.height = yukBase + 'px';
        katman.style.display = 'block';

        const kb = 0.1;
        kutu.style.left = (genBase * kb) + 'px';
        kutu.style.top = (yukBase * kb) + 'px';
        kutu.style.width = (genBase * (1 - kb * 2)) + 'px';
        kutu.style.height = (yukBase * (1 - kb * 2)) + 'px';

        onaylaBtn.style.display = 'flex';
    }

    function isrtKirpIptal() {
        const katman = document.getElementById('isrtKirpKatmani');
        const onaylaBtn = document.getElementById('isrtKirpOnaylaBtn');
        if (katman) katman.style.display = 'none';
        if (onaylaBtn) onaylaBtn.style.display = 'none';
    }

    function isrtKirpiUygula() {
        isrtNotlariCanvasaBakeEt();

        const canvas = document.getElementById('isaretlemeCanvas');
        const kutu = document.getElementById('isrtKirpKutu');
        if (!canvas || !kutu) return;

        const canvasRect = canvas.getBoundingClientRect();
        const oranX = canvas.width / canvasRect.width;
        const oranY = canvas.height / canvasRect.height;

        const kutuRect = kutu.getBoundingClientRect();
        const sx = Math.max(0, (kutuRect.left - canvasRect.left) * oranX);
        const sy = Math.max(0, (kutuRect.top - canvasRect.top) * oranY);
        const sw = Math.min(kutuRect.width * oranX, canvas.width - sx);
        const sh = Math.min(kutuRect.height * oranY, canvas.height - sy);

        if (sw < 5 || sh < 5) { isrtKirpIptal(); return; }

        const yeniCanvas = document.createElement('canvas');
        yeniCanvas.width = Math.round(sw);
        yeniCanvas.height = Math.round(sh);
        yeniCanvas.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, yeniCanvas.width, yeniCanvas.height);

        const alan = document.getElementById('isrtCanvasAlani');
        const maxW = Math.max(alan.clientWidth - 10, 100);
        const maxH = Math.max(alan.clientHeight - 10, 100);
        const oran = Math.min(maxW / yeniCanvas.width, maxH / yeniCanvas.height, 1);
        canvas.width = Math.round(yeniCanvas.width * oran);
        canvas.height = Math.round(yeniCanvas.height * oran);
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(yeniCanvas, 0, 0, canvas.width, canvas.height);

        isrtGecmisePush();
        isrtKirpIptal();
        isaretlemeAraciSec('eskiz');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', isaretlemeOlaylariniBaslat);
    } else {
        isaretlemeOlaylariniBaslat();
    }

    // ============================================================
    // 5) GLOBAL EXPORTLAR
    // ============================================================
    window.isaretlemeyiAc = isaretlemeyiAc;
    window.isaretlemeyiKapat = isaretlemeyiKapat;
    window.isaretlemeyiBitir = isaretlemeyiBitir;
    window.isaretlemeAraciSec = isaretlemeAraciSec;
    window.isaretlemeRenkSec = isaretlemeRenkSec;
    window.isaretlemeGeriAl = isaretlemeGeriAl;
    window.isaretlemeIleriAl = isaretlemeIleriAl;
    window.isrtKirpiUygula = isrtKirpiUygula;

})();