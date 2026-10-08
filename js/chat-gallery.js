// "+" menüsünün altındaki galeri ızgarası (WhatsApp tarzı).
// Yalnızca Android uygulamasında çalışır (AuraGallery köprüsü gerekir); tarayıcıda hiçbir şey yapmaz.

const PAGE = 60;
const MAX_PICK = 10;

let root = null;      // ızgara kabı
let gridEl = null;
let barEl = null;
let permEl = null;
let onPickCb = null;
let loaded = 0;
let loading = false;
let finished = false;
let selected = [];    // seçilen resim kimlikleri (sıralı)
let cells = new Map();
let observer = null;
let expanded = false;
const thumbWaiters = new Map();
const fullWaiters = new Map();

function bridge() {
    return window.AuraGallery && window.AuraGallery.list ? window.AuraGallery : null;
}

export function galleryAvailable() {
    return !!bridge();
}

// Köprüden gelen yanıtlar
window.__auraGalThumb = function (id, dataUrl) {
    const cell = cells.get(id);
    if (cell) {
        const img = cell.querySelector('img');
        if (img) img.src = dataUrl;
    }
    thumbWaiters.delete(id);
};
window.__auraGalFull = function (id, dataUrl) {
    const w = fullWaiters.get(id);
    if (w) { fullWaiters.delete(id); w(dataUrl); }
};

function dataUrlToFile(dataUrl, name) {
    const bin = atob((dataUrl.split(',')[1]) || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: 'image/jpeg' });
}

function requestThumb(id) {
    if (thumbWaiters.has(id)) return;
    thumbWaiters.set(id, true);
    try { bridge().thumbAsync(id, 220); } catch (e) {}
}

function updateBar() {
    if (!barEl) return;
    if (!selected.length) {
        barEl.style.display = 'none';
        return;
    }
    barEl.style.display = 'flex';
    barEl.textContent = '';
    const label = document.createElement('span');
    label.textContent = selected.length + ' seçildi';
    label.style.fontSize = '14px';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Ekle';
    btn.style.cssText = 'background:var(--aura-btn,#22c55e);color:#fff;border-radius:999px;padding:8px 22px;font-size:15px;font-weight:600;';
    btn.addEventListener('click', confirmPick);
    barEl.appendChild(label);
    barEl.appendChild(btn);
}

function refreshCellMarks() {
    cells.forEach((cell, id) => {
        const idx = selected.indexOf(id);
        const mark = cell.querySelector('.aura-gal-mark');
        const on = idx >= 0;
        cell.style.outline = on ? '3px solid var(--aura-btn,#22c55e)' : 'none';
        cell.style.outlineOffset = '-3px';
        if (mark) {
            mark.textContent = on ? String(idx + 1) : '';
            mark.style.background = on ? 'var(--aura-btn,#22c55e)' : 'rgba(0,0,0,0.25)';
            mark.style.borderColor = on ? 'var(--aura-btn,#22c55e)' : 'rgba(255,255,255,0.8)';
        }
    });
}

function toggle(id) {
    const i = selected.indexOf(id);
    if (i >= 0) selected.splice(i, 1);
    else if (selected.length < MAX_PICK) selected.push(id);
    refreshCellMarks();
    updateBar();
}

async function confirmPick() {
    const ids = selected.slice();
    if (!ids.length || !bridge()) return;
    barEl.textContent = 'Hazırlanıyor...';
    try {
        const files = await Promise.all(ids.map((id, i) => new Promise((resolve) => {
            const t = setTimeout(() => { fullWaiters.delete(id); resolve(null); }, 15000);
            fullWaiters.set(id, (dataUrl) => {
                clearTimeout(t);
                resolve(dataUrl ? dataUrlToFile(dataUrl, 'galeri_' + i + '.jpg') : null);
            });
            try { bridge().fullAsync(id); } catch (e) { clearTimeout(t); resolve(null); }
        })));
        const ok = files.filter(Boolean);
        selected = [];
        refreshCellMarks();
        updateBar();
        if (ok.length && onPickCb) onPickCb(ok);
    } catch (e) {
        updateBar();
    }
}

function addCell(id) {
    const cell = document.createElement('div');
    cell.dataset.gid = String(id);
    cell.style.cssText = 'position:relative;aspect-ratio:1/1;background:#1b262d;overflow:hidden;';
    const img = document.createElement('img');
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
    img.alt = '';
    img.draggable = false;
    cell.appendChild(img);
    const mark = document.createElement('div');
    mark.className = 'aura-gal-mark';
    mark.style.cssText = 'position:absolute;top:5px;right:5px;width:22px;height:22px;border-radius:50%;border:2px solid rgba(255,255,255,0.8);background:rgba(0,0,0,0.25);color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;';
    cell.appendChild(mark);
    cell.addEventListener('click', () => toggle(id));
    cells.set(id, cell);
    gridEl.appendChild(cell);
    if (observer) observer.observe(cell);
}

function loadMore() {
    if (loading || finished || !bridge()) return;
    loading = true;
    let ids = [];
    try { ids = JSON.parse(bridge().list(loaded, PAGE) || '[]'); } catch (e) { ids = []; }
    ids.forEach(addCell);
    loaded += ids.length;
    if (ids.length < PAGE) finished = true;
    loading = false;
}

function showPermission() {
    gridEl.style.display = 'none';
    permEl.style.display = 'flex';
}

function showGrid() {
    permEl.style.display = 'none';
    gridEl.style.display = 'grid';
}

function reset() {
    cells.clear();
    thumbWaiters.clear();
    selected = [];
    loaded = 0;
    finished = false;
    loading = false;
    if (gridEl) gridEl.textContent = '';
    if (observer) observer.disconnect();
    if (gridEl) {
        observer = new IntersectionObserver((entries) => {
            entries.forEach((en) => {
                if (!en.isIntersecting) return;
                const id = Number(en.target.dataset.gid);
                const img = en.target.querySelector('img');
                if (img && !img.src) requestThumb(id);
                observer.unobserve(en.target);
            });
        }, { root: root, rootMargin: '300px' });
    }
    updateBar();
}

// Menü içine ızgarayı kurar. host: menü elemanı, onPick: seçilen dosyaları alan fonksiyon
export function mountGallery(host, onPick) {
    if (!bridge() || root) return root;
    onPickCb = onPick;

    root = document.createElement('div');
    root.className = 'aura-gal-grid';
    root.style.cssText = 'flex:1;min-height:0;overflow-y:hidden;overflow-x:hidden;position:relative;margin-top:10px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;';

    gridEl = document.createElement('div');
    gridEl.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:2px;';
    root.appendChild(gridEl);

    permEl = document.createElement('div');
    permEl.style.cssText = 'display:none;flex-direction:column;align-items:center;gap:10px;padding:18px 20px;color:#cbd5e1;font-size:14px;text-align:center;';
    permEl.innerHTML = '<span>Resimleri burada görmek için galeri izni gerekiyor.</span>';
    const permBtn = document.createElement('button');
    permBtn.type = 'button';
    permBtn.textContent = 'İzin ver';
    permBtn.style.cssText = 'background:var(--aura-btn,#22c55e);color:#fff;border-radius:999px;padding:8px 22px;font-size:15px;font-weight:600;';
    permBtn.addEventListener('click', () => {
        try { bridge().ask(); } catch (e) {}
        let n = 0;
        const t = setInterval(() => {
            n++;
            if (bridge() && bridge().has()) { clearInterval(t); openGallery(); }
            else if (n > 40) clearInterval(t);
        }, 500);
    });
    permEl.appendChild(permBtn);
    root.appendChild(permEl);

    barEl = document.createElement('div');
    barEl.style.cssText = 'display:none;position:absolute;left:0;right:0;bottom:0;z-index:5;align-items:center;justify-content:space-between;padding:10px 16px;background:rgba(17,27,33,0.96);color:#fff;border-top:1px solid rgba(255,255,255,0.1);';
    host.style.position = 'relative';
    host.appendChild(root);
    host.appendChild(barEl);
    barEl.style.position = 'absolute';
    barEl.style.bottom = '0';

    root.addEventListener('scroll', () => {
        if (root.scrollTop + root.clientHeight > root.scrollHeight - 600) loadMore();
    }, { passive: true });

    reset();
    return root;
}

// Menü her açıldığında çağrılır: listeyi tazeler
export function openGallery() {
    if (!root || !bridge()) return;
    reset();
    setGalleryExpanded(false);
    let ok = false;
    try { ok = !!bridge().has(); } catch (e) {}
    if (!ok) { showPermission(); return; }
    showGrid();
    loadMore();
}

export function closeGallery() {
    if (!root) return;
    selected = [];
    updateBar();
    setGalleryExpanded(false);
}

export function setGalleryExpanded(v) {
    expanded = !!v;
    if (!root) return;
    root.style.overflowY = expanded ? 'auto' : 'hidden';
    if (!expanded) root.scrollTop = 0;
}

export function isGalleryExpanded() {
    return expanded;
}
